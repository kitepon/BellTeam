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
  const install = join(root, 'install')
  const image = join(root, 'image')
  await mkdir(install)
  await mkdir(join(image, 'scripts'), { recursive: true })
  for (const path of ['install.sh', 'compose.yaml']) {
    await copyFile(new URL(`../distribution/server/${path}`, import.meta.url), join(install, path))
  }
  await copyFile(new URL('../scripts/update-cursor.sh', import.meta.url), join(image, 'scripts/update-cursor.sh'))
  await copyFile(new URL('../compose.cursor-update.yaml', import.meta.url), join(image, 'compose.cursor-update.yaml'))
  const commands = join(root, 'commands')
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_COMMANDS"
if [ "$2" = config ] && [ "$3" = --images ]; then printf '%s\\n' "\${TEST_IMAGES-fixture-server}"; fi
if [ "$2" = config ] && [ "$3" = --format ]; then printf '%s\\n' 'name: fixture' 'services:' '  bellteam:' '    environment:' '      BELLTEAM_BUGHUB_KEY: synthetic-only' 'volumes:' '  cursor-cli:' '    name: fixture-cursor'; fi
if [ "$2" = port ]; then printf '%s\\n' "$TEST_ENDPOINT"; fi
case "$*" in
  'image inspect fixture-server') exit "\${TEST_INSPECT_EXIT:-0}";;
  'run --pull never --rm --network none --read-only --entrypoint /bin/cat fixture-server /app/'*)
    [ "\${TEST_EXTRACT_EXIT:-0}" = 0 ] || exit "$TEST_EXTRACT_EXIT"
    for path do :; done
    cat "$TEST_IMAGE/\${path#/app/}";;
  *'--no-deps cursor-update') exit "\${TEST_CURSOR_EXIT:-0}";;
esac
`)
  await chmod(join(root, 'bin/docker'), 0o755)
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_COMMANDS: commands, TEST_IMAGE: image }
  for (const [endpoint, url] of [['0.0.0.0:18891', 'http://localhost:18891'], ['192.168.1.25:18891', 'http://192.168.1.25:18891'], ['[::]:18891', 'http://localhost:18891']]) {
    await writeFile(commands, '')
    const { stdout } = await exec('sh', [join(install, 'install.sh')], {
      env: { ...env, TEST_ENDPOINT: endpoint },
    })
    assert.match(stdout, new RegExp(url.replaceAll('.', '\\.')))
    assert.match(stdout, /公式サイトで認証/)
    const calls = (await readFile(commands, 'utf8')).trim().split('\n')
    assert.equal(calls[0], 'compose pull')
    assert.equal(calls[1], 'compose config --images')
    assert.equal(calls[2], 'run --pull never --rm --network none --read-only --entrypoint /bin/cat fixture-server /app/compose.cursor-update.yaml')
    assert.equal(calls[3], 'run --pull never --rm --network none --read-only --entrypoint /bin/cat fixture-server /app/scripts/update-cursor.sh')
    assert.match(calls[4], /^compose run --pull never --rm --no-deps --user root bellteam/)
    assert.equal(calls[5], 'compose stop bellteam')
    assert.equal(calls[6], 'compose config --images')
    assert.equal(calls[7], 'compose config --format yaml')
    assert.equal(calls[8], 'volume inspect fixture-cursor')
    assert.match(calls[9], /compose -f .*compose.cursor-update.yaml run --rm --no-deps cursor-update$/)
    assert.equal(calls[10], 'compose up -d --wait --wait-timeout 120 --pull never')
    assert.equal(calls[11], 'compose port bellteam 4180')
    assert.doesNotMatch(stdout, /synthetic-only/)
  }
  await writeFile(commands, '')
  await assert.rejects(exec('sh', [join(install, 'install.sh')], {
    env: { ...env, TEST_CURSOR_EXIT: '37' },
  }), error => error.code === 37 && /停止したまま/.test(error.stderr))
  assert.doesNotMatch(await readFile(commands, 'utf8'), /compose up /)
  for (const extra of [{ TEST_EXTRACT_EXIT: '23' }, { TEST_IMAGES: 'first\nsecond' }, { TEST_IMAGES: '' }]) {
    await writeFile(commands, '')
    await assert.rejects(exec('sh', [join(install, 'install.sh')], { env: { ...env, ...extra } }))
    assert.doesNotMatch(await readFile(commands, 'utf8'), /compose (run|stop|up) /)
  }
  // ローカルbuildを使うときも、公開版と同じ更新・起動経路で設定を保持する。
  await writeFile(commands, '')
  await exec('sh', [join(install, 'install.sh'), '--no-pull'], {
    env: { ...env, TEST_ENDPOINT: '127.0.0.1:18891' },
  })
  const localCalls = (await readFile(commands, 'utf8')).trim().split('\n')
  assert.deepEqual(localCalls.slice(0, 2), ['compose config --images', 'image inspect fixture-server'])
  assert.ok(!localCalls.includes('compose pull'))
  assert.ok(localCalls.some(call => call.endsWith('--no-deps cursor-update')))
  assert.ok(localCalls.includes('compose up -d --wait --wait-timeout 120 --pull never'))
  await writeFile(commands, '')
  await assert.rejects(exec('sh', [join(install, 'install.sh'), '--no-pull'], {
    env: { ...env, TEST_INSPECT_EXIT: '1' },
  }), error => /先にビルド/.test(error.stderr))
  assert.doesNotMatch(await readFile(commands, 'utf8'), /compose (pull|run|stop|up) /)
  for (const args of [['--unknown'], ['--no-pull', 'extra']]) {
    await writeFile(commands, '')
    await assert.rejects(exec('sh', [join(install, 'install.sh'), ...args], { env }), error => error.code === 2)
    assert.equal(await readFile(commands, 'utf8'), '')
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
    'config/setup-guide.json', 'config/ponytail-LICENSE', 'docs/bot-environment.md', 'docs/onboarding.md',
    'services/subscriptions/product.json', 'services/subscriptions/endpoints.json',
    'compose.cursor-update.yaml', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh',
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
  for (const path of ['compose.cursor-update.yaml', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh']) assert.ok(pathsInArchive.includes(path))
  assert.ok(!pathsInArchive.includes('config/models.json'), 'モデル候補は導入先CLIから取得し古い一覧を同梱しない')
  assert.deepEqual(JSON.parse(await readFile(join(output, 'config/bots.json'), 'utf8')).bots, [])
  for (const path of ['.env', 'runtime/home/auth.json', 'services/subscriptions/keys/private.p8']) assert.ok(!pathsInArchive.includes(path))
  assert.equal(JSON.parse(await readFile(join(output, 'distribution.json'), 'utf8')).sourceCommit, result.sourceCommit)
})
