import { folderRefusal, sentence, unreachableReason } from './terminals.js?v=__ASSET_VERSION__'

// S6 folder picker (terminals README "Folder picker"): the Owner picks a terminal folder on screen instead of typing it.
export const OLD_BODY_TEXT = 'フォルダを画面で選ぶには、本体を「Update」で更新してください。下の「ほかの方法」からパスを入力することもできます。'

// Windows paths are X:\... (terminals README "Windows and Linux terminals"); the picker follows the served path's form.
const windowsPath = path => /^[A-Za-z]:\\/u.test(path ?? '')
// Entry names never contain / \ NUL, nor : on Windows.
export function folderNameProblem(name, parent = '') {
  if (!name) return 'フォルダの名前を入れてください。'
  if (windowsPath(parent) && (name === '.' || name === '..' || /[/\\:\0]/u.test(name))) return '「/」「\\」「:」「.」「..」は名前に使えません。'
  if (name === '.' || name === '..' || /[/\\\0]/u.test(name)) return '「/」「\\」「.」「..」は名前に使えません。'
  if (new TextEncoder().encode(name).length > 255) return '名前が長すぎます。'
  return ''
}
export const childPath = (parent, name) => windowsPath(parent) ? `${parent.replace(/\\$/u, '')}\\${name}` : parent === '/' ? `/${name}` : `${parent}/${name}`

// A non-null reason is one sentence: folder reasons use the S5 words; connection reasons say the terminal is not reachable now;
// a reached terminal's failure (e.g. COMMAND_FAILED) shows its action alone (terminals S6 screen rule 3).
export function folderReasonText(reason, action, path) {
  if (/^FOLDER_/u.test(reason)) return folderRefusal({ code: reason }, path)
  if (reason === 'TERMINAL_NOT_FOUND') return 'この端末は登録されていません。'
  // action is one sentence when present (Crust #887); absent -> the screen's own sentence alone.
  if (unreachableReason(reason)) return `いまは端末に届きません。${sentence(action)}`
  return sentence(action) || '端末でフォルダを読めませんでした。'
}
export function folderErrorText(error) {
  if (error?.code === 'INVALID_PATH') return 'このパスは使えません。'
  if (error?.code === 'TERMINAL_NOT_FOUND') return 'この端末は登録されていません。'
  if (error?.status === 404 || error?.status === 405) return OLD_BODY_TEXT
  return 'フォルダを読めませんでした。'
}

export function createFolderPicker(root, { api, chosen, onChoose, onOldBody }) {
  const node = (tag, className, text = '') => { const item = document.createElement(tag); if (className) item.className = className; item.textContent = text; return item }
  const button = (text, className = 'upload-button') => { const item = node('button', className, text); item.type = 'button'; return item }
  const pathLine = node('p', 'folder-picker-path')
  const up = button('上へ'), close = button('閉じる', 'text-button')
  const rows = node('div', 'folder-picker-list')
  const status = node('p', 'folder-picker-status'); status.setAttribute('role', 'status')
  const retry = button('もう一度'), choose = button('このフォルダにする', 'upload-button primary'), add = button('新しいフォルダ')
  const nameInput = node('input', 'folder-picker-name'); nameInput.placeholder = '新しいフォルダの名前'; nameInput.maxLength = 255
  const make = button('作る'), createError = node('p', 'folder-picker-status')
  const createRow = node('div', 'folder-picker-create'); createRow.append(nameInput, make, createError); createRow.hidden = true
  const head = node('div', 'folder-picker-head'); head.append(up, close)
  const actions = node('div', 'folder-picker-actions'); actions.append(choose, add)
  root.replaceChildren(head, pathLine, status, retry, rows, actions, createRow)

  // seq drops any reply that is not for the latest list/create of the open picker.
  let seq = 0, terminalId = '', listed = null, again = null, parentPath = null
  const url = (id, tail) => `/api/terminals/${encodeURIComponent(id)}/${tail}`
  function show({ text = '', path = '', parent = null, entries = null, truncated = false }) {
    pathLine.textContent = path
    parentPath = parent ?? null
    up.hidden = parentPath == null
    status.textContent = text
    retry.hidden = !again
    rows.replaceChildren(...(entries ?? []).map(entry => {
      const row = button(entry.path === chosen() ? `${entry.name}　✓ 選んでいます` : entry.name, 'folder-picker-row')
      row.addEventListener('click', () => { void list(entry.path) })
      return row
    }))
    if (entries && !entries.length) status.textContent = 'この中にフォルダはありません。'
    if (truncated) status.textContent = '最初の500件だけ表示しています。'
    actions.hidden = !entries
    if (!entries) createRow.hidden = true
  }
  async function list(path = null) {
    const mine = ++seq, id = terminalId
    listed = null; again = null
    show({ text: 'フォルダを読んでいます…', path: path ?? '' })
    let view
    try { view = await api(url(id, `folders${path ? `?path=${encodeURIComponent(path)}` : ''}`)) }
    catch (error) {
      if (mine !== seq) return
      const text = folderErrorText(error)
      if (text === OLD_BODY_TEXT) onOldBody?.(); else again = () => list(path)
      show({ text, path: path ?? '' })
      return
    }
    if (mine !== seq) return
    if (view?.reason) {
      again = () => list(path)
      show({ text: folderReasonText(view.reason, view.action, view.path ?? path ?? ''), path: view.path ?? path ?? '', parent: view.parent })
      return
    }
    listed = view.path
    show({ path: view.path, parent: view.parent, entries: view.entries ?? [], truncated: view.truncated === true })
  }
  async function create() {
    const name = nameInput.value.trim(), problem = folderNameProblem(name, listed)
    if (problem) { createError.textContent = problem; return }
    if (listed == null) return
    const mine = seq, parent = listed, target = childPath(parent, name)
    make.disabled = true; createError.textContent = '作っています…'
    try {
      const result = await api(url(terminalId, 'folder'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: target, create: true }) })
      if (mine !== seq) return
      if (result?.reason) { createError.textContent = folderReasonText(result.reason, result.action, target); return }
      nameInput.value = ''; createError.textContent = ''; createRow.hidden = true
      onChoose(target, { close: false })
      await list(parent)
      if (listed === parent) status.textContent = `「${name}」を作って、選びました。`
    } catch (error) { if (mine === seq) createError.textContent = error?.code || error?.status ? folderErrorText(error) : 'フォルダを作れたか確かめられませんでした。一覧を見てから、必要ならもう一度押してください。' }
    finally { make.disabled = false }
  }
  up.addEventListener('click', () => { if (parentPath != null) void list(parentPath) })
  close.addEventListener('click', () => picker.close())
  retry.addEventListener('click', () => { void again?.() })
  choose.addEventListener('click', () => { if (listed != null) onChoose(listed, { close: true }) })
  add.addEventListener('click', () => { createRow.hidden = false; createError.textContent = ''; nameInput.focus() })
  make.addEventListener('click', () => { void create() })
  // Enter in the name field must not submit the member form.
  nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void create() } })

  const picker = {
    open(id) { terminalId = id; root.hidden = false; nameInput.value = ''; void list() },
    close() { seq++; root.hidden = true; listed = null; again = null },
    list,
  }
  picker.close()
  return picker
}
