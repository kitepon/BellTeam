#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
const sourceCommit = stdout.trim()
const output = resolve(process.argv[2] ?? join(root, 'runtime/distribution', sourceCommit.slice(0, 12)))
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
const temporary = await mkdtemp(join(tmpdir(), 'bellteam-distribution-'))
const archive = join(temporary, 'source.tar')
try {
  await exec('git', ['archive', '--format=tar', '-o', archive, sourceCommit,
    'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'src', 'web', 'integrations',
    'config/common-agents.md', 'config/setup-guide.json', 'config/ponytail-LICENSE',
    'config/web-gateway-verification.json', 'config/web-gateway-trusted-root.jsonl',
    'config/notifications-verification.json', 'config/members-verification.json', 'config/memory-verification.json', 'config/update-catalog-verification.json',
    'docs/bot-environment.md', 'docs/onboarding.md',
    'services/subscriptions/product.json', 'services/subscriptions/endpoints.json',
    'distribution/server',
    'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh',
    'scripts/seat-exec.c', 'scripts/server-start.c', 'scripts/notifications-start.c', 'scripts/members-start.c',
    'scripts/assert-state-writers-stopped.sh',
    'scripts/install-sce-headers.py',
    'scripts/verify-web-gateway.py', 'scripts/web_gateway_artifact.py',
    'scripts/verify-notifications.py', 'scripts/verify-members.py', 'scripts/verify-memory.py', 'scripts/module_artifact_verifier.py',
    'scripts/install-web-gateway-release.py', 'scripts/install-notifications-release.py', 'scripts/install-members-release.py', 'scripts/install-memory-release.py',
    'scripts/verify-update-catalog.py', 'scripts/update_catalog.py',
    'scripts/container-update-host.py', 'scripts/install-container-update-code.py', 'scripts/cleanup-deploy-images.py', 'scripts/save-deploy-restore-point.py',
  ], { cwd: root })
  await exec('tar', ['-xf', archive, '-C', output])
  await mkdir(join(output, 'bridge'))
  for (const [source, target] of [
    ['distribution-profile.mjs', 'src/distribution-profile.mjs'],
    ['bots.json', 'config/bots.json'],
    ['compose.yaml', 'compose.yaml'],
    ['compose.aiterm-checkpoint.yaml', 'compose.aiterm-checkpoint.yaml'],
    ['install-resume-state.sh', 'install-resume-state.sh'],
    ['.env.example', '.env.example'],
    ['README.md', 'README.md'],
    ['install.sh', 'install.sh'],
    ...['compose.yaml', 'compose.bellteam.yaml', 'bridge.env.example', 'README.md', 'install.sh'].map(name => [`bridge/${name}`, `bridge/${name}`]),
  ]) await copyFile(join(output, 'distribution/server', source), join(output, target))
  await chmod(join(output, 'install.sh'), 0o755)
  await chmod(join(output, 'bridge/install.sh'), 0o755)
  await rename(join(output, 'distribution/server/updater'), join(output, 'updater'))
  await rm(join(output, 'distribution'), { recursive: true })
  await mkdir(join(output, 'distribution/server'), { recursive: true })
  await rename(join(output, 'updater'), join(output, 'distribution/server/updater'))
  // Dockerfile uses the same two source paths in repository and public contexts.
  for (const name of ['install-resume-state.sh', 'compose.aiterm-checkpoint.yaml'])
    await copyFile(join(output, name), join(output, 'distribution/server', name))
  const codePaths = JSON.parse(await readFile(join(output, 'distribution/server/updater/root-code-paths.json'), 'utf8'))
  if (codePaths.schema !== 'bellteam.host-updater.code-paths.v1' || !Array.isArray(codePaths.files) || !codePaths.files.length)
    throw new Error('Invalid root updater code paths')
  const codeFiles = [], seen = new Set()
  for (const item of codePaths.files) {
    if (Object.keys(item).sort().join(',') !== 'imagePath,installPath'
      || typeof item.imagePath !== 'string' || !/^\/app\/(?:install\.sh|(?:scripts|config)\/[a-zA-Z0-9][a-zA-Z0-9_.-]*|distribution\/server\/updater\/(?:bellteam-container-update-host\.service\.in|bellteam-update-catalog-refresh\.service\.in|bellteam-update-catalog-refresh\.timer|compose\.overlay\.yaml))$/u.test(item.imagePath)
      || item.installPath !== item.imagePath.slice(5) || seen.has(item.imagePath)) throw new Error('Invalid root updater code path')
    seen.add(item.imagePath)
    const file = join(output, item.installPath), info = await lstat(file)
    if (!info.isFile() || info.nlink !== 1) throw new Error('Untrusted root updater code file')
    const bytes = await readFile(file)
    codeFiles.push({ ...item, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(join(output, 'distribution/server/updater/root-code-manifest.json'), JSON.stringify({
    schema: 'bellteam.host-updater.code-manifest.v1', sourceCommit, files: codeFiles,
  }, null, 2) + '\n')
  await writeFile(join(output, 'distribution.json'), JSON.stringify({
    schema: 'bellteam.server.distribution.v1', sourceCommit, profile: 'public',
  }, null, 2) + '\n')
  const compressedArchive = output + '.tar.gz'
  await (await open(compressedArchive, 'wx')).close()
  const format = process.platform === 'darwin' ? ['--no-xattrs'] : []
  await exec('tar', [...format, '--format=ustar', '-czf', compressedArchive, '-C', output, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  console.log(JSON.stringify({ output, archive: compressedArchive, sourceCommit, profile: 'public' }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
