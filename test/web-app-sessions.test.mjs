import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADD_APP_TEXT, REQUEST_WARNING, createAppSessions, requestRow, sessionRow } from '../web/app-sessions.js'

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.hidden = false }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
}
const walk = node => [node, ...node.children.flatMap(walk)]
const texts = node => walk(node).map(item => item.textContent).filter(Boolean)
const err = status => Object.assign(new Error('HTTP'), { status })

test('a485: session and request rows say who, how it came in and which one is this browser', () => {
  assert.deepEqual(sessionRow({ id: 's1', kind: 'web', origin: 'phone', current: true, lastUsedAt: 'invalid' }), { id: 's1', current: true, title: 'Web（このブラウザー）', line: 'スマホで承認', revoke: 'ログアウト' })
  assert.equal(sessionRow({ id: 's2', kind: 'apple', origin: 'added', current: false }).title, 'iPhone・iPad・Mac')
  assert.equal(sessionRow({ id: 's2', kind: 'apple', origin: 'added', current: false }).revoke, '取り消す')
  assert.match(requestRow({ loginId: 'L', kind: 'windows', networkClass: 'unknown' }).line, /外から届いた可能性/u)
  assert.match(requestRow({ loginId: 'L', kind: 'windows', networkClass: 'lan' }).line, /同じネットワーク/u)
})

test('a485: the add-an-app text is the ruled one (app-sessions.md 7e, the free browser way)', () => {
  assert.equal(ADD_APP_TEXT, 'この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。')
})

function setup(script) {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => Object.assign(new Node(tag), { }), createTextNode: text => Object.assign(new Node('#text'), { textContent: text }) }
  const calls = [], lost = [], requestsRoot = new Node('div'), sessionsRoot = new Node('div')
  const api = async (path, init) => { calls.push([init?.method ?? 'GET', path]); const next = script[path]?.shift?.() ?? script[path]; if (next instanceof Error) throw next; return next }
  const sessions = createAppSessions({ api, requestsRoot, sessionsRoot, onLost: () => lost.push(1) })
  return { sessions, calls, lost, requestsRoot, sessionsRoot, restore: () => { globalThis.document = previous } }
}
const press = (root, text) => walk(root).find(item => item.tag === 'button' && item.textContent === text).onclick({ currentTarget: { disabled: false } })

test('a485: a login request shows with its warning; 許可 approves it and the list is read again', async () => {
  const t = setup({ '/api/login/requests': [{ requests: [{ loginId: 'L1', kind: 'linux', networkClass: 'unknown', requestedAt: '2026-11-21T13:00:00.000Z' }] }, { requests: [] }], '/api/login/L1/approve': { loginId: 'L1', status: 'waiting_phone' }, '/api/sessions': { sessions: [] } })
  try {
    await t.sessions.refreshRequests()
    assert.equal(t.requestsRoot.hidden, false); assert.ok(texts(t.requestsRoot).includes('Linuxからのログイン要求')); assert.ok(texts(t.requestsRoot).includes(REQUEST_WARNING))
    await press(t.requestsRoot, '許可する')
    assert.deepEqual(t.calls, [['GET', '/api/login/requests'], ['POST', '/api/login/L1/approve'], ['GET', '/api/login/requests']])
    assert.equal(t.requestsRoot.hidden, true)
  } finally { t.restore() }
})

test('a485: the session list revokes another app in place and ends this browser into the code screen; 「アプリを追加」 shows the ruled text, and 429 says why', async () => {
  const list = () => ({ sessions: [{ id: 'me', kind: 'web', origin: 'phone', current: true, lastUsedAt: '2026-11-21T13:00:00.000Z' }, { id: 'other', kind: 'windows', origin: 'console', current: false }] })
  const t = setup({ '/api/sessions': [list(), list(), list(), list(), list()], '/api/sessions/other': { id: 'other', status: 'ended' }, '/api/sessions/me': { id: 'me', status: 'ended' },
    '/api/login/code': [{ code: 'ABCD-EFGH-JKMNP', expiresAt: '2999-01-01T00:00:00.000Z' }, err(429)] })
  try {
    await t.sessions.onEvent({ type: 'session.created' })
    assert.ok(texts(t.sessionsRoot).includes('Windows')); assert.ok(texts(t.sessionsRoot).includes('Web（このブラウザー）'))
    await press(t.sessionsRoot, '取り消す')
    assert.ok(t.calls.some(call => call[0] === 'DELETE' && call[1] === '/api/sessions/other')); assert.equal(t.lost.length, 0)
    await press(t.sessionsRoot, 'アプリを追加するコードを出す')
    assert.ok(texts(t.sessionsRoot).includes('ABCD-EFGH-JKMNP')); assert.ok(texts(t.sessionsRoot).includes(ADD_APP_TEXT))
    await press(t.sessionsRoot, 'アプリを追加するコードを出す')
    assert.ok(texts(t.sessionsRoot).some(text => text.includes('いま出せるコードの数'))); assert.equal(texts(t.sessionsRoot).includes('ABCD-EFGH-JKMNP'), false)
    await press(t.sessionsRoot, 'ログアウト')
    assert.ok(t.calls.some(call => call[0] === 'DELETE' && call[1] === '/api/sessions/me')); assert.equal(t.lost.length, 1)
    assert.equal(await t.sessions.onEvent({ type: 'settings' }), false)
  } finally { t.restore() }
})
