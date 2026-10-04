import { useCallback, useEffect, useRef, useState } from 'react'
import { DoseCardView } from './components/DoseCardView.tsx'
import { InputStep, type InputPayload } from './components/InputStep.tsx'
import { ReviewStep } from './components/ReviewStep.tsx'
import { TranscriptStep } from './components/TranscriptStep.tsx'
import { ExtractionError } from './lib/extract.ts'
import { checkModel, DEFAULT_MODEL, extractPrescription, OllamaError, transcribePhoto, type ModelStatus } from './lib/ollama.ts'
import { clearCard, loadCard, saveCard } from './lib/storage.ts'
import type { Medicine } from './lib/types.ts'

type Step = 'input' | 'reading' | 'transcript' | 'review' | 'card'

export function App() {
  const saved = useRef(loadCard()).current
  const [step, setStep] = useState<Step>(saved ? 'card' : 'input')
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [patientName, setPatientName] = useState(saved?.patientName ?? '')
  const [medicines, setMedicines] = useState<Medicine[]>(saved?.medicines ?? [])
  const [unreadable, setUnreadable] = useState<string[]>([])
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [sourceText, setSourceText] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [readingLabel, setReadingLabel] = useState('Reading the prescription…')
  const [lastRun, setLastRun] = useState<{ ms: number; model: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshStatus = useCallback(() => {
    checkModel().then(setStatus)
  }, [])

  useEffect(() => {
    refreshStatus()
    const id = setInterval(refreshStatus, 15_000)
    return () => clearInterval(id)
  }, [refreshStatus])

  useEffect(() => {
    if (step !== 'reading') return
    const started = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250)
    return () => clearInterval(id)
  }, [step])

  /** Runs one model call with the shared loading / cancel / error handling. Returns null if it failed. */
  async function run<T>(label: string, fn: (signal: AbortSignal) => Promise<T>, fallback: Step): Promise<T | null> {
    setError(null)
    setElapsed(0)
    setReadingLabel(label)
    setStep('reading')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      return await fn(controller.signal)
    } catch (err) {
      if (!(err instanceof OllamaError && err.kind === 'aborted')) {
        const message = err instanceof OllamaError || err instanceof ExtractionError ? err.message : `Something went wrong: ${(err as Error).message}`
        setError(message)
        refreshStatus()
      }
      setStep(fallback)
      return null
    } finally {
      abortRef.current = null
    }
  }

  async function findMedicines(text: string, fallback: Step) {
    const result = await run('Finding the medicines…', (signal) => extractPrescription(text, { signal }), fallback)
    if (!result) return
    setPatientName(result.extraction.patientName)
    setMedicines(result.extraction.medicines)
    setUnreadable(result.extraction.unreadable)
    setLastRun({ ms: result.durationMs, model: result.model })
    setStep('review')
  }

  async function handleRead(payload: InputPayload) {
    setPhotoUrls(payload.photoUrls)
    if (payload.images.length === 0) {
      setSourceText(payload.text)
      await findMedicines(payload.text, 'input')
      return
    }
    // Photos: transcribe first, let the person correct the reading, then structure the corrected text.
    const result = await run('Reading the handwriting…', (signal) => transcribePhoto(payload.images, { signal }), 'input')
    if (!result) return
    setSourceText([result.text, payload.text.trim()].filter(Boolean).join('\n'))
    setLastRun({ ms: result.durationMs, model: result.model })
    setStep('transcript')
  }

  function handleConfirm() {
    saveCard({ patientName, medicines, savedAt: new Date().toISOString() })
    setStep('card')
  }

  function startOver() {
    clearCard()
    setMedicines([])
    setPatientName('')
    setUnreadable([])
    setPhotoUrls([])
    setSourceText('')
    setError(null)
    setStep('input')
  }

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            💊
          </span>
          <div>
            <h1>DoseCard</h1>
            <p className="tagline">Prescription in. A medicine card your family can follow out.</p>
          </div>
        </div>
        <StatusPill status={status} />
      </header>

      <Stepper step={step} />

      <main>
        {step === 'input' && <InputStep status={status} error={error} onSubmit={handleRead} />}
        {step === 'reading' && (
          <section className="panel reading" aria-live="polite">
            <div className="pulse" aria-hidden />
            <h2>{readingLabel}</h2>
            <p className="muted">
              {DEFAULT_MODEL} is running on this laptop. Nothing is being uploaded.
              <br />
              <span className="mono">{elapsed}s</span> {elapsed > 40 && '— photos take longer on 8 GB machines, hang on.'}
            </p>
            <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          </section>
        )}
        {step === 'transcript' && (
          <TranscriptStep
            photoUrls={photoUrls}
            text={sourceText}
            onText={setSourceText}
            lastRun={lastRun}
            onBack={() => setStep('input')}
            onContinue={() => findMedicines(sourceText, 'transcript')}
          />
        )}
        {step === 'review' && (
          <ReviewStep
            patientName={patientName}
            onPatientName={setPatientName}
            medicines={medicines}
            onChange={setMedicines}
            unreadable={unreadable}
            photoUrls={photoUrls}
            sourceText={sourceText}
            lastRun={lastRun}
            onBack={() => setStep(photoUrls.length ? 'transcript' : 'input')}
            onConfirm={handleConfirm}
          />
        )}
        {step === 'card' && (
          <DoseCardView patientName={patientName} medicines={medicines} onEdit={() => setStep('review')} onStartOver={startOver} />
        )}
      </main>

      <footer className="footer no-print">
        DoseCard reads what the doctor wrote. It does not give medical advice — always check with the doctor or pharmacist.
      </footer>
    </div>
  )
}

function StatusPill({ status }: { status: ModelStatus | null }) {
  if (!status) return <span className="pill">Checking local model…</span>
  if (!status.online) return <span className="pill bad">Ollama offline</span>
  if (!status.hasModel) return <span className="pill warn">Model not installed</span>
  return (
    <span className="pill ok" title="Inference runs on this machine via Ollama">
      <span className="dot" /> {status.model} · on-device
    </span>
  )
}

const STEPS: { key: Step[]; label: string }[] = [
  { key: ['input', 'reading', 'transcript'], label: 'Add prescription' },
  { key: ['review'], label: 'Check each medicine' },
  { key: ['card'], label: 'Print / share card' },
]

function Stepper({ step }: { step: Step }) {
  const active = STEPS.findIndex((s) => s.key.includes(step))
  return (
    <ol className="stepper no-print" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.label} className={i === active ? 'active' : i < active ? 'done' : ''} aria-current={i === active ? 'step' : undefined}>
          <span className="num">{i < active ? '✓' : i + 1}</span>
          {s.label}
        </li>
      ))}
    </ol>
  )
}
