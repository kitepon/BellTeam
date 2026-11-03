import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('actual guest state scanner retains nested secret/data files, excludes only fixture and selection metadata, refuses links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-fixture-state-')); t.after(() => rm(root, { recursive: true, force: true }))
  const state = join(root, 'state')
  for (const path of ['state/secret-values/tool/secrets', 'owner', 'shared/tools/bellteam-settings']) await mkdir(join(root, path), { recursive: true })
  for (const path of ['state/fixture-status.json', 'state/usage-release.json', 'state/usage.lock', 'state/secret-values/tool/secrets/value', 'owner/onboarding.json', 'shared/tools/bellteam-settings/settings.json']) await writeFile(join(root, path), path)
  const source = await readFile(new URL('./helpers/usage-runtime-guest.mjs', import.meta.url), 'utf8')
  const body = source.match(/  const savedState = \(\) => \{[\s\S]*?\n  \}/)?.[0]; assert.ok(body)
  const scan = vm.runInNewContext(`${body}; savedState`, { assert, root, state, lstatSync, readdirSync, fileState: path => { try { return readFileSync(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error } } })
  assert.deepEqual(Object.keys(scan()).sort(), ['owner/onboarding.json', 'shared/tools/bellteam-settings/settings.json', 'state/secret-values/tool/secrets/value', 'shared/onboarding.json', 'shared/subscription.json'].map(path => join(root, path)).sort())
  await symlink(join(state, 'secret-values'), join(state, 'linked'))
  assert.throws(scan, { code: 'ERR_ASSERTION' })
})
