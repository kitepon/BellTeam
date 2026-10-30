import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const element = (value = '') => ({ value, files: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn } })

test('light bot list uses versioned images without embedding image data', async () => {
  const calls = []
  const state = { selected: null }
  const api = async path => { calls.push(path); return path.startsWith('/api/bots') ? { bots: [{ id: 'bot-a', avatarVersion: '123', avatar: '' }, { id: 'bot-b', avatarVersion: '' }] } : path === '/api/rooms' ? { rooms: [] } : { owner: {} } }
  const ctx = { state, api, renderOwner() {}, renderBots() {} }
  vm.runInNewContext(extract('async function loadBots()', '\nfunction renderOwner()'), ctx)
  await ctx.loadBots()
  assert(calls.includes('/api/bots?avatar=omit'))
  assert.equal(state.bots[0].avatar, '/api/bots/bot-a/avatar?v=123')
  assert.equal(state.bots[1].avatar, '')
})

test('editing an unchanged image omits avatar; selecting a new one sends its data', async () => {
  const fileInput = element(), zoom = element('1'), nameInput = element('Name'), preview = {}, cropEditor = {}, error = {}
  const canvas = { ...element(), width: 100, height: 100, getContext: () => ({ clearRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,bmV3' }
  let failDecode = true
  const ctx = { URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} }, Image: class { naturalWidth = 100; naturalHeight = 100; async decode() { if (failDecode) throw new Error('invalid image') } }, initials: x => x[0], escapeClass: x => x, applyAvatar(element, bot) { element.avatar = bot.avatar } }
  vm.runInNewContext(extract('function createAvatarEditor(', '\n// アバター画像から代表色'), ctx)
  const editor = ctx.createAvatarEditor({ fileInput, preview, cropEditor, canvas, zoom, nameInput, fallback: 'B', error })
  editor.reset('/api/bots/bot-a/avatar?v=123')
  assert.equal(preview.avatar, '/api/bots/bot-a/avatar?v=123')
  assert.equal(editor.changed(), false)
  const requests = []
  Object.assign(ctx, { state: { inFlight: new Set(), editingBot: { id: 'bot-a' }, bots: [] }, claimSingleFlight: () => true, releaseSingleFlight() {}, botFormError: {}, saveBotButton: {}, botName: element('A'), botProfileText: element(), botPersonality: element(), botSpeechStyle: element(), botPosition: element(), botRole: element(), botColor: element('rose'), botHarness: element('codex'), botReasoningEffort: element('high'), selectedModel: () => '', botAvatarEditor: editor, botDialog: { close() {} }, loadBots: async () => {}, selectBot: async () => {}, api: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { bot: { id: 'bot-a' } } } })
  vm.runInNewContext(extract('async function saveBot(', '\nfunction openMemoryDialog()'), ctx)
  await ctx.saveBot({ preventDefault() {} })
  assert.equal(Object.hasOwn(requests[0].body, 'avatar'), false)
  fileInput.files = [{}]
  await fileInput.handlers.change()
  assert.equal(editor.changed(), false)
  assert.equal(preview.avatar, '/api/bots/bot-a/avatar?v=123')
  failDecode = false
  await fileInput.handlers.change()
  await ctx.saveBot({ preventDefault() {} })
  assert.equal(requests[1].body.avatar, 'data:image/jpeg;base64,bmV3')
})
