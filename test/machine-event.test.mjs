import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMachineEvent, arrangeMachineRows } from '../web/machine-event.js'
const settle = () => new Promise(resolve => setImmediate(resolve))
class Element {
  children = []; className = ''; dataset = {}; listeners = {}; hidden = false; disabled = false; textContent = ''; value = ''; parent = null
  constructor(tag) { this.tag = tag }
  setAttribute(name, value) { this[name] = value }
  detach() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
  append(...nodes) { for (const node of nodes) { node.detach(); node.parent = this; this.children.push(node) } }
  insertBefore(node, before) { node.detach(); node.parent = this; const at = before ? this.children.indexOf(before) : -1; this.children.splice(at < 0 ? this.children.length : at, 0, node) }
  remove() { this.detach() }
  querySelector(selector) { return all(this, node => '.' + node.className === selector)[0] ?? null }
  addEventListener(type, fn) { this.listeners[type] = fn }
}
const all = (node, match) => [...(match(node) ? [node] : []), ...node.children.flatMap(child => all(child, match))]
const words = node => [node.textContent, ...node.children.map(words)].join(' ')
const buttons = card => all(card, node => node.tag === 'button')
const label = (card, text) => buttons(card).find(button => words(button).includes(text))
test.beforeEach(() => { globalThis.document = { createElement: tag => new Element(tag) } })
const questions = (multiSelect = false, count = 1) => Array.from({ length: count }, (_, i) => ({ header: 'Q' + i, question: '質問' + i, multiSelect, allowOther: true,
  options: [{ index: 1, label: '赤', description: '明るい色' }, { index: 2, label: '青', description: null }] }))
const item = (request, view = 'question') => ({ id: 'me-1-0', kind: 'machine_event', sender: { id: 'b', name: 'A' }, message: 'AskUserQuestion: 質問0',
  machine_event: { view, display: 'show', title: 'AskUserQuestion', text: '質問0', tool: { name: 'Bash', summary: 'ls' }, request } })
const ctx = (calls, changes = [], fail) => ({ sender: 'A', onChanged: request => changes.push(request),
  api: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); if (fail) throw fail; return { request: { request_id: 'r1', status: 'answered' } } } })

test('a single question sends the tapped option at once to the seat request route', async () => {
  const calls = [], changes = []
  const card = renderMachineEvent(item({ request_id: 'r/1', status: 'pending', questions: questions() }), ctx(calls, changes))
  assert.match(words(card), /Aからの質問/); assert.match(words(card), /要対応/); assert.match(words(card), /明るい色/)
  label(card, '青').listeners.click(); label(card, '青').listeners.click(); await settle()
  assert.deepEqual(calls, [{ path: '/api/seat-requests/r%2F1/answer', body: { answers: [{ indexes: [2], other: null }] } }])
  assert.equal(changes[0].status, 'answered')
})

test('several questions and multi-select wait for 送る; picks toggle and Other counts as an answer', async () => {
  const calls = []
  const card = renderMachineEvent(item({ request_id: 'r1', status: 'pending', questions: questions(true, 2) }), ctx(calls))
  const send = label(card, '送る'); assert.equal(send.disabled, true)
  const [red0, red1] = buttons(card).filter(button => words(button).includes('赤'))
  red0.listeners.click(); assert.equal(send.disabled, true)
  const [, other1] = all(card, node => node.tag === 'input'); other1.value = '緑'; other1.listeners.input()
  assert.equal(send.disabled, false)
  const blue0 = buttons(card).filter(button => words(button).includes('青'))[0]
  blue0.listeners.click(); red1.listeners.click(); red1.listeners.click()
  send.listeners.click(); await settle()
  assert.deepEqual(calls[0].body, { answers: [{ indexes: [1, 2], other: null }, { indexes: [], other: '緑' }] })
})

test('a single-choice question: typing Other clears the option, an option clears the text', () => {
  const card = renderMachineEvent(item({ request_id: 'r1', status: 'pending', questions: questions(false, 2) }), ctx([]))
  const [red0] = buttons(card).filter(button => words(button).includes('赤')), [input0] = all(card, node => node.tag === 'input')
  red0.listeners.click(); assert.equal(red0['aria-pressed'], 'true')
  input0.value = 'x'; input0.listeners.input(); assert.equal(red0['aria-pressed'], 'false')
  red0.listeners.click(); assert.equal(input0.value, '')
})

test('a closed request says so, stays disabled; a mismatched answer re-enables the choices', async () => {
  const closed = renderMachineEvent(item({ request_id: 'r1', status: 'pending', questions: questions(true) }), ctx([], [], Object.assign(Error('x'), { code: 'REQUEST_NOT_PENDING', status: 409 })))
  label(closed, '赤').listeners.click(); label(closed, '送る').listeners.click(); await settle()
  assert.match(words(closed), /もう答えを待っていません/); assert.equal(label(closed, '赤').disabled, true)
  const invalid = renderMachineEvent(item({ request_id: 'r1', status: 'pending', questions: questions() }), ctx([], [], Object.assign(Error('x'), { code: 'SEAT_REQUEST_ANSWER_INVALID', status: 400 })))
  label(invalid, '赤').listeners.click(); await settle()
  assert.match(words(invalid), /選び直してください/); assert.equal(label(invalid, '赤').disabled, false)
})

