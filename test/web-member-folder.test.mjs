import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotEditor } from '../web/bot-editor.js'
import { folderRefusal, memberFolder } from '../web/terminals.js'
import { editorDOM, bot, models } from './helpers/editor-dom.mjs'
const settle = () => new Promise(resolve => setImmediate(resolve))
const callbacks = { onSaved: async () => {}, onDeleted: async () => {}, onRestarted() {}, onStatus() {}, onMemory() {}, onSheets() {} }

test('member folder default and refusal words follow members S5', () => {
  assert.equal(memberFolder('kite', ' アドミ '), '/Users/kite/BellTeam/アドミ')
  assert.equal(memberFolder('kite', 'a/b:c\0d'), '/Users/kite/BellTeam/a-b-c-d')
  for (const name of ['', ' ', '.', '..', undefined]) assert.equal(memberFolder('kite', name), '/Users/kite/BellTeam/member')
  // #859: the refusal carries only the code (readApiError then gives message === code).
  assert.equal(folderRefusal({ code: 'FOLDER_MISSING', message: 'FOLDER_MISSING' }, '/x'), 'このフォルダはMacにありません。作るか、あるフォルダを選んでください（/x）。')
  assert.equal(folderRefusal({ code: 'FOLDER_NOT_DIRECTORY', message: 'FOLDER_NOT_DIRECTORY' }, '/x'), 'これはファイルです。フォルダを選んでください（/x）。')
  assert.equal(folderRefusal({ code: 'FOLDER_NOT_WRITABLE', message: 'FOLDER_NOT_WRITABLE' }, '/x'), 'このMacのユーザーが書き込めるフォルダを選んでください（/x）。')
  assert.match(folderRefusal({ code: 'FOLDER_NOT_PERMITTED', message: 'FOLDER_NOT_PERMITTED' }, '/x'), /^Macがこのフォルダを開かせてくれません。.*フルディスクアクセスを許可」をオンにしてください（\/x）。$/u)
  assert.equal(folderRefusal({ code: 'FOLDER_NEW', message: 'FOLDER_NEW' }, '/x'), 'このフォルダは使えません（/x）。')
  assert.equal(folderRefusal({ code: 'TERMINAL_NOT_FOUND', message: 'terminal mac is not registered' }, '/x'), 'この端末は登録されていません。')
  assert.equal(folderRefusal({ code: 'BOT_UPDATE_FIELD_INVALID' }, '/x'), null)
})

test('member editor: prefill, FOLDER_MISSING -> create and save again, other refusals no button, unchecked note keeps the dialog open', async t => {
  const f = editorDOM(t), writes = []
  let answer = null
  const editor = createBotEditor(f.dialog, { ...callbacks, api: async (path, options) => {
    if (options?.method) { writes.push(JSON.parse(options.body)); return answer() }
    if (path === '/api/terminals') return { terminals: [{ terminalId: 'mac', user: 'kite', host: 'h' }] }
    return path === '/api/models' ? { models } : { bot: bot('a') }
  } })
  await editor.open(bot('a')); await settle()
  const name = f.get('bot-name'), terminal = f.get('bot-terminal'), folder = f.get('bot-project-root'), create = f.get('bot-create-folder')
  name.value = 'アドミ'; terminal.value = 'mac'; terminal.handlers.change()
  assert.equal(folder.value, '/Users/kite/BellTeam/アドミ')
  // The fake keeps one listener per event (the avatar preview owns name input here); terminal change runs the same refresh.
  name.value = 'a/b'; terminal.handlers.change(); assert.equal(folder.value, '/Users/kite/BellTeam/a-b')
  folder.value = '/Users/kite/work'; name.value = 'c'; terminal.handlers.change(); assert.equal(folder.value, '/Users/kite/work')
  folder.value = '/Users/kite/BellTeam/a-b'

  answer = () => { throw Object.assign(new Error('FOLDER_MISSING'), { code: 'FOLDER_MISSING', status: 409 }) }
  await f.submit('bot-form')
  assert.match(f.get('bot-form-error').textContent, /^このフォルダはMacにありません。作るか、あるフォルダを選んでください（\/Users\/kite\/BellTeam\/a-b）。$/u)
  assert.equal(create.hidden, false); assert.equal(f.get('verify-bot-save').hidden, true)
  assert.equal(writes[0].createFolder, undefined)

  answer = () => ({ bot: { ...bot('a'), terminalId: 'mac', projectRoot: '/Users/kite/BellTeam/a-b', folderCheck: { checked: false, reason: 'UNREACHABLE', observedAt: 'x' } } })
  create.handlers.click({ preventDefault() {} }); await settle(); await settle()
  assert.deepEqual([writes[1].createFolder, writes[1].terminalId, writes[1].projectRoot], [true, 'mac', '/Users/kite/BellTeam/a-b'])
  assert.equal(f.get('bot-remote-status').textContent, 'Macにつながらなかったので、フォルダはまだ確かめていません。席を起こす時にもう一度確かめます。')
  assert.equal(f.dialog.open, true); assert.equal(create.hidden, true)

  folder.value = '/Users/kite/Desktop/x'
  answer = () => { throw Object.assign(new Error('FOLDER_NOT_PERMITTED'), { code: 'FOLDER_NOT_PERMITTED', status: 409 }) }
  await f.submit('bot-form')
  assert.match(f.get('bot-form-error').textContent, /開かせてくれません/); assert.equal(create.hidden, true)
})
