import { describe, expect, it, vi } from 'vitest'
import { cleanName, cleanStrength, ExtractionError, parseModelOutput } from './extract.ts'
import { extractPrescription, OllamaError, transcribePhoto } from './ollama.ts'

const row = (over: Record<string, unknown> = {}) => ({
  name: 'Telma',
  strength: '40 mg',
  form: 'tablet',
  frequency_text: '1-0-0',
  food_text: 'after food',
  duration_text: '1 month',
  instructions: null,
  confidence: 'high',
  ...over,
})

const output = (medicines: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ patient_name: 'Mrs. S', doctor_name: null, medicines, unreadable: [], ...extra })

describe('parseModelOutput', () => {
  it('turns a clean model row into a scheduled medicine via rules', () => {
    const { medicines, patientName } = parseModelOutput(output([row()]))
    expect(patientName).toBe('Mrs. S')
    expect(medicines).toHaveLength(1)
    const [m] = medicines
    expect(m.doses).toEqual({ morning: '1', afternoon: null, evening: null, night: null })
    expect(m.food).toBe('after')
    expect(m.interpretedBy).toBe('rule')
    expect(m.issues).toEqual([])
    expect(m.checked).toBe(false)
  })

  it('decodes the schedule from the copied dosing text', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: '1-0-1' })])).medicines
    expect(m.doses).toEqual({ morning: '1', afternoon: null, evening: null, night: '1' })
  })

  it('never guesses times when the dosing text cannot be decoded', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: 'as directed', model_slots: ['night'] })])).medicines
    expect(m.interpretedBy).toBe('none')
    expect(Object.values(m.doses).every((v) => v === null)).toBe(true)
    expect(m.issues.join(' ')).toMatch(/Set the times by hand/)
  })

  it('drops a "strength" with no number (split brand name like "Pan D")', () => {
    const [m] = parseModelOutput(output([row({ name: 'Pan D', strength: 'D' })])).medicines
    expect(m.strength).toBe('')
  })

  it('decodes "only if fever" from the dosing text as as-needed', () => {
    const [m] = parseModelOutput(output([row({ name: 'Dolo', frequency_text: 'only if fever goes above 100' })])).medicines
    expect(m.asNeeded).toBe(true)
  })

  it('flags low-confidence names', () => {
    const [m] = parseModelOutput(output([row({ confidence: 'low' })])).medicines
    expect(m.issues.join(' ')).toMatch(/hard to read/)
  })

  it('tolerates code fences, nulls and junk confidence values', () => {
    const content = '```json\n' + output([row({ strength: null, form: undefined, confidence: 'very sure' })]) + '\n```'
    const [m] = parseModelOutput(content).medicines
    expect(m.strength).toBe('')
    expect(m.confidence).toBe('low')
  })

  it('drops invalid rows individually and dedupes repeats', () => {
    const { medicines, unreadable } = parseModelOutput(output([row(), row(), { name: '' }, { strength: '5mg' }, row({ name: 'Metformin', strength: '500 mg' })]))
    expect(medicines.map((m) => m.name)).toEqual(['Telma', 'Metformin'])
    expect(unreadable).toEqual([])
  })

  it('rejects empty, non-JSON and medicine-less responses with a typed error', () => {
    expect(() => parseModelOutput('')).toThrow(ExtractionError)
    expect(() => parseModelOutput('Sorry, I cannot help')).toThrow(/not valid JSON/)
    expect(() => parseModelOutput(output([]))).toThrow(/Couldn't find any medicines/)
  })
})

