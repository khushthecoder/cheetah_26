import { useState } from 'react'
import { asNeededTiming, dueDaily, toWhatsAppText } from '../lib/share.ts'
import { FOOD_LABELS, SLOT_LABELS, SLOTS, type Medicine, type Slot } from '../lib/types.ts'

interface Props {
  patientName: string
  medicines: Medicine[]
  onEdit: () => void
  onStartOver: () => void
}

const SLOT_ICONS: Record<Slot, string> = { morning: '🌅', afternoon: '☀️', evening: '🌇', night: '🌙' }

export function DoseCardView({ patientName, medicines, onEdit, onStartOver }: Props) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const asNeeded = medicines.filter((m) => m.asNeeded)
  const limited = medicines.filter((m) => m.duration && !/continue|cont\.?|ongoing|long/i.test(m.duration))
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

  async function copy() {
    try {
      await navigator.clipboard.writeText(toWhatsAppText(patientName, medicines))
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
    setTimeout(() => setCopied('idle'), 2500)
  }

  return (
    <section className="card-wrap">
      <div className="card-actions no-print">
        <button className="btn ghost" onClick={onEdit}>
          ← Edit
        </button>
        <div className="foot-right">
          <button className="btn ghost" onClick={copy}>
            {copied === 'ok' ? 'Copied ✓' : copied === 'fail' ? 'Copy failed' : 'Copy for WhatsApp'}
          </button>
          <button className="btn primary" onClick={() => window.print()}>
            Print card
          </button>
        </div>
      </div>

      <article className="dosecard" aria-label="Medicine card">
        <header className="dc-head">
          <h2>{patientName ? `${patientName}'s medicines` : 'Daily medicines'}</h2>
          <p>
            रोज़ की दवाइयाँ · Updated {today}
          </p>
        </header>

        <div className="dc-grid">
          {SLOTS.map((slot) => {
            const due = dueDaily(medicines, slot)
            return (
              <div key={slot} className={`dc-slot slot-${slot} ${due.length ? '' : 'empty'}`}>
                <div className="dc-slot-head">
                  <span className="dc-icon" aria-hidden>
                    {SLOT_ICONS[slot]}
                  </span>
                  <div>
                    <strong>{SLOT_LABELS[slot].hi}</strong>
                    <span>
                      {SLOT_LABELS[slot].en} · ~{SLOT_LABELS[slot].time}
                    </span>
                  </div>
                </div>
                {due.length === 0 ? (
                  <p className="dc-none">No medicine</p>
                ) : (
                  <ul>
                    {due.map((m) => (
                      <li key={m.id}>
                        <span className="dc-qty">{m.doses[slot]}</span>
                        <span className="dc-name">
                          {m.name} {m.strength && <small>{m.strength}</small>}
                          {m.food !== 'any' && (
                            <em className={`food food-${m.food}`}>
                              {FOOD_LABELS[m.food].hi} · {FOOD_LABELS[m.food].en}
                            </em>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>

        {(asNeeded.length > 0 || limited.length > 0) && (
          <div className="dc-extra">
            {asNeeded.length > 0 && (
              <div>
                <h3>Only when needed · ज़रूरत पड़ने पर</h3>
                <ul>
                  {asNeeded.map((m) => (
                    <li key={m.id}>
                      <b>{m.name}</b> {m.strength} {asNeededTiming(m) && `(${asNeededTiming(m)})`} {m.instructions && `— ${m.instructions}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {limited.length > 0 && (
              <div>
                <h3>Stop after · इतने दिन तक</h3>
                <ul>
                  {limited.map((m) => (
                    <li key={m.id}>
                      <b>{m.name}</b> — {m.duration}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <footer className="dc-foot">Checked against the doctor's prescription. If anything looks different, ask the doctor or pharmacist.</footer>
      </article>

      <p className="center no-print">
        <button className="btn link" onClick={onStartOver}>
          Start a new prescription
        </button>
      </p>
    </section>
  )
}
