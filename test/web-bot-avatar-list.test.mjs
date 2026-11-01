import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createAvatarEditor } from '../web/avatar-editor.js'

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

test('editing an unchanged image omits avatar; selecting a new one sends its data', async t => {
  const fileInput = element(), zoom = element('1'), nameInput = element('Name'), preview = {}, cropEditor = {}, error = {}
  const canvas = { ...element(), width: 100, height: 100, getContext: () => ({ clearRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,bmV3' }
  let failDecode = true
  const ctx = { URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} }, Image: class { naturalWidth = 100; naturalHeight = 100; async decode() { if (failDecode) throw new Error('invalid image') } }, initials: x => x[0], escapeClass: x => x, applyAvatar(element, bot) { element.avatar = bot.avatar } }
  const originalImage = globalThis.Image
  globalThis.Image = ctx.Image
  t.after(() => { globalThis.Image = originalImage })
  t.mock.method(URL, 'createObjectURL', ctx.URL.createObjectURL)
  t.mock.method(URL, 'revokeObjectURL', ctx.URL.revokeObjectURL)
  const editor = createAvatarEditor({ ...ctx, fileInput, preview, cropEditor, canvas, zoom, nameInput, fallback: 'B', error })
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

test('avatar decoding cannot overwrite a newer selection or a reset/closed editor', async t => {
  const pending = [], revoked = []
  const originalImage = globalThis.Image
  globalThis.Image = class {
    naturalWidth = 100; naturalHeight = 100
    decode() { return new Promise((resolve, reject) => pending.push({ resolve, reject })) }
  }
  t.after(() => { globalThis.Image = originalImage })
  let counter = 0
  t.mock.method(URL, 'createObjectURL', () => `blob:${++counter}`)
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url))
  const fileInput = element(), zoom = element('1'), preview = {}, error = {}
  let draws = 0
  const canvas = { ...element(), width: 100, height: 100, getContext: () => ({ clearRect() {}, drawImage() { draws++ } }), toDataURL: () => 'data:image/jpeg;base64,new' }
  const editor = createAvatarEditor({ fileInput, zoom, preview, error, canvas, cropEditor: {}, nameInput: element('Bot'), fallback: 'B', initials: x => x[0], escapeClass: x => x, applyAvatar: (element, bot) => { element.avatar = bot.avatar } })
  fileInput.files = [{}]
  const first = fileInput.handlers.change(), second = fileInput.handlers.change()
  pending[1].resolve(); await second
  const afterSecond = draws
  pending[0].resolve(); await first
  assert.equal(draws, afterSecond)
  const third = fileInput.handlers.change()
  editor.reset('/api/bots/new/avatar')
  pending[2].resolve(); await third
  assert.equal(editor.value(), '/api/bots/new/avatar')
  assert.equal(editor.changed(), false)
  const fourth = fileInput.handlers.change()
  editor.cancelRead()
  pending[3].reject(new Error('old failure')); await fourth
  assert.equal(error.textContent, undefined)
  assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2', 'blob:3', 'blob:4'])
})