describe('extractPrescription', () => {
  const okFetch = (content: string) =>
    vi.fn(async () => new Response(JSON.stringify({ message: { content } }), { status: 200 })) as unknown as typeof fetch

  it('sends text, schema and deterministic options to Ollama', async () => {
    const fetchImpl = okFetch(output([row()]))
    const result = await extractPrescription('Tab Telma 40 1-0-0', { fetchImpl, baseUrl: 'http://x', model: 'm' })
    expect(result.extraction.medicines).toHaveLength(1)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://x/api/chat')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('m')
    expect(body.stream).toBe(false)
    expect(body.options.temperature).toBe(0)
    expect(body.format.required).toContain('medicines')
    expect(body.messages[1].content).toContain('Tab Telma 40 1-0-0')
    expect(body.messages[1].images).toBeUndefined()
    expect(result.extraction.medicines[0].issues).toEqual([])
  })

  it('transcribes photos as plain text without a JSON schema', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: { content: '```\nT. Vite 0-1-0\nT. Zinc 1-0-0\n```' } }), { status: 200 })) as unknown as typeof fetch
    const result = await transcribePhoto(['AAAA'], { fetchImpl, baseUrl: 'http://x' })
    expect(result.text).toBe('T. Vite 0-1-0\nT. Zinc 1-0-0')
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.messages[0].images).toEqual(['AAAA'])
    expect(body.format).toBeUndefined()
    expect(body.options.num_predict).toBeGreaterThan(0)
  })

  it('caps generation so a repetition loop cannot run forever', async () => {
    const fetchImpl = okFetch(output([row()]))
    await extractPrescription('Tab Telma 40 1-0-0', { fetchImpl, baseUrl: 'http://x' })
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.options.num_predict).toBeGreaterThan(0)
    expect(body.format.properties.medicines.maxItems).toBeGreaterThan(0)
  })

  it('reports Ollama being offline', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(extractPrescription('x', { fetchImpl })).rejects.toMatchObject({ kind: 'offline' })
  })

  it('reports a missing model with the pull command', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"model \\"m\\" not found"}', { status: 404 })) as unknown as typeof fetch
    await expect(extractPrescription('x', { fetchImpl, model: 'm' })).rejects.toThrow(/ollama pull m/)
  })

  it('times out slow inference', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    ) as unknown as typeof fetch
    const err = await extractPrescription('x', { fetchImpl, timeoutMs: 10 }).catch((e) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect(err.kind).toBe('timeout')
  })

  it('surfaces malformed model output as an ExtractionError', async () => {
    await expect(extractPrescription('x', { fetchImpl: okFetch('not json') })).rejects.toBeInstanceOf(ExtractionError)
  })
})

describe('safety checks', () => {
  const source = 'Tab. Telma 40   1-0-0   after breakfast'

  it('passes rows that are grounded in the entered text', () => {
    const [m] = parseModelOutput(output([row()]), source).medicines
    expect(m.issues).toEqual([])
  })

  it('flags a medicine name the model changed', () => {
    const [m] = parseModelOutput(output([row({ name: 'Telmisartan' })]), source).medicines
    expect(m.issues.join(' ')).toMatch(/doesn't appear in the text/)
  })

  it('replaces a dose the model invented with the one written next to the medicine, and flags it', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: '1-0-1' })]), source).medicines
    expect(m.frequencyText).toBe('1-0-0')
    expect(m.doses).toEqual({ morning: '1', afternoon: null, evening: null, night: null })
    expect(m.issues.join(' ')).toMatch(/paired this with "1-0-1", but "1-0-0" is written next to it/)
  })

  it('flags dosing text that is nowhere in the input', () => {
    const [m] = parseModelOutput(output([row({ name: 'Zzzmed', frequency_text: 'TDS' })]), source).medicines
    expect(m.issues.join(' ')).toMatch(/Dosing "TDS" doesn't appear/)
  })

  it('skips grounding when there is no source text (photo input)', () => {
    const [m] = parseModelOutput(output([row({ name: 'Anything' })]), '').medicines
    expect(m.issues).toEqual([])
  })
})

