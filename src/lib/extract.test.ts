import { describe, expect, it, vi } from 'vitest'
import { ExtractionError, parseModelOutput } from './extract.ts'
import { extractPrescription, OllamaError } from './ollama.ts'

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
    const result = await extractPrescription({ text: 'Tab Telma 40 1-0-0' }, { fetchImpl, baseUrl: 'http://x', model: 'm' })
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
  })

  it('attaches images when given', async () => {
    const fetchImpl = okFetch(output([row()]))
    await extractPrescription({ images: ['AAAA'] }, { fetchImpl, baseUrl: 'http://x' })
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.messages[1].images).toEqual(['AAAA'])
  })

  it('reports Ollama being offline', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(extractPrescription({ text: 'x' }, { fetchImpl })).rejects.toMatchObject({ kind: 'offline' })
  })

  it('reports a missing model with the pull command', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"model \\"m\\" not found"}', { status: 404 })) as unknown as typeof fetch
    await expect(extractPrescription({ text: 'x' }, { fetchImpl, model: 'm' })).rejects.toThrow(/ollama pull m/)
  })

  it('times out slow inference', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    ) as unknown as typeof fetch
    const err = await extractPrescription({ text: 'x' }, { fetchImpl, timeoutMs: 10 }).catch((e) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect(err.kind).toBe('timeout')
  })

  it('surfaces malformed model output as an ExtractionError', async () => {
    await expect(extractPrescription({ text: 'x' }, { fetchImpl: okFetch('not json') })).rejects.toBeInstanceOf(ExtractionError)
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

  it('flags dosing text the model invented', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: '1-0-1' })]), source).medicines
    expect(m.issues.join(' ')).toMatch(/Dosing "1-0-1" doesn't appear/)
  })

  it('skips grounding when there is no source text (photo input)', () => {
    const [m] = parseModelOutput(output([row({ name: 'Anything' })]), '').medicines
    expect(m.issues).toEqual([])
  })
})

describe('grounding matches whole words', () => {
  it('does not let "1-0-1" hide inside other numbers', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: '1-0-1' })]), 'Tab. Telma 40 1-0-0 x 10 days').medicines
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
