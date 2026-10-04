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
    ['1/2-0-1/2', ['morning:½', 'night:½']],
    ['1 0 1', ['morning:1', 'night:1']],
    // Regressions from the first real Gemma eval run:
    ['M1 1-0-1', ['morning:1', 'night:1']],
    ['Telma 40 1-0-0', ['morning:1']],
    ['500 1-0-1', ['morning:1', 'night:1']],
    ['1-0-1 x 5 days', ['morning:1', 'night:1']],
  ])('%s', (input, expected) => {
    expect(slotsOf(input)).toEqual(expected)
  })

  it('does not treat strengths or durations as a slot pattern', () => {
    expect(slotsOf('500 mg')).toBeNull()
    expect(slotsOf('x 5 days')).toBeNull()
  })

  it('rejects implausible quantities instead of putting them on the card', () => {
    expect(interpretFrequency('40-0-0')).toBeNull()
    expect(interpretFrequency('10-0-10')).toBeNull()
  })

  it('does not combine mixed separators into one dose pattern', () => {
    expect(slotsOf('1 1-0')).toBeNull()
  })

  it.each(['only if fever goes above 100', 'if fever', 'zarurat pade to', 'only when pain'])('treats "%s" as as-needed', (text) => {
    expect(interpretFrequency(text)?.asNeeded).toBe(true)
  })

  it('does not pick a time for once-daily without a written time', () => {
    const r = interpretFrequency('OD')
    expect(Object.values(r!.doses).every((v) => v === null)).toBe(true)
    expect(r?.notes[0]).toMatch(/time isn't written/i)
  })

  it('uses the written time when once-daily has one', () => {
    expect(slotsOf('OD at night')).toEqual(['night:1'])
    expect(slotsOf('once a day in the morning')).toEqual(['morning:1'])
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

describe('conditional doses (held-out eval regression)', () => {
  it('keeps the condition when a time is also written', () => {
    const r = interpretFrequency('at bedtime if itching')
    expect(r?.asNeeded).toBe(true)
    expect(r?.doses.night).toBe('1')
  })

  it.each(['agar dard ho to', 'if BP above 160', '1-0-0 if sugar is high'])('"%s" is as-needed', (text) => {
    expect(interpretFrequency(text)?.asNeeded).toBe(true)
  })
})
