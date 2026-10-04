import { useRef, useState } from 'react'
import { fileToModelImage } from '../lib/image.ts'
import type { ModelStatus } from '../lib/ollama.ts'
import { SAMPLE_PRESCRIPTION } from '../lib/sample.ts'

export interface InputPayload {
  text: string
  images: string[]
  photoUrls: string[]
}

interface Props {
  status: ModelStatus | null
  error: string | null
  onSubmit: (payload: InputPayload) => void
}

const MAX_PHOTOS = 3

export function InputStep({ status, error, onSubmit }: Props) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<{ file: File; url: string }[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const ready = status?.online && status.hasModel
  const canSubmit = ready && !busy && (text.trim().length > 0 || files.length > 0)

  function addFiles(list: FileList | null) {
    if (!list) return
    const images = Array.from(list).filter((f) => f.type.startsWith('image/'))
    if (images.length < list.length) setLocalError('Only photos (JPG, PNG, HEIC) are supported.')
    else setLocalError(null)
    setFiles((prev) => [...prev, ...images.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_PHOTOS))
  }

  async function submit() {
    setBusy(true)
    setLocalError(null)
    try {
      const images = await Promise.all(files.map((f) => fileToModelImage(f.file)))
      onSubmit({ text, images, photoUrls: files.map((f) => f.url) })
    } catch (err) {
      setLocalError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2>What did the doctor write?</h2>
      <p className="muted">Take a photo of the prescription, or type / paste it. Both work.</p>

      {!ready && status && <SetupHelp status={status} />}
      {(error || localError) && (
        <div className="alert error" role="alert">
          {error ?? localError}
        </div>
      )}

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        {files.length === 0 ? (
          <>
            <span className="drop-icon" aria-hidden>
              📷
            </span>
            <strong>Drop a prescription photo</strong>
            <span className="muted">or click to choose · up to {MAX_PHOTOS} pages</span>
          </>
        ) : (
          <div className="thumbs" onClick={(e) => e.stopPropagation()}>
            {files.map((f, i) => (
              <figure key={f.url} className="thumb">
                <img src={f.url} alt={`Prescription page ${i + 1}`} />
                <button
                  className="thumb-x"
                  aria-label={`Remove page ${i + 1}`}
                  onClick={() => {
                    URL.revokeObjectURL(f.url)
                    setFiles(files.filter((_, j) => j !== i))
                  }}
                >
                  ×
                </button>
              </figure>
            ))}
            {files.length < MAX_PHOTOS && (
              <button className="thumb add" onClick={() => inputRef.current?.click()}>
                + page
              </button>
            )}
          </div>
        )}
      </div>

      <div className="or">
        <span>or type it</span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Tab. Telma 40   1-0-0   after breakfast\nTab. Glycomet GP 1   1-0-1   before food\n…'}
        rows={7}
        aria-label="Prescription text"
      />

      <div className="actions">
        <button className="btn link" onClick={() => setText(SAMPLE_PRESCRIPTION)}>
          Use a sample prescription
        </button>
        <button className="btn primary" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Preparing…' : 'Read prescription'}
        </button>
      </div>
      <p className="privacy-note">🔒 Read by an open-weight model on this computer. The photo never leaves it.</p>
    </section>
  )
}

function SetupHelp({ status }: { status: ModelStatus }) {
  return (
    <div className="alert warn">
      {!status.online ? (
        <>
          <strong>Ollama isn't running.</strong> Start it with <code>ollama serve</code> (or open the Ollama app).
        </>
      ) : (
        <>
          <strong>One-time setup:</strong> download the model with <code>ollama pull {status.model}</code> (~4 GB).
        </>
      )}
    </div>
  )
}
