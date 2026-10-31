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

test('段階を明示した公式案内だけを描き、input_requiredから秘密入力を推測しない', () => {
  assert.equal(harnessAuthView(null).stage, 'unavailable')
  assert.equal(harnessAuthView({ status: 'blocked', input_required: true }).stage, 'unavailable')
  assert.equal(harnessAuthView({ status: 'authenticated' }).poll, false)
  const auth_ui = { schema: 'aiterm.auth-ui.v1', binding: { session_id: 'auth-1', launch_id: 'a'.repeat(32) },
    stage: 'device_code', title: '公式ページでログインしてください', message: '', url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234' }
  assert.deepEqual(harnessAuthView({ auth_ui }), { ...auth_ui, poll: true })
})

test('今の認証が消えうるAIは、認証が無い・切れていると分かっている時を除いて、始める前に知らせる', () => {
  const codex = { id: 'codex', startWarning: 'Codexは、認証し直しを始めた時点で今の認証が消えます。' }
  assert.equal(needsStartConfirmation(codex, { status: 'authenticated' }), true)
  assert.equal(needsStartConfirmation(codex, { status: 'failed' }), true)
  assert.equal(needsStartConfirmation(codex, null), true)
  assert.equal(needsStartConfirmation(codex, { status: 'blocked' }), false)
  assert.equal(needsStartConfirmation({ id: 'claude', startWarning: null }, { status: 'authenticated' }), false)
})

test('一覧を開くと各AIの認証状態と操作を表示し、認証し直すと公式サイトとコードを出す', async () => {
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
    if (path === '/api/harness-auth/codex/start') return { harness: 'codex', auth: { status: 'waiting', session_id: 'auth-1', auth_ui: { schema: 'aiterm.auth-ui.v1', binding: { session_id: 'auth-1', launch_id: 'a'.repeat(32) }, stage: 'device_code', title: '公式ページでログインしてください', message: '', url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234' } } }
    if (path === '/api/harness-auth/codex/cancel') return { harness: 'codex', auth: null }
    if (path === '/api/harness-auth/codex') return { harness: 'codex', auth: { status: 'authenticated', url: null, user_code: null, input_required: false, message: null } }
    if (path === '/api/harness-auth/claude') throw new Error('Aitermの公式認証の応答を読み取れません。')
    throw new Error(`unexpected ${path}`)
  }
  let section
  try {
    const container = new Element('div')
    section = await renderHarnessAuth(container, { api })
    await settle()
    assert.deepEqual(container.children.map(item => item.children[0].textContent), ['Claude · 10人が使用', 'Codex · 19人が使用'])
    assert.ok(container.children.every(item => item.tag !== 'details'))
    assert.deepEqual(calls, ['GET /api/harness-auth', 'GET /api/harness-auth/claude', 'GET /api/harness-auth/codex'])
    assert.ok(texts(container.children[0]).includes('確認できません'))
    assert.ok(texts(container.children[1]).includes('認証済み'))
    assert.equal(documentListeners.length, 2)

    const codex = container.children[1]
    const press = label => descendants(codex).find(item => item.tag === 'button' && item.textContent === label).fire('click')
    await settle()
    assert.deepEqual(calls.slice(1), ['GET /api/harness-auth/claude', 'GET /api/harness-auth/codex'])
    assert.ok(texts(codex).includes('認証が完了しました'))
    assert.equal(descendants(codex).some(item => item.textContent === '認証を中止する'), false)

    // 認証済みに見えるCodexは、始めた時点で今の認証が消える。1回目は知らせるだけで、何も始めない。
    press('認証し直す')
    await settle()
    assert.deepEqual(calls.slice(1), ['GET /api/harness-auth/claude', 'GET /api/harness-auth/codex'])
    assert.ok(texts(codex).includes('Codexは、認証し直しを始めた時点で今の認証が消えます。'))
    press('始めない')
    await settle()
    assert.equal(texts(codex).includes('Codexは、認証し直しを始めた時点で今の認証が消えます。'), false)
    assert.deepEqual(calls.slice(1), ['GET /api/harness-auth/claude', 'GET /api/harness-auth/codex'])

    // 知らせを読んで、もう一度押した時に始める。
    press('認証し直す')
    press('今の認証を手放して始める')
    await settle()
    assert.equal(calls.at(-1), 'POST /api/harness-auth/codex/start')
    assert.ok(texts(codex).includes('公式ページでログインしてください'))
    assert.ok(texts(codex).includes('ABCD-1234'))
    assert.equal(descendants(codex).find(item => item.tag === 'a').href, 'https://auth.openai.com/codex/device')

    // やめた後は、公式の状態を見直して出す。
    press('認証を中止する')
    await settle()
    assert.deepEqual(calls.slice(-2), ['POST /api/harness-auth/codex/cancel', 'GET /api/harness-auth/codex'])
    assert.ok(texts(codex).includes('認証が完了しました'))
    assert.equal(descendants(codex).some(item => item.textContent === '認証を中止する'), false)

    // 見に行けなかった時は、理由を出して止まる。
    const claude = container.children[0]
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

test('サーバーが再認証非対応と返す種類には開始を案内せず、公式案内と状態更新を残す', async () => {
  const previous = globalThis.document
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  const calls = [], message = '公式CLIで認証してください。'
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}`)
    if (path === '/api/harness-auth') return { harnesses: [{ id: 'fixture', name: 'Fixture', members: 0, reloginSupported: false, startWarning: message }] }
    if (path === '/api/harness-auth/fixture') return { auth: { status: 'blocked', session_id: null } }
    throw Error(`unexpected ${path}`)
  }
  let section
  try {
    const container = new Element('div'); section = await renderHarnessAuth(container, { api })
    const row = container.children[0]
    await settle()
    assert.ok(texts(row).includes(message))
    assert.equal(texts(row).some(text => text.includes('認証ボタンを押すと')), false)
    assert.equal(descendants(row).some(item => item.tag === 'button' && ['認証する', '認証し直す'].includes(item.textContent)), false)
    descendants(row).find(item => item.tag === 'button' && item.textContent === '状態を更新').fire('click'); await settle()
    assert.deepEqual(calls, ['GET /api/harness-auth', 'GET /api/harness-auth/fixture', 'GET /api/harness-auth/fixture'])
  } finally { section?.stop(); globalThis.document = previous }
})

test('変更完了後の古いstatus応答を捨て、不明な入力は明示更新まで再入力させない', async t => {
  const previous = globalThis.document
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const binding = { session_id: 'owned', launch_id: null }
  const code = { status: 'waiting', session_id: 'owned', auth_ui: { schema: 'aiterm.auth-ui.v1', stage: 'paste_code', title: '公式ページでログイン', message: '',
    binding, prompt_digest: 'a'.repeat(64), url: 'https://claude.com/login', input: 'authorization_code' } }
  const complete = { status: 'authenticated', session_id: null, auth_ui: { stage: 'complete', title: '認証完了', message: '', binding: null } }
  let current = complete, pending, finish, rejectInput = false, posts = 0
  const api = async (path, options = {}) => {
    if (path === '/api/harness-auth') return { harnesses: [{ id: 'claude', name: 'Claude', members: 1 }] }
    if (path.endsWith('/start')) { current = code; return { auth: current } }
    if (path.endsWith('/input')) { posts++; if (rejectInput) throw Error('認証結果を確認できませんでした。'); current = complete; return { auth: current } }
    if (path.endsWith('/claude')) return pending ? await pending : { auth: current }
    throw Error(path)
  }
  let section
  try {
    const container = new Element('div'); section = await renderHarnessAuth(container, { api })
    const row = container.children[0], button = label => descendants(row).find(item => item.tag === 'button' && item.textContent === label)
    await settle()
    button('認証し直す').fire('click'); await settle()
    pending = new Promise(resolve => { finish = resolve })
    t.mock.timers.tick(3000); await settle()
    let input = descendants(row).find(item => item.tag === 'input'); input.value = 'synthetic'; input.fire('input'); button('認証を完了する').fire('click'); await settle()
    assert.ok(texts(row).includes('認証完了'))
    finish({ auth: code }); pending = null; await settle()
    assert.ok(texts(row).includes('認証完了')); assert.equal(descendants(row).some(item => item.tag === 'input'), false)
    button('認証し直す').fire('click'); await settle(); rejectInput = true
    input = descendants(row).find(item => item.tag === 'input'); input.value = 'synthetic'; input.fire('input'); button('認証を完了する').fire('click'); await settle()
    assert.equal(posts, 2); assert.equal(descendants(row).some(item => item.tag === 'input'), false)
    t.mock.timers.tick(9000); await settle(); assert.equal(posts, 2)
    button('状態を更新').fire('click'); await settle()
    assert.equal(descendants(row).some(item => item.tag === 'input'), true)
  } finally { section?.stop(); globalThis.document = previous; t.mock.timers.reset() }
})

test('利用人数にかかわらず認証状態を読み、確認中・未認証・失敗を認証済みと区別する', async () => {
  const previous = globalThis.document
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  let finish, posts = 0
  const api = async (path, options = {}) => {
    if (options.method === 'POST') posts++
    if (path === '/api/harness-auth') return { harnesses: ['ready', 'missing', 'failed', 'waiting'].map(id => ({ id, name: id, members: 0 })) }
    if (path.endsWith('/ready')) return new Promise(resolve => { finish = resolve })
    if (path.endsWith('/missing')) return { auth: { status: 'blocked', session_id: null } }
    if (path.endsWith('/waiting')) return { auth: { status: 'waiting', session_id: 'existing', auth_ui: { stage: 'waiting', title: '認証を待っています' } } }
    return { auth: { status: 'failed' } }
  }
  let section
  try {
    const container = new Element('div'); section = await renderHarnessAuth(container, { api }); await settle()
    const [ready, missing, failed, waiting] = container.children
    assert.ok(texts(ready).includes('確認中'))
    assert.equal(descendants(ready).find(item => item.tag === 'button' && item.textContent === '認証する').disabled, true)
    assert.ok(texts(missing).includes('未認証')); assert.ok(texts(missing).includes('認証する'))
    assert.ok(texts(failed).includes('確認できません')); assert.equal(texts(failed).includes('未認証'), false)
    assert.ok(texts(waiting).includes('認証中'))
    finish({ auth: { status: 'authenticated' } }); await settle()
    assert.ok(texts(ready).includes('認証済み')); assert.ok(texts(ready).includes('認証し直す'))
    assert.equal(posts, 0)
  } finally { section?.stop(); globalThis.document = previous }
})
