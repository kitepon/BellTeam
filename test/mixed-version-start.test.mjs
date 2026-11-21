import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { createUsageParentEffects } from '../src/usage-parent-effects.mjs'

// a399 (module-ipc.md "Records between halves that ship apart"): the body and the usage payload are swapped one at a
// time, and the production order is body first. So this body must start the usage child users already run: the usage
// rows of the last catalogs, taken from git as real source trees. Z89 and Z91 failed exactly here, on the lab.
const repo = fileURLToPath(new URL('..', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
// Prereleases the lab refused and nobody installed; a row listed here is not a version a user can have.
const neverShipped = new Set(['3931cd1e5d2be8d368f6b29ede978001549f751f'])
function shippedUsageCommits() {
  if (process.env.BELLTEAM_MIXED_USAGE_COMMITS) return process.env.BELLTEAM_MIXED_USAGE_COMMITS.split(',')
  const found = []
  for (const commit of git('log', '-8', '--format=%H', '--', 'config/update-catalog.json').split('\n').filter(Boolean)) {
    const row = JSON.parse(git('show', `${commit}:config/update-catalog.json`)).releases.find(item => item.componentId === 'usage')
    if (row && !neverShipped.has(row.sourceCommit) && !found.includes(row.sourceCommit)) found.push(row.sourceCommit)
    if (found.length === 2) break
  }
  return found
}
let commits = null
try { commits = shippedUsageCommits() } catch { /* an exported tree without git history has nothing to compare with */ }

for (const commit of commits ?? []) test(`この本体が、配布済みのusageの部品（${commit.slice(0, 8)}）を起動できる`, { timeout: 60000 }, async t => {
  const tree = await mkdtemp(join(tmpdir(), 'bellteam-usage-tree-')), root = await mkdtemp(join(tmpdir(), 'bellteam-mixed-'))
  t.after(() => Promise.all([tree, root].map(path => rm(path, { recursive: true, force: true }))))
  execFileSync('tar', ['-x', '-C', tree], { input: execFileSync('git', ['archive', commit, 'src', 'config', 'services', 'package.json'], { cwd: repo, maxBuffer: 256 * 1024 * 1024 }) })
  await symlink(join(repo, 'node_modules'), join(tree, 'node_modules'))
  await mkdir(join(tree, 'test/fixtures'), { recursive: true })
  await copyFile(join(repo, 'test/fixtures/usage-runtime-child.mjs'), join(tree, 'test/fixtures/usage-runtime-child.mjs'))
  // Stored data from before a353: the setup choice and the guide still name the retired AI.
  await mkdir(join(root, 'state'), { recursive: true }); await mkdir(join(root, 'shared'), { recursive: true })
  await writeFile(join(root, 'shared/onboarding.json'), JSON.stringify({ schema: 'bellteam.onboarding.v1', harness: 'antigravity', guideBotId: 'bot-guide', authSession: null, started: false, complete: false }))
  const bots = new Map([['bot-guide', { id: 'bot-guide', name: '案内役', harness: 'antigravity', project: join(root, 'bots/bot-guide') }]])
  bots.refresh = async () => {}
  const services = { bots, rooms: Object.assign(new Map(), { refresh: async () => {} }), notifications: {}, messenger: {},
    transport: { client: { call: async () => assert.fail('Aiterm is not asked for a retired AI') } } }
  const children = []
  const assembly = createUsageAssembly({ root, getServices: () => services, onState: () => {},
    onEffect: createUsageParentEffects({ getServices: () => services, getFeatures: () => null, seatRuntime: null }),
    spawnProcess: (_entry, args, options) => {
      const child = spawn(process.execPath, [join(tree, 'test/fixtures/usage-runtime-child.mjs'), root, args[0]], { ...options, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
      children.push(child); return child
    } })
  t.after(async () => { await assembly.close().catch(() => {}); for (const child of children) child.kill('SIGKILL') })
  // The same three steps as the body's startup; the last one ends with the ready probe.
  await assembly.initializeSettings(); await assembly.initializeSubscriptions(); await assembly.initializeServices()
  assert.equal(typeof assembly.facade.subscriptions.status().canUseAI, 'boolean')
  assert.equal(assembly.facade.settings.list().length >= 7, true)
})