test('answered and expired cards show the chosen labels or the closed line, with no buttons', () => {
  const done = renderMachineEvent(item({ request_id: 'r1', status: 'answered', questions: questions(true), answers: [{ indexes: [1, 2], other: '緑' }] }), ctx([]))
  assert.match(words(done), /「赤、青、緑」と答えました/); assert.equal(buttons(done).length, 0); assert.match(done.className, /is-done/)
  const expired = renderMachineEvent(item({ request_id: 'r1', status: 'expired', questions: questions() }), ctx([]))
  assert.match(words(expired), /もう答えを待っていません/); assert.equal(buttons(expired).length, 0)
})

test('an approval card allows or denies by request id', async () => {
  const calls = []
  const card = renderMachineEvent(item({ request_id: 'r2', status: 'pending' }, 'approval'), ctx(calls))
  assert.match(words(card), /許可待ち/); assert.match(words(card), /Bash: ls/)
  label(card, '断る').listeners.click(); await settle()
  assert.deepEqual(calls, [{ path: '/api/seat-requests/r2/answer', body: { decision: 'deny' } }])
})

const row = (id, view, display, extra = {}, request) => {
  const entry = { id: 'me-' + id + '-0', kind: 'machine_event', sender: { id: 'b', name: 'A' }, message: extra.message ?? view,
    machine_event: { seq: id, view, display, title: extra.title ?? null, text: extra.text ?? '', truncated: extra.truncated === true, fold_group: display === 'fold' ? view : undefined, tool: extra.tool } }
  return entry
}
const draw = (entry, open = false) => { const el = renderMachineEvent(entry, { ...ctx([]), open, onOpen() {}, readRaw: async seq => '{"raw":' + seq + '}' }); el.dataset.id = entry.id; return el }
const order = container => container.children.map(child => child.dataset.machineGroup ? '[' + child.children.filter(c => c.dataset.machineView).map(c => c.dataset.id).join(',') + ']' : child.dataset.id)

test('a fold row is one closed line (open only when the app opened it); show rows are drawn open; a hide value is read as show', () => {
  const fold = draw(row(1, 'tool_result', 'fold', { message: 'tool_result: ok', text: 'ok\nmore' }))
  assert.equal(fold.tag, 'details'); assert.equal(fold.open, false); assert.match(words(fold), /tool_result: ok/)
  assert.equal(draw(row(1, 'tool_result', 'fold', { text: 'x' }), true).open, true)
  assert.equal(draw(row(2, 'words', 'show', { text: 'こんにちは' })).tag, 'div')
  const odd = draw(row(3, 'hook', 'hide', { text: 'x' }))
  assert.equal(odd.hidden, false); assert.equal(odd.dataset.fold, undefined)
  const use = draw(row(4, 'tool_use', 'show', { tool: { id: 'u1', name: 'Bash', summary: 'ls' } }))
  assert.match(words(use), /Bash/); assert.equal(use.dataset.toolId, 'u1')
})

test('a truncated fold row reads the whole stored line on request', async () => {
  const line = draw(row(7, 'tool_result', 'fold', { text: 'cut', truncated: true }), true)
  const more = label(line, '全文を読む'); more.listeners.click(); await settle()
  assert.equal(all(line, node => node.tag === 'pre')[0].textContent, '{"raw":7}'); assert.equal(more.hidden, true)
})

test('arrange: a result sits under its tool use, same-group runs share one line, shows and other groups break a run; idempotent', () => {
  const container = new Element('div'), open = new Set()
  const rows = [
    row(1, 'tool_use', 'show', { tool: { id: 'a', name: 'Bash', summary: 'ls' } }), row(2, 'tool_use', 'show', { tool: { id: 'b', name: 'Read', summary: 'x' } }),
    row(3, 'hook', 'fold'), row(4, 'hook', 'fold'), row(5, 'hook', 'fold'), row(6, 'system', 'fold'),
    row(7, 'tool_result', 'fold', { tool: { id: 'a' } }), row(8, 'tool_result', 'fold', { tool: { id: 'b' } }), row(9, 'tool_result', 'fold', { tool: { id: 'gone' } }),
    row(10, 'words', 'show', { text: 'done' }), row(11, 'tool_result', 'fold', { tool: { id: 'gone2' } }), row(12, 'tool_result', 'fold', { tool: { id: 'gone3' } }),
  ]
  container.append(...rows.map(entry => draw(entry)))
  arrangeMachineRows(container, open)
  const expected = ['me-1-0', 'me-7-0', 'me-2-0', 'me-8-0', '[me-3-0,me-4-0,me-5-0]', 'me-6-0', 'me-9-0', 'me-10-0', '[me-11-0,me-12-0]']
  assert.deepEqual(order(container), expected)
  const group = container.children[4]; assert.match(words(group), /hooks ×3/)
  arrangeMachineRows(container, open); assert.deepEqual(order(container), expected)
  // opening the group opens its members and is remembered for the next arrangement
  group.open = true; group.listeners.toggle()
  arrangeMachineRows(container, open)
  assert.equal(container.children[4].open, true); assert.ok(container.children[4].children.filter(c => c.dataset.machineView).every(c => c.open))
  // a late tool use pulls an orphan result under it (older page arrives)
  const late = draw(row(0, 'tool_use', 'show', { tool: { id: 'gone', name: 'Grep', summary: '' } }))
  container.insertBefore(late, container.children[0]); arrangeMachineRows(container, open)
  assert.deepEqual(order(container).slice(0, 3), ['me-0-0', 'me-9-0', 'me-1-0'])
})
