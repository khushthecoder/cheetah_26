/**
 * Run one prescription (photo or .txt) through the same pipeline the app uses and print
 * the raw model output next to DoseCard's interpretation.
 *
 *   npm run read -- private/rx-1.jpg
 *   npm run read -- private/rx-1.jpg gemma3:4b
 *
 * Photos are downscaled to 1280px with macOS `sips`, matching the browser's canvas downscale.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { MODEL_JSON_SCHEMA, parseModelOutput, SYSTEM_PROMPT } from '../src/lib/extract.ts'
import { SLOTS } from '../src/lib/types.ts'

const [file, modelArg] = process.argv.slice(2)
if (!file) {
  console.error('usage: npm run read -- <photo|text file> [model]')
  process.exit(1)
}
const model = modelArg || process.env.VITE_MODEL || 'gemma4:e2b-it-qat'
const baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'

const isText = ['.txt', '.md'].includes(extname(file).toLowerCase())
let text = ''
let images: string[] = []
if (isText) {
  text = readFileSync(file, 'utf8')
} else {
  const out = join(mkdtempSync(join(tmpdir(), 'dosecard-')), 'rx.jpg')
  execFileSync('sips', ['-Z', '1280', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', file, '--out', out], { stdio: 'ignore' })
  images = [readFileSync(out).toString('base64')]
}

const userContent = images.length ? 'Read the prescription in the attached photo.' : `Read this prescription.\n\nPrescription text:\n"""\n${text}\n"""`
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
      { role: 'user', content: userContent, ...(images.length ? { images } : {}) },
    ],
  }),
})
const seconds = ((performance.now() - started) / 1000).toFixed(1)
if (!res.ok) {
  console.error(`Ollama ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const data = (await res.json()) as { message: { content: string } }
console.log(`model: ${model}   time: ${seconds}s   input: ${isText ? 'text' : 'photo'}\n`)
console.log('RAW MODEL OUTPUT')
console.log(JSON.stringify(JSON.parse(data.message.content), null, 2))

const extraction = parseModelOutput(data.message.content, text)
console.log('\nDOSECARD RESULT')
for (const m of extraction.medicines) {
  const slots = SLOTS.filter((s) => m.doses[s]).map((s) => `${s}:${m.doses[s]}`)
  console.log(`- ${m.name} ${m.strength}  written "${m.frequencyText}" → [${slots.join(', ')}${m.asNeeded ? ' SOS' : ''}] via ${m.interpretedBy}, food: ${m.food}, duration: ${m.duration || '-'}`)
  for (const issue of m.issues) console.log(`    ⚠ ${issue}`)
}
if (extraction.unreadable.length) console.log(`\nunreadable: ${extraction.unreadable.join(' | ')}`)
