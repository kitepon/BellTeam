import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { memberReadTools, memberWriteTools, callMemberTool } from '../src/members/profiles-mcp.mjs'
import { createMemberProfileApi } from '../src/members/profiles-http.mjs'
import { createOwnerApi } from '../src/members/owner-http.mjs'
import { bellTeamTools, callBellTeamTool } from '../src/mcp-tools.mjs'
import { callOwnerTool } from '../src/mcp-owner-tools.mjs'

test('専用プロフィール受付は通常保存と実行設定の公開configureを分け、元の結果/失敗を保持する', async () => {
  const bot = { id: 'bot-a', name: 'Synthetic', avatar: 'data:image/png;base64,AAAA' }
  const registry = new Map([[bot.id, bot]])
  registry.refresh = async () => registry
  const saved = [], configured = [], pending = { applying: true, bot }
  registry.update = async (id, changes) => { saved.push([id, changes]); return { ...bot, ...changes } }
  const configure = async (id, changes) => { configured.push([id, changes]); return pending }
  const context = { from: bot.id, registry, configure }
  assert.deepEqual(await callMemberTool({ ...context, name: 'update_self', args: { role: 'fixture' } }), { bot: { ...bot, role: 'fixture' } })
  assert.equal(await callMemberTool({ ...context, name: 'update_bot', args: { botId: bot.id, model: 'candidate', role: 'fixture' } }), pending)
  assert.deepEqual(saved, [[bot.id, { role: 'fixture' }]])
  assert.deepEqual(configured, [[bot.id, { model: 'candidate', role: 'fixture' }]])
  const refusal = new Error('SYNTHETIC_CONFIGURATION_REFUSED')
  await assert.rejects(callMemberTool({ ...context, name: 'update_self', args: { reasoningEffort: 'high' }, configure: async () => { throw refusal } }), error => error === refusal)
  assert.equal(saved.length, 1)
  const state = { state: 'failed', effect: 'possible' }
  const viewed = await callBellTeamTool({ ...context, name: 'get_self', internalUrl: 'http://synthetic', botView: value => ({ ...value, configurationApplication: state }) })
  assert.equal(viewed.bot.hasAvatar, true)
  assert.equal(viewed.bot.avatarUrl, 'http://synthetic/api/bots/bot-a/avatar')
  assert.equal(Object.hasOwn(viewed.bot, 'avatar'), false)
  assert.deepEqual(viewed.bot.configurationApplication, state)
  await assert.rejects(callMemberTool({ ...context, name: 'get_bot', args: { botId: 'absent' } }), /BOT_NOT_FOUND/u)
  await assert.rejects(callMemberTool({ ...context, name: 'update_user_rules' }), /USER_RULES_INVALID/u)
  for (const tool of [...memberReadTools, ...memberWriteTools]) {
    assert.equal(bellTeamTools.filter(item => item.name === tool.name).length, 1)
    assert.equal(bellTeamTools.find(item => item.name === tool.name), tool)
  }
  assert.equal(bellTeamTools.some(tool => tool.name === 'update_user_rules'), true)
})

test('Bot作成後の記憶領域失敗を隠さず、既に保存したBotを消さない', async () => {
  const registry = new Map(), bot = { id: 'bot-new', name: 'Synthetic' }
  registry.create = async () => { registry.set(bot.id, bot); return bot }
  const failure = new Error('SYNTHETIC_SCOPE_FAILED')
  await assert.rejects(callMemberTool({ name: 'create_bot', args: { name: bot.name }, registry,
    memory: { async ensureScope(id, scope) { assert.deepEqual([id, scope], [bot.id, 'personal']); throw failure } },
  }), error => error === failure)
  assert.equal(registry.get(bot.id), bot)
})

