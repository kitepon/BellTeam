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
  assert.equal(folderRefusal({ code: 'FOLDER_MISSING', message: 'FOLDER_MISSING' }, '/x'), 'このフォルダは端末にありません。作るか、あるフォルダを選んでください（/x）。')
  assert.equal(folderRefusal({ code: 'FOLDER_NOT_DIRECTORY', message: 'FOLDER_NOT_DIRECTORY' }, '/x'), 'これはファイルです。フォルダを選んでください（/x）。')
  assert.equal(folderRefusal({ code: 'FOLDER_NOT_WRITABLE', message: 'FOLDER_NOT_WRITABLE' }, '/x'), 'この端末のユーザーが書き込めるフォルダを選んでください（/x）。')
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
  assert.match(f.get('bot-form-error').textContent, /^保存できませんでした。このフォルダは端末にありません。作るか、あるフォルダを選んでください（\/Users\/kite\/BellTeam\/a-b）。$/u)
  assert.equal(create.hidden, false); assert.equal(f.get('verify-bot-save').hidden, true)
  assert.equal(writes[0].createFolder, undefined)

  answer = () => ({ bot: { ...bot('a'), terminalId: 'mac', projectRoot: '/Users/kite/BellTeam/a-b', folderCheck: { checked: false, reason: 'UNREACHABLE', observedAt: 'x' } } })
  create.handlers.click({ preventDefault() {} }); await settle(); await settle()
  assert.deepEqual([writes[1].createFolder, writes[1].terminalId, writes[1].projectRoot], [true, 'mac', '/Users/kite/BellTeam/a-b'])
  assert.equal(f.get('bot-remote-status').textContent, '端末につながらなかったので、フォルダはまだ確かめていません。席を起こす時にもう一度確かめます。')
  assert.equal(f.dialog.open, true); assert.equal(create.hidden, true)

  folder.value = '/Users/kite/Desktop/x'
  answer = () => { throw Object.assign(new Error('FOLDER_NOT_PERMITTED'), { code: 'FOLDER_NOT_PERMITTED', status: 409 }) }
  await f.submit('bot-form')
  assert.match(f.get('bot-form-error').textContent, /開かせてくれません/); assert.equal(create.hidden, true)

  // Owner 09:03: an old members module refused createFolder. A definite refusal is not "result unknown".
  const verify = f.get('verify-bot-save')
  for (const [error, text] of [
    [{ code: 'MEMBERS_INPUT_INVALID', status: 400 }, '保存できませんでした。本体がこの入力にまだ対応していないか、入力の形が違います。本体を「Update」で更新してから、もう一度保存してください。'],
    [{ code: 'SOMETHING_NEW', status: 422 }, '保存できませんでした。サーバーが入力を受け付けませんでした。入力を見直してから、もう一度保存してください。'],
  ]) {
    answer = () => { throw Object.assign(new Error(error.code), error) }
    await f.submit('bot-form')
    assert.equal(f.get('bot-form-error').textContent, text); assert.equal(create.hidden, true); assert.equal(verify.hidden, true)
  }
  // No answer / 5xx stays "unknown" with the GET-only check.
  for (const error of [new TypeError('Failed to fetch'), Object.assign(new Error('HTTP_502'), { status: 502 })]) {
    answer = () => { throw error }
    await f.submit('bot-form')
    assert.match(f.get('bot-form-error').textContent, /^保存結果を確認できませんでした/); assert.equal(create.hidden, true); assert.equal(verify.hidden, false)
  }
  // A later refusal is about a different submission: the earlier GET check goes away.
  answer = () => { throw Object.assign(new Error('MEMBERS_INPUT_INVALID'), { code: 'MEMBERS_INPUT_INVALID', status: 400 }) }
  await f.submit('bot-form'); assert.equal(verify.hidden, true)
})
