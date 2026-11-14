import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configureHarnessEntries } from '../src/harness-entries.mjs'

const xarticle = {
  claude: { type: 'http', url: 'http://x.invalid/mcp', headersHelper: '/x/headers.sh' },
  codex: { command: '/x/launch.sh', args: [], startup_timeout_sec: 60 },
  grok: { command: '/x/launch.sh', args: [], startup_timeout_sec: 60, enabled: true },
  cursor: { command: '/x/launch.sh', args: [] },
}
const typesafe = {
  claude: { type: 'http', url: 'https://t.invalid/mcp' },
  codex: { url: 'https://t.invalid/mcp' },
  grok: { url: 'https://t.invalid/mcp', enabled: true },
  cursor: { url: 'https://t.invalid/mcp' },
}
const e1 = (product, server, extra = {}) => ({ schema: 'bellteam.harness-entries.v1', product, version: '1', mcpServers: { [product]: server }, ...extra })

// A seat home whose files already hold today's entries, plus fakes for the CLI and the Codex app-server.
async function fixture({ products = { xarticle: e1('xarticle', xarticle), typesafe: e1('typesafe', typesafe) } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bellteam-harness-entries-'))
  const home = join(dir, 'home')
  await mkdir(join(home, '.cursor'), { recursive: true })
  const registry = []
  for (const [product, value] of Object.entries(products)) {
    const file = join(dir, `${product}.json`)
    if (value !== null) await writeFile(file, JSON.stringify(value))
    registry.push({ product, file })
  }
  await writeFile(join(dir, 'registry.json'), JSON.stringify(registry))
  const claude = { mcpServers: { xarticle: xarticle.claude, typesafe: typesafe.claude, other: { url: 'keep' } }, unrelated: 1 }
  await writeFile(join(home, '.claude.json'), JSON.stringify(claude))
  await writeFile(join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { xarticle: xarticle.cursor, typesafe: typesafe.cursor, other: { url: 'keep' } }, top: true }))
  const grok = [{ ...xarticle.grok, name: 'xarticle', scope: 'user' }, { ...typesafe.grok, name: 'typesafe', scope: 'user' }]
  const codex = { xarticle: { ...xarticle.codex, environment_id: 'local', enabled: true, tool_timeout_sec: null }, typesafe: { ...typesafe.codex, environment_id: 'local', enabled: true, tool_timeout_sec: null } }
  const calls = [], requests = [], reports = []
  const run = async (command, args) => {
    calls.push([command, ...args])
    return { stdout: JSON.stringify(grok) }
  }
  const appServer = async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    if (method === 'config/read') return { config: { mcp_servers: codex } }
    if (method === 'config/batchWrite') { const [{ keyPath, value }] = params.edits; codex[keyPath.split('.')[1]] = { ...value, environment_id: 'local', enabled: true, tool_timeout_sec: null } }
  })
  const apply = () => configureHarnessEntries(home, { registry: join(dir, 'registry.json'), run, appServer, report: message => reports.push(message) })
  return { dir, home, calls, requests, reports, apply, claude, files: () => Promise.all(['.claude.json', '.cursor/mcp.json'].map(name => readFile(join(home, name), 'utf8'))) }
}
const writes = calls => calls.filter(call => !(call[0] === 'grok' && call[2] === 'list'))

test('entries identical to the seat files run no write command and change no file', async () => {
  const f = await fixture()
  const before = await f.files()
  await f.apply()
  assert.deepEqual(writes(f.calls), [])
  assert.deepEqual(f.requests.map(([method]) => method), ['config/read'])
  assert.deepEqual(await f.files(), before)
  assert.deepEqual(f.reports, [])
  const applied = JSON.parse(await readFile(join(f.home, '.bellteam-cli-registration/applied.json'), 'utf8'))
  assert.deepEqual(applied.xarticle.entries.sort(), ['claude:xarticle', 'codex:xarticle', 'cursor:xarticle', 'grok:xarticle'])
  await f.apply()
  assert.deepEqual(writes(f.calls), [])
})