describe('grounding matches whole words', () => {
  it('does not let "1-0-1" hide inside other numbers', () => {
    const [m] = parseModelOutput(output([row({ name: 'Other', frequency_text: '1-0-1' })]), 'Tab. Telma 40 1-0-0 x 10 days').medicines
    expect(m.issues.join(' ')).toMatch(/Dosing "1-0-1" doesn't appear/)
  })

  it('tolerates spacing and punctuation differences', () => {
    const [m] = parseModelOutput(output([row({ name: 'Glycomet GP', strength: '1', frequency_text: '1-0-1' })]), 'Tab.Glycomet-GP 1   1 - 0 - 1').medicines
    expect(m.issues).toEqual([])
  })
})

describe('strength grounding (live run regression)', () => {
  const source = 'Cap. Pan D   OD  empty stomach\nTab. Telma 40mg 1-0-0\nT. Vitamin D3 60K'
  it('flags a strength the model invented', () => {
    const [m] = parseModelOutput(output([row({ name: 'Pan D', strength: '1', frequency_text: 'OD' })]), source).medicines
    expect(m.issues.join(' ')).toMatch(/Strength "1" doesn't appear next to Pan D/)
  })
  it('accepts strengths written with or without a unit', () => {
    const meds = parseModelOutput(output([row({ name: 'Telma', strength: '40 mg', frequency_text: '1-0-0' }), row({ name: 'Vitamin D3', strength: '60K', frequency_text: '' })]), source).medicines
    expect(meds.flatMap((m) => m.issues).filter((i) => i.startsWith('Strength'))).toEqual([])
  })
})

describe('cleanName (real photo regression)', () => {
  it.each([
    ['T. Vite 0-1-0', '0-1-0', 'Vite'],
    ['T. zul (ad) 1-0-0', '1-0-0', 'zul (ad)'],
    ['Tab. Telma', '1-0-0', 'Telma'],
    ['Glycomet GP', '1-0-1', 'Glycomet GP'],
    ['BPO', '', 'BPO'],
  ])('%s -> %s', (name, freq, expected) => {
    expect(cleanName(name, freq)).toBe(expected)
  })
})

describe('prompt hygiene', () => {
  it('contains no real medicine names the model could copy into an answer', async () => {
    const { SYSTEM_PROMPT, TRANSCRIBE_PROMPT } = await import('./extract.ts')
    for (const brand of ['telma', 'glycomet', 'dolo', 'warm water', 'metformin']) {
      expect(SYSTEM_PROMPT.toLowerCase()).not.toContain(brand)
      expect(TRANSCRIBE_PROMPT.toLowerCase()).not.toContain(brand)
    }
  })
})

describe('dose anchoring (real handwritten photo regression)', () => {
  // Transcript Gemma produced from the real photo; Vit C is 0-1-0, Zinc's dose is on the line below it.
  const transcript = "SIB slu-\nAde\nS' Acu (G I)\nT. Vite 0-1-0\n+ Chomi\nluu\nT. zul (ad)\n1-0-0\nButonim 0.05 ointment\nBPO 2.5% gel."

  it('fixes the model pairing Vit C with Zinc\'s dose', () => {
    const [m] = parseModelOutput(output([row({ name: 'Vite 0-1-0', strength: null, frequency_text: '1-0-0' })]), transcript).medicines
    expect(m.name).toBe('Vite')
    expect(m.doses).toEqual({ morning: null, afternoon: '1', evening: null, night: null })
    expect(m.issues.join(' ')).toMatch(/"0-1-0" is written next to it/)
  })

  it('picks up a dose written on the line below the medicine', () => {
    const [m] = parseModelOutput(output([row({ name: 'zul (ad)', strength: null, frequency_text: null })]), transcript).medicines
    expect(m.doses.morning).toBe('1')
    expect(m.issues.join(' ')).toMatch(/"1-0-0" is written next to this medicine/)
  })

  it('drops a dose pattern the model put in the strength field', () => {
    const [m] = parseModelOutput(output([row({ name: 'zul (ad)', strength: '1-0-0', frequency_text: null })]), transcript).medicines
    expect(m.strength).toBe('')
  })

  it('leaves medicines with no written dose for the person', () => {
    const [m] = parseModelOutput(output([row({ name: 'BPO', strength: '2.5%', frequency_text: null })]), transcript).medicines
    expect(Object.values(m.doses).every((v) => v === null)).toBe(true)
  })

  it('does not anchor from a line that names several doses', () => {
    const line = 'Telma AM 1-0-0. Glimisave M1 1-0-1 khane se pehle.'
    const [m] = parseModelOutput(output([row({ name: 'Glimisave M1', strength: null, frequency_text: '1-0-1' })]), line).medicines
    expect(m.doses).toEqual({ morning: '1', afternoon: null, evening: null, night: '1' })
    expect(m.issues).toEqual([])
  })
})

describe('anchoring noise', () => {
  it('does not flag when the model copied the same dose with extra words', () => {
    const [m] = parseModelOutput(output([row({ name: 'Zerodol SP', strength: null, frequency_text: '1-0-1 after food x 5 days' })]), 'Tab Zerodol SP   1-0-1  after food  x 5 days').medicines
    expect(m.frequencyText).toBe('1-0-1')
    expect(m.issues).toEqual([])
  })
})

describe('cleanStrength', () => {
  it.each([
    ['0.05 ointment', '0.05'],
    ['2.5%', '2.5%'],
    ['500 mg', '500 mg'],
    ['60K', '60K'],
    ['D', ''],
    ['1-0-0', ''],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(cleanStrength(input)).toBe(expected)
  })
})

describe('duration', () => {
  it('drops the leading "x" from "x 1 month"', () => {
    const [m] = parseModelOutput(output([row({ duration_text: 'x 1 month' })])).medicines
    expect(m.duration).toBe('1 month')
  })
})
