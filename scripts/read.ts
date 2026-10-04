/**
 * Run one prescription (photo or .txt) through exactly the app's pipeline and print each stage.
 *
 *   npm run read -- private/rx-1.jpg
 *   npm run read -- private/rx-1.jpg --rotate 270      # rotate clockwise first, like the ↻ button
 *   npm run read -- private/rx-1.jpg --model gemma3:4b
 *
 * Photos are downscaled to 1600px with macOS `sips`, matching the browser's canvas downscale.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { extractPrescription, transcribePhoto } from '../src/lib/ollama.ts'
import { SLOTS } from '../src/lib/types.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { model: { type: 'string' }, rotate: { type: 'string' }, size: { type: 'string', default: '1600' } },
})
const file = positionals[0]
if (!file) {
  console.error('usage: npm run read -- <photo|text file> [--rotate 90|180|270] [--model name]')
  process.exit(1)
}
const opts = {
  model: values.model || process.env.VITE_MODEL || 'gemma4:e2b-it-qat',
  baseUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
}

let text: string
if (['.txt', '.md'].includes(extname(file).toLowerCase())) {
  text = readFileSync(file, 'utf8')
} else {
  const out = join(mkdtempSync(join(tmpdir(), 'dosecard-')), 'rx.jpg')
  const rotate = values.rotate ? ['-r', values.rotate] : []
  execFileSync('sips', [...rotate, '-Z', values.size!, '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', file, '--out', out], { stdio: 'ignore' })
  const t = await transcribePhoto([readFileSync(out).toString('base64')], opts)
  console.log(`PASS 1 — transcription (${opts.model}, ${(t.durationMs / 1000).toFixed(1)}s)\n---\n${t.text}\n---\n`)
  text = t.text
}

try {
  const { extraction, durationMs } = await extractPrescription(text, opts)
  console.log(`PASS 2 — medicines (${(durationMs / 1000).toFixed(1)}s)`)
  for (const m of extraction.medicines) {
    const slots = SLOTS.filter((s) => m.doses[s]).map((s) => `${s}:${m.doses[s]}`)
    console.log(`- ${m.name} ${m.strength}  written "${m.frequencyText}" → [${slots.join(', ')}${m.asNeeded ? ' SOS' : ''}] via ${m.interpretedBy}, food: ${m.food}, duration: ${m.duration || '-'}`)
    for (const issue of m.issues) console.log(`    ⚠ ${issue}`)
  }
  if (extraction.unreadable.length) console.log(`\nunreadable: ${extraction.unreadable.join(' | ')}`)
} catch (err) {
  console.log(`PASS 2 — rejected: ${(err as Error).message}`)
}
