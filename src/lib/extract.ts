import { z } from 'zod'
import { findDoseTexts, interpretFood, interpretFrequency, isDoseOnlyLine } from './frequency.ts'
import { emptyDoses, type Extraction, type Medicine } from './types.ts'

/**
 * What we ask the model for. The model's job is narrow: *read* the prescription and copy
 * what is written. It never decides the schedule on its own — see frequency.ts.
 */
const nullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v ?? '').trim())

export const ModelMedicineSchema = z.object({
  name: z.string().trim().min(1),
  strength: nullableText,
  form: nullableText,
  frequency_text: nullableText,
  food_text: nullableText,
  duration_text: nullableText,
  instructions: nullableText,
  confidence: z
    .string()
    .nullish()
    .transform((v) => (v === 'high' || v === 'medium' || v === 'low' ? v : 'low')),
})

export const ModelOutputSchema = z.object({
  patient_name: nullableText,
  doctor_name: nullableText,
  medicines: z.array(z.unknown()).default([]),
  unreadable: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
})

/**
 * Generation settings shared by the app and the scripts. num_predict caps a runaway repetition loop
 * (seen on a sideways photo: 98 s of "T. Vit" until the JSON broke); repeat_penalty discourages it.
 */
export const MODEL_OPTIONS = { temperature: 0, num_ctx: 4096, num_predict: 1200, repeat_penalty: 1.15 } as const

/** Pass 1 for photos. Transcription only — the layout change (dose onto the medicine's line) is the one liberty allowed. */
export const TRANSCRIBE_PROMPT = `Transcribe the medicines in this handwritten prescription, exactly as written.
Write one medicine per line. If a dosing pattern (like 1-0-1 or 0-1-0) or a duration is written next to or
directly below a medicine, put it on that medicine's line.
Skip the clinic address, patient details, date and diagnosis.
Write [?] for any word you cannot read. Do not correct spellings, explain, add or summarise anything.`

export const TRANSCRIBE_OPTIONS = { temperature: 0, num_ctx: 4096, num_predict: 600, repeat_penalty: 1.15 } as const

/** JSON schema handed to Ollama's structured-output `format` field (constrained decoding). */
export const MODEL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    patient_name: { type: ['string', 'null'] },
    doctor_name: { type: ['string', 'null'] },
    medicines: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          strength: { type: ['string', 'null'] },
          form: { type: ['string', 'null'] },
          frequency_text: { type: ['string', 'null'] },
          food_text: { type: ['string', 'null'] },
          duration_text: { type: ['string', 'null'] },
          instructions: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['name', 'strength', 'form', 'frequency_text', 'food_text', 'duration_text', 'instructions', 'confidence'],
      },
    },
    unreadable: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  },
  required: ['patient_name', 'doctor_name', 'medicines', 'unreadable'],
} as const

// No real medicine names in here: on an unreadable photo a small model will copy prompt examples
// into its answer (it once returned "Telma 40 … with warm water" for a prescription without it).
export const SYSTEM_PROMPT = `You read a doctor's prescription and copy the medicines into JSON.

Rules:
- Only include medicines you can actually see written. Never add a medicine. Never guess a name.
- If you cannot read the prescription, return an empty medicines list. That is a correct answer.
- name: the medicine name exactly as written, without the "Tab."/"Cap."/"Syp."/"T." prefix.
- strength: only the number part with its unit if written (like "500 mg", "2.5%", "0.05%"). Letters that belong to the brand stay in name.
- form: tablet, capsule, syrup, drops, gel, cream, ointment, face wash, injection, sachet — only if written or clear from the prefix.
- frequency_text: copy the dosing text exactly as written (number patterns like "1-0-1", or codes like BD, TDS, HS, OD, SOS, or words). Do not rewrite it.
  Handwritten prescriptions often put the dosing pattern on the line directly below the medicine name — it still belongs to that medicine.
- food_text: any food instruction exactly as written. Empty if none.
- duration_text: how long, exactly as written. Empty if none.
- instructions: any other written instruction for that medicine (like "apply at night", "local application"). Empty if none.
- confidence: "high" only if name and dosing are clearly legible. "low" if you are unsure of any letter.
- unreadable: each line that looks like a medicine but you could not read, listed once.
- Ignore the clinic address, phone numbers, patient details, date, vitals and test advice.
- Lines starting with "D:", "Dx", "C/O", "Diagnosis" or "Adv" are the diagnosis or advice, not medicines.
- Do not give medical advice. Output JSON only.`

