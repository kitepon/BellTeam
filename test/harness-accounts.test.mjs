import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseLimitText, modelScope } from '../src/claude-limit-text.mjs'
import { HarnessAccounts } from '../src/harness-accounts.mjs'

// 2026-11-08 12:00 UTC
const NOW = Date.UTC(2026, 10, 8, 12, 0)

test('limit text: observed Claude Code forms give scope and reset time', () => {
  const at = text => parseLimitText(text, { now: NOW, timeZone: 'Asia/Tokyo' })
  assert.deepEqual(at("You've hit your weekly limit · resets 8am (UTC)").resetAt, '2026-11-09T08:00:00.000Z')
  assert.equal(at("You've hit your weekly limit · resets 8am (UTC)").scope, 'all')
  assert.equal(at("You've hit your weekly limit · resets Nov 10, 8am (UTC)").resetAt, '2026-11-10T08:00:00.000Z')
  assert.equal(at("You've hit your session limit · resets 11pm (Asia/Tokyo)").resetAt, '2026-11-08T14:00:00.000Z')
  // No zone in the line: the seat process's zone applies (here Asia/Tokyo): 8am JST tomorrow.
  assert.equal(at('Usage limit reached · continuing automatically at 8am · esc to cancel').resetAt, '2026-11-08T23:00:00.000Z')
  assert.equal(at('Usage limit reached · continuing automatically at 8am · esc to cancel').scope, 'all')
  const fable = at("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.")
  assert.deepEqual([fable.scope, fable.resetAt], ['fable', null])
  // The model-limit line (production 2026-11-09, credits off): the model is named after 'keep using'.
  assert.equal(at("You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.").scope, 'fable')
  assert.equal(at("You've hit your usage limit. Visit … or try again at Nov 9th, 2026 12:35 PM.").resetAt, '2026-11-09T03:35:00.000Z')
  // Far future (a mis-parse) or the past is not trusted.
  assert.equal(at("You've hit your weekly limit · resets Dec 30, 8am (UTC)").resetAt, null)
  assert.equal(at("You've hit your usage limit. try again at Aug 8th, 2026 12:35 PM.").resetAt, null)
  assert.equal(at('something else').scope, null)
  assert.deepEqual(['claude-fable-5-1', 'opus', 'claude-sonnet-5-5', 'gpt-x'].map(modelScope), ['fable', 'opus', 'sonnet', null])
})

async function setup(t, { usage = async () => [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bellteam-accounts-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.claude/projects'), { recursive: true })
  await writeFile(join(home, '.claude/settings.json'), '{}')
  await writeFile(join(home, '.claude/.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}')
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { bellteam: { url: 'x' }, other: { url: 'y' } }, projects: { '/p': { hasTrustDialogAccepted: true } }, oauthAccount: { emailAddress: 'a' }, hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.261', numStartups: 9 }))
  let clock = NOW
  const timers = new Map(); let next = 0
  const accounts = new HarnessAccounts({ home, statePath: join(home, 'state.json'), readUsage: usage, now: () => clock,
    timeZone: 'Asia/Tokyo', log: () => {}, timers: { set: (fn, ms) => { timers.set(++next, { fn, at: clock + ms }); return next }, clear: id => timers.delete(id) } })
  const advance = async ms => {
    clock += ms
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn() }
    await accounts.writing; await new Promise(resolve => setImmediate(resolve)); await accounts.writing
  }
  return { home, accounts, advance, timers }
}

test('prepare: create-only symlinks to the 1st root, the 1st config copied except the account, credentials separate', async t => {
  const { home, accounts } = await setup(t)
  await mkdir(join(home, '.bellteam-accounts/claude/2nd'), { recursive: true })
  await writeFile(join(home, '.bellteam-accounts/claude/2nd/settings.json'), '{"own":true}')
  const { configurationRoot, history } = await accounts.prepare('claude', '2nd')
  assert.equal(configurationRoot, join(home, '.bellteam-accounts/claude/2nd'))
  assert.equal(history, 'shared')
  assert.equal(await readlink(join(configurationRoot, 'projects')), join(home, '.claude/projects'))
  // An existing real file is never replaced.
  assert.equal(await readFile(join(configurationRoot, 'settings.json'), 'utf8'), '{"own":true}')
  await assert.rejects(lstat(join(configurationRoot, '.credentials.json')))
  const config = JSON.parse(await readFile(join(configurationRoot, '.claude.json'), 'utf8'))
  // Only the account differs (Owner 2026-11-09): every MCP server and setting of the 1st, not just BellTeam's three.
  assert.deepEqual(Object.keys(config.mcpServers), ['bellteam', 'other'])
  assert.equal(config.projects['/p'].hasTrustDialogAccepted, true)
  assert.equal(config.oauthAccount, undefined)
  assert.deepEqual([config.hasCompletedOnboarding, config.lastOnboardingVersion, config.numStartups], [true, '2.1.261', 9])
  // The slot's own account record and caches stay; a later 1st change reaches the next prepare.
  await writeFile(join(configurationRoot, '.claude.json'), JSON.stringify({ ...config, oauthAccount: { emailAddress: 'b' }, modelAccessCache: { own: 1 } }))
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { bellteam: { url: 'x' }, other: { url: 'y' }, added: { url: 'z' } }, oauthAccount: { emailAddress: 'a' }, modelAccessCache: { first: 1 } }))
  await accounts.prepare('claude', '2nd')
  const again = JSON.parse(await readFile(join(configurationRoot, '.claude.json'), 'utf8'))
  assert.deepEqual([Object.keys(again.mcpServers), again.oauthAccount.emailAddress, again.modelAccessCache], [['bellteam', 'other', 'added'], 'b', { own: 1 }])
  assert.equal(await accounts.loggedIn('claude', '2nd'), false)
  assert.deepEqual(await accounts.prepare('claude', '1st'), { configurationRoot: join(home, '.claude'), history: 'shared' })
  await assert.rejects(accounts.prepare('claude', '3rd'), { code: 'ACCOUNT_SLOT_INVALID' })
})

