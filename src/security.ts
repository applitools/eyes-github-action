/**
 * The security rules every implementation follows (SPEC §13a), as the Jenkins plugin's review fixed them
 * (docs/SECURITY.md there: F2, F3, F4, F10, F12).
 */
import {lookup} from 'node:dns/promises'
import {isIP} from 'node:net'

/** Largest Eyes response read, before and after decompression (Eyes results for 1,000 tests are under 1 MB). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

const METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal'])

/**
 * Refuses an Eyes server URL the keys mustn't go to: not `https` (plain `http` only to this machine, or with
 * `allowHttp`), user info in the URL, or a host that is or resolves to a link-local, unspecified, multicast or cloud
 * metadata address.
 */
export async function checkServerUrl(raw: string, allowHttp: boolean): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`serverUrl '${raw}' isn't a URL`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.username || url.password) throw new Error('serverUrl must not contain a user name or password')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`serverUrl must be https, not ${url.protocol}`)
  if (METADATA_HOSTS.has(host)) throw new Error(`serverUrl must not point at a cloud metadata service (${host})`)
  const addresses = isIP(host) ? [host] : (await lookup(host, {all: true}).catch(() => [])).map(a => a.address)
  const bad = addresses.find(isReserved)
  if (bad) throw new Error(`serverUrl ${host} resolves to ${bad}, a reserved address the Eyes keys mustn't go to`)
  const loopback = host === 'localhost' || (addresses.length > 0 && addresses.every(isLoopback))
  if (url.protocol === 'http:' && !allowHttp && !loopback) {
    throw new Error('serverUrl must be https: plain http would send the Eyes keys unencrypted. Set `allowHttp: true` to allow it.')
  }
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

function isReserved(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '')
  if (METADATA_HOSTS.has(a)) return true
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number)
    return x === 0 || (x === 169 && y === 254) || (x >= 224 && x <= 239)
  }
  return a === '::' || /^fe[89ab]/.test(a) || a.startsWith('ff')
}

/** Keeps a link only if it's an absolute http(s) URL with a host, so results can't plant `javascript:` links. */
export function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return undefined
    // Parentheses would end a Markdown link early.
    return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

/**
 * Shows text from test code (test, batch and environment names) as plain text in Markdown: a PR author controls it, so
 * it mustn't add links, images or HTML.
 */
export function markdownText(text: string): string {
  // Escaping brackets is enough to stop links and images; names never start a line, so # and + stay as they are.
  return text.replace(/\r?\n/g, ' ').replace(/[\\`*_[\]<>|~]/g, c => `\\${c}`)
}
