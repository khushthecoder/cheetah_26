import { describe, expect, it } from 'vitest'
import { interpretFood, interpretFrequency } from './frequency.ts'

const slotsOf = (text: string) => {
  const r = interpretFrequency(text)
  return r && Object.entries(r.doses).filter(([, v]) => v !== null).map(([k, v]) => `${k}:${v}`)
}

describe('interpretFrequency', () => {
  it.each([
    ['1-0-1', ['morning:1', 'night:1']],
    ['1-1-1', ['morning:1', 'afternoon:1', 'night:1']],
    ['0-0-1', ['night:1']],
    ['0-1-0', ['afternoon:1']],
    ['1 - 0 - 0', ['morning:1']],
    ['1–0–1 after food', ['morning:1', 'night:1']],
    ['½-0-½', ['morning:½', 'night:½']],
    ['0.5-0-1', ['morning:½', 'night:1']],
    ['1-0-0-1', ['morning:1', 'night:1']],
    ['0-0-1-0', ['evening:1']],
    ['BD', ['morning:1', 'night:1']],
    ['1 tab BD x 5 days', ['morning:1', 'night:1']],
    ['TDS', ['morning:1', 'afternoon:1', 'night:1']],
    ['tid pc', ['morning:1', 'afternoon:1', 'night:1']],
    ['QID', ['morning:1', 'afternoon:1', 'evening:1', 'night:1']],
    ['HS', ['night:1']],
    ['at bedtime', ['night:1']],
    ['morning and night', ['morning:1', 'night:1']],
    ['after lunch', ['afternoon:1']],
    ['twice daily', ['morning:1', 'night:1']],
  ])('%s', (input, expected) => {
    expect(slotsOf(input)).toEqual(expected)
  })

  it('does not treat strengths or durations as a slot pattern', () => {
    expect(slotsOf('500 mg')).toBeNull()
    expect(slotsOf('x 5 days')).toBeNull()
  })

  it('marks once-daily without a time as an assumption the human must confirm', () => {
    const r = interpretFrequency('OD')
    expect(r?.doses.morning).toBe('1')
    expect(r?.notes[0]).toMatch(/assumed morning/i)
  })

  it('handles as-needed medicines', () => {
    const r = interpretFrequency('SOS for fever')
    expect(r?.asNeeded).toBe(true)
    expect(Object.values(r!.doses).every((v) => v === null)).toBe(true)
  })

  it('refuses weekly schedules rather than guessing', () => {
    expect(interpretFrequency('once a week on Sunday')).toBeNull()
    expect(interpretFrequency('alternate days')).toBeNull()
  })

  it('returns null for empty or meaningless text', () => {
    expect(interpretFrequency('')).toBeNull()
    expect(interpretFrequency('as directed')).toBeNull()
    expect(interpretFrequency('0-0-0')).toBeNull()
  })
})

describe('interpretFood', () => {
  it.each([
    ['after food', 'after'],
    ['1-0-1 PC', 'after'],
    ['before breakfast', 'before'],
    ['empty stomach', 'before'],
    ['AC', 'before'],
    ['with meals', 'with'],
    ['BD', 'any'],
  ] as const)('%s -> %s', (input, expected) => {
    expect(interpretFood(input)).toBe(expected)
  })
})
