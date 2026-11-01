// Container-only integration. Empty synthetic state and HOME, no credentials.
import assert from 'node:assert/strict'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SeatRuntime } from '../../src/seat-runtime.mjs'
import { BotRegistry } from '../../src/bot-registry.mjs'
import { aitermExecutionRegistration } from '../../src/aiterm-hooks.mjs'
import { createGlobalInstructionsRefresher } from '../../src/global-instructions.mjs'
import { MessageAssets } from '../../src/message-assets.mjs'

const root = '/srv/bellteam', home = '/home/bell'
assert.equal(process.getuid(), 1001)
const seat = new SeatRuntime({ root, home })
const seedPath = join(root, 'state/seed.json')
await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots'),
  projectFiles: seat.projectFiles })
await bots.initialize()
const bot = await bots.create({ name: 'Synthetic seat', harness: 'codex' }, { id: 'bot-synthetic' })
await bots.prepareStartupContext(bot.id, 'synthetic previous session')
await bots.setSchedule(bot.id, { kind: 'once', at: '2099-01-01T00:00:00Z', command: 'printf synthetic' })
assert.equal((await stat(join(root, 'state/bots', bot.id, 'bot.json'))).uid, 1001)
assert.equal((await stat(join(root, 'state/bots', bot.id, 'schedule.json'))).uid, 1001)
assert.equal((await stat(join(bot.project, 'AGENTS.md'))).uid, 1000)
await assert.rejects(readFile(join(bot.project, 'memory/previous-session.md')), { code: 'EACCES' })

const memory = seat.memory(bots)
await memory.initialize()
const entry = await memory.remember({ botId: bot.id, kind: 'fact', content: 'synthetic memory boundary' })
const recalled = await memory.recallMemory({ botId: bot.id, query: 'synthetic memory boundary' })
assert.ok(recalled.items.some(item => item.id === entry.id))
await memory.recordKnowledge({ botId: bot.id, title: 'Synthetic boundary', content: 'synthetic knowledge boundary' })
assert.ok((await memory.searchKnowledge({ botId: bot.id, query: 'synthetic knowledge boundary' })).items.length)

const parentRegistration = await aitermExecutionRegistration()
const registration = await seat.aitermRegistration()
const stateRoot = value => value.args[value.args.indexOf('--state-root') + 1]
assert.notEqual(stateRoot(registration), stateRoot(parentRegistration))
assert.ok(stateRoot(registration).includes('1000'))
await seat.configureHarnesses(bots, registration, { enabled: false })
await createGlobalInstructionsRefresher({ home, ownerProfile: { async get() { return { name: 'Synthetic owner', links: [] } } },
  userRules: { async get() { return 'synthetic seat rule' } },
  write: (home, instructions) => seat.writeInstructions(home, instructions) })()
await assert.rejects(readFile(join(home, '.codex/AGENTS.md')), { code: 'EACCES' })
const inspection = `
import {readFile,stat} from 'node:fs/promises';
const home=${JSON.stringify(home)},project=${JSON.stringify(bot.project)};
const instructions=await readFile(home+'/.codex/AGENTS.md','utf8');
const startup=await readFile(project+'/memory/previous-session.md','utf8');
const git=JSON.parse(await readFile(project+'/.synthetic-git-identity.json','utf8'));
await import('node:fs/promises').then(fs=>fs.writeFile(project+'/private-image.png',Buffer.from([137,80,78,71,13,10,26,10]),{mode:0o600}));
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),
  serverCanaryPresent:Object.hasOwn(process.env,'BELLTEAM_SYNTHETIC_SERVER_SECRET'),
  serverOnlyKeyPresent:Object.hasOwn(process.env,'BELLTEAM_BUGHUB_KEY'),
  startupPreserved:startup.trim()==='synthetic previous session',
  instructionsPreserved:instructions.includes('synthetic seat rule'),
  projectHasGit:(await stat(project+'/.git')).isDirectory(),git}));`
const inspectionResult = await seat.run(process.execPath, ['--input-type=module', '-e', inspection], { acceptNonzero: true })
assert.equal(inspectionResult.code, 0, inspectionResult.stderr)
const { stdout } = inspectionResult
const identity = JSON.parse(stdout)
assert.equal(identity.uid, 1000)
assert.equal(identity.gid, 1000)
assert.equal(identity.serverCanaryPresent, false)
assert.equal(identity.serverOnlyKeyPresent, false)
assert.equal(identity.startupPreserved, true)
assert.equal(identity.instructionsPreserved, true)
assert.equal(identity.projectHasGit, true)
assert.equal(identity.git.uid, 1000)
assert.equal(identity.git.serverCanaryPresent, false)
const assets = new MessageAssets({ root, botsAssetsRoot: join(root, 'state/bots'),
  readImage: (image, max) => seat.readImage(image, max) })
const imagePath = join(bot.project, 'private-image.png')
await assert.rejects(readFile(imagePath), { code: 'EACCES' })
const saved = await assets.save({ owner: bot.id, id: 'synthetic-image', image: { path: imagePath } })
const asset = await assets.open(bot.id, saved.file)
const chunks = []
for await (const chunk of asset.stream) chunks.push(chunk)
assert.deepEqual(Buffer.concat(chunks), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
assert.equal((await stat(join(root, 'state/bots', bot.id, 'messages/assets', saved.file))).uid, 1001)
await bots.remove(bot.id)
await assert.rejects(access(bot.project), { code: 'ENOENT' })
await assert.rejects(access(join(root, 'state/bots', bot.id)), { code: 'ENOENT' })
console.log(JSON.stringify({ passed: true, parentUid: process.getuid(), seat: identity,
  nativeStateRoot: stateRoot(registration), parentStateRoot: stateRoot(parentRegistration),
  profileAndScheduleUid: 1001, projectUid: 1000, memoryAndKnowledgeRoundtrip: true,
  privateSeatFileUnreadableByServer: true, privateImageReadInSeatAndStoredInServerState: true, removedBothRoots: true }))
