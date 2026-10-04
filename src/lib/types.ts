export const SLOTS = ['morning', 'afternoon', 'evening', 'night'] as const
export type Slot = (typeof SLOTS)[number]

export type Food = 'before' | 'after' | 'with' | 'any'
export type Confidence = 'high' | 'medium' | 'low'

/** How the dosing schedule was decided. Rules are preferred over the model. */
export type InterpretedBy = 'rule' | 'model' | 'manual' | 'none'

/** Quantity to take in each slot, e.g. "1" or "½". null = nothing in that slot. */
export type SlotDoses = Record<Slot, string | null>

export interface Medicine {
  id: string
  name: string
  strength: string
  form: string
  doses: SlotDoses
  asNeeded: boolean
  food: Food
  duration: string
  /** The dosing text exactly as written on the prescription, e.g. "1-0-1" or "BD". */
  frequencyText: string
  instructions: string
  confidence: Confidence
  interpretedBy: InterpretedBy
  /** Things the person must double-check before trusting this row. */
  issues: string[]
  /** Set by the human after comparing with the paper prescription. */
  checked: boolean
}

export interface Extraction {
  patientName: string
  doctorName: string
  medicines: Medicine[]
  /** Text the model saw but could not turn into a medicine. */
  unreadable: string[]
}

export const SLOT_LABELS: Record<Slot, { en: string; hi: string; time: string }> = {
  morning: { en: 'Morning', hi: 'सुबह', time: '8 AM' },
  afternoon: { en: 'Afternoon', hi: 'दोपहर', time: '1 PM' },
  evening: { en: 'Evening', hi: 'शाम', time: '6 PM' },
  night: { en: 'Night', hi: 'रात', time: '10 PM' },
}

export const FOOD_LABELS: Record<Food, { en: string; hi: string }> = {
  before: { en: 'Before food', hi: 'खाने से पहले' },
  after: { en: 'After food', hi: 'खाने के बाद' },
  with: { en: 'With food', hi: 'खाने के साथ' },
  any: { en: '', hi: '' },
}

export const emptyDoses = (): SlotDoses => ({ morning: null, afternoon: null, evening: null, night: null })
