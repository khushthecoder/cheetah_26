import { FOOD_LABELS, SLOT_LABELS, SLOTS, type Medicine, type Slot } from './types.ts'

const label = (m: Medicine) => [m.name, m.strength].filter(Boolean).join(' ')

/** Medicines taken every day in this slot. Conditional (as-needed) medicines never appear here. */
export const dueDaily = (medicines: Medicine[], slot: Slot) => medicines.filter((m) => !m.asNeeded && m.doses[slot])

/** "at night", "morning / night" — the written time for an as-needed medicine, if any. */
export function asNeededTiming(m: Medicine): string {
  const slots = SLOTS.filter((s) => m.doses[s])
  return slots.length ? slots.map((s) => SLOT_LABELS[s].en.toLowerCase()).join(' / ') : ''
}

const sosLine = (m: Medicine) => [label(m), asNeededTiming(m) && `(${asNeededTiming(m)})`, m.instructions && `— ${m.instructions}`].filter(Boolean).join(' ')

/** Plain-text version of the card, formatted for pasting into a WhatsApp family group. */

export function toWhatsAppText(patientName: string, medicines: Medicine[]): string {
  const lines: string[] = [`*${patientName ? `${patientName}'s medicines` : 'Medicines'}* 💊`, '']
  for (const slot of SLOTS) {
    const due = dueDaily(medicines, slot)
    if (!due.length) continue
    lines.push(`*${SLOT_LABELS[slot].en} / ${SLOT_LABELS[slot].hi}*`)
    for (const m of due) {
      const food = FOOD_LABELS[m.food].en
      lines.push(`• ${label(m)} — ${m.doses[slot]}${food ? ` (${food.toLowerCase()})` : ''}`)
    }
    lines.push('')
  }
  const sos = medicines.filter((m) => m.asNeeded)
  if (sos.length) {
    lines.push('*Only when needed*')
    for (const m of sos) lines.push(`• ${sosLine(m)}`)
    lines.push('')
  }
  const limited = medicines.filter((m) => m.duration && !/continue|cont\.?|ongoing|long/i.test(m.duration))
  if (limited.length) {
    lines.push('*For a limited time*')
    for (const m of limited) lines.push(`• ${label(m)} — ${m.duration}`)
    lines.push('')
  }
  lines.push('_Checked against the prescription. Made with DoseCard._')
  return lines.join('\n').trim()
}