test('limits are per slot and model scope; selection never refuses; the timer clears at the reset time', async t => {
  const { home, accounts, advance } = await setup(t)
  await accounts.prepare('claude', '2nd')
  await writeFile(join(home, '.bellteam-accounts/claude/2nd/.credentials.json'), '{}')
  // No preference: every model starts on the 1st (Owner ruling 2026-11-09).
  assert.equal((await accounts.selection('claude', 'fable')).slot, '1st')
  assert.equal((await accounts.selection('claude', 'opus')).slot, '1st')
  // A Fable-only limit on the 1st moves only Fable seats (the catalog alias 'fable' included); Opus stays on the 1st.
  const first = await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'fable', text: "You've reached your Fable limit · resets 9pm (Asia/Tokyo)" })
  assert.equal(first.scope, 'fable')
  assert.equal((await accounts.selection('claude', 'fable')).slot, '2nd')
  assert.equal((await accounts.selection('claude', 'claude-fable-5-1')).slot, '2nd')
  assert.equal((await accounts.selection('claude', 'opus')).slot, '1st')
  await accounts.clear(first)
  assert.equal((await accounts.selection('claude', 'fable')).slot, '1st')
  const entry = await accounts.recordLimit({ harness: 'claude', slot: '2nd', model: 'claude-fable-5-1', text: "You've hit your Fable limit · resets 11pm (Asia/Tokyo)" })
  assert.deepEqual([entry.scope, entry.resetAt, entry.resetSource], ['fable', '2026-11-08T14:00:00.000Z', 'message'])
  assert.equal((await accounts.selection('claude', 'claude-fable-5-1')).slot, '1st')
  await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'opus', text: "You've hit your weekly limit · resets 8am (UTC)" })
  // Both limited for fable: the earliest known reset wins, never a refusal.
  assert.equal((await accounts.selection('claude', 'claude-fable-5-1')).slot, '2nd')
  await accounts.setSeat('b1', '2nd')
  const listed = await accounts.list()
  assert.deepEqual(listed.harnesses[0].allLimited, [{ scope: 'fable', earliestResetAt: '2026-11-08T14:00:00.000Z' }])
  assert.deepEqual(listed.harnesses[0].slots[1].seats, ['b1'])
  assert.equal(listed.harnesses[0].slots[0].label, 'a')
  assert.equal(listed.harnesses[0].slots[1].label, null)
  assert.deepEqual(listed.rules, [])
  // Exactly at the reset time, by the timer.
  await advance(2 * 3_600_000 - 1)
  assert.equal(accounts.limitFor('claude', '2nd', 'claude-fable-5-1').length, 1)
  await advance(1)
  assert.equal(accounts.limitFor('claude', '2nd', 'claude-fable-5-1').length, 0)
  // Re-armed after a restart (or a body exchange) from the registry.
  const again = new HarnessAccounts({ home, statePath: join(home, 'state.json'), now: () => NOW + 2 * 3_600_000, log: () => {},
    timers: { set: () => 1, clear: () => {} } })
  await again.load()
  assert.equal(again.limitFor('claude', '1st', 'opus')[0].resetAt, '2026-11-09T08:00:00.000Z')
})

test('no time in the text: usage fills it; unknown resets exit by re-read or a successful turn only', async t => {
  let rows = [{ scope: 'fable', percent: 100, resetsAt: null }]
  const { accounts, advance } = await setup(t, { usage: async () => rows })
  const entry = await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'claude-fable-5-1', text: "You've reached your Fable limit. Run /usage-credits" })
  assert.deepEqual([entry.scope, entry.resetAt], ['fable', null])
  await accounts.turnSucceeded('claude', '1st', 'opus')
  assert.equal(accounts.limitFor('claude', '1st', 'claude-fable-5-1').length, 1)
  rows = [{ scope: 'fable', percent: 100, resetsAt: '2026-11-08T20:00:00.000Z' }]
  await advance(600_000)
  assert.equal(accounts.limitFor('claude', '1st', 'claude-fable-5-1')[0].resetAt, '2026-11-08T20:00:00.000Z')
  // Known time now: a successful turn no longer clears it early.
  await accounts.turnSucceeded('claude', '1st', 'claude-fable-5-1')
  assert.equal(accounts.limitFor('claude', '1st', 'claude-fable-5-1').length, 1)
  const unknown = await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'opus', text: 'Usage limit reached' })
  assert.equal(unknown.resetAt, null)
  await accounts.turnSucceeded('claude', '1st', 'opus')
  // The unknown 'all' entry left; the Fable entry with its known time stays.
  assert.deepEqual(accounts.limitFor('claude', '1st', 'claude-fable-5-1').map(value => value.scope), ['fable'])
})

