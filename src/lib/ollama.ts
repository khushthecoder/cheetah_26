import { MODEL_JSON_SCHEMA, parseModelOutput, SYSTEM_PROMPT } from './extract.ts'
import type { Extraction } from './types.ts'

export const DEFAULT_MODEL = (import.meta.env?.VITE_MODEL as string | undefined) || 'gemma4:e2b-it-qat'
/** Same-origin path proxied to Ollama by Vite (see vite.config.ts). */
export const DEFAULT_BASE_URL = '/ollama'
const TIMEOUT_MS = 180_000

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'missing-model' | 'timeout' | 'server' | 'aborted',
  ) {
    super(message)
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

export interface ExtractInput {
  text?: string
  /** Base64 image data without the `data:` prefix. */
  images?: string[]
}

export interface ExtractOptions {
  model?: string
  baseUrl?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface ExtractResult {
  extraction: Extraction
  model: string
  durationMs: number
}

export async function extractPrescription(input: ExtractInput, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const doFetch = opts.fetchImpl ?? fetch
  const text = input.text?.trim() ?? ''
  const images = input.images ?? []

  const userContent = [
    images.length ? `Read the prescription in the attached photo${images.length > 1 ? 's' : ''}.` : 'Read this prescription.',
    text ? `\n\nPrescription text:\n"""\n${text.slice(0, 8000)}\n"""` : '',
  ].join('')

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.timeoutMs ?? TIMEOUT_MS)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort)

  const started = performance.now()
  let res: Response
  try {
    res = await doFetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        keep_alive: '30m',
        format: MODEL_JSON_SCHEMA,
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent, ...(images.length ? { images } : {}) },
        ],
      }),
    })
  } catch (err) {
    if (timedOut) throw new OllamaError('The model took too long. Try a smaller photo or fewer pages.', 'timeout')
    if (opts.signal?.aborted) throw new OllamaError('Cancelled.', 'aborted')
    throw new OllamaError(`Can't reach Ollama. Is it running? (${(err as Error).message})`, 'offline')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
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
  const extraction = parseModelOutput(data.message?.content ?? '')
  return { extraction, model, durationMs: Math.round(performance.now() - started) }
}
