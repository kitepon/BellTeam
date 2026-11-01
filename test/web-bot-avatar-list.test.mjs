import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createBotEditor } from '../web/bot-editor.js'
import { editorDOM, bot, models } from './helpers/editor-dom.mjs'
import { createAvatarEditor } from '../web/avatar-editor.js'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const element = (value = '') => ({ value, files: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn } })

test('light bot list uses versioned images without embedding image data', async () => {
  const calls = []
  const state = { selected: null }
  const api = async path => { calls.push(path); return path.startsWith('/api/bots') ? { bots: [{ id: 'bot-a', avatarVersion: '123', avatar: '' }, { id: 'bot-b', avatarVersion: '' }] } : path === '/api/rooms' ? { rooms: [] } : { owner: {} } }
  const ctx = { catalogueRead: 0, state, api, renderOwner() {}, renderBots() {} }
  vm.runInNewContext(extract('async function loadBots()', '\nfunction renderOwner()'), ctx)
  await ctx.loadBots()
  assert(calls.includes('/api/bots?avatar=omit'))
  assert.equal(state.bots[0].avatar, '/api/bots/bot-a/avatar?v=123')
  assert.equal(state.bots[1].avatar, '')
})

test('editing an unchanged image omits avatar; selecting a new one sends its data', async t => {
  const f = editorDOM(t), requests = []
  const editor = createBotEditor(f.dialog, { api: async (path, options) => {
    if (options?.method === 'PATCH') { requests.push(JSON.parse(options.body)); return { bot: bot('a') } }
    return path === '/api/models' ? { models } : { bot: bot('a') }
  }, onSaved: async () => {}, onDeleted() {}, onRestarted() {}, onStatus() {}, onMemory() {}, onSheets() {} })
  await editor.open(bot('a'))
  await f.submit('bot-form')
  assert.equal(Object.hasOwn(requests[0], 'avatar'), false)
  await editor.open(bot('a'))
  const originalImage = globalThis.Image
  let failDecode = true
  globalThis.Image = class { naturalWidth = 100; naturalHeight = 100; async decode() { if (failDecode) throw Error('invalid image') } }
  t.after(() => { globalThis.Image = originalImage })
  t.mock.method(URL, 'createObjectURL', () => 'blob:fixture')
  t.mock.method(URL, 'revokeObjectURL', () => {})
  f.get('bot-avatar-file').files = [{}]
  await f.get('bot-avatar-file').handlers.change()
  await f.submit('bot-form')
  assert.equal(Object.hasOwn(requests[1], 'avatar'), false)
  await editor.open(bot('a'))
  failDecode = false
  await f.get('bot-avatar-file').handlers.change()
  await f.submit('bot-form')
  assert.equal(requests[2].avatar, 'data:image/jpeg;base64,bmV3')
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
