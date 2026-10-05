import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harnessAuthTitle, harnessAuthView, needsStartConfirmation, renderHarnessAuth } from '../web/harness-auth.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.value = ''; this.dataset = {}; this.listeners = {}; this.open = false }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
  fire(type) { for (const listener of this.listeners[type] ?? []) listener({}) }
}
const descendants = element => [element, ...element.children.flatMap(descendants)]
const texts = element => descendants(element).map(item => item.textContent).filter(Boolean)
const settle = () => new Promise(resolve => setImmediate(resolve))

test('AIの行の見出しは、使っているメンバーの数を添える', () => {
  assert.equal(harnessAuthTitle({ name: 'Codex', members: 19 }), 'Codex · 19人が使用')
  assert.equal(harnessAuthTitle({ name: 'Grok', members: 0 }), 'Grok · 使用していません')
})

test('公式認証の進行から、画面に出す物を決める', () => {
  assert.deepEqual(harnessAuthView(null), { text: '', message: '', link: null, code: null, input: false, poll: false })
  assert.deepEqual(harnessAuthView({ status: 'waiting', url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234', input_required: false, message: null }), {
    text: '公式サイトでの認証を待っています。', message: '', link: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', input: false, poll: true,
  })
  // httpsの公式サイトだけをリンクにする。待っている間だけ、数秒おきに見に行く。
  for (const url of ['http://auth.example.com/', 'javascript:alert(1)', 'not a url', null])
    assert.equal(harnessAuthView({ status: 'waiting', url }).link, null, String(url))
  assert.equal(harnessAuthView({ status: 'authenticated' }).poll, false)
  assert.deepEqual(harnessAuthView({ status: 'blocked', input_required: true, message: '認証が切れています。' }), {
    text: '認証に必要な操作を確認してください。', message: '認証が切れています。', link: null, code: null, input: true, poll: false,
  })
  assert.equal(harnessAuthView({ status: 'unknown' }).text, '認証の状態を確認してください。')
})

test('今の認証が消えうるAIは、認証が無い・切れていると分かっている時を除いて、始める前に知らせる', () => {
  const codex = { id: 'codex', startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。' }
  assert.equal(needsStartConfirmation(codex, { status: 'authenticated' }), true)
  assert.equal(needsStartConfirmation(codex, { status: 'failed' }), true)
  assert.equal(needsStartConfirmation(codex, null), true)
  assert.equal(needsStartConfirmation(codex, { status: 'blocked' }), false)
  assert.equal(needsStartConfirmation({ id: 'claude', startWarning: null }, { status: 'authenticated' }), false)
})

test('一覧では公式の状態を見に行かず、行を開いた時に見て、認証し直すと公式サイトとコードを出す', async () => {
  const previous = globalThis.document
  const documentListeners = []
  globalThis.document = {
    hidden: false,
    createElement: tag => new Element(tag),
    addEventListener: (type, listener) => documentListeners.push(listener),
    removeEventListener: (type, listener) => documentListeners.splice(documentListeners.indexOf(listener), 1),
  }
  const calls = []
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}`)
    if (path === '/api/harness-auth') return { harnesses: [{ id: 'claude', name: 'Claude', members: 10, startWarning: null }, { id: 'codex', name: 'Codex', members: 19, startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。' }] }
    if (path === '/api/harness-auth/codex/start') return { harness: 'codex', auth: { status: 'waiting', url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234', input_required: false, message: null } }
    if (path === '/api/harness-auth/codex/cancel') return { harness: 'codex', auth: null }
    if (path === '/api/harness-auth/codex') return { harness: 'codex', auth: { status: 'authenticated', url: null, user_code: null, input_required: false, message: null } }
    if (path === '/api/harness-auth/claude') throw new Error('Aitermの公式認証の応答を読み取れません。')
    throw new Error(`unexpected ${path}`)
  }
  let section
  try {
    const container = new Element('div')
    section = await renderHarnessAuth(container, { api })
    assert.deepEqual(container.children.map(item => item.children[0].textContent), ['Claude · 10人が使用', 'Codex · 19人が使用'])
    assert.deepEqual(calls, ['GET /api/harness-auth'])
    assert.equal(documentListeners.length, 2)

    const codex = container.children[1]
    const press = label => descendants(codex).find(item => item.tag === 'button' && item.textContent === label).fire('click')
    codex.open = true
    codex.fire('toggle')
    await settle()
    assert.deepEqual(calls.slice(1), ['GET /api/harness-auth/codex'])
    assert.ok(texts(codex).includes('認証済みです。'))
    assert.equal(descendants(codex).some(item => item.textContent === 'やめる'), false)

    // 認証済みに見えるCodexは、始めた時点で今の認証が消える。1回目は知らせるだけで、何も始めない。
    press('認証し直す')
    await settle()
    assert.deepEqual(calls.slice(1), ['GET /api/harness-auth/codex'])
    assert.ok(texts(codex).includes('Codexは、認証し直しを始めた時点で今の認証が消えます。'))
    press('始めない')
    await settle()
    assert.equal(texts(codex).includes('Codexは、認証し直しを始めた時点で今の認証が消えます。'), false)
    assert.deepEqual(calls.slice(1), ['GET /api/harness-auth/codex'])

    // 知らせを読んで、もう一度押した時に始める。
    press('認証し直す')
    press('今の認証を手放して始める')
    await settle()
    assert.equal(calls.at(-1), 'POST /api/harness-auth/codex/start')
    assert.ok(texts(codex).includes('公式サイトでの認証を待っています。'))
    assert.ok(texts(codex).includes('利用者コード: ABCD-1234'))
    assert.equal(descendants(codex).find(item => item.tag === 'a').href, 'https://auth.openai.com/codex/device')

    // やめた後は、公式の状態を見直して出す。
    press('やめる')
    await settle()
    assert.deepEqual(calls.slice(-2), ['POST /api/harness-auth/codex/cancel', 'GET /api/harness-auth/codex'])
    assert.ok(texts(codex).includes('認証済みです。'))
    assert.equal(descendants(codex).some(item => item.textContent === 'やめる'), false)

    // 見に行けなかった時は、理由を出して止まる。
    const claude = container.children[0]
    claude.open = true
    claude.fire('toggle')
    await settle()
    const failure = descendants(claude).find(item => item.className === 'form-error')
    assert.equal(failure.textContent, 'Aitermの公式認証の応答を読み取れません。')
    assert.equal(failure.attributes.role, 'alert')
  } finally {
    section?.stop()
    assert.equal(documentListeners.length, 0)
    globalThis.document = previous
  }
})