function response() {
  return { status: null, body: null, writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
}

test('プロフィールHTTPは実行担当の公開view/update結果をそのまま公開する', async () => {
  const bot = { id: 'bot-a', name: 'Synthetic' }, bots = new Map([[bot.id, bot]])
  const application = { state: 'pending' }, saved = { bot, applying: true }
  const api = createMemberProfileApi({ bots, administration: {
    view(value) { return { ...value, configurationApplication: application } },
    async update(id, changes) { assert.equal(id, bot.id); assert.deepEqual(changes, { model: 'candidate' }); return saved },
  } })
  const url = new URL('http://synthetic/api/bots/bot-a'), get = response()
  await api({ method: 'GET' }, get, url)
  assert.equal(get.status, 200)
  assert.deepEqual(get.body.bot.configurationApplication, application)
  const request = Readable.from([Buffer.from('{"model":"candidate"}')]); request.method = 'PATCH'
  const patch = response()
  await api(request, patch, url)
  assert.equal(patch.status, 200)
  assert.deepEqual(patch.body, saved)
})

test('HTTP profile/avatar and MCP self use fresh full profiles rather than image-free projection', async () => {
  const bot = { id: 'bot-a', name: 'Synthetic', avatar: 'data:image/png;base64,AAAA' }
  const bots = new Map()
  bots.readMember = async id => { assert.equal(id, bot.id); return bot }
  const api = createMemberProfileApi({ bots, administration: {} })
  const profile = response()
  await api({ method: 'GET' }, profile, new URL('http://synthetic/api/bots/bot-a'))
  assert.equal(profile.body.bot.avatar, bot.avatar)
  const avatar = { status: null, body: null, writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api({ method: 'GET', headers: {} }, avatar, new URL('http://synthetic/api/bots/bot-a/avatar'))
  assert.equal(avatar.status, 200); assert.deepEqual(avatar.body, Buffer.from('AAAA', 'base64'))
  bots.set(bot.id, { id: bot.id, name: bot.name })
  bots.refresh = async () => bots
  const result = await callBellTeamTool({ name: 'get_self', from: bot.id, registry: bots, internalUrl: 'http://synthetic' })
  assert.equal(result.bot.hasAvatar, true); assert.equal(result.bot.avatarUrl, 'http://synthetic/api/bots/bot-a/avatar')
  const unavailable = Object.assign(new Error('MEMBERS_UNAVAILABLE'), { code: 'MEMBERS_UNAVAILABLE', status: 503 })
  bots.readMember = async () => { throw unavailable }
  await assert.rejects(api({ method: 'GET' }, response(), new URL('http://synthetic/api/bots/bot-a')), error => error === unavailable)
})

test('Owner HTTP/MCPは保存だけを行い、専用MCPの境界を変えない（指示の作り直しはmembers、bd14 E4）', async () => {
  const calls = []
  let profile = { name: 'before' }, text = 'before'
  const userRules = { async update(value) { text = value; calls.push('rules-saved'); return text } }
  const ownerProfile = { async update(value) { profile = value; calls.push('profile-saved'); return profile } }
  const api = createOwnerApi({ ownerProfile, userRules })
  for (const [method, path, body] of [
    ['PATCH', '/api/owner', { name: 'saved' }], ['PUT', '/api/user-rules', { text: 'saved' }],
  ]) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]); request.method = method
    const output = response()
    await api(request, output, new URL(path, 'http://synthetic'))
    assert.equal(output.status, 200)
  }
  assert.deepEqual(profile, { name: 'saved' }); assert.equal(text, 'saved')
  assert.deepEqual(calls, ['profile-saved', 'rules-saved'])
  assert.deepEqual(await callOwnerTool({ name: 'update_user_rules', arguments: { text: 'mcp-saved' }, userRules }), { text: 'mcp-saved' })
  const count = calls.length
  await assert.rejects(callOwnerTool({ name: 'update_user_rules', arguments: { text: 'ignored', extra: true }, userRules }), /TOOL_ARGUMENT_INVALID/u)
  assert.equal(calls.length, count)
})
