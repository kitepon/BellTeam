import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)

test('配布archiveはcommitから必要な公開ファイルを収録し個人設定を除く', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await copyFile(new URL('../scripts/package-server.mjs', import.meta.url), join(root, 'scripts/package-server.mjs'))
  const paths = [
    'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'src/supervisor.mjs',
    'web/index.html', 'integrations/bellteam.mjs', 'config/common-agents.md', 'config/models.json',
    'config/setup-guide.json', 'config/ponytail-LICENSE', 'docs/bot-environment.md', 'docs/onboarding.md',
    'services/subscriptions/product.json', 'services/subscriptions/endpoints.json',
    'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'src/server-state-transfer.mjs', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh',
    'scripts/seat-exec.c', 'scripts/server-start.c',
    'scripts/assert-state-writers-stopped.sh',
    'runtime/home/auth.json', '.env', 'config/bots.json', 'services/subscriptions/keys/private.p8',
    'distribution/server/bridge/bridge.env',
  ]
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), path === 'config/bots.json' ? '{"bots":[{"id":"owner-private"}]}' : `${path}\n`)
  }
  await mkdir(join(root, 'distribution/server'), { recursive: true })
  for (const path of ['distribution-profile.mjs', 'bots.json', 'compose.yaml', '.env.example', 'README.md', 'install.sh']) {
    await copyFile(new URL(`../distribution/server/${path}`, import.meta.url), join(root, 'distribution/server', path))
  }
  const bridgeFiles = ['compose.yaml', 'compose.bellteam.yaml', 'bridge.env.example', 'README.md', 'install.sh']
  await mkdir(join(root, 'distribution/server/bridge'), { recursive: true })
  for (const name of bridgeFiles) await copyFile(new URL(`../distribution/server/bridge/${name}`, import.meta.url), join(root, 'distribution/server/bridge', name))
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=配布試験', '-c', 'user.email=test@example.com', 'commit', '-qm', '配布試験の入力'], { cwd: root })
  const output = join(root, 'output')
  const result = JSON.parse((await exec(process.execPath, [join(root, 'scripts/package-server.mjs'), output])).stdout)
  const pathsInArchive = (await exec('tar', ['-tzf', result.archive])).stdout.trim().split('\n').map(path => path.replace(/^\.\//, ''))
  assert.ok(pathsInArchive.includes('config/setup-guide.json'))
  assert.ok(pathsInArchive.includes('config/ponytail-LICENSE'))
  assert.ok(pathsInArchive.includes('docs/onboarding.md'))
  for (const name of bridgeFiles) assert.ok(pathsInArchive.includes(`bridge/${name}`))
  assert.ok(!pathsInArchive.includes('bridge/bridge.env'), '利用者のBridge認証設定は配布しない')
  for (const path of ['compose.cursor-update.yaml', 'compose.state-maintenance.json', 'src/server-state-transfer.mjs', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh']) assert.ok(pathsInArchive.includes(path))
  for (const path of ['scripts/seat-exec.c', 'scripts/server-start.c']) assert.ok(pathsInArchive.includes(path))
  assert.ok(!pathsInArchive.includes('config/models.json'), 'モデル候補は導入先CLIから取得し古い一覧を同梱しない')
  assert.deepEqual(JSON.parse(await readFile(join(output, 'config/bots.json'), 'utf8')).bots, [])
  for (const path of ['.env', 'runtime/home/auth.json', 'services/subscriptions/keys/private.p8']) assert.ok(!pathsInArchive.includes(path))
  assert.equal(JSON.parse(await readFile(join(output, 'distribution.json'), 'utf8')).sourceCommit, result.sourceCommit)
})