test('one changed claude entry gives exactly one remove and add-json for that server', async () => {
  const changed = { ...xarticle, claude: { ...xarticle.claude, url: 'http://new.invalid/mcp' } }
  const f = await fixture({ products: { xarticle: e1('xarticle', changed), typesafe: e1('typesafe', typesafe) } })
  await f.apply()
  assert.deepEqual(writes(f.calls), [
    ['claude', 'mcp', 'remove', 'xarticle', '--scope', 'user'],
    ['claude', 'mcp', 'add-json', 'xarticle', JSON.stringify(changed.claude), '--scope', 'user'],
  ])
  assert.deepEqual(f.requests.map(([method]) => method), ['config/read'])
})

test('a changed codex entry is upserted through config/batchWrite for that key only (undeclared keys stay)', async () => {
  const changed = { ...typesafe, codex: { url: 'https://new.invalid/mcp' } }
  const f = await fixture({ products: { typesafe: e1('typesafe', changed) } })
  await f.apply()
  const batch = f.requests.filter(([method]) => method === 'config/batchWrite')
  assert.equal(batch.length, 1)
  assert.deepEqual(batch[0][1].edits, [{ keyPath: 'mcp_servers.typesafe', value: changed.codex, mergeStrategy: 'upsert' }])
  assert.deepEqual(f.reports, [])
})

test('grok entry with a field grok mcp add cannot write is reported and left alone', async () => {
  const changed = { ...xarticle, grok: { ...xarticle.grok, startup_timeout_sec: 90 } }
  const f = await fixture({ products: { xarticle: e1('xarticle', changed) } })
  await f.apply()
  assert.deepEqual(writes(f.calls), [])
  assert.match(f.reports.join('\n'), /grok.*xarticle.*startup_timeout_sec/u)
})

test('cursor merge changes only the named server and keeps other keys', async () => {
  const changed = { ...xarticle, cursor: { command: '/x/new.sh', args: ['a'] } }
  const f = await fixture({ products: { xarticle: e1('xarticle', changed) } })
  await f.apply()
  const cursor = JSON.parse(await readFile(join(f.home, '.cursor/mcp.json'), 'utf8'))
  assert.deepEqual(cursor, { mcpServers: { xarticle: changed.cursor, typesafe: typesafe.cursor, other: { url: 'keep' } }, top: true })
  assert.deepEqual(writes(f.calls), [])
})

test('an invalid or missing E1 writes nothing for that product while the other product still applies', async () => {
  const typesafeChanged = { ...typesafe, claude: { type: 'http', url: 'https://new.invalid/mcp' } }
  const f = await fixture({ products: { xarticle: { ...e1('xarticle', xarticle), product: 'other' }, typesafe: e1('typesafe', typesafeChanged), broken: null } })
  await f.apply()
  assert.deepEqual(writes(f.calls).map(call => call[3]), ['typesafe', 'typesafe'])
  assert.equal(f.reports.length, 2)
  assert.match(f.reports[0], /xarticle/u)
  assert.match(f.reports[1], /broken/u)
  const applied = JSON.parse(await readFile(join(f.home, '.bellteam-cli-registration/applied.json'), 'utf8'))
  assert.deepEqual(Object.keys(applied), ['typesafe'])
})

test('a product that also has hooks is skipped and reported', async () => {
  const f = await fixture({ products: { xarticle: e1('xarticle', { ...xarticle, claude: { type: 'http', url: 'http://new.invalid' } }, { hooks: { claude: { Stop: [] }, codex: {} } }) } })
  await f.apply()
  assert.deepEqual(writes(f.calls), [])
  assert.match(f.reports[0], /xarticle.*hooks/u)
  assert.equal(JSON.parse(await readFile(join(f.home, '.claude.json'), 'utf8')).mcpServers.xarticle.url, xarticle.claude.url)
})

test('merge rule: declared keys win, undeclared keys and env keys stay, env:{} clears nothing', async () => {
  const { mergeEntry } = await import('../src/harness-entries.mjs')
  const current = { command: '/old', args: ['x'], env: { A: '1', B: '2' }, startup_timeout_sec: 90, custom: true }
  assert.deepEqual(mergeEntry(current, { command: '/new', args: [], env: { B: '3' } }),
    { command: '/new', args: [], env: { A: '1', B: '3' }, startup_timeout_sec: 90, custom: true })
  assert.deepEqual(mergeEntry(current, { command: '/old', args: ['x'], env: {} }).env, { A: '1', B: '2' })
  assert.deepEqual(mergeEntry(undefined, { url: 'u' }), { url: 'u' })
})
