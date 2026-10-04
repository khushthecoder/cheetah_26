import type { Medicine } from './types.ts'

const KEY = 'dosecard:last'

export interface SavedCard {
  patientName: string
  medicines: Medicine[]
  savedAt: string
}

// Stored only in this browser on this machine. Wrapped because storage can be blocked.
export function saveCard(card: SavedCard): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(card))
  } catch {
    /* storage unavailable — the card still works for this session */
  }
}

export function loadCard(): SavedCard | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const card = JSON.parse(raw) as SavedCard
    return Array.isArray(card.medicines) ? card : null
  } catch {
    return null
  }
}

export function clearCard(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
