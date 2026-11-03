#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
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
    'config/notifications-verification.json', 'config/update-catalog-verification.json',
    'docs/bot-environment.md', 'docs/onboarding.md',
    'services/subscriptions/product.json', 'services/subscriptions/endpoints.json',
    'distribution/server',
    'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'scripts/update-cursor.sh', 'scripts/cursor-update-entrypoint.sh',
    'scripts/seat-exec.c', 'scripts/server-start.c', 'scripts/notifications-start.c',
    'scripts/assert-state-writers-stopped.sh',
    'scripts/install-sce-headers.py',
    'scripts/verify-web-gateway.py', 'scripts/web_gateway_artifact.py',
    'scripts/verify-notifications.py', 'scripts/module_artifact_verifier.py',
    'scripts/verify-update-catalog.py', 'scripts/update_catalog.py',
    'scripts/install-web-gateway-release.py', 'scripts/install-notifications-release.py',
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
  await rm(join(output, 'distribution'), { recursive: true })
  await mkdir(join(output, 'distribution/server'), { recursive: true })
  // Dockerfile uses the same two source paths in repository and public contexts.
  for (const name of ['install-resume-state.sh', 'compose.aiterm-checkpoint.yaml'])
    await copyFile(join(output, name), join(output, 'distribution/server', name))
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
