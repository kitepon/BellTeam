import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BotRegistry } from '../src/bot-registry.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-profile-overlap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'bots', 'member')
  await mkdir(project, { recursive: true })
  const profilePath = join(project, 'bot.json')
  await writeFile(profilePath, JSON.stringify({ schema: 'bellteam.bot.v8', id: 'member',
    name: 'Fixture', harness: 'codex', session: 'old-session', avatar: '' }))
  const registry = new BotRegistry({ seedPath: join(root, 'unused.json'), botsRoot: join(root, 'bots') })
  await registry.refresh()
  return { registry, profilePath }
}

for (const firstKind of ['session', 'avatar']) {
  test(`overlapping ${firstKind} and other profile update retain both changes`, async t => {
    const { registry, profilePath } = await fixture(t)
    const nextAvatar = 'data:image/png;base64,bmV3'
    let entered, release
    const held = new Promise(resolve => { entered = resolve })
    const unblock = new Promise(resolve => { release = resolve })
    const write = registry.writeProfile.bind(registry)
    let firstWrite = true
    registry.writeProfile = async profile => {
      if (firstWrite) { firstWrite = false; entered(); await unblock }
      return write(profile)
    }
    const session = () => registry.updateSession('member', 'new-session')
    const avatar = () => registry.update('member', { avatar: nextAvatar })
    const first = firstKind === 'session' ? session() : avatar()
    await held
    let overlappingRead = false
    const refresh = registry.refresh.bind(registry)
    let blocked = true
    registry.refresh = async () => {
      if (blocked) overlappingRead = true
      return refresh()
    }
    const second = firstKind === 'session' ? avatar() : session()
    try {
      await Promise.resolve()
      assert.equal(overlappingRead, false, 'a second mutation must read after the held write completes')
    } finally {
      blocked = false
      release()
      await Promise.all([first, second])
    }
    const saved = JSON.parse(await readFile(profilePath, 'utf8'))
    assert.equal(saved.session, 'new-session')
    assert.equal(saved.avatar, nextAvatar)
  })
}

test('failed profile write releases the next mutation and preserves its error', async t => {
  const { registry, profilePath } = await fixture(t)
  const write = registry.writeProfile.bind(registry)
  const error = new Error('fixture write failed')
  let first = true
  registry.writeProfile = async profile => {
    if (first) { first = false; throw error }
    return write(profile)
  }
  const failed = assert.rejects(registry.updateSession('member', 'failed-session'), value => value === error)
  const next = registry.update('member', { avatar: 'data:image/png;base64,bmV3' })
  await Promise.all([failed, next])
  const saved = JSON.parse(await readFile(profilePath, 'utf8'))
  assert.equal(saved.avatar, 'data:image/png;base64,bmV3')
  assert.equal(saved.session, 'old-session')
})
