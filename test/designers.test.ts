import {describe, expect, it, vi} from 'vitest'
import {allows, describe as describeDesigners, isAnyone, isTeam, parseDesigners, resolveDesigners} from '../src/designers.js'

describe('parseDesigners (SPEC §6.3)', () => {
  it('splits on commas and new lines only, keeping spaces and apostrophes in team names', () => {
    expect(parseDesigners("dana@example.com, team:Tim's Eyes Org\nteam:UX Design Team\r\n\n ,lee@example.com,")).toEqual([
      'dana@example.com',
      "team:Tim's Eyes Org",
      'team:UX Design Team',
      'lee@example.com'
    ])
  })

  it('is empty for nothing', () => {
    expect(parseDesigners(undefined)).toEqual([])
    expect(parseDesigners(' \n , ')).toEqual([])
  })

  it('recognizes team entries case-insensitively', () => {
    expect(isTeam('TEAM:Design')).toBe(true)
    expect(isTeam('teammate@example.com')).toBe(false)
  })
})

describe('resolveDesigners', () => {
  const teams = [
    {id: 'abc123', name: "Tim's Eyes Org", members: ['Tim@Example.com', 'pat@example.com']},
    {id: 'empty1', name: 'Empty', members: []}
  ]

  it('expands teams by name (case-insensitive) or id, mixed with emails', async () => {
    const d = await resolveDesigners(["team:tim's eyes org", 'Lee@Example.com', 'team:abc123'], async () => teams)
    expect([...d.allowed].sort()).toEqual(['lee@example.com', 'pat@example.com', 'tim@example.com'])
    expect(d.problem).toBeUndefined()
    expect(allows(d, 'TIM@example.com')).toBe(true)
    expect(allows(d, 'someone@example.com')).toBe(false)
    expect(describeDesigners(d)).toBe("team:tim's eyes org, Lee@Example.com, team:abc123")
  })

  it('reports unknown and empty teams, fetching the team list once', async () => {
    const source = vi.fn(async () => teams)
    const d = await resolveDesigners(['team:Nope', 'team:Empty'], source)
    expect(source).toHaveBeenCalledTimes(1)
    expect(d.allowed.size).toBe(0)
    expect(d.problem).toBe("Eyes team 'Nope' not found; Eyes team 'Empty' has no members")
  })

  it('fails closed when teams cannot be listed', async () => {
    const d = await resolveDesigners(['team:Design', 'dana@example.com'], async () => {
      throw new Error('HTTP 403')
    })
    expect([...d.allowed]).toEqual(['dana@example.com'])
    expect(d.problem).toContain("couldn't list Eyes teams (HTTP 403)")
  })

  it('does not look up teams when there are none, and no entries means anyone', async () => {
    const source = vi.fn(async () => teams)
    expect(isAnyone(await resolveDesigners([], source))).toBe(true)
    await resolveDesigners(['a@example.com'], source)
    expect(source).not.toHaveBeenCalled()
  })
})
