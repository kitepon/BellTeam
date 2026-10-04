import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)

// installerのDocker入口を記録し、正常起動後に接続先を返すことを確認する。
test('installerはDockerの起動完了後に直接接続URLと公式認証の案内を返す', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await copyFile(new URL('../distribution/server/install.sh', import.meta.url), join(root, 'install.sh'))
  const commands = join(root, 'commands')
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_COMMANDS"\nif [ "$2" = port ]; then printf '%s\\n' "$TEST_ENDPOINT"; fi\n`)
  await chmod(join(root, 'bin/docker'), 0o755)
  for (const [endpoint, url] of [['0.0.0.0:18891', 'http://localhost:18891'], ['192.168.1.25:18891', 'http://192.168.1.25:18891'], ['[::]:18891', 'http://localhost:18891']]) {
    await writeFile(commands, '')
    const { stdout } = await exec('sh', [join(root, 'install.sh')], {
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_COMMANDS: commands, TEST_ENDPOINT: endpoint },
    })
    assert.match(stdout, new RegExp(url.replaceAll('.', '\\.')))
    assert.match(stdout, /公式サイトで認証/)
    const calls = (await readFile(commands, 'utf8')).trim().split('\n')
    assert.equal(calls[0], 'compose pull')
    assert.match(calls[1], /^compose run --rm --no-deps --user root bellteam/)
    assert.equal(calls[2], 'compose up -d --wait --wait-timeout 120')
    assert.equal(calls[3], 'compose port bellteam 4180')
  }
})

test('配布archiveはcommitから必要な公開ファイルを収録し個人設定を除く', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await copyFile(new URL('../scripts/package-server.mjs', import.meta.url), join(root, 'scripts/package-server.mjs'))
  const paths = [
    'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'src/supervisor.mjs',
    'web/index.html', 'integrations/bellteam.mjs', 'config/common-agents.md', 'config/models.json',
    'config/setup-guide.json', 'docs/bot-environment.md', 'docs/onboarding.md',
    'services/subscriptions/product.json', 'services/subscriptions/endpoints.json',
    'runtime/home/auth.json', '.env', 'config/bots.json', 'services/subscriptions/keys/private.p8',
  ]
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), path === 'config/bots.json' ? '{"bots":[{"id":"owner-private"}]}' : `${path}\n`)
  }
  await mkdir(join(root, 'distribution/server'), { recursive: true })
  for (const path of ['distribution-profile.mjs', 'bots.json', 'compose.yaml', '.env.example', 'README.md', 'install.sh']) {
    await copyFile(new URL(`../distribution/server/${path}`, import.meta.url), join(root, 'distribution/server', path))
  }
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=配布試験', '-c', 'user.email=test@example.com', 'commit', '-qm', '配布試験の入力'], { cwd: root })
  const output = join(root, 'output')
  const result = JSON.parse((await exec(process.execPath, [join(root, 'scripts/package-server.mjs'), output])).stdout)
  const pathsInArchive = (await exec('tar', ['-tzf', result.archive])).stdout.trim().split('\n').map(path => path.replace(/^\.\//, ''))
  assert.ok(pathsInArchive.includes('config/setup-guide.json'))
  assert.ok(pathsInArchive.includes('docs/onboarding.md'))
  assert.ok(!pathsInArchive.includes('config/models.json'), 'モデル候補は導入先CLIから取得し古い一覧を同梱しない')
  assert.deepEqual(JSON.parse(await readFile(join(output, 'config/bots.json'), 'utf8')).bots, [])
  for (const path of ['.env', 'runtime/home/auth.json', 'services/subscriptions/keys/private.p8']) assert.ok(!pathsInArchive.includes(path))
  assert.equal(JSON.parse(await readFile(join(output, 'distribution.json'), 'utf8')).sourceCommit, result.sourceCommit)
})
