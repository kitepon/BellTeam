import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-public-bridge-socket-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'bridge'))
  await copyFile(new URL('../distribution/server/compose.yaml', import.meta.url), join(root, 'compose.yaml'))
  for (const name of ['compose.yaml', 'compose.bellteam.yaml', 'install.sh'])
    await copyFile(new URL('../distribution/server/bridge/' + name, import.meta.url), join(root, 'bridge', name))
  await writeFile(join(root, 'bridge/bridge.env'), 'CALL_BRIDGE_IMAGE=fixture:bridge\n')
  return root
}

test('公開Composeは同じprivate state socketだけをBridgeへRO共有する', async t => {
  const root = await fixture(t)
  const compose = resolve(process.env.TEST_COMPOSE ?? '../../integrations/docker-compose/bin/docker-compose')
  const { stdout } = await exec(compose, ['--project-directory', root, '--env-file', 'bridge/bridge.env',
    '-f', 'compose.yaml', '-f', 'bridge/compose.yaml', '-f', 'bridge/compose.bellteam.yaml', 'config', '--format', 'json'], {
    cwd: root, env: { PATH: process.env.PATH, BELLTEAM_SERVER_IMAGE: 'fixture:server' },
  })
  const config = JSON.parse(stdout), normal = config.services.bellteam, bridge = config.services['call-bridge']
  assert.equal(normal.environment.BELLTEAM_CALL_BRIDGE_SOCKET, '/srv/bellteam/state/call-bridge-socket/bellteam.sock')
  assert.equal(bridge.environment.CALL_BRIDGE_BELLTEAM_UNIX, '/run/bellteam/bellteam.sock')
  const socket = bridge.volumes.find(mount => mount.target === '/run/bellteam')
  assert.deepEqual(socket, { type: 'bind', source: root + '/runtime/server-only/state-data/state/call-bridge-socket',
    target: '/run/bellteam', read_only: true, bind: {} })
  const state = normal.volumes.find(mount => mount.target === '/srv/bellteam/state')
  assert.equal(socket.source, state.source + '/call-bridge-socket')
  assert.equal(bridge.volumes.length, 3)
  assert.equal(normal.depends_on, undefined); assert.equal(bridge.depends_on, undefined)
})

test('公開optional installerはprivate socket親を準備し、Bridgeだけを起動する', async t => {
  const root = await fixture(t), bin = join(root, 'bin'), log = join(root, 'calls.jsonl')
  await mkdir(bin)
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify(a)+'\\n');
if(a.includes('config')&&a.includes('--images'))console.log('fixture:bridge');
if(a.includes('run')&&a.at(-1)==='printf "%s:%s" "$(id -u)" "$(id -g)"')console.log('1000:1000');
`)
  await chmod(join(bin, 'docker'), 0o700)
  await exec('sh', ['bridge/install.sh', '--with-bellteam', '--no-pull'], {
    cwd: root, env: { PATH: bin + ':' + process.env.PATH, TEST_CALLS: log },
  })
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
  const prepare = calls.find(args => args.includes('bellteam') && args.includes('run'))
  assert.equal(prepare.at(-1), 'mkdir -p /srv/bellteam/state/call-bridge-socket')
  assert.deepEqual(calls.filter(args => args.includes('up')).map(args => args.at(-1)), ['call-bridge'])
})
