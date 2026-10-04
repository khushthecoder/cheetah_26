import { z } from 'zod'
import { interpretFood, interpretFrequency } from './frequency.ts'
import { emptyDoses, SLOTS, type Extraction, type Medicine, type Slot } from './types.ts'

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
  model_slots: z
    .array(z.string())
    .nullish()
    .transform((v) => (v ?? []).map((s) => s.toLowerCase().trim()).filter((s): s is Slot => (SLOTS as readonly string[]).includes(s))),
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

/** JSON schema handed to Ollama's structured-output `format` field (constrained decoding). */
export const MODEL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    patient_name: { type: ['string', 'null'] },
    doctor_name: { type: ['string', 'null'] },
    medicines: {
      type: 'array',
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
          model_slots: { type: 'array', items: { type: 'string', enum: [...SLOTS] } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['name', 'strength', 'form', 'frequency_text', 'food_text', 'duration_text', 'instructions', 'model_slots', 'confidence'],
      },
    },
    unreadable: { type: 'array', items: { type: 'string' } },
  },
  required: ['patient_name', 'doctor_name', 'medicines', 'unreadable'],
} as const

export const SYSTEM_PROMPT = `You read Indian doctor's prescriptions and copy the medicines into JSON.

Rules:
- Only include medicines that are actually written. Never add a medicine, never guess a name.
- Copy the medicine name exactly as written (brand names like "Tab. Telma 40" -> name "Telma", strength "40 mg" if a unit is shown, else "40").
- form: tablet, capsule, syrup, drops, injection, inhaler, ointment, sachet — only if written or obvious from "Tab."/"Cap."/"Syp.".
- frequency_text: copy the dosing text VERBATIM, e.g. "1-0-1", "BD", "TDS", "HS", "1 tab twice daily", "SOS". Do not translate or rewrite it.
- food_text: copy any food instruction verbatim, e.g. "after food", "AC", "empty stomach". Empty if none.
- duration_text: e.g. "5 days", "1 month", "continue". Empty if none.
- instructions: any other written instruction for that medicine (e.g. "with warm water"). Empty if none.
- model_slots: your best reading of when to take it, using only: morning, afternoon, evening, night.
- confidence: "high" only if the name and dosing are clearly legible. "low" if you are unsure of any letter in the name.
- unreadable: list any line that looks like a medicine but you could not read.
- Ignore diagnoses, vitals, test advice, clinic address and phone numbers.
- Do not give medical advice. Do not explain. Output JSON only.`

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty' | 'malformed' | 'nothing-found',
  ) {
    super(message)
  }
}

let idCounter = 0
const newId = () => `med-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

/** Turn one validated model row into a Medicine, preferring deterministic rules over the model's guess. */
export function toMedicine(raw: z.infer<typeof ModelMedicineSchema>): Medicine {
  const issues: string[] = []
  const combined = [raw.frequency_text, raw.food_text, raw.instructions].filter(Boolean).join(' ')
  const rule = interpretFrequency(raw.frequency_text) ?? (raw.instructions ? interpretFrequency(combined) : null)

  let doses = emptyDoses()
  let asNeeded = false
  let interpretedBy: Medicine['interpretedBy'] = 'none'

  if (rule) {
    doses = rule.doses
    asNeeded = rule.asNeeded
    interpretedBy = 'rule'
    issues.push(...rule.notes)
  } else if (raw.model_slots.length > 0) {
    for (const s of raw.model_slots) doses[s] = '1'
    interpretedBy = 'model'
    issues.push(
      raw.frequency_text
        ? `Couldn't decode "${raw.frequency_text}" with certainty — times are the AI's guess.`
        : 'No dosing written — times are the AI’s guess.',
    )
  } else {
    issues.push(raw.frequency_text ? `Couldn't decode "${raw.frequency_text}". Set the times by hand.` : 'No dosing found. Set the times by hand.')
  }

  if (raw.confidence === 'low') issues.push('Name was hard to read — compare spelling with the paper.')

  return {
    id: newId(),
    name: raw.name,
    strength: raw.strength,
    form: raw.form,
    doses,
    asNeeded,
    food: interpretFood(`${raw.food_text} ${raw.frequency_text} ${raw.instructions}`),
    duration: raw.duration_text,
    frequencyText: raw.frequency_text,
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
export function parseModelOutput(content: string): Extraction {
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
    medicines.push(toMedicine(parsed.data))
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
