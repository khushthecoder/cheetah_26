import { MODEL_JSON_SCHEMA, MODEL_OPTIONS, parseModelOutput, SYSTEM_PROMPT, TRANSCRIBE_OPTIONS, TRANSCRIBE_PROMPT } from './extract.ts'
import type { Extraction } from './types.ts'

export const DEFAULT_MODEL = (import.meta.env?.VITE_MODEL as string | undefined) || 'gemma4:e2b-it-qat'
/** Same-origin path proxied to Ollama by Vite (see vite.config.ts). */
export const DEFAULT_BASE_URL = '/ollama'
const TIMEOUT_MS = 180_000

export class OllamaError extends Error {
  readonly kind: 'offline' | 'missing-model' | 'timeout' | 'server' | 'aborted'
  constructor(message: string, kind: 'offline' | 'missing-model' | 'timeout' | 'server' | 'aborted') {
    super(message)
    this.kind = kind
  }
}

export interface ModelStatus {
  online: boolean
  hasModel: boolean
  model: string
}

export async function checkModel(model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL): Promise<ModelStatus> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`)
    if (!res.ok) return { online: false, hasModel: false, model }
    const data = (await res.json()) as { models?: { name: string }[] }
    const names = (data.models ?? []).map((m) => m.name)
    const hasModel = names.includes(model) || names.includes(`${model}:latest`)
    return { online: true, hasModel, model }
  } catch {
    return { online: false, hasModel: false, model }
  }
}

export interface CallOptions {
  model?: string
  baseUrl?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** One non-streaming /api/chat call with timeout, cancellation and readable errors. */
async function chat(body: Record<string, unknown>, opts: CallOptions): Promise<{ content: string; model: string; durationMs: number }> {
  const model = opts.model ?? DEFAULT_MODEL
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const doFetch = opts.fetchImpl ?? fetch

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.timeoutMs ?? TIMEOUT_MS)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort)

  const started = performance.now()
  try {
    let res: Response
    try {
      res = await doFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model, stream: false, think: false, keep_alive: '30m', ...body }),
      })
    } catch (err) {
      if (timedOut) throw new OllamaError('The model took too long. Try a closer photo of just the prescription.', 'timeout')
      if (opts.signal?.aborted) throw new OllamaError('Cancelled.', 'aborted')
      throw new OllamaError(`Can't reach Ollama. Is it running? (${(err as Error).message})`, 'offline')
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 404 || /not found/i.test(detail)) {
        throw new OllamaError(`Model "${model}" isn't installed. Run: ollama pull ${model}`, 'missing-model')
      }
      if (res.status === 502 || res.status === 504) {
        throw new OllamaError("Can't reach Ollama. Start it with: ollama serve", 'offline')
      }
      throw new OllamaError(`Ollama error ${res.status}: ${detail.slice(0, 200)}`, 'server')
    }

    const data = (await res.json()) as { message?: { content?: string } }
    return { content: data.message?.content ?? '', model, durationMs: Math.round(performance.now() - started) }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

export interface TranscribeResult {
  text: string
  model: string
  durationMs: number
}

/**
 * Pass 1 for photos: plain-text transcription, one medicine per line. The person sees and can correct
 * this text before anything is structured. In testing on a real two-column handwritten prescription,
 * asking for JSON straight from the photo lost every dose; transcribing first kept them.
 */
export async function transcribePhoto(images: string[], opts: CallOptions = {}): Promise<TranscribeResult> {
  if (images.length === 0) throw new OllamaError('No photo to read.', 'server')
  const { content, model, durationMs } = await chat(
    { options: TRANSCRIBE_OPTIONS, messages: [{ role: 'user', content: TRANSCRIBE_PROMPT, images }] },
    opts,
  )
  // Drop any markdown/code-fence wrapping; keep the lines exactly as the model wrote them.
  const text = content.replace(/```[a-z]*\n?/gi, '').trim()
  return { text, model, durationMs }
}

export interface ExtractResult {
  extraction: Extraction
  model: string
  durationMs: number
}

/** Pass 2 (and the only pass for typed text): prescription text → validated medicines. */
export async function extractPrescription(text: string, opts: CallOptions = {}): Promise<ExtractResult> {
  const source = text.trim()
  const { content, model, durationMs } = await chat(
    {
      format: MODEL_JSON_SCHEMA,
      options: MODEL_OPTIONS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Read this prescription.\n\nPrescription text:\n"""\n${source.slice(0, 8000)}\n"""` },
      ],
    },
    opts,
  )
  // The text is always the full source here, so every row can be checked against it.
  return { extraction: parseModelOutput(content, source), model, durationMs }
}
