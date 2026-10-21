/**
 * Who may approve a design review (SPEC §6.3). Entries are Eyes login emails or `team:<Eyes team name or id>`; teams
 * expand to their members through the Eyes admin API, so designers are managed in Eyes, where they review. If a team
 * can't be resolved, nobody from it can approve (fail closed).
 */

export const TEAM_PREFIX = 'team:'

export interface Team {
  id?: string
  name: string
  members: string[]
}

/** Lists the organization's teams for the key in use (see EyesClient.teams). */
export type TeamSource = () => Promise<Team[]>

export interface Designers {
  /** As configured, for messages. Empty means anyone reviewing in Eyes may approve. */
  entries: string[]
  /** Normalized emails that may approve. */
  allowed: Set<string>
  /** Why some entries couldn't be resolved, if any. */
  problem?: string
}

/** Commas and new lines only: Eyes team names contain spaces and apostrophes ("team:Tim's Eyes Org"). */
export function parseDesigners(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\n\r]+/)
    .map(v => v.trim())
    .filter(v => v !== '')
}

export function isTeam(entry: string): boolean {
  return entry.slice(0, TEAM_PREFIX.length).toLowerCase() === TEAM_PREFIX
}

export function isAnyone(designers: Designers): boolean {
  return designers.entries.length === 0
}

export function allows(designers: Designers, user: string): boolean {
  return designers.allowed.has(normalize(user))
}

export function describe(designers: Designers): string {
  return designers.entries.join(', ')
}

/** Entries taken as they are, with no team lookups (when design review isn't required, or there are no teams). */
export function plainDesigners(entries: string[]): Designers {
  return {entries, allowed: new Set(entries.map(normalize))}
}

/** Expands `team:` entries (only fetching teams when there are any). */
export async function resolveDesigners(entries: string[], teams: TeamSource): Promise<Designers> {
  const allowed = new Set<string>()
  const problems: string[] = []
  let known: Team[] | undefined
  for (const entry of entries) {
    if (!isTeam(entry)) {
      allowed.add(normalize(entry))
      continue
    }
    const wanted = entry.slice(TEAM_PREFIX.length).trim()
    if (known === undefined) {
      try {
        known = await teams()
      } catch (e) {
        problems.push(`couldn't list Eyes teams (${errorMessage(e)})`)
        known = []
      }
    }
    const team = known.find(t => t.name.toLowerCase() === wanted.toLowerCase() || t.id === wanted)
    if (!team) {
      problems.push(`Eyes team '${wanted}' not found`)
    } else if (team.members.length === 0) {
      problems.push(`Eyes team '${wanted}' has no members`)
    } else {
      team.members.forEach(m => allowed.add(normalize(m)))
    }
  }
  return {entries, allowed, problem: problems.length > 0 ? [...new Set(problems)].join('; ') : undefined}
}

function normalize(user: string): string {
  return user.trim().toLowerCase()
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
