import { describe, expect, it } from 'vitest'
import { toWhatsAppText } from './share.ts'
import { emptyDoses, type Medicine } from './types.ts'

const med = (over: Partial<Medicine>): Medicine => ({
  id: 'x', name: 'Telma', strength: '40', form: 'tablet', doses: emptyDoses(), asNeeded: false, food: 'any',
  duration: '', frequencyText: '', instructions: '', confidence: 'high', interpretedBy: 'rule', issues: [], checked: true,
  ...over,
})

describe('toWhatsAppText', () => {
  it('groups by time of day and lists as-needed and limited-duration medicines', () => {
    const text = toWhatsAppText('Kamla Devi', [
      med({ doses: { ...emptyDoses(), morning: '1', night: '1' }, food: 'after', duration: '5 days' }),
      med({ name: 'Dolo', strength: '650', asNeeded: true, instructions: 'for fever' }),
      med({ name: 'Glycomet', doses: { ...emptyDoses(), morning: '1' }, duration: 'continue' }),
    ])
    expect(text).toContain("*Kamla Devi's medicines*")
    expect(text).toContain('*Morning / सुबह*\n• Telma 40 — 1 (after food)\n• Glycomet 40 — 1')
    expect(text).toContain('*Night / रात*\n• Telma 40 — 1 (after food)')
    expect(text).not.toContain('Afternoon')
    expect(text).toContain('*Only when needed*\n• Dolo 650 — for fever')
    expect(text).toContain('*For a limited time*\n• Telma 40 — 5 days')
    expect(text).not.toMatch(/Glycomet 40 — continue/)
  })
})

describe('as-needed medicines with a time', () => {
  it('are listed only under "when needed", never in the daily slots', () => {
    const text = toWhatsAppText('', [med({ name: 'Cetirizine', strength: '10', asNeeded: true, doses: { ...emptyDoses(), night: '1' }, instructions: 'if itching' })])
    expect(text).not.toContain('*Night')
    expect(text).toContain('*Only when needed*\n• Cetirizine 10 (night) — if itching')
  })
})
