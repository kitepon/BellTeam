import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
    'web/index.html', 'integrations/bellteam.mjs', 'config/common-agents.md', 'config/harness-products.json', 'config/models.json',
    'config/setup-guide.json', 'config/ponytail-LICENSE', 'docs/bot-environment.md', 'docs/onboarding.md',
    'config/web-gateway-verification.json', 'config/web-gateway-trusted-root.jsonl',
    'scripts/verify-web-gateway.py', 'scripts/web_gateway_artifact.py',
    'scripts/install-web-gateway-release.py', 'scripts/install-notifications-release.py',
    'config/notifications-verification.json', 'scripts/module_artifact_verifier.py',
    'scripts/verify-notifications.py', 'scripts/notifications-start.c',
    'config/members-verification.json', 'scripts/verify-members.py', 'scripts/members-start.c', 'scripts/install-members-release.py',
    'config/conversation-verification.json', 'scripts/verify-conversation.py', 'scripts/conversation-start.c', 'scripts/install-conversation-release.py', 'config/memory-verification.json', 'config/usage-verification.json', 'config/diagnostics-verification.json', 'scripts/verify-memory.py', 'scripts/verify-usage.py', 'scripts/verify-diagnostics.py', 'scripts/install-memory-release.py', 'scripts/install-usage-release.py', 'scripts/install-diagnostics-release.py',
    'scripts/verify-update-catalog.py', 'scripts/update_catalog.py', 'config/update-catalog-verification.json',
    'scripts/module-update-service.py', 'scripts/module-update-compose.mjs',
    'scripts/body-quiesce-helper.mjs',
    'scripts/container-update-host.py', 'scripts/install-container-update-code.py', 'scripts/cleanup-deploy-images.py', 'scripts/save-deploy-restore-point.py',
    ...['bellteam-container-update-host.service.in', 'bellteam-update-catalog-refresh.service.in', 'bellteam-update-catalog-refresh.timer', 'compose.overlay.yaml', 'README.md', 'root-code-paths.json'].map(name => 'distribution/server/updater/' + name),
    'services/subscriptions/product.json', 'services/subscriptions/endpoints.json',
    'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'src/server-state-transfer.mjs', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh',
    'scripts/module-start.c', 'scripts/usage-start.c', 'scripts/diagnostics-start.c',
    'scripts/seat-exec.c', 'scripts/server-start.c',
    'scripts/assert-state-writers-stopped.sh',
    'scripts/install-sce-headers.py', 'scripts/import-call-bridge.mjs',
    'distribution/server/install-resume-state.sh',
    'distribution/lattice/package.json', 'distribution/lattice/package-lock.json',
    'config/work-graph-verification.json', 'config/lattice-verification.json', 'config/execution-verification.json',
    'scripts/work-graph-start.c', 'scripts/lattice-start.c', 'scripts/verify-work-graph.py', 'scripts/verify-lattice.py', 'scripts/verify-execution.py',
    'scripts/install-work-graph-release.py', 'scripts/install-lattice-release.py', 'scripts/install-execution-release.py',
    'scripts/module-worker-termination.py', 'scripts/body-preflight.mjs', 'scripts/container-update-service.py', 'scripts/container-update-compose.mjs', 'scripts/read-container-update-normal.mjs',
    'runtime/home/auth.json', '.env', 'config/bots.json', 'services/subscriptions/keys/private.p8',
    'distribution/server/bridge/bridge.env',
  ]
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), path === 'distribution/server/updater/root-code-paths.json' ? JSON.stringify({schema:'bellteam.host-updater.code-paths.v1',files:['scripts/container-update-host.py','install.sh','scripts/cleanup-deploy-images.py','scripts/save-deploy-restore-point.py','scripts/verify-update-catalog.py','scripts/update_catalog.py','scripts/module_artifact_verifier.py','scripts/web_gateway_artifact.py','config/update-catalog-verification.json','config/web-gateway-trusted-root.jsonl','distribution/server/updater/bellteam-container-update-host.service.in','distribution/server/updater/bellteam-update-catalog-refresh.service.in','distribution/server/updater/bellteam-update-catalog-refresh.timer','distribution/server/updater/compose.overlay.yaml'].map(name=>({imagePath:'/app/'+name,installPath:name}))}) : path === 'config/bots.json' ? '{"bots":[{"id":"owner-private"}]}' : `${path}\n`)
  }
  await mkdir(join(root, 'distribution/server'), { recursive: true })
  for (const path of ['distribution-profile.mjs', 'bots.json', 'compose.yaml', 'compose.aiterm-checkpoint.yaml', '.env.example', 'README.md', 'install.sh']) {
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
  assert.equal(await readFile(join(output, 'compose.aiterm-checkpoint.yaml'), 'utf8'),
    await readFile(new URL('../distribution/server/compose.aiterm-checkpoint.yaml', import.meta.url), 'utf8'))
  for (const name of ['install-resume-state.sh', 'compose.aiterm-checkpoint.yaml']) {
    assert.ok(pathsInArchive.includes(name))
    assert.ok(pathsInArchive.includes('distribution/server/' + name))
    assert.equal(await readFile(join(output, name), 'utf8'),
      await readFile(join(output, 'distribution/server', name), 'utf8'))
  }
  for (const name of ['package.json', 'package-lock.json']) assert.ok(pathsInArchive.includes('distribution/lattice/' + name))
  assert.ok(pathsInArchive.includes('config/setup-guide.json'))
  assert.ok(pathsInArchive.includes('config/ponytail-LICENSE'))
  assert.ok(pathsInArchive.includes('docs/onboarding.md'))
  for (const name of bridgeFiles) assert.ok(pathsInArchive.includes(`bridge/${name}`))
  assert.ok(!pathsInArchive.includes('bridge/bridge.env'), '利用者のBridge認証設定は配布しない')
  for (const path of ['compose.cursor-update.yaml', 'compose.state-maintenance.json', 'src/server-state-transfer.mjs', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh']) assert.ok(pathsInArchive.includes(path))
  for (const path of ['scripts/module-start.c', 'scripts/usage-start.c', 'scripts/diagnostics-start.c', 'scripts/seat-exec.c', 'scripts/server-start.c']) assert.ok(pathsInArchive.includes(path))
  assert.ok(pathsInArchive.includes('scripts/install-sce-headers.py'))
  assert.ok(pathsInArchive.includes('scripts/import-call-bridge.mjs'))
  assert.ok(pathsInArchive.includes('config/harness-products.json'))
  for (const path of ['config/web-gateway-verification.json', 'config/web-gateway-trusted-root.jsonl',
    'scripts/verify-web-gateway.py', 'scripts/web_gateway_artifact.py',
    'scripts/install-web-gateway-release.py', 'scripts/install-notifications-release.py',
    'config/notifications-verification.json', 'scripts/module_artifact_verifier.py',
    'scripts/verify-notifications.py', 'scripts/notifications-start.c',
    'config/members-verification.json', 'scripts/verify-members.py', 'scripts/members-start.c', 'scripts/install-members-release.py',
    'config/conversation-verification.json', 'scripts/verify-conversation.py', 'scripts/conversation-start.c', 'scripts/install-conversation-release.py', 'config/memory-verification.json', 'config/usage-verification.json', 'config/diagnostics-verification.json', 'scripts/verify-memory.py', 'scripts/verify-usage.py', 'scripts/verify-diagnostics.py', 'scripts/install-memory-release.py']) assert.ok(pathsInArchive.includes(path))
  const rootCode = JSON.parse(await readFile(join(output, 'distribution/server/updater/root-code-manifest.json'), 'utf8'))
  assert.equal(rootCode.schema, 'bellteam.host-updater.code-manifest.v1')
  assert.equal(rootCode.sourceCommit, result.sourceCommit)
  assert.equal(rootCode.files.length, 14)
  for (const item of rootCode.files) {
    const bytes = await readFile(join(output, item.installPath))
    assert.equal(item.bytes, bytes.length)
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
  assert.ok(!pathsInArchive.includes('updater/root-code-paths.json'))
  assert.ok(!pathsInArchive.includes('config/models.json'), 'モデル候補は導入先CLIから取得し古い一覧を同梱しない')
  assert.deepEqual(JSON.parse(await readFile(join(output, 'config/bots.json'), 'utf8')).bots, [])
  for (const path of ['.env', 'runtime/home/auth.json', 'services/subscriptions/keys/private.p8']) assert.ok(!pathsInArchive.includes(path))
  assert.equal(JSON.parse(await readFile(join(output, 'distribution.json'), 'utf8')).sourceCommit, result.sourceCommit)
  await writeFile(join(root, 'distribution/server/updater/root-code-paths.json'), JSON.stringify({
    schema: 'bellteam.host-updater.code-paths.v1', files: [{ imagePath: '/app/scripts/../../.env', installPath: 'scripts/../../.env' }],
  }))
  await exec('git', ['add', 'distribution/server/updater/root-code-paths.json'], { cwd: root })
  await exec('git', ['-c', 'user.name=配布試験', '-c', 'user.email=test@example.com', 'commit', '-qm', '越境拒否の入力'], { cwd: root })
  await assert.rejects(exec(process.execPath, [join(root, 'scripts/package-server.mjs'), join(root, 'invalid-output')]), /Invalid root updater code path/u)

})
