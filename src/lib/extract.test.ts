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
  model_slots: ['morning'],
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

  it('prefers the deterministic rule over a wrong model guess', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: '1-0-1', model_slots: ['afternoon'] })])).medicines
    expect(m.doses.morning).toBe('1')
    expect(m.doses.night).toBe('1')
    expect(m.doses.afternoon).toBeNull()
  })

  it('falls back to the model guess and flags it when the dosing text is unknown', () => {
    const [m] = parseModelOutput(output([row({ frequency_text: 'as directed', model_slots: ['night'] })])).medicines
    expect(m.interpretedBy).toBe('model')
    expect(m.doses.night).toBe('1')
    expect(m.issues.join(' ')).toMatch(/AI's guess/)
  })

  it('flags low-confidence names', () => {
    const [m] = parseModelOutput(output([row({ confidence: 'low' })])).medicines
    expect(m.issues.join(' ')).toMatch(/hard to read/)
  })

  it('tolerates code fences, nulls and junk confidence values', () => {
    const content = '```json\n' + output([row({ strength: null, form: undefined, confidence: 'very sure', model_slots: null })]) + '\n```'
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

  it('flags disagreement between the rule decoder and the model', () => {
    const [m] = parseModelOutput(output([row({ model_slots: ['night'] })])).medicines
    expect(m.doses.morning).toBe('1')
    expect(m.issues.join(' ')).toMatch(/read the timing differently/)
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
    const [m] = parseModelOutput(output([row({ name: 'Glycomet GP', frequency_text: '1-0-1', model_slots: ['morning', 'night'] })]), 'Tab.Glycomet-GP 1   1 - 0 - 1').medicines
    expect(m.issues).toEqual([])
  })
})
