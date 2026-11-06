/**
 * Setup checks (SPEC §13), the Action's version of the Jenkins plugin's setup page: is the Eyes server allowed and
 * reachable, can each key do its job, do the designers resolve, can the token read pull requests. Every problem comes
 * with the fix. Nothing changes in Eyes or GitHub.
 */
import {isTeam, resolveDesigners} from './designers.js'
import {EyesClient, EyesHttpError} from './eyes.js'
import {checkServerUrl} from './security.js'

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorItem {
  name: string
  status: DoctorStatus
  detail: string
}

export interface DoctorConfig {
  serverUrl: string
  allowHttp: boolean
  apiKey?: string
  readApiKey?: string
  mergeApiKey?: string
  designers: string[]
  hideReviewers?: boolean
}

export interface DoctorDeps {
  eyes(apiKey: string): EyesClient
  /** Reads the repository's pull requests; throws when the token can't. */
  readPullRequests?(): Promise<void>
}

export async function runDoctor(config: DoctorConfig, deps: DoctorDeps): Promise<DoctorItem[]> {
  const items: DoctorItem[] = []
  const add = (name: string, status: DoctorStatus, detail: string) => items.push({name, status, detail})

  try {
    await checkServerUrl(config.serverUrl, config.allowHttp)
  } catch (e) {
    add('Eyes server', 'fail', `${message(e)}.`)
    return items
  }

  // Run key: also tells whether the server answers at all.
  if (!config.apiKey) {
    add('Run key', 'fail', 'Missing. Add your Eyes run key as the secret `APPLITOOLS_API_KEY` and pass it as `apiKey`.')
  } else {
    try {
      const {permissions} = await deps.eyes(config.apiKey).keyInfo()
      add('Eyes server', 'ok', `${config.serverUrl} answers.`)
      if (permissions.length > 0 && !permissions.includes('execute')) {
        add('Run key', 'fail', `It has ${permissions.join(', ')} permission, so Eyes refuses its test uploads. Use a key with execute permission.`)
      } else {
        add('Run key', 'ok', permissions.length > 0 ? `Permissions: ${permissions.join(', ')}.` : 'Valid.')
      }
    } catch (e) {
      if (e instanceof EyesHttpError && e.unauthorized) {
        add('Eyes server', 'ok', `${config.serverUrl} answers.`)
        add('Run key', 'fail', `Eyes doesn't accept it (HTTP ${e.status}). Check the \`APPLITOOLS_API_KEY\` secret, and \`serverUrl\` for a dedicated cloud.`)
      } else {
        add('Eyes server', 'fail', `${message(e)}. Check \`serverUrl\`.`)
        return items
      }
    }
  }

  const readKey = config.readApiKey ?? config.apiKey
  if (readKey) {
    const fallback = config.readApiKey ? '' : ' (no `readApiKey`, so this is the run key)'
    const read = await probe(() => deps.eyes(readKey).checkRead())
    if (read === 'ALLOWED') add('Read key', 'ok', `Can read results${fallback}.`)
    else {
      add(
        'Read key',
        'fail',
        `${read === 'INVALID' ? "Eyes doesn't accept it" : "It can't read results"}${fallback}. Add an Eyes read key as the ` +
          'secret `APPLITOOLS_READ_KEY` and pass it as `readApiKey`.' +
          (read instanceof Error ? ` (${read.message})` : '')
      )
    }
  }

  const mergeKey = config.mergeApiKey ?? config.apiKey
  if (mergeKey) {
    const fallback = config.mergeApiKey ? '' : ' (no `mergeApiKey`, so this is the run key)'
    const merge = await probe(() => deps.eyes(mergeKey).checkMerge())
    if (merge === 'ALLOWED') add('Merge key', 'ok', `Can merge baselines${fallback}.`)
    else {
      add(
        'Merge key',
        // Only the merge workflow needs it.
        config.mergeApiKey ? 'fail' : 'warn',
        `${merge === 'INVALID' ? "Eyes doesn't accept it" : "It can't merge baselines"}${fallback}, so merged PRs' baselines ` +
          "won't be merged. Eyes merge keys are created for a team and a user; add one as the secret " +
          '`APPLITOOLS_MERGE_KEY` and pass it as `mergeApiKey` to the merge workflow.' +
          (merge instanceof Error ? ` (${merge.message})` : '')
      )
    }
  }

  if (config.designers.length === 0) {
    add('Designers', 'ok', 'None set: anyone who reviews in Eyes can approve design review.')
  } else if (readKey) {
    const resolved = await resolveDesigners(config.designers, () => deps.eyes(readKey).ownTeams())
    const who = config.hideReviewers
      ? `${resolved.allowed.size} designer${resolved.allowed.size === 1 ? '' : 's'}`
      : [...resolved.allowed].sort().join(', ') || 'nobody'
    if (resolved.allowed.size === 0) {
      add('Designers', 'fail', `Nobody can approve: ${resolved.problem ?? 'no designers resolved'}. Check the team names in Eyes.`)
    } else if (resolved.problem) {
      add('Designers', 'warn', `${who}. But ${resolved.problem}.`)
    } else {
      add('Designers', 'ok', `${who}${config.designers.some(isTeam) ? ' (Eyes teams resolved with the read key)' : ''}.`)
    }
  }

  if (deps.readPullRequests) {
    try {
      await deps.readPullRequests()
      add(
        'GitHub',
        'ok',
        'The token can read pull requests. Posting checks needs `checks: write` in the workflow\'s `permissions`; ' +
          "that can't be checked without posting one, so the first run reports it if it's missing."
      )
    } catch (e) {
      add('GitHub', 'fail', `The token can't read pull requests (${message(e)}). Add \`pull-requests: read\` to the workflow's \`permissions\`.`)
    }
  }
  return items
}

export function doctorMarkdown(items: DoctorItem[]): string {
  const icon = {ok: '✅', warn: '⚠️', fail: '❌'}
  const rows = items.map(i => `| ${icon[i.status]} ${i.name} | ${i.detail.replace(/\|/g, '\\|')} |`)
  return `## Applitools setup check\n\n| Check | Result |\n| --- | --- |\n${rows.join('\n')}\n`
}

async function probe<T>(fn: () => Promise<T>): Promise<T | Error> {
  try {
    return await fn()
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\.$/, '')
}
