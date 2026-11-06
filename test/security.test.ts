import {describe, expect, it} from 'vitest'
import {checkServerUrl, markdownText, safeLink} from '../src/security.js'

describe('checkServerUrl (SPEC §13a)', () => {
  it.each([
    ['https://eyes.applitools.com', false],
    ['http://127.0.0.1:8080', false],
    ['http://localhost:8080', false],
    ['http://eyes.example.internal', true]
  ])('accepts %s', async (url, allowHttp) => {
    await expect(checkServerUrl(url, allowHttp)).resolves.toBeUndefined()
  })

  it.each([
    ['http://eyes.example.com', 'must be https'],
    ['https://user:pw@eyes.applitools.com', 'user name or password'],
    ['https://169.254.169.254/latest', 'cloud metadata'],
    ['https://metadata.google.internal', 'cloud metadata'],
    ['https://[fe80::1]', 'reserved address'],
    ['https://0.0.0.0', 'reserved address'],
    ['https://224.0.0.1', 'reserved address'],
    ['ftp://eyes.applitools.com', 'must be https'],
    ['eyes.applitools.com', "isn't a URL"]
  ])('refuses %s', async (url, message) => {
    await expect(checkServerUrl(url, false)).rejects.toThrow(message)
  })
})

describe('safeLink', () => {
  it('keeps http(s) links only', () => {
    expect(safeLink('https://eyes.applitools.com/app/test-results/1')).toBe('https://eyes.applitools.com/app/test-results/1')
    expect(safeLink(' JavaScript:alert(1)')).toBeUndefined()
    expect(safeLink('data:text/html,hi')).toBeUndefined()
    expect(safeLink('/app/test-results/1')).toBeUndefined()
    expect(safeLink('https://e.example/a)b')).toBe('https://e.example/a%29b')
  })
})

describe('markdownText', () => {
  it('keeps test names from adding links, images or HTML', () => {
    expect(markdownText('![x](https://evil) <img> *a* | b\nc')).toBe('!\\[x\\](https://evil) \\<img\\> \\*a\\* \\| b c')
  })
})
