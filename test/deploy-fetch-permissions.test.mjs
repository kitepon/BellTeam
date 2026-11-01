import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('deploy fetch: source objects remain readable while private snapshot umask stays 077', t => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-fetch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const origin = join(root, 'origin'), target = join(root, 'target')
  mkdirSync(origin); mkdirSync(target)
  git(origin, 'init', '-q'); writeFileSync(join(origin, 'public-source'), 'source\n')
  git(origin, 'add', '.')
  git(origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source')
  git(target, 'init', '-q'); git(target, 'remote', 'add', 'origin', origin)
  const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')
  const prelude = script.split("<<'REMOTE'\n")[1].split('if [ -n "$(git status')[0]
  const mask = execFileSync('/bin/sh', ['-s'], { cwd: target, input: prelude + '\numask\n', encoding: 'utf8' }).trim()
  assert.equal(parseInt(mask, 8), 0o077)
  let objects = 0
  for (const dir of readdirSync(join(target, '.git/objects')).filter(name => /^[0-9a-f]{2}$/.test(name))) {
    const path = join(target, '.git/objects', dir)
    assert.equal(statSync(path).mode & 0o005, 0o005)
    for (const object of readdirSync(path)) {
      assert.equal(statSync(join(path, object)).mode & 0o004, 0o004)
      objects++
    }
  }
  assert.ok(objects >= 3)
})
