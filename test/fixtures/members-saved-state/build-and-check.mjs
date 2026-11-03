import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat, writeFile, rm, copyFile, cp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { BotRegistry } from '../../work/BellTeam-members-20261102/src/bot-registry.mjs'
import { OwnerProfile } from '../../work/BellTeam-members-20261102/src/owner-profile.mjs'
import { UserRules } from '../../work/BellTeam-members-20261102/src/user-rules.mjs'

const directory = dirname(fileURLToPath(import.meta.url)), root = join(directory, 'root')
const repo = join(directory, '../../work/BellTeam-members-20261102')
const source = 'd00ba40b026bf946de2c191403ffa704be655a86'
const sourcePaths = ['src/bot-registry.mjs', 'src/owner-profile.mjs', 'src/user-rules.mjs', 'src/schedule-definition.mjs', 'src/members/state-compatibility.mjs']
const digest = raw => createHash('sha256').update(raw).digest('hex')
const sources = []
for (const path of sourcePaths) {
  const raw = execFileSync('git', ['show', `${source}:${path}`], { cwd: repo })
  assert.deepEqual(await readFile(join(repo, path)), raw)
  sources.push({ path, source, bytes: raw.length, sha256: digest(raw) })
}
await mkdir(root) // Refuse to overwrite a previously fixed fixture.
await mkdir(join(root, 'state'), { mode: 0o700 })
await mkdir(join(directory, 'examples'))
const seedPath = join(directory, 'seed.json')
await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }) + '\n', { mode: 0o600 })
const files = {
  ensureRoot: path => mkdir(path, { recursive: true, mode: 0o700 }),
  claim: path => mkdir(path, { mode: 0o700 }),
  initialize: async () => {}, writeInstructions: async () => {},
  remove: path => rm(path, { recursive: true, force: true }),
}
const options = { seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots'),
  now: () => new Date('2030-01-01T00:00:00.000Z'), id: () => 'schedule-fixture', projectFiles: files,
  models: { forHarness: () => { throw new Error('unexpected live model access') } },
}
const registry = new BotRegistry(options)
await registry.initialize()
await registry.create({ name: 'Synthetic fixture member', harness: 'grok', role: 'Synthetic data only; never launch a real task.' }, { id: 'bot-fixture' })
await registry.setSchedule('bot-fixture', { kind: 'once', name: 'Disabled synthetic schedule', at: '2100-01-01T00:00:00.000Z', enabled: false, prompt: 'Synthetic fixture only; do not execute.' })
const owner = new OwnerProfile({ root }), rules = new UserRules({ root })
await owner.initialize(); await owner.update({ name: 'Synthetic fixture owner', profile: 'Artificial data for isolated module acceptance.' })
await rules.initialize(); await rules.update('Synthetic fixture rules. No real tasks or schedule execution.')

// Use the actual receipt writer, then complete its synthetic cleanup so the base has one active Bot only.
await registry.create({ name: 'Synthetic retired member', harness: 'grok' }, { id: 'bot-fixture-retired' })
const remove = files.remove
files.remove = async () => { throw new Error('synthetic interruption to capture the existing receipt') }
await assert.rejects(registry.remove('bot-fixture-retired'), { code: 'BOT_DELETE_PENDING' })
const example = join(directory, 'examples/deletion-receipt.json')
await copyFile(join(root, 'state/bots/.deleting/bot-fixture-retired.json'), example)
files.remove = remove
await registry.remove('bot-fixture-retired')
await rm(join(root, 'state/bots/.deleting'), { recursive: true })
await rm(seedPath)

async function snapshot(path) {
  const result = {}
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) result[entry.name] = await snapshot(full)
    else {
      const raw = await readFile(full), info = await stat(full, { bigint: true })
      result[entry.name] = { bytes: raw.length, sha256: digest(raw), mode: Number(info.mode & 0o777n), mtimeNs: info.mtimeNs.toString() }
    }
  }
  return result
}
const forbidden = new Proxy({}, { get: () => () => { throw new Error('restore effect forbidden') } })
const before = await snapshot(root)
const restored = new BotRegistry({ ...options, projectFiles: forbidden, onChange: () => { throw new Error('CLI effect forbidden') } })
await restored.restore(); await owner.restore(); await rules.restore()
assert.equal(restored.size, 1)
assert.equal(restored.get('bot-fixture').harness, 'grok')
const schedules = await restored.listSchedules('bot-fixture')
assert.equal(schedules.length, 1); assert.equal(schedules[0].enabled, false); assert.equal(schedules[0].nextRunAt, null)
assert.equal(schedules[0].at, '2100-01-01T00:00:00.000Z')
assert.deepEqual(await restored.readRemovalStates(), { removals: [] })
assert.deepEqual(await snapshot(root), before)

const check = join(directory, '.receipt-validation')
await cp(root, check, { recursive: true })
await mkdir(join(check, 'state/bots/.deleting'))
await copyFile(example, join(check, 'state/bots/.deleting/bot-fixture-retired.json'))
const receiptBefore = await snapshot(check)
const receiptRegistry = new BotRegistry({ ...options, botsRoot: join(check, 'bots'), stateRoot: join(check, 'state/bots'), projectFiles: forbidden })
await receiptRegistry.restore()
assert.equal(receiptRegistry.size, 1)
assert.deepEqual(await receiptRegistry.readRemovalStates(), { removals: [{ botId: 'bot-fixture-retired', active: false, hasIntent: true, retired: false }] })
const listing = await receiptRegistry.listForClient()
assert.equal(listing.length, 2); assert.equal(listing.find(bot => bot.id === 'bot-fixture-retired').deleting, true)
assert.deepEqual(await snapshot(check), receiptBefore)
await rm(check, { recursive: true })

const paths = ['root/state/bots/.initialized', 'root/state/bots/bot-fixture/bot.json', 'root/state/bots/bot-fixture/schedule.json', 'root/owner/profile.json', 'root/owner/user-rules.md', 'examples/deletion-receipt.json']
const documents = []
for (const path of paths) { const raw = await readFile(join(directory, path)); documents.push({ path, bytes: raw.length, sha256: digest(raw) }) }
const manifest = { source, mainWithSameStateSources: '4e01fadcb5edcaa74c010436a47be9cb26eabeec', purpose: 'Synthetic offline acceptance fixture, no real seat/state copied', sources, documents,
  checks: { activeBots: 1, schedules: 1, enabledSchedules: 0, basePendingRemovals: 0, optionalReceiptOnlyPending: true, restoreBytesModeMtimeUnchanged: true, liveModelAccess: 0, nativeCalls: 0, cliCalls: 0, scheduleIssues: 0 },
  optionalReceipt: { sourcePath: 'examples/deletion-receipt.json', targetPath: 'state/bots/.deleting/bot-fixture-retired.json', active: false, hasIntent: true, retired: false, notPartOfBase: true } }
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ source, documents: documents.length, checks: manifest.checks }))