export class ExtractionError extends Error {
  readonly kind: 'empty' | 'malformed' | 'nothing-found'
  constructor(message: string, kind: 'empty' | 'malformed' | 'nothing-found') {
    super(message)
    this.kind = kind
  }
}

let idCounter = 0
const newId = () => `med-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

/** Lowercase, punctuation → single spaces, padded so `includes(' x ')` matches whole words only. */
const words = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ') // keep the dot only inside decimals like 0.5
    .replace(/[^a-z0-9½.]+/g, ' ')
    .trim()} `

/**
 * For typed/pasted input we can check the model's transcription against what was actually entered.
 * A small model sometimes "corrects" a brand name into a different, real-looking drug — this catches it.
 */
function groundingIssues(raw: z.infer<typeof ModelMedicineSchema>, sourceText: string, frequencyText: string): string[] {
  const source = words(sourceText)
  if (!source.trim()) return []
  const issues: string[] = []
  const nameTokens = nameTokensOf(raw.name)
  if (nameTokens.length > 0 && !nameTokens.some((t) => source.includes(` ${t} `))) {
    issues.push(`"${raw.name}" doesn't appear in the text you entered — the AI may have changed the spelling.`)
  }
  // Strength numbers are easy for a small model to invent ("Pan D" -> strength "1"), so the number
  // must appear on the same line as the medicine's name (whole text if we can't find the line).
  const strengthNumbers = findDoseTexts(raw.strength).length ? [] : (raw.strength.match(/\d+(?:\.\d+)?/g) ?? [])
  if (strengthNumbers.length > 0) {
    const lines = sourceText.split(/\n+/).map(words)
    const nameLines = lines.filter((l) => nameTokens.some((t) => l.includes(` ${t} `)))
    const scope = nameLines.length ? nameLines.join(' ') : source
    const written = (n: string) => new RegExp(` ${n.replace('.', '\\.')}(?:mg|mcg|ml|g|k|iu)? `).test(scope)
    if (!strengthNumbers.every(written)) {
      issues.push(`Strength "${raw.strength}" doesn't appear next to ${raw.name} in the text you entered — check it against the paper.`)
    }
  }
  const freq = words(frequencyText)
  if (freq.trim() && !source.includes(freq)) {
    issues.push(`Dosing "${frequencyText}" doesn't appear in the text you entered — check the timing.`)
  }
  return issues
}

/** Keep only number + unit ("0.05 ointment" → "0.05"); drop non-numeric "strengths" and misplaced doses. */
export function cleanStrength(strength: string): string {
  if (!/\d/.test(strength) || findDoseTexts(strength).length > 0) return ''
  const m = strength.match(/\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|%|iu|k|lac|lakh)?(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|%)?)?/i)
  return m ? m[0].trim() : ''
}

/** Remove the "T."/"Tab." prefix and a dosing pattern the model copied into the name ("T. Vite 0-1-0" → "Vite"). */
export function cleanName(name: string, frequencyText: string): string {
  let n = name.replace(/^(tab|tablet|cap|capsule|syp|syrup|inj|t|c)\.?\s+/i, '')
  const freq = frequencyText.trim()
  if (freq && n.endsWith(freq)) n = n.slice(0, -freq.length)
  n = n.replace(/\s+\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*$/, '')
  return n.trim() || name.trim()
}

const nameTokensOf = (name: string) =>
  words(name)
    .trim()
    .split(' ')
    .filter((t) => t.length >= 3 && !/^\d/.test(t))

/**
 * The dosing written next to this medicine in the source: on its own line, or on a dose-only line
 * directly below it (common in handwriting). A small model pairing doses across lines put Zinc's
 * "1-0-0" on Vit C in a real photo test, so the written position wins over the model's pairing.
 * Lines naming more than one dose are ambiguous and skipped.
 */
export function anchoredDose(name: string, sourceText: string): string | null {
  const tokens = nameTokensOf(name)
  if (tokens.length === 0) return null
  // Lines, plus sentences inside a line ("… khali pet. Shelcal 500 …"), so typed notes anchor per medicine.
  const lines = sourceText
    .split(/\n+|(?<=[a-z0-9)])\.\s+(?=[A-Z])/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    const line = words(lines[i])
    if (!tokens.some((t) => line.includes(` ${t} `))) continue
    const own = findDoseTexts(lines[i])
    if (own.length === 1) return own[0]
    if (own.length > 1) continue
    if (i + 1 < lines.length && isDoseOnlyLine(lines[i + 1])) return findDoseTexts(lines[i + 1])[0]
  }
  return null
}

