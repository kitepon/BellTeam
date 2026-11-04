import assert from 'node:assert/strict'
import test from 'node:test'
import { BotAdministration } from '../src/bot-administration.mjs'
import { createMemberProfileApi } from '../src/members/profiles-http.mjs'
import { callBellTeamTool } from '../src/mcp-tools.mjs'

function fixture(present) {
  const bot = { id: 'bot-a', name: 'A', harness: 'codex', session: 'fixture', avatar: 'data:image/png;base64,AAAA' }
  const bots = new Map([[bot.id, bot]])
  bots.refresh = async () => bots
  const administration = new BotAdministration({ bots, transport: {} })
  const existing = { state: 'pending', fields: ['model'], requested: { model: 'next' } }
  administration.applications.set(bot.id, existing)
  const operation = { schema: 'bellteam.automatic-configuration-application.v1', requestId: '12345678-1234-1234-1234-123456789abc',
    state: 'unknown', phase: 'configure', effect: 'possible', laterEffect: 'unknown', stopIntent: 'durable',
    admissionStopped: true, revocation: 'unknown', errorCode: 'AUTOMATIC_CONFIGURATION_UNKNOWN' }
  if (present) administration.automaticConfigurationOperations.set(bot.id, {
    currentRequestId: operation.requestId, records: new Map([[operation.requestId, operation]]),
  })
  return { bot, bots, administration, existing, operation }
}

function verify(bot, f, present) {
  assert.deepEqual(bot.configurationApplication, f.existing)
  assert.equal(Object.hasOwn(bot, 'automaticConfigurationApplication'), present)
  if (present) assert.deepEqual(bot.automaticConfigurationApplication, f.operation)
}

test('HTTP roster and single profile preserve the optional execution snapshot and existing application', async () => {
  for (const present of [true, false]) {
    const f = fixture(present)
    const api = createMemberProfileApi({ bots: f.bots, administration: f.administration,
      transport: { runningBots: async () => new Set() }, store: {}, sources: async () => [] })
    for (const path of ['/api/bots?avatar=omit', '/api/bots/bot-a']) {
      const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
      await api({ method: 'GET' }, response, new URL(path, 'http://fixture'))
      assert.equal(response.status, 200)
      verify(response.body.bot ?? response.body.bots[0], f, present)
    }
  }
})

for (const name of ['get_self', 'get_bot']) test(`${name} retains optional unknown snapshot while removing image bodies`, async () => {
  for (const present of [true, false]) {
    const f = fixture(present)
    const result = await callBellTeamTool({ name, arguments: name === 'get_bot' ? { botId: f.bot.id } : {},
      from: f.bot.id, registry: f.bots, botView: bot => f.administration.view(bot), internalUrl: 'http://fixture' })
    verify(result.bot, f, present)
    for (const field of ['avatar', 'avatarLarge', 'avatarSource', 'avatarLargeSource']) assert.equal(Object.hasOwn(result.bot, field), false)
    assert.equal(result.bot.hasAvatar, true)
    assert.equal(result.bot.avatarUrl, 'http://fixture/api/bots/bot-a/avatar')
  }
})
