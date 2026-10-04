import { emptyDoses, FOOD_LABELS, SLOT_LABELS, SLOTS, type Food, type Medicine, type Slot } from '../lib/types.ts'

interface Props {
  patientName: string
  onPatientName: (name: string) => void
  medicines: Medicine[]
  onChange: (medicines: Medicine[]) => void
  unreadable: string[]
  photoUrls: string[]
  sourceText: string
  lastRun: { ms: number; model: string } | null
  onBack: () => void
  onConfirm: () => void
}

const QTY_CYCLE = [null, '1', '½', '2'] as const

export function ReviewStep({ patientName, onPatientName, medicines, onChange, unreadable, photoUrls, sourceText, lastRun, onBack, onConfirm }: Props) {
  const checkedCount = medicines.filter((m) => m.checked).length
  const allChecked = medicines.length > 0 && checkedCount === medicines.length
  const missingTimes = medicines.filter((m) => !m.asNeeded && SLOTS.every((s) => !m.doses[s]))

  const update = (id: string, patch: Partial<Medicine>) =>
    onChange(medicines.map((m) => (m.id === id ? { ...m, ...patch, checked: patch.checked ?? false } : m)))

  function cycleSlot(m: Medicine, slot: Slot) {
    const i = QTY_CYCLE.indexOf(m.doses[slot] as (typeof QTY_CYCLE)[number])
    const next = QTY_CYCLE[(i + 1) % QTY_CYCLE.length]
    update(m.id, { doses: { ...m.doses, [slot]: next }, interpretedBy: 'manual' })
  }

  function addMedicine() {
    onChange([
      ...medicines,
      {
        id: `manual-${Date.now()}`,
        name: '',
        strength: '',
        form: '',
        doses: emptyDoses(),
        asNeeded: false,
        food: 'any',
        duration: '',
        frequencyText: '',
        instructions: '',
        confidence: 'high',
        interpretedBy: 'manual',
        issues: [],
        checked: false,
      },
    ])
  }

  return (
    <div className="review-layout">
      <aside className="source panel">
        <h3>The prescription</h3>
        {photoUrls.length > 0 ? (
          photoUrls.map((u, i) => <img key={u} src={u} alt={`Prescription page ${i + 1}`} className="source-img" />)
        ) : (
          <pre className="source-text">{sourceText}</pre>
        )}
        {lastRun && (
          <p className="muted small">
            Read by <span className="mono">{lastRun.model}</span> on this laptop in {(lastRun.ms / 1000).toFixed(1)}s.
          </p>
        )}
      </aside>

      <section className="panel review">
        <div className="review-head">
          <div>
            <h2>Check each medicine</h2>
            <p className="muted">Compare every row with the paper. Tap a time to change the dose. Tick when it matches.</p>
          </div>
          <label className="field patient">
            <span>Card is for</span>
            <input value={patientName} onChange={(e) => onPatientName(e.target.value)} placeholder="e.g. Maa" />
          </label>
        </div>

        {unreadable.length > 0 && (
          <div className="alert warn">
            <strong>Couldn't read:</strong> {unreadable.join(', ')}. Add these by hand if they are medicines.
          </div>
        )}

        <ul className="med-list">
          {medicines.map((m) => (
            <li key={m.id} className={`med ${m.checked ? 'is-checked' : ''} ${m.issues.length && !m.checked ? 'needs-look' : ''}`}>
              <div className="med-top">
                <input
                  className="med-name"
                  value={m.name}
                  onChange={(e) => update(m.id, { name: e.target.value })}
                  placeholder="Medicine name"
                  aria-label="Medicine name"
                />
                <input
                  className="med-strength"
                  value={m.strength}
                  onChange={(e) => update(m.id, { strength: e.target.value })}
                  placeholder="Strength"
                  aria-label="Strength"
                />
                <button className="icon-btn" aria-label={`Remove ${m.name || 'medicine'}`} onClick={() => onChange(medicines.filter((x) => x.id !== m.id))}>
                  🗑
                </button>
              </div>

              {m.frequencyText && (
                <p className="as-written">
                  Written as <span className="mono">{m.frequencyText}</span>
                  {m.interpretedBy === 'rule' && <span className="tag">decoded by rules</span>}
                </p>
              )}

              <div className="slots" role="group" aria-label="When to take">
                {SLOTS.map((slot) => (
                  <button
                    key={slot}
                    className={`slot ${m.doses[slot] ? 'on' : ''}`}
                    onClick={() => cycleSlot(m, slot)}
                    aria-pressed={!!m.doses[slot]}
                    aria-label={`${SLOT_LABELS[slot].en}: ${m.doses[slot] ?? 'none'}`}
                  >
                    <span className="slot-name">{SLOT_LABELS[slot].en}</span>
                    <span className="slot-qty">{m.doses[slot] ?? '—'}</span>
                  </button>
                ))}
                <button className={`slot sos ${m.asNeeded ? 'on' : ''}`} aria-pressed={m.asNeeded} onClick={() => update(m.id, { asNeeded: !m.asNeeded })}>
                  <span className="slot-name">When needed</span>
                  <span className="slot-qty">{m.asNeeded ? 'SOS' : '—'}</span>
                </button>
              </div>

              <div className="med-meta">
                <label className="field">
                  <span>Food</span>
                  <select value={m.food} onChange={(e) => update(m.id, { food: e.target.value as Food })}>
                    {(Object.keys(FOOD_LABELS) as Food[]).map((f) => (
                      <option key={f} value={f}>
                        {f === 'any' ? 'Not specified' : FOOD_LABELS[f].en}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>For how long</span>
                  <input value={m.duration} onChange={(e) => update(m.id, { duration: e.target.value })} placeholder="e.g. 5 days / continue" />
                </label>
                <label className="field grow">
                  <span>Note</span>
                  <input value={m.instructions} onChange={(e) => update(m.id, { instructions: e.target.value })} placeholder="e.g. for fever" />
                </label>
              </div>

              {m.issues.length > 0 && !m.checked && (
                <ul className="issues">
                  {m.issues.map((issue) => (
                    <li key={issue}>⚠️ {issue}</li>
                  ))}
                </ul>
              )}

              <label className="check">
                <input
                  type="checkbox"
                  checked={m.checked}
                  disabled={!m.name.trim()}
                  onChange={(e) => update(m.id, { checked: e.target.checked })}
                />
                Matches the prescription
              </label>
            </li>
          ))}
        </ul>

        <button className="btn ghost add-med" onClick={addMedicine}>
          + Add a medicine the AI missed
        </button>

        <div className="review-foot">
          <button className="btn ghost" onClick={onBack}>
            ← Back
          </button>
          <div className="foot-right">
            <span className="muted">
              {checkedCount} of {medicines.length} checked
              {missingTimes.length > 0 && ` · ${missingTimes.length} without a time`}
            </span>
            <button className="btn primary" disabled={!allChecked || missingTimes.length > 0} onClick={onConfirm}>
              Make the card →
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
