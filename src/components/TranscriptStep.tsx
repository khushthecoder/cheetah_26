interface Props {
  photoUrls: string[]
  text: string
  onText: (text: string) => void
  lastRun: { ms: number; model: string } | null
  onBack: () => void
  onContinue: () => void
}

/**
 * Between the photo and the medicine list: the person sees what the model read and fixes it.
 * Everything after this step is checked against this text, so a correction here flows through.
 */
export function TranscriptStep({ photoUrls, text, onText, lastRun, onBack, onContinue }: Props) {
  const lines = text.split('\n').filter((l) => l.trim()).length
  return (
    <div className="review-layout">
      <aside className="source panel">
        <h3>The photo</h3>
        {photoUrls.map((u, i) => (
          <img key={u.slice(-40)} src={u} alt={`Prescription page ${i + 1}`} className="source-img" />
        ))}
      </aside>

      <section className="panel">
        <h2>Is this what the doctor wrote?</h2>
        <p className="muted">
          This is what the AI read from the photo. Fix any word that's wrong, add anything it missed, and keep{' '}
          <b>one medicine per line, with its dose on the same line</b> (e.g. <span className="mono">Vit C 0-1-0</span>).
        </p>
        <textarea value={text} onChange={(e) => onText(e.target.value)} rows={Math.max(8, lines + 3)} aria-label="What the AI read" />
        {lastRun && (
          <p className="muted small">
            Read by <span className="mono">{lastRun.model}</span> on this laptop in {(lastRun.ms / 1000).toFixed(1)}s. Handwriting is
            hard — expect to fix a few words.
          </p>
        )}
        <div className="review-foot">
          <button className="btn ghost" onClick={onBack}>
            ← Retake / rotate photo
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={onContinue}>
            Looks right — find the medicines →
          </button>
        </div>
      </section>
    </div>
  )
}
