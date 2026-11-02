import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const helper = JSON.parse(await readFile(new URL('../distribution/server/compose.aiterm-checkpoint.yaml', import.meta.url), 'utf8'))

test('offline checkpointは席UIDとreadonlyの旧state/HOMEだけを受け取る', () => {
  const service = helper.services['aiterm-checkpoint']
  assert.equal(service.user, '1000:1000')
  assert.equal(service.read_only, true)
  assert.equal(service.network_mode, 'none')
  assert.deepEqual(service.cap_drop, ['ALL'])
  assert.deepEqual(service.security_opt, ['no-new-privileges:true'])
  assert.deepEqual(service.entrypoint, ['/usr/local/bin/node', '/usr/local/lib/node_modules/aiterm-mcp/dist/resume-state-cli.js'])
  assert.deepEqual(service.command, [])
  assert.deepEqual(service.environment, {
    HOME: '/home/bell', CODEX_HOME: '/home/bell/.codex', AITERM_STATE_BASE: '/srv/bellteam-aiterm',
    TMPDIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin',
  })
  assert.equal(service.volumes.length, 2, 'private stateやDocker socketを渡さない')
  assert.deepEqual(service.volumes.map(volume => [volume.type, volume.target, volume.read_only]), [
    ['volume', '/srv/bellteam-aiterm', true], ['bind', '/home/bell', true],
  ])
  assert.equal(service.volumes[0].source, 'aiterm-state')
  assert.equal(service.volumes[0].volume.nocopy, true)
  assert.equal(service.volumes[1].bind.create_host_path, false)
  for (const key of ['privileged', 'cap_add', 'pid', 'ipc', 'devices', 'env_file']) assert.equal(Object.hasOwn(service, key), false)
})

test('checkpointのimageと旧backing/HOMEは未指定ならComposeで拒否する', () => {
  const service = helper.services['aiterm-checkpoint']
  assert.match(service.image, /^\$\{BELLTEAM_SERVER_IMAGE:\?[^}]+\}$/u)
  assert.equal(helper.volumes['aiterm-state'].external, true)
  assert.match(helper.volumes['aiterm-state'].name, /^\$\{BELLTEAM_AITERM_STATE_VOLUME:\?[^}]+\}$/u)
  assert.match(service.volumes[1].source, /^\$\{BELLTEAM_AITERM_CHECKPOINT_HOME:\?[^}]+\}$/u)
})

test('public/internal normalは同じbaseと外部volumeを使いruntimeの世代選択を保持する', async () => {
  for (const file of ['compose.yaml', 'distribution/server/compose.yaml']) {
    const normal = await readFile(new URL('../' + file, import.meta.url), 'utf8')
    assert.match(normal, /AITERM_STATE_BASE: \/srv\/bellteam-aiterm\n/u)
    assert.match(normal, /type: volume\n\s+source: aiterm-state\n\s+target: \/srv\/bellteam-aiterm\n\s+volume:\n\s+nocopy: true/u)
    assert.match(normal, /aiterm-state:\n\s+external: true\n\s+name: \$\{BELLTEAM_AITERM_STATE_VOLUME:-bellteam-aiterm-state\}/u)
  }
})


test('Dockerfileはinternal/public双方の同じsourceからruntimeの固定pathへ同梱する', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /WORKDIR \/app[\s\S]*COPY \. \.\nCOPY distribution\/server\/install-resume-state\.sh distribution\/server\/compose\.aiterm-checkpoint\.yaml \.\//u)
})
