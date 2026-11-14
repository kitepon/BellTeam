import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
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
async function fixture({ products = { xarticle: e1('xarticle', xarticle), typesafe: e1('typesafe', typesafe) }, failAdd = null } = {}) {
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
    const failure = failAdd && failAdd(command, args)
    if (failure) throw failure instanceof Error ? failure : new Error('synthetic add failure')
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
  assert.match(f.reports[1], /broken.*がありません/u)
  const applied = JSON.parse(await readFile(join(f.home, '.bellteam-cli-registration/applied.json'), 'utf8'))
  assert.deepEqual(Object.keys(applied), ['typesafe'])
})

test('permissions for a harness or key BellTeam does not apply are reported and skipped while the rest of the product applies', async () => {
  const changed = { ...xarticle, claude: { type: 'http', url: 'http://new.invalid' } }
  const f = await fixture({ products: { xarticle: e1('xarticle', changed, { permissions: { gemini: { allow: ['x'] }, cursor: { allow: ['Mcp(x:y)'], deny: ['z'] } } }) } })
  await f.apply()
  assert.deepEqual(f.reports, ['BellTeam 権限 xarticle: permissions.gemini は適用しません', 'BellTeam 権限 xarticle: permissions.cursor.deny は適用しません'])
  assert.ok(writes(f.calls).some(call => call[2] === 'add-json' && call[4].includes('new.invalid')))
  assert.equal(JSON.parse(await readFile(join(f.home, '.cursor/cli-config.json'), 'utf8')).permissions.allow.at(-1), 'Mcp(x:y)')
})

test('merge rule: declared keys win, undeclared keys and env keys stay, env:{} clears nothing', async () => {
  const { mergeEntry } = await import('../src/harness-entries.mjs')
  const current = { command: '/old', args: ['x'], env: { A: '1', B: '2' }, startup_timeout_sec: 90, custom: true }
  assert.deepEqual(mergeEntry(current, { command: '/new', args: [], env: { B: '3' } }),
    { command: '/new', args: [], env: { A: '1', B: '3' }, startup_timeout_sec: 90, custom: true })
  assert.deepEqual(mergeEntry(current, { command: '/old', args: ['x'], env: {} }).env, { A: '1', B: '2' })
  assert.deepEqual(mergeEntry(undefined, { url: 'u' }), { url: 'u' })
})

test('remove succeeded, new add failed: the previous entry is added back (claude and grok)', async () => {
  const changed = { ...typesafe, claude: { type: 'http', url: 'https://new.invalid/mcp' }, grok: { url: 'https://new.invalid/mcp', enabled: true } }
  const failAdd = (command, args) => args[0] === 'mcp' && (args[1] === 'add-json' || args[1] === 'add') && JSON.stringify(args).includes('new.invalid')
  const f = await fixture({ products: { typesafe: e1('typesafe', changed) }, failAdd })
  await f.apply()
  assert.deepEqual(writes(f.calls), [
    ['claude', 'mcp', 'remove', 'typesafe', '--scope', 'user'],
    ['claude', 'mcp', 'add-json', 'typesafe', JSON.stringify(changed.claude), '--scope', 'user'],
    ['claude', 'mcp', 'add-json', 'typesafe', JSON.stringify(typesafe.claude), '--scope', 'user'],
    ['grok', 'mcp', 'remove', 'typesafe', '--scope', 'user'],
    ['grok', 'mcp', 'add', 'typesafe', '--scope', 'user', '--transport', 'http', 'https://new.invalid/mcp'],
    ['grok', 'mcp', 'add', 'typesafe', '--scope', 'user', '--transport', 'http', typesafe.grok.url],
  ])
  assert.equal(f.reports.length, 2)
  assert.match(f.reports.join('\n'), /synthetic add failure/u)
})

test('a missing E2 registry is an error (reported by configureHarnesses), not a silent no-op', async () => {
  const f = await fixture()
  await assert.rejects(configureHarnessEntries(f.home, { registry: join(f.dir, 'absent.json'), run: async () => ({ stdout: '[]' }), report: () => {} }), /E2 .*absent\.json/u)
})

test('a failed CLI call carrying a credential reports only product, harness, program and exit code', async () => {
  const secret = 'SYNTHETIC-SECRET-1436'
  const changed = { ...typesafe, claude: { type: 'http', url: 'https://new.invalid/mcp', headers: { Authorization: `Bearer ${secret}` } } }
  // execFile's Error: message and cmd carry the whole argv, stderr may echo it.
  const failAdd = (command, args) => command === 'claude' && args[1] === 'add-json' && JSON.stringify(args).includes(secret)
    && Object.assign(new Error(`Command failed: claude ${args.join(' ')}\n${secret}`), { cmd: `claude ${args.join(' ')}`, code: 1, stderr: secret })
  const f = await fixture({ products: { typesafe: e1('typesafe', changed) }, failAdd })
  await f.apply()
  assert.equal(f.reports.length, 1)
  assert.doesNotMatch(f.reports[0], new RegExp(secret, 'u'))
  assert.match(f.reports[0], /typesafe: claude の typesafe を適用できませんでした（claude が終了コード 1 で失敗しました）/u)
})

