import test from 'node:test'
import assert from 'node:assert/strict'
import { childPath, createFolderPicker, folderErrorText, folderNameProblem, folderReasonText, OLD_BODY_TEXT } from '../web/folder-picker.js'
import { Element, editorDOM } from './helpers/editor-dom.mjs'
const settle = () => new Promise(resolve => setImmediate(resolve))

test('folder picker words and name rules follow terminals S6', () => {
  for (const name of ['', '.', '..', 'a/b', 'a\0b', 'あ'.repeat(86)]) assert.notEqual(folderNameProblem(name), '', name)
  assert.equal(folderNameProblem('仕事'), '')
  assert.equal(childPath('/', 'a'), '/a'); assert.equal(childPath('/Users/kite', 'a'), '/Users/kite/a')
  assert.equal(folderReasonText('UNREACHABLE', 'Macが起きているか確かめてください。', '/x'), 'いまは端末に届きません。Macが起きているか確かめてください。')
  assert.equal(folderReasonText('UNREACHABLE', 'Macが起きていて、BellTeamと同じネットワークにつながっているか確かめてから、もう一度お試しください', '/x'), 'いまは端末に届きません。Macが起きていて、BellTeamと同じネットワークにつながっているか確かめてから、もう一度お試しください。')
  for (const reason of ['TERMINAL_UNAVAILABLE', 'REMOTE_AITERM_TOO_OLD', 'CREDENTIAL_UNAVAILABLE']) assert.equal(folderReasonText(reason, undefined, '/x'), 'いまは端末に届きません。')
  assert.match(folderReasonText('FOLDER_NOT_PERMITTED', 'x', '/Users/kite/Desktop'), /^Macがこのフォルダを開かせてくれません。.*（\/Users\/kite\/Desktop）。$/u)
  assert.equal(folderErrorText({ status: 400, code: 'INVALID_PATH' }), 'このパスは使えません。')
  assert.equal(folderErrorText({ status: 404, code: 'TERMINAL_NOT_FOUND' }), 'この端末は登録されていません。')
  assert.equal(folderErrorText({ status: 404 }), OLD_BODY_TEXT)
  assert.equal(folderErrorText(new TypeError('Failed to fetch')), 'フォルダを読めませんでした。')
})

test('folder picker: home, subfolder, up, choose, create, offline with retry, stale reply dropped', async t => {
  editorDOM(t)
  const root = new Element(), calls = [], chosen = []
  let value = '/Users/kite/BellTeam/a', answers = {}
  const picker = createFolderPicker(root, { chosen: () => value, onChoose: (path, options) => { value = path; chosen.push([path, options.close]) },
    api: async (path, options) => { calls.push([path, options?.body]); return answers[path](options) } })
  const [head, pathLine, status, retry, rows, actions, createRow] = root.children
  const [up] = head.children, [choose, add] = actions.children, [nameInput, make, createError] = createRow.children
  assert.equal(root.hidden, true)
  const listing = (path, parent, names) => ({ terminalId: 'mac', path, parent, home: '/Users/kite', entries: names.map(name => ({ name, path: childPath(path, name) })), truncated: false, reason: null, action: null })
  answers['/api/terminals/mac/folders'] = () => listing('/Users/kite', '/Users', ['BellTeam', 'work'])
  picker.open('mac'); await settle()
  assert.equal(root.hidden, false); assert.equal(pathLine.textContent, '/Users/kite'); assert.equal(up.hidden, false)
  assert.deepEqual(rows.children.map(row => row.textContent), ['BellTeam', 'work']); assert.equal(actions.hidden, false)

  answers['/api/terminals/mac/folders?path=%2FUsers%2Fkite%2FBellTeam'] = () => listing('/Users/kite/BellTeam', '/Users/kite', ['a'])
  rows.children[0].handlers.click(); await settle()
  assert.deepEqual(rows.children.map(row => row.textContent), ['a　✓ 選んでいます'])

  // Create refuses bad names on screen, then POSTs once, chooses the new path and relists the same folder.
  add.handlers.click(); assert.equal(createRow.hidden, false)
  nameInput.value = '..'; make.handlers.click(); await settle(); assert.match(createError.textContent, /使えません/)
  answers['/api/terminals/mac/folder'] = () => ({ terminalId: 'mac', path: '/Users/kite/BellTeam/new', exists: true, directory: true, writable: true, reason: null })
  answers['/api/terminals/mac/folders?path=%2FUsers%2Fkite%2FBellTeam'] = () => listing('/Users/kite/BellTeam', '/Users/kite', ['a', 'new'])
  nameInput.value = ' new '; make.handlers.click(); await settle(); await settle()
  assert.deepEqual(JSON.parse(calls.find(([path]) => path === '/api/terminals/mac/folder')[1]), { path: '/Users/kite/BellTeam/new', create: true })
  assert.deepEqual(chosen.at(-1), ['/Users/kite/BellTeam/new', false])
  assert.deepEqual(rows.children.map(row => row.textContent), ['a', 'new　✓ 選んでいます']); assert.equal(createRow.hidden, true)
  assert.equal(status.textContent, '「new」を作って、選びました。')

  choose.handlers.click(); assert.deepEqual(chosen.at(-1), ['/Users/kite/BellTeam', true])

  // Offline: a sentence + もう一度, never an empty list; retry repeats the same request.
  answers['/api/terminals/mac/folders?path=%2FUsers%2Fkite'] = () => ({ terminalId: 'mac', path: '/Users/kite', parent: '/Users', entries: [], reason: 'UNREACHABLE', action: 'Macが起きているか確かめてください。' })
  up.handlers.click(); await settle()
  assert.equal(status.textContent, 'いまは端末に届きません。Macが起きているか確かめてください。')
  assert.equal(rows.children.length, 0); assert.equal(actions.hidden, true); assert.equal(retry.hidden, false)
  answers['/api/terminals/mac/folders?path=%2FUsers%2Fkite'] = () => listing('/Users/kite', '/Users', [])
  retry.handlers.click(); await settle()
  assert.equal(status.textContent, 'この中にフォルダはありません。'); assert.equal(actions.hidden, false)

  // A reply that arrives after close is dropped.
  let release
  answers['/api/terminals/mac/folders'] = () => new Promise(resolve => { release = () => resolve(listing('/Users/kite', '/Users', ['late'])) })
  picker.open('mac'); picker.close(); release(); await settle()
  assert.equal(root.hidden, true); assert.deepEqual(rows.children.map(row => row.textContent), [])
})