/**
 * Turn one validated model row into a Medicine. The schedule comes only from deterministic rules
 * applied to the text the model copied. If the rules can't decode it, the human sets the times —
 * the model is never asked to guess (in our eval its own guesses were right only 9 of 23 times).
 */
export function toMedicine(raw: z.infer<typeof ModelMedicineSchema>, sourceText = ''): Medicine {
  let frequencyText = raw.frequency_text
  const anchorIssues: string[] = []
  const anchored = sourceText ? anchoredDose(raw.name, sourceText) : null
  if (anchored && words(frequencyText).includes(words(anchored))) {
    frequencyText = anchored // same dose, the model just copied extra words around it
  } else if (anchored) {
    anchorIssues.push(
      frequencyText
        ? `The AI paired this with "${frequencyText}", but "${anchored}" is written next to it — using that. Check the paper.`
        : `Dose "${anchored}" is written next to this medicine — check the paper.`,
    )
    frequencyText = anchored
  }
  const issues: string[] = [...groundingIssues(raw, sourceText, frequencyText), ...anchorIssues]
  const combined = [frequencyText, raw.food_text, raw.instructions].filter(Boolean).join(' ')
  const rule = interpretFrequency(frequencyText) ?? (raw.instructions ? interpretFrequency(combined) : null)

  let doses = emptyDoses()
  let asNeeded = false
  let interpretedBy: Medicine['interpretedBy'] = 'none'

  if (rule) {
    doses = rule.doses
    asNeeded = rule.asNeeded
    interpretedBy = 'rule'
    issues.push(...rule.notes)
  } else {
    issues.push(frequencyText ? `Couldn't decode "${frequencyText}". Set the times by hand.` : 'No dosing found. Set the times by hand.')
  }

  if (raw.confidence === 'low') issues.push('Name was hard to read — compare spelling with the paper.')

  return {
    id: newId(),
    name: cleanName(raw.name, frequencyText),
    // A strength without any digit ("D" from "Pan D") is a split brand name, not a strength.
    // …and a dose pattern in the strength field ("1-0-0") is a misplaced dose, not a strength.
    strength: cleanStrength(raw.strength),
    form: raw.form,
    doses,
    asNeeded,
    food: interpretFood(`${raw.food_text} ${frequencyText} ${raw.instructions}`),
    duration: raw.duration_text,
    frequencyText,
    instructions: raw.instructions,
    confidence: raw.confidence,
    interpretedBy,
    issues,
    checked: false,
  }
}

/** Strip code fences / leading chatter some models add despite format constraints. */
function extractJsonText(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : content
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

/** Validate raw model output. Bad rows are dropped individually rather than failing the whole result. */
export function parseModelOutput(content: string, sourceText = ''): Extraction {
  if (!content.trim()) throw new ExtractionError('The model returned an empty response.', 'empty')

  let json: unknown
  try {
    json = JSON.parse(extractJsonText(content))
  } catch {
    throw new ExtractionError('The model returned something that is not valid JSON.', 'malformed')
  }

  const top = ModelOutputSchema.safeParse(json)
  if (!top.success) throw new ExtractionError('The model response did not match the expected shape.', 'malformed')

  const unreadable = [...top.data.unreadable]
  const medicines: Medicine[] = []
  const seen = new Set<string>()
  for (const row of top.data.medicines) {
    const parsed = ModelMedicineSchema.safeParse(row)
    if (!parsed.success) {
      const name = typeof row === 'object' && row && 'name' in row ? String((row as { name: unknown }).name) : ''
      if (name) unreadable.push(name)
      continue
    }
    const key = `${parsed.data.name.toLowerCase()}|${parsed.data.strength.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    medicines.push(toMedicine(parsed.data, sourceText))
  }

  if (medicines.length === 0) {
    throw new ExtractionError("Couldn't find any medicines. Try a clearer, closer photo or paste the text.", 'nothing-found')
  }

  return {
    patientName: top.data.patient_name,
    doctorName: top.data.doctor_name,
    medicines,
    unreadable: unreadable.filter(Boolean),
  }
}