test('Codex app-server failures carrying a credential (remote error, stderr on exit) report only codes', async () => {
  const secret = 'SYNTHETIC-SECRET-1436-CODEX'
  const changed = { ...typesafe, codex: { url: 'https://new.invalid/mcp', http_headers: { Authorization: `Bearer ${secret}` } } }
  for (const [mode, expected] of [['error', /codex の typesafe を適用できませんでした（CODEX_APP_SERVER_ERROR: -32000）/u], ['exit', /Codexのapp-serverを使えませんでした（CODEX_APP_SERVER_EXITED: 3）/u]]) {
    // A fake `codex` on PATH driven through the real codexAppServer: batchWrite answers an error object echoing the secret
    // (per-entry report), or the server prints it on stderr and exits (outer report).
    const bin = await mkdtemp(join(tmpdir(), 'bellteam-fake-codex-'))
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return
  if (m.method === 'initialize') return console.log(JSON.stringify({ id: m.id, result: {} }))
  if (${JSON.stringify(mode)} === 'exit') { process.stderr.write('config ${secret}\\n'); process.exit(3) }
  if (m.method === 'config/read') return console.log(JSON.stringify({ id: m.id, result: { config: { mcp_servers: {} } } }))
  console.log(JSON.stringify({ id: m.id, error: { code: -32000, message: 'bad ${secret}', data: { value: '${secret}' } } })) })
`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const f = await fixture({ products: { typesafe: e1('typesafe', changed) } })
      await configureHarnessEntries(f.home, { registry: join(f.dir, 'registry.json'), run: async () => ({ stdout: '[]' }), report: message => f.reports.push(message) })
      const codexReports = f.reports.filter(line => /codex|Codex/u.test(line))
      assert.ok(codexReports.length >= 1, f.reports.join('\n'))
      assert.doesNotMatch(f.reports.join('\n'), new RegExp(secret, 'u'))
      assert.match(codexReports.join('\n'), expected)
    } finally { process.env.PATH = path }
  }
})

// bd14 second switch: RTK's hooks. RTK's E1 (Drilly, v1.1) as published, and the bytes the old configureRtk wrote (test/fixtures/rtk-switch.json, frozen from origin/main c685e719).
const gate = harness => `node /srv/bellteam/shared/tools/testgate/current/bin/testgate.mjs hook ${harness}`
const rtkE1 = {
  schema: 'bellteam.harness-entries.v1', product: 'rtk', version: 'rtk 1.2.0 via testgate current', mcpServers: {},
  hooks: {
    claude: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gate('claude') }] }] },
    codex: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gate('codex') }] }] },
    cursor: { preToolUse: [{ command: gate('cursor'), matcher: 'Shell' }] },
    grok: { hooks: { PreToolUse: [{ matcher: '^run_terminal_command$', hooks: [{ type: 'command', command: gate('grok'), timeout: 5, env: { RTK_BIN: '/usr/local/bin/rtk' } }] }] } },
  },
  owns: { commandIncludes: ['/srv/bellteam/shared/tools/testgate/current/bin/testgate.mjs hook ', 'rtk hook ', 'integrations/rtk/grok-hook.mjs'] },
}
const OLD = JSON.parse(await readFile(new URL('./fixtures/rtk-switch.json', import.meta.url), 'utf8'))
const HOOK_PATHS = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.grok/hooks/rtk.json']

async function hookSeat(before = {}, e1 = rtkE1) {
  const dir = await mkdtemp(join(tmpdir(), 'bellteam-hook-entries-'))
  const home = join(dir, 'home')
  for (const [file, text] of Object.entries(before)) {
    await mkdir(join(home, file, '..'), { recursive: true })
    await writeFile(join(home, file), text)
  }
  await writeFile(join(dir, 'rtk.json'), JSON.stringify(e1))
  await writeFile(join(dir, 'registry.json'), JSON.stringify([{ product: 'rtk', file: join(dir, 'rtk.json') }]))
  const requests = [], reports = []
  const appServer = async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    const source = await realpath(join(home, '.codex/hooks.json'))
    const hooks = []
    for (const [event, groups] of Object.entries(JSON.parse(await readFile(source, 'utf8')).hooks ?? {}))
      groups.forEach((group, gi) => group.hooks.forEach((hook, hi) => hooks.push({ key: `${source}:${event}:${gi}:${hi}`, command: hook.command, sourcePath: source, enabled: true, trustStatus: 'trusted', currentHash: 'h' })))
    return { data: [{ hooks }] }
  })
  const apply = () => configureHarnessEntries(home, { registry: join(dir, 'registry.json'), run: async () => ({ stdout: '[]' }), appServer, report: message => reports.push(message) })
  const read = async file => readFile(join(home, file), 'utf8').catch(() => null)
  return { home, requests, reports, apply, read, bytes: () => Promise.all(HOOK_PATHS.map(read)) }
}

for (const name of ['seat', 'legacy', 'fresh']) {
  test(`RTK hooks from E1 give the bytes the old configureRtk wrote (${name})`, async () => {
    const f = await hookSeat(OLD[name].before)
    await f.apply()
    assert.deepEqual(f.reports, [])
    assert.deepEqual(await f.bytes(), HOOK_PATHS.map(file => OLD[name].after[file]))
  })
}

test('a seat already holding the old writer output is not written at all (same bytes, same inode, trust only read)', async () => {
  const f = await hookSeat(OLD.legacy.after)
  const inodes = async () => (await Promise.all(HOOK_PATHS.map(file => stat(join(f.home, file))))).map(info => info.ino)
  const before = await inodes()
  await f.apply()
  await f.apply()
  assert.deepEqual(await f.bytes(), HOOK_PATHS.map(file => OLD.legacy.after[file]))
  assert.deepEqual(await inodes(), before)
  assert.deepEqual([...new Set(f.requests.map(([method]) => method))], ['hooks/list'])
  assert.deepEqual(f.reports, [])
  const applied = JSON.parse(await f.read('.bellteam-cli-registration/applied.json'))
  assert.deepEqual(applied.rtk.entries, ['claude:hooks:PreToolUse', 'codex:hooks:PreToolUse', 'cursor:hooks:preToolUse', 'grok:hooks'])
})

test('a hook item the product owns is replaced in place; user hooks, group metadata and undeclared item fields stay', async () => {
  const f = await hookSeat(OLD.legacy.before)
  await f.apply()
  const claude = JSON.parse(await f.read('.claude/settings.json'))
  assert.deepEqual(claude.hooks.PreToolUse[1], { matcher: 'Bash', note: 'user group metadata', hooks: [{ type: 'command', command: gate('claude'), timeout: 9 }, { type: 'command', command: 'user-second' }] })
  assert.equal(claude.hooks.PreToolUse.length, 3)
  assert.deepEqual(JSON.parse(await f.read('.codex/hooks.json')).hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: gate('codex') }] }, { hooks: [{ type: 'command', command: 'later' }] }])
})

test('codex trust is re-issued for the changed handler through hooks/list and config/batchWrite', async () => {
  const e1 = { ...rtkE1, hooks: { codex: rtkE1.hooks.codex } }
  const f = await hookSeat({ '.codex/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook codex' }] }] } }) }, e1)
  const source = await realpath(join(f.home, '.codex/hooks.json'))
  const key = `${source}:PreToolUse:0:0`
  let trusted = false
  const requests = []
  await configureHarnessEntries(f.home, { registry: join(f.home, '../registry.json'), run: async () => ({ stdout: '[]' }), report: message => f.reports.push(message), appServer: async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    if (method === 'config/batchWrite') { trusted = true; return {} }
    return { data: [{ hooks: [{ key, command: gate('codex'), sourcePath: source, enabled: trusted, trustStatus: trusted ? 'trusted' : 'untrusted', currentHash: 'sha256:g' }] }] }
  }) })
  assert.deepEqual(f.reports, [])
  assert.deepEqual(requests.map(([method]) => method), ['hooks/list', 'config/batchWrite', 'hooks/list'])
  assert.deepEqual(requests[1][1].edits.map(edit => edit.keyPath), [`hooks.state.${JSON.stringify(key)}.trusted_hash`, `hooks.state.${JSON.stringify(key)}.enabled`])
})

test('two existing owned items for one E1 item report an error and leave the file untouched', async () => {
  const text = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: gate('claude') }] }] } })
  const f = await hookSeat({ '.claude/settings.json': text })
  await f.apply()
  assert.equal(await f.read('.claude/settings.json'), text)
  assert.match(f.reports.join('\n'), /rtk.*claude.*2件/u)
  // the other harnesses of the product still apply
  assert.equal(await f.read('.cursor/hooks.json'), OLD.fresh.after['.cursor/hooks.json'])
})

test('an invalid hooks E1 keeps the seat hook files and is reported', async () => {
  const f = await hookSeat(OLD.legacy.before, { ...rtkE1, hooks: { claude: { PreToolUse: 'x' } } })
  await f.apply()
  assert.deepEqual(await f.bytes(), HOOK_PATHS.map(file => OLD.legacy.before[file] ?? null))
  assert.match(f.reports[0], /rtk.*claude.*PreToolUse/u)
})

// bd14 third switch: Throughline's E1 is printed by its CLI (command form in E2). TL is `throughline harness-entries --json` of 0.20.0 and the files `throughline install` + the old RTK pass left (frozen).
const TL = JSON.parse(await readFile(new URL('./fixtures/throughline-switch.json', import.meta.url), 'utf8'))
const TL_PATHS = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.grok/hooks/throughline.json', '.grok/hooks/rtk.json']
const TL_COMMAND = ['throughline', 'harness-entries', '--json', '--home', '{home}']

async function tlSeat(before = {}, { e1 = TL.e1, features = { hooks: true }, fail = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bellteam-throughline-entries-'))
  const home = join(dir, 'home')
  for (const [file, text] of Object.entries(before)) {
    await mkdir(join(home, file, '..'), { recursive: true })
    await writeFile(join(home, file), text)
  }
  await writeFile(join(dir, 'rtk.json'), JSON.stringify(rtkE1))
  await writeFile(join(dir, 'registry.json'), JSON.stringify([{ product: 'throughline', command: TL_COMMAND }, { product: 'rtk', file: join(dir, 'rtk.json') }]))
  const requests = [], reports = [], commands = []
  const run = async (program, args, options) => {
    commands.push([program, args, options.env.HOME])
    if (fail) throw fail
    return { stdout: typeof e1 === 'string' ? e1 : JSON.stringify(e1) }
  }
  const appServer = async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    if (method === 'config/read') return { config: { mcp_servers: {}, features } }
    if (method === 'config/batchWrite') return {}
    const source = await realpath(join(home, '.codex/hooks.json'))
    const hooks = []
    for (const [event, groups] of Object.entries(JSON.parse(await readFile(source, 'utf8')).hooks ?? {}))
      groups.forEach((group, gi) => group.hooks.forEach((hook, hi) => hooks.push({ key: `${source}:${event}:${gi}:${hi}`, command: hook.command, sourcePath: source, enabled: true, trustStatus: 'trusted', currentHash: 'h' })))
    return { data: [{ hooks }] }
  })
  const apply = () => configureHarnessEntries(home, { registry: join(dir, 'registry.json'), run, appServer, report: message => reports.push(message) })
  const read = file => readFile(join(home, file), 'utf8').catch(() => null)
  return { home, requests, reports, commands, apply, read, bytes: () => Promise.all(TL_PATHS.map(read)) }
}

test('a seat holding what throughline install and the old RTK pass wrote is not written at all (command E2, no codex batchWrite)', async () => {
  const f = await tlSeat(TL.after)
  const inodes = async () => (await Promise.all(TL_PATHS.map(file => stat(join(f.home, file))))).map(info => info.ino)
  const before = await inodes()
  await f.apply()
  assert.deepEqual(await f.bytes(), TL_PATHS.map(file => TL.after[file]))
  assert.deepEqual(await inodes(), before)
  assert.deepEqual(f.commands, [['throughline', ['harness-entries', '--json', '--home', f.home], f.home]])
  assert.deepEqual([...new Set(f.requests.map(([method]) => method))], ['config/read', 'hooks/list'])
  assert.deepEqual(f.reports, [])
  const applied = JSON.parse(await f.read('.bellteam-cli-registration/applied.json'))
  assert.deepEqual(applied.throughline.entries, ['codex:settings:features.hooks', 'claude:hooks:SessionStart', 'claude:hooks:Stop', 'claude:hooks:UserPromptSubmit', 'codex:hooks:PreCompact', 'codex:hooks:UserPromptSubmit', 'codex:hooks:PostToolUse', 'codex:hooks:Stop', 'cursor:hooks:sessionStart', 'cursor:hooks:beforeSubmitPrompt', 'cursor:hooks:stop', 'grok:hooks'])
})

test('an empty seat gets the same hook bytes as throughline install plus the old RTK pass (throughline before rtk)', async () => {
  const f = await tlSeat()
  await f.apply()
  assert.deepEqual(f.reports, [])
  assert.deepEqual(await f.bytes(), TL_PATHS.map(file => TL.after[file]))
})

test('codex features.hooks is written through config/batchWrite only while the key is absent; an explicit false stays', async () => {
  const absent = await tlSeat(TL.after, { features: {} })
  await absent.apply()
  assert.deepEqual(absent.requests.filter(([method]) => method === 'config/batchWrite').map(([, params]) => params), [{ edits: [{ keyPath: 'features.hooks', value: true, mergeStrategy: 'upsert' }], filePath: join(absent.home, '.codex/config.toml') }])
  assert.ok(JSON.parse(await absent.read('.bellteam-cli-registration/applied.json')).throughline.entries.includes('codex:settings:features.hooks'))
  const off = await tlSeat(TL.after, { features: { hooks: false } })
  await off.apply()
  assert.deepEqual(off.requests.filter(([method]) => method === 'config/batchWrite'), [])
  assert.ok(!JSON.parse(await off.read('.bellteam-cli-registration/applied.json')).throughline.entries.includes('codex:settings:features.hooks'))
  assert.deepEqual(off.reports, [])
})

test('a settings key outside the allowlist is reported and skipped while the product hooks still apply', async () => {
  const f = await tlSeat({}, { e1: { ...TL.e1, settings: { codex: { 'features.hooks': true, 'approval_policy': 'never' }, claude: { theme: 'x' } } } })
  await f.apply()
  assert.deepEqual(f.reports, ['BellTeam 設定 throughline: codex の approval_policy は許可された設定ではないので適用しません', 'BellTeam 設定 throughline: claude の theme は許可された設定ではないので適用しません'])
  assert.deepEqual(await f.bytes(), TL_PATHS.map(file => TL.after[file]))
})

test('a failed or unreadable E1 command keeps the seat as it was and reports only the program and exit code', async () => {
  const secret = 'sk-live-secret'
  for (const [options, expected] of [
    [{ fail: Object.assign(new Error(`Command failed: throughline harness-entries ${secret}`), { cmd: `throughline harness-entries ${secret}`, code: 2 }) }, /throughline が終了コード 2 で失敗しました/u],
    [{ e1: `not json ${secret}` }, /JSON として読めません/u],
  ]) {
    const f = await tlSeat(TL.after, options)
    await f.apply()
    assert.deepEqual(await f.bytes(), TL_PATHS.map(file => TL.after[file]))
    assert.match(f.reports[0], /throughline.*E1を使えない/u)
    assert.match(f.reports[0], expected)
    assert.doesNotMatch(f.reports.join('\n'), new RegExp(secret, 'u'))
    assert.deepEqual(f.requests.filter(([method]) => method === 'config/batchWrite'), [])
  }
})

// bd14 fourth switch: Aiterm's E1 is printed by `aiterm-setup harness-entries` (0.70.58); command parts take {name} values from `vars`.
// The fixture freezes the E1 and the bytes the old path (configureNativeExecutionHooks, real Aiterm 0.70.58 + real Codex app-server on temp homes) left from three starting states.
const AT = JSON.parse(await readFile(new URL('./fixtures/aiterm-switch.json', import.meta.url), 'utf8'))
const AT_PATHS = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json']
const E2_AITERM = JSON.parse(await readFile(new URL('../config/harness-products.json', import.meta.url), 'utf8')).find(item => item.product === 'aiterm')
const atFile = (text, home) => text === null ? null : text.replaceAll('@HOME@', home)

async function aitermSeat(before = {}, { vars = AT.vars, command = E2_AITERM.command } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bellteam-aiterm-entries-'))
  const home = join(dir, 'home')
  for (const [file, text] of Object.entries(before)) if (text !== null) {
    await mkdir(join(home, file, '..'), { recursive: true })
    await writeFile(join(home, file), atFile(text, home))
  }
  await writeFile(join(dir, 'registry.json'), JSON.stringify([{ product: 'aiterm', command }]))
  const requests = [], reports = [], commands = []
  const run = async (program, args) => { commands.push([program, args]); return { stdout: atFile(JSON.stringify(AT.e1), home) } }
  const appServer = async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    const source = await realpath(join(home, '.codex/hooks.json'))
    const hooks = []
    for (const [event, groups] of Object.entries(JSON.parse(await readFile(source, 'utf8')).hooks ?? {}))
      groups.forEach((group, gi) => group.hooks.forEach((hook, hi) => hooks.push({ key: `${source}:${event}:${gi}:${hi}`, command: hook.command, sourcePath: source, enabled: true, trustStatus: 'trusted', currentHash: 'h' })))
    return { data: [{ hooks }] }
  })
  const apply = () => configureHarnessEntries(home, { vars, registry: join(dir, 'registry.json'), run, appServer, report: message => reports.push(message) })
  const read = file => readFile(join(home, file), 'utf8').catch(() => null)
  return { home, requests, reports, commands, apply, read, bytes: () => Promise.all(AT_PATHS.map(read)) }
}

// claude and cursor: the same bytes. codex: Aiterm's own writer printed compact JSON, BellTeam writes every hook file as 2-space JSON like the RTK and Throughline passes: same content, so the expectation is the old content in BellTeam's format.
const oldBytes = (name, home) => AT_PATHS.map(file => {
  const text = atFile(AT.cases[name].after[file], home)
  return file === '.codex/hooks.json' ? `${JSON.stringify(JSON.parse(text), null, 2)}\n` : text
})

for (const name of ['empty', 'seat', 'noaiterm']) {
  test(`Aiterm hooks from E1 give the old configureNativeExecutionHooks content (${name})`, async () => {
    const f = await aitermSeat(AT.cases[name].before)
    await f.apply()
    assert.deepEqual(f.reports, [])
    assert.deepEqual(await f.bytes(), oldBytes(name, f.home))
    assert.deepEqual(f.commands, [['aiterm-setup', ['harness-entries', '--json', '--home', f.home, '--state-root', AT.vars.stateRoot, '--socket', AT.vars.socket,
      '--steer-provider', AT.vars.steerProvider, '--codex-binary', AT.vars.codexBinary, '--clients', 'claude,cursor,codex']]])
    const applied = JSON.parse(await f.read('.bellteam-cli-registration/applied.json'))
    assert.deepEqual(applied.aiterm.entries, ['claude:hooks:PreToolUse', 'claude:hooks:PostToolUse', 'claude:hooks:SessionEnd', 'cursor:hooks:afterMCPExecution', 'cursor:hooks:postToolUse', 'codex:hooks:PostToolUse', 'codex:hooks:Stop'])
  })
}

test('the old writer left a seat byte-for-byte as it was; the new pass writes nothing on it (same inode, trust only read)', async () => {
  for (const file of AT_PATHS) assert.equal(AT.cases.seat.after[file], AT.cases.seat.before[file])
  const f = await aitermSeat(AT.cases.seat.before)
  const inodes = async () => (await Promise.all(AT_PATHS.map(file => stat(join(f.home, file))))).map(info => info.ino)
  const before = await inodes()
  await f.apply()
  await f.apply()
  assert.deepEqual(await f.bytes(), AT_PATHS.map(file => atFile(AT.cases.seat.before[file], f.home)))
  assert.deepEqual(await inodes(), before)
  assert.deepEqual([...new Set(f.requests.map(([method]) => method))], ['hooks/list'])
  assert.deepEqual(f.reports, [])
})

test('an E2 command part takes {name} from vars (and {home} from the seat) and nothing else is changed in the part', async () => {
  const f = await aitermSeat({}, { command: ['p', '--a={stateRoot}/{socket}', '--h', '{home}', 'plain', '{home}{home}'], vars: { stateRoot: '/s', socket: 'k', home: '/not-the-seat' } })
  await f.apply()
  assert.deepEqual(f.commands, [['p', [`--a=/s/k`, '--h', f.home, 'plain', `${f.home}${f.home}`]]])
})

test('a {name} without a value makes that product E1 unusable: reported, the program is not run, the seat files stay', async () => {
  for (const vars of [{}, { ...AT.vars, steerProvider: undefined }, { ...AT.vars, socket: '' }, { ...AT.vars, codexBinary: null }]) {
    const f = await aitermSeat(AT.cases.seat.before, { vars })
    await f.apply()
    assert.deepEqual(f.commands, [])
    assert.equal(f.reports.length, 1)
    assert.match(f.reports[0], /aiterm.*E1を使えない.*\{(stateRoot|socket|steerProvider|codexBinary)\} の値がありません/u)
    assert.deepEqual(await f.bytes(), AT_PATHS.map(file => atFile(AT.cases.seat.before[file], f.home)))
    assert.deepEqual(f.requests, [])
    assert.equal(JSON.parse(await f.read('.bellteam-cli-registration/applied.json')).aiterm, undefined)
  }
})

// bd14 fifth switch: Approval Box's E1 (0.1.37) and what the real `mcp-lazy wrap-entry` (0.4.0) printed for each raw entry are frozen in the fixture.
const AB = JSON.parse(await readFile(new URL('./fixtures/approval-box-switch.json', import.meta.url), 'utf8'))
const E2_AB = JSON.parse(await readFile(new URL('../config/harness-products.json', import.meta.url), 'utf8')).find(item => item.product === 'approval-box')
const RAW = AB.e1.mcpServers['approval-box']
const ALLOW = AB.e1.permissions.cursor.allow
const at = (value, home) => JSON.parse(JSON.stringify(value).replaceAll('@HOME@', home))
const json = value => `${JSON.stringify(value, null, 2)}\n`
const AB_FILES = ['.claude/settings.json', '.cursor/hooks.json', '.cursor/cli-config.json', '.cursor/mcp.json']

// A seat as production holds it on 2026-11-14: codex, cursor and grok wrapped, claude raw, the hooks and the Cursor allow items in place.
async function abSeat({ relay = AB.relay, claude = RAW.claude, cursorConfig = { permissions: { allow: ['Shell(ls)', ...ALLOW], deny: [] }, version: 1 }, wrap = null, e1: product = AB.e1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bellteam-ab-entries-'))
  const home = join(dir, 'home')
  const wrapped = at(AB.wrapped, home)
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(home, '.cursor'), { recursive: true })
  await writeFile(join(home, '.claude.json'), json({ mcpServers: { 'approval-box': claude === 'wrapped' ? wrapped.claude : claude, other: { url: 'keep' } }, numStartups: 3 }))
  await writeFile(join(home, '.claude/settings.json'), json({ hooks: AB.e1.hooks.claude, model: 'opus' }))
  await writeFile(join(home, '.cursor/hooks.json'), json({ version: 1, hooks: AB.e1.hooks.cursor }))
  await writeFile(join(home, '.cursor/mcp.json'), json({ mcpServers: { 'approval-box': wrapped.cursor } }))
  if (cursorConfig) await writeFile(join(home, '.cursor/cli-config.json'), json(cursorConfig))
  await writeFile(join(dir, 'registry.json'), JSON.stringify([E2_AB]))
  const calls = [], requests = [], reports = [], inputs = []
  const run = async (program, args, options) => {
    calls.push([program, ...args])
    if (program === join(home, '.approval-box/bin/approval-box')) return { stdout: JSON.stringify(product) }
    if (program === AB.relay) {
      const harness = args.find(arg => arg.startsWith('MCP_LAZY_CACHE_DIR=')).split('-').at(-1)
      inputs.push([harness, options.input])
      if (wrap === harness) throw Object.assign(new Error(`Command failed: ${program} ${args.join(' ')}`), { cmd: `${program} ${args.join(' ')}`, code: 1 })
      return { stdout: JSON.stringify(wrapped[harness]) }
    }
    if (program === 'grok' && args[1] === 'list') return { stdout: JSON.stringify([{ ...wrapped.grok, enabled: true, name: 'approval-box', scope: 'user' }]) }
    return { stdout: '' }
  }
  let codex = { ...wrapped.codex, environment_id: 'local', enabled: true, tool_timeout_sec: null }
  const appServer = async (_env, use) => use(async (method, params) => {
    requests.push([method, params])
    if (method === 'config/read') return { config: { mcp_servers: { 'approval-box': codex } } }
    if (method === 'config/batchWrite') codex = { ...codex, ...params.edits[0].value }
  })
  const apply = () => configureHarnessEntries(home, { relay, registry: join(dir, 'registry.json'), run, appServer, report: message => reports.push(message) })
  const read = file => readFile(join(home, file), 'utf8').catch(() => null)
  return { home, calls, requests, reports, inputs, apply, read, wrapped, bytes: () => Promise.all(AB_FILES.map(read)) }
}
const abWrites = calls => calls.filter(call => ['claude', 'grok'].includes(call[0]) && !(call[0] === 'grok' && call[2] === 'list'))

test('Approval Box: a production seat changes only the claude entry (raw to wrapped); hooks, cursor mcp.json, cli-config, codex and grok are not touched', async () => {
  const f = await abSeat()
  const before = await f.bytes()
  const inodes = async () => (await Promise.all(AB_FILES.map(file => stat(join(f.home, file))))).map(info => info.ino)
  const ino = await inodes()
  await f.apply()
  assert.deepEqual(f.reports, [])
  assert.deepEqual(await f.bytes(), before)
  assert.deepEqual(await inodes(), ino)
  assert.deepEqual(f.requests.map(([method]) => method), ['config/read'])
  assert.deepEqual(f.calls.filter(call => call[0] === join(f.home, '.approval-box/bin/approval-box')), [[join(f.home, '.approval-box/bin/approval-box'), 'harness-entries', '--json']])
  // each raw entry goes to the relay on stdin; argv names the relay and the per-client cache dir only
  assert.deepEqual(f.inputs.map(([harness, input]) => [harness, JSON.parse(input)]), ['claude', 'codex', 'cursor', 'grok'].map(harness => [harness, RAW[harness]]))
  assert.deepEqual(f.calls.find(call => call[0] === AB.relay), [AB.relay, 'wrap-entry', '--json', '--relay', AB.relay, '--env', `MCP_LAZY_CACHE_DIR=${f.home}/.cache/mcp-lazy/approval-box-claude`, '--env', 'MCP_LAZY_IDLE_STOP=0'])
  assert.deepEqual(abWrites(f.calls), [
    ['claude', 'mcp', 'remove', 'approval-box', '--scope', 'user'],
    ['claude', 'mcp', 'add-json', 'approval-box', JSON.stringify({ type: 'stdio', command: AB.relay, args: ['/usr/local/bin/node', '/home/bell/.approval-box/runtime/0.1.37/cli.mjs', 'mcp'], env: { MCP_LAZY_CACHE_DIR: `${f.home}/.cache/mcp-lazy/approval-box-claude`, MCP_LAZY_IDLE_STOP: '0' } }), '--scope', 'user'],
  ])
  const applied = JSON.parse(await f.read('.bellteam-cli-registration/applied.json'))
  assert.deepEqual(applied['approval-box'].entries, ['claude:approval-box', 'grok:approval-box', 'cursor:approval-box', 'codex:approval-box', 'claude:hooks:PreToolUse', 'claude:hooks:PostToolUse', 'claude:hooks:Stop', 'claude:hooks:SessionStart', 'claude:hooks:SessionEnd', 'cursor:hooks:afterMCPExecution', 'cursor:hooks:postToolUse', 'cursor:permissions'])
})

test('Approval Box: a seat that already holds the wrapped claude entry is not written at all (second pass)', async () => {
  const f = await abSeat({ claude: 'wrapped' })
  await f.apply()
  assert.deepEqual(abWrites(f.calls), [])
  assert.deepEqual(f.requests.map(([method]) => method), ['config/read'])
  assert.deepEqual(f.reports, [])
})

test('Approval Box: an empty seat gets the four entries, the hooks and the Cursor allow items; cli-config.json is created with allow and deny', async () => {
  const f = await abSeat({ cursorConfig: null })
  await f.apply()
  assert.equal(await f.read('.cursor/cli-config.json'), json({ permissions: { allow: ALLOW, deny: [] } }))
  assert.deepEqual(f.reports, [])
})

test('Cursor permissions.allow appends only the missing E1 items in E1 order and keeps every other item, deny and key', async () => {
  const user = ['Shell(ls)', ALLOW[3], 'Read(~/x)', ALLOW[0]]
  const f = await abSeat({ cursorConfig: { version: 1, permissions: { allow: user, deny: ['Shell(rm)'], extra: 1 }, editor: { vimMode: false } } })
  await f.apply()
  assert.equal(await f.read('.cursor/cli-config.json'), json({ version: 1, permissions: { allow: [...user, ...ALLOW.filter(rule => !user.includes(rule))], deny: ['Shell(rm)'], extra: 1 }, editor: { vimMode: false } }))
  const once = await f.read('.cursor/cli-config.json')
  await f.apply()
  assert.equal(await f.read('.cursor/cli-config.json'), once)
})

test('Approval Box: permissions for another harness or key are reported and skipped, the product still applies', async () => {
  const f = await abSeat({ cursorConfig: { permissions: { allow: [], deny: [] } }, e1: { ...AB.e1, permissions: { ...AB.e1.permissions, gemini: { allow: ['x'] }, cursor: { ...AB.e1.permissions.cursor, deny: ['y'] } } } })
  await f.apply()
  assert.deepEqual(f.reports, ['BellTeam 権限 approval-box: permissions.cursor.deny は適用しません', 'BellTeam 権限 approval-box: permissions.gemini は適用しません'])
  assert.deepEqual(JSON.parse(await f.read('.cursor/cli-config.json')).permissions, { allow: ALLOW, deny: [] })
  assert.equal(abWrites(f.calls).length, 2)
})

test('Approval Box: a failed transform is reported without the entry and that entry stays as the seat holds it; the others still apply', async () => {
  const f = await abSeat({ wrap: 'claude', cursorConfig: { permissions: { allow: [], deny: [] } } })
  await f.apply()
  assert.equal(f.reports.length, 1)
  assert.match(f.reports[0], /approval-box: claude の approval-box をmcp-lazyで包めなかった.*\/usr\/local\/bin\/mcp-lazy が終了コード 1 で失敗しました/u)
  assert.doesNotMatch(f.reports[0], /cli\.mjs|wrap-entry/u)
  assert.deepEqual(abWrites(f.calls), [])
  assert.deepEqual(JSON.parse(await f.read('.claude.json')).mcpServers['approval-box'], RAW.claude)
  assert.deepEqual(JSON.parse(await f.read('.cursor/cli-config.json')).permissions.allow, ALLOW)
  assert.ok(!JSON.parse(await f.read('.bellteam-cli-registration/applied.json'))['approval-box'].entries.includes('claude:approval-box'))
})

test('Approval Box: without an executable relay the raw E1 entry is written, no transform runs', async () => {
  const f = await abSeat({ relay: null })
  await f.apply()
  assert.deepEqual(f.calls.filter(call => call[0] === AB.relay), [])
  assert.deepEqual(f.reports, [])
  // claude already holds the raw entry: nothing to write for it; the wrapped cursor entry takes E1's raw command (E1 wins, the seat's extra env stays)
  assert.deepEqual(abWrites(f.calls).map(call => call.slice(0, 3)), [['grok', 'mcp', 'remove'], ['grok', 'mcp', 'add']])
  assert.equal(JSON.parse(await f.read('.cursor/mcp.json')).mcpServers['approval-box'].command, RAW.cursor.command)
})

test('an E2 wrap value other than mcp-lazy makes that product E1 unusable', async () => {
  const f = await abSeat()
  await writeFile(join(f.home, '../registry.json'), JSON.stringify([{ ...E2_AB, wrap: 'other' }]))
  const before = await f.bytes()
  await f.apply()
  assert.match(f.reports[0], /approval-box.*E1を使えない.*wrap "other" は未対応です/u)
  assert.deepEqual(await f.bytes(), before)
})
