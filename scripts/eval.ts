/**
 * Runs the sample prescriptions through the local model and scores the result.
 *
 *   npm run eval                      # default model
 *   npm run eval -- gemma3:4b         # compare another model
 *
 * Compares two ways of deciding *when* to take each medicine:
 *   - model:  the model's own `model_slots` guess
 *   - rules:  DoseCard's pipeline (deterministic frequency.ts, model guess only as fallback)
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { MODEL_JSON_SCHEMA, ModelMedicineSchema, ModelOutputSchema, SYSTEM_PROMPT, toMedicine } from '../src/lib/extract.ts'
import { SLOTS, type Slot } from '../src/lib/types.ts'

interface Expected {
  name: string
  slots: Slot[]
  asNeeded?: boolean
}
interface Case {
  id: string
  note: string
  text: string
  expected: Expected[]
}

const model = process.argv[2] || process.env.VITE_MODEL || 'gemma4:e2b-it-qat'
const baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const cases = JSON.parse(await readFile(new URL('../samples/eval-cases.json', import.meta.url), 'utf8')) as Case[]

const sameSlots = (a: Slot[], b: Slot[]) => a.length === b.length && a.every((s) => b.includes(s))

async function run(c: Case) {
  const started = performance.now()
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: MODEL_JSON_SCHEMA,
      options: { temperature: 0, num_ctx: 4096 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Read this prescription.\n\nPrescription text:\n"""\n${c.text}\n"""` },
      ],
    }),
  })
  const ms = performance.now() - started
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const data = (await res.json()) as { message: { content: string }; eval_count?: number; eval_duration?: number }
  const top = ModelOutputSchema.parse(JSON.parse(data.message.content))
  const rows = top.medicines.flatMap((r) => {
    const p = ModelMedicineSchema.safeParse(r)
    return p.success ? [p.data] : []
  })

  let found = 0
  let modelCorrect = 0
  let rulesCorrect = 0
  let byRule = 0
  const details: string[] = []
  for (const exp of c.expected) {
    const row = rows.find((r) => r.name.toLowerCase().includes(exp.name))
    if (!row) {
      details.push(`  ✗ missed ${exp.name}`)
      continue
    }
    found++
    const med = toMedicine(row)
    const pipelineSlots = SLOTS.filter((s) => med.doses[s])
    const modelOk = sameSlots(row.model_slots, exp.slots)
    const rulesOk = sameSlots(pipelineSlots, exp.slots) && (exp.asNeeded ?? false) === med.asNeeded
    if (med.interpretedBy === 'rule') byRule++
    if (modelOk) modelCorrect++
    if (rulesOk) rulesCorrect++
    details.push(
      `  ${rulesOk ? '✓' : '✗'} ${row.name.padEnd(16)} written "${row.frequency_text}" → model:[${row.model_slots.join(',')}] dosecard:[${pipelineSlots.join(',')}${med.asNeeded ? ',SOS' : ''}] (${med.interpretedBy}) expected:[${exp.slots.join(',')}${exp.asNeeded ? ',SOS' : ''}]`,
    )
  }
  const extra = rows.filter((r) => !c.expected.some((e) => r.name.toLowerCase().includes(e.name)))
  for (const r of extra) details.push(`  ! extra row "${r.name}" (hallucinated or split)`)

  const tokPerSec = data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : 0
  return { id: c.id, expected: c.expected.length, found, extra: extra.length, modelCorrect, rulesCorrect, byRule, ms, tokPerSec, details }
}

console.log(`Model: ${model}\n`)
const results: Awaited<ReturnType<typeof run>>[] = []
// Warm-up so the first case doesn't include model load time.
await fetch(`${baseUrl}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt: 'hi', stream: false, options: { num_predict: 1 } }) })
for (const c of cases) {
  try {
    const r = await run(c)
    results.push(r)
    console.log(`${c.id} (${(r.ms / 1000).toFixed(1)}s, ${r.tokPerSec.toFixed(1)} tok/s): found ${r.found}/${r.expected}, schedule model ${r.modelCorrect}/${r.found} vs dosecard ${r.rulesCorrect}/${r.found}`)
    console.log(r.details.join('\n') + '\n')
  } catch (err) {
    console.log(`${c.id}: FAILED — ${(err as Error).message}\n`)
  }
}

const sum = (k: 'expected' | 'found' | 'extra' | 'modelCorrect' | 'rulesCorrect' | 'byRule') => results.reduce((a, r) => a + r[k], 0)
const summary = {
  model,
  cases: results.length,
  medicines: sum('expected'),
  found: sum('found'),
  extraRows: sum('extra'),
  scheduleCorrectModelOnly: sum('modelCorrect'),
  scheduleCorrectDoseCard: sum('rulesCorrect'),
  decodedByRules: sum('byRule'),
  avgSeconds: +(results.reduce((a, r) => a + r.ms, 0) / results.length / 1000).toFixed(1),
}
console.log('SUMMARY', summary)
await mkdir(new URL('../eval-results/', import.meta.url), { recursive: true })
await writeFile(new URL(`../eval-results/${model.replace(/[^a-z0-9.-]/gi, '_')}.json`, import.meta.url), JSON.stringify({ summary, results }, null, 2))