test('a failing reset write keeps the entry limited and retries after 60 s, not in a hot loop', async t => {
  const { home, accounts, advance, timers } = await setup(t)
  const lines = []; accounts.log = line => lines.push(line)
  await accounts.recordLimit({ harness: 'claude', slot: '1st', model: 'opus', text: "You've hit your session limit · resets 1pm (UTC)" })
  await chmod(home, 0o500)
  try {
    await advance(3_600_000)
    assert.equal(accounts.limitFor('claude', '1st', 'opus').length, 1)
    // One pending retry timer 60 s ahead, nothing due now.
    const pending = [...timers.values()]
    assert.equal(pending.length, 1)
    await advance(0)
    assert.equal([...timers.values()].length, 1)
    await advance(59_999)
    assert.equal(accounts.limitFor('claude', '1st', 'opus').length, 1)
    await advance(1)
    assert.equal(lines.filter(line => line.includes('reset write failed')).length, 1, 'logged once, code only')
  } finally { await chmod(home, 0o700) }
  await advance(60_000)
  assert.equal(accounts.limitFor('claude', '1st', 'opus').length, 0)
})

test('seat-user helper: the stringified script runs alone, makes a traversable root, and a failure is ACCOUNT_ROOT_UNAVAILABLE', async t => {
  const { execFile } = await import('node:child_process')
  const { stat } = await import('node:fs/promises')
  const { seatFilesOver } = await import('../src/harness-accounts.mjs')
  // Stand-in for ports.seat.waitProcess: run the executable, parse stdout (the real one adds sudo seat-exec).
  const waitProcess = ({ executable, args }) => new Promise((resolve, reject) =>
    execFile(executable, args, { cwd: tmpdir() }, (error, stdout) => { try { resolve(JSON.parse(stdout)) } catch { reject(error) } }))
  const { home } = await setup(t)
  const logs = []
  const accounts = new HarnessAccounts({ home, statePath: join(home, 'state.json'), seat: seatFilesOver(waitProcess), log: line => logs.push(line) })
  const { configurationRoot, history } = await accounts.prepare('claude', '2nd')
  assert.equal(history, 'shared')
  assert.equal(await readlink(join(configurationRoot, 'projects')), join(home, '.claude/projects'))
  for (const path of [join(home, '.bellteam-accounts'), join(home, '.bellteam-accounts/claude'), configurationRoot])
    assert.equal((await stat(path)).mode & 0o777, 0o711)
  assert.equal((await stat(join(configurationRoot, '.claude.json'))).mode & 0o777, 0o600)
  assert.equal(await accounts.label('claude', '1st'), 'a')
  await rm(configurationRoot, { recursive: true, force: true })
  await chmod(join(home, '.bellteam-accounts/claude'), 0o500)
  try { await assert.rejects(accounts.prepare('claude', '2nd'), { code: 'ACCOUNT_ROOT_UNAVAILABLE', status: 503 }) }
  finally { await chmod(join(home, '.bellteam-accounts/claude'), 0o700) }
  assert.match(logs.at(-1), /prepare claude 2nd failed \(EACCES\)/)
})

test('parent Aiterm over the seat command carries the account roots (production 2nd-login rejection)', async () => {
  const { AitermClient, seatConnectionEnvironment } = await import('../src/aiterm-client.mjs')
  const client = new AitermClient({ seatProject: '/srv/bellteam' })
  assert.match(client.claudeConfigRoots, /\/\.bellteam-accounts\/claude$/)
  assert.deepEqual(seatConnectionEnvironment('g', client.claudeConfigRoots), ['BELLTEAM_RUNTIME_GENERATION=g', `AITERM_CLAUDE_CONFIG_ROOTS=${client.claudeConfigRoots}`])
  assert.deepEqual(seatConnectionEnvironment('g', null), ['BELLTEAM_RUNTIME_GENERATION=g'])
})

// harness-accounts.md: an unreadable or invalid 1st config never empties the slot's copy (protection: overwriting existing state).
test('prepare keeps the slot config byte-for-byte when the 1st config cannot be read or parsed', async t => {
  const { home, accounts } = await setup(t)
  const { configurationRoot } = await accounts.prepare('claude', '2nd')
  const before = await readFile(join(configurationRoot, '.claude.json'), 'utf8')
  for (const broken of ['{not json', '[]']) {
    await writeFile(join(home, '.claude.json'), broken)
    await assert.rejects(accounts.prepare('claude', '2nd'), { code: 'ACCOUNT_ROOT_UNAVAILABLE' })
    assert.equal(await readFile(join(configurationRoot, '.claude.json'), 'utf8'), before)
  }
})
