import { emptyDoses, type Food, type Slot, type SlotDoses } from './types.ts'

/**
 * Deterministic interpreter for the shorthand Indian doctors write on prescriptions.
 *
 * The language model only *reads* the prescription and copies the dosing text verbatim.
 * Turning "1-0-1" or "BD" into an actual schedule is done here, by plain code, because
 * a 2B-parameter model guessing at medicine timings is not acceptable.
 */

export interface FrequencyResult {
  doses: SlotDoses
  asNeeded: boolean
  /** Human-readable caveats, e.g. "Once a day, but the time isn't written". */
  notes: string[]
}

const QTY = String.raw`(?:\d+(?:\.\d+)?|½|¼|¾|\d\/\d)`
// 1-0-1, 1 0 1, 1/0/1 (3 slots) and 1-0-0-1 (4 slots).
// The separator must be the same throughout (\2) and a quantity can't be glued to letters or digits,
// so "M1 1-0-1" and "Telma 40 1-0-0" only match the real "1-0-1" / "1-0-0".
const SLOT_PATTERN = new RegExp(
  String.raw`(?:^|[^\da-z/.½¼¾])(${QTY})\s*([-/ ])\s*(${QTY})\s*\2\s*(${QTY})(?:\s*\2\s*(${QTY}))?(?![\d/.a-z½¼¾])`,
  'i',
)
/** More than this many units in one slot is almost certainly a misread (e.g. a strength), not a dose. */
const MAX_UNITS_PER_SLOT = 4

function qtyValue(q: string): number {
  if (q === '½') return 0.5
  if (q === '¼') return 0.25
  if (q === '¾') return 0.75
  const frac = q.match(/^(\d)\/(\d)$/)
  if (frac) return Number(frac[1]) / Number(frac[2])
  return Number(q)
}

function normalizeQty(raw: string): string | null {
  const q = raw.trim()
  if (q === '0' || q === '0.0') return null
  if (q === '0.5' || q === '1/2') return '½'
  if (q === '0.25' || q === '1/4') return '¼'
  if (q === '0.75' || q === '3/4') return '¾'
  if (q === '1.5') return '1½'
  return q
}

function withSlots(slots: Slot[], qty = '1'): SlotDoses {
  const doses = emptyDoses()
  for (const s of slots) doses[s] = qty
  return doses
}

const has = (text: string, ...patterns: RegExp[]) => patterns.some((p) => p.test(text))

/** Returns null when the text cannot be interpreted with confidence. */
export function interpretFrequency(input: string): FrequencyResult | null {
  const text = ` ${input
    .toLowerCase()
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()} `
  if (!text.trim()) return null

  // Weekly / alternate-day schedules don't fit a daily card — make the human decide.
  if (has(text, /\bweekly\b/, /\bonce a week\b/, /\balternate day/, /\bevery other day\b/, /\b(mon|tue|wed|thu|fri|sat|sun)day\b/)) {
    return null
  }

  const asNeeded = has(
    text,
    /\bsos\b/,
    /\bprn\b/,
    /\bas (and when )?needed\b/,
    /\bif (needed|required)\b/,
    /\bwhen required\b/,
    /\bin case of\b/,
    /\bonly if\b/,
    /\bonly when\b/,
    // Any written condition ("if itching", "agar dard ho") means it is not a daily medicine.
    /\bif\b/,
    /\bagar\b/,
    /\bzar(u|oo|o)rat\b/,
  )

  const slotMatch = text.match(SLOT_PATTERN)
  if (slotMatch) {
    const [, a, , b, c, d] = slotMatch
    if ([a, b, c, d].some((q) => q !== undefined && !(qtyValue(q) <= MAX_UNITS_PER_SLOT))) return null
    const doses = emptyDoses()
    if (d !== undefined) {
      doses.morning = normalizeQty(a)
      doses.afternoon = normalizeQty(b)
      doses.evening = normalizeQty(c)
      doses.night = normalizeQty(d)
    } else {
      // Three-slot convention: morning - afternoon - night
      doses.morning = normalizeQty(a)
      doses.afternoon = normalizeQty(b)
      doses.night = normalizeQty(c)
    }
    if (Object.values(doses).every((v) => v === null)) return null
    return { doses, asNeeded, notes: [] }
  }

  if (has(text, /\bqid\b/, /\bqds\b/, /\bfour times\b/, /\b4 times\b/)) {
    return { doses: withSlots(['morning', 'afternoon', 'evening', 'night']), asNeeded, notes: [] }
  }
  if (has(text, /\btds\b/, /\btid\b/, /\bthrice\b/, /\bthree times\b/, /\b3 times\b/)) {
    return { doses: withSlots(['morning', 'afternoon', 'night']), asNeeded, notes: [] }
  }
  if (has(text, /\bbd\b/, /\bbid\b/, /\btwice\b/, /\btwo times\b/, /\b2 times\b/)) {
    return { doses: withSlots(['morning', 'night']), asNeeded, notes: [] }
  }

  // Explicit times of day ("morning and night", "after lunch", "HS")
  const slots: Slot[] = []
  if (has(text, /\bmorning\b/, /\bbreakfast\b/, /\bsubah\b/, /\bsuba\b/, /\bam\b/)) slots.push('morning')
  if (has(text, /\bafternoon\b/, /\blunch\b/, /\bnoon\b/, /\bdopahar\b/)) slots.push('afternoon')
  if (has(text, /\bevening\b/, /\bshaam\b/, /\bsham\b/)) slots.push('evening')
  if (has(text, /\bnight\b/, /\bbedtime\b/, /\bbed time\b/, /\bhs\b/, /\bdinner\b/, /\braat\b/, /\bpm\b/)) slots.push('night')
  if (slots.length > 0) return { doses: withSlots(slots), asNeeded, notes: [] }

  if (has(text, /\bod\b/, /\bqd\b/, /\bonce\b/, /\bdaily\b/, /\bonce a day\b/, /\b1 time\b/)) {
    // "Once a day" says how often, not when. We don't pick a time on the doctor's behalf.
    return {
      doses: emptyDoses(),
      asNeeded,
      notes: ['Once a day, but the time isn\'t written. Tap the time the doctor told you.'],
    }
  }

  if (asNeeded) return { doses: emptyDoses(), asNeeded: true, notes: [] }

  return null
}

export function interpretFood(input: string): Food {
  const text = ` ${input.toLowerCase()} `
  if (has(text, /\bbefore (food|meal|breakfast|lunch|dinner|eating)/, /\bempty stomach\b/, /\bac\b/, /\bkhali pet\b/, /\bkhane se pehle\b/)) return 'before'
  if (has(text, /\bafter (food|meal|meals|breakfast|lunch|dinner|eating)/, /\bpc\b/, /\bkhane ke baad\b/)) return 'after'
  if (has(text, /\bwith (food|meal|meals|milk)/)) return 'with'
  return 'any'
}
