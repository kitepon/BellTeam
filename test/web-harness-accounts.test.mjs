import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bannerTexts, fableOnSecond, limitText, seatBadge, slotView } from '../web/harness-accounts.js'
import { renderHarnessAuth } from '../web/harness-auth.js'

const now = Date.parse('2026-11-08T12:00:00Z') // 21:00 JST

test('上限の文は契約どおり。JST、今日でなければ日付、解除時刻が無ければ解除時刻不明', () => {
  assert.equal(limitText('all', '2026-11-08T13:30:00Z', now), '上限中 (22:30に解除)')
  assert.equal(limitText('fable', '2026-11-08T14:00:00Z', now), 'Fableのみ上限中 (23:00に解除)')
  assert.equal(limitText('opus', '2026-11-08T23:00:00Z', now), 'Opusのみ上限中 (11/9 08:00に解除)')
  assert.equal(limitText('all', null, now), '上限中 (解除時刻不明)')
  assert.equal(limitText('fable', 'not-a-date', now), 'Fableのみ上限中 (解除時刻不明)')
})

const list = {
  harnesses: [{ harness: 'claude', slots: [
    { slot: '1st', loggedIn: true, label: 'first@example.test', history: 'shared', limits: [{ scope: 'fable', since: '2026-11-08T11:00:00Z', resetAt: '2026-11-08T14:00:00Z', resetSource: 'message' }], seats: ['bot-a', 'bot-b'] },
    { slot: '2nd', loggedIn: false, label: null, history: 'separate', limits: [], seats: [] },
  ], allLimited: [{ scope: 'fable', earliestResetAt: null }] }],
  rules: [{ harness: 'claude', modelPrefix: 'claude-fable', slot: '2nd' }],
}

test('枠・規則・両方上限・席の印は accounts.list() と Bot項目だけから決める', () => {
  assert.deepEqual(slotView(list.harnesses[0].slots[0], now), { slot: '1st', title: '1stアカウント', login: 'first@example.test', state: 'Fableのみ上限中 (23:00に解除)', limited: true, seats: 2, separate: false })
  assert.deepEqual(slotView(list.harnesses[0].slots[1], now), { slot: '2nd', title: '2ndアカウント', login: '未ログイン', state: '', limited: false, seats: 0, separate: true })
  assert.equal(slotView({ slot: '1st' }, now).login, 'ログイン状態は未確認')
  assert.equal(fableOnSecond(list), true)
  assert.equal(fableOnSecond({ ...list, rules: [] }), false)
  assert.deepEqual(bannerTexts(list, now), ['両方のアカウントでFableのみ上限中 (解除時刻不明)'])
  assert.deepEqual(bannerTexts(null), [])
  assert.deepEqual(seatBadge({ harness: 'claude', slot: '1st', preferredSlot: '2nd' }), { text: '1stアカウント', title: '1stアカウントで動作中（通常は2ndアカウント）' })
  assert.equal(seatBadge(undefined), null)
  assert.equal(seatBadge(null), null)
})

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} } }
  append(...children) { this.children.push(...children.filter(child => typeof child === 'object')) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
}
const descendants = element => [element, ...element.children.flatMap(descendants)]
const settle = () => new Promise(resolve => setImmediate(resolve))

test('Claudeは1st/2ndの2行。ログインは枠ごとに ?slot=、切替は setRule を1回。/api/accounts が無ければ従来の1行', async () => {
  const previous = globalThis.document
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  const calls = []
  let accounts = list
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}${options.body ? ` ${options.body}` : ''}`)
    if (path === '/api/harness-auth') return { harnesses: [{ id: 'claude', name: 'Claude', members: 2, startWarning: null }] }
    if (path === '/api/accounts') { if (!accounts) throw Object.assign(new Error('NOT_FOUND'), { status: 404 }); return accounts }
    if (path === '/api/accounts/rules') return { rules: [] }
    if (path.startsWith('/api/harness-auth/claude')) return { harness: 'claude', auth: { status: path.includes('slot=2nd') ? 'blocked' : 'authenticated', session_id: null } }
    throw new Error(`unexpected ${path}`)
  }
  try {
    const container = new Element('div')
    const section = await renderHarnessAuth(container, { api })
    await settle()
    const all = descendants(container)
    assert.deepEqual(all.filter(item => item.tag === 'h5').map(item => item.textContent), ['1stアカウント', '2ndアカウント'])
    assert.ok(calls.includes('GET /api/harness-auth/claude') && calls.includes('GET /api/harness-auth/claude?slot=2nd'))
    assert.ok(all.some(item => item.tag === 'dd' && /^Fableのみ上限中 \((\d+\/\d+ )?\d{2}:\d{2}に解除\)$/.test(item.textContent)))
    const toggle = all.find(item => item.attributes.role === 'switch')
    assert.equal(toggle.checked, true)
    toggle.checked = false
    await toggle.listeners.change[0]()
    assert.ok(calls.includes('POST /api/accounts/rules {"harness":"claude","modelPrefix":"claude-fable","slot":null}'))
    assert.equal(toggle.checked, false)
    const start = all.find(item => item.tag === 'button' && item.textContent === 'ログイン')
    await start.listeners.click[0]()
    await settle()
    assert.ok(calls.includes('POST /api/harness-auth/claude/start?slot=2nd'))
    section.stop()

    accounts = null
    const old = new Element('div')
    ;(await renderHarnessAuth(old, { api })).stop()
    assert.equal(descendants(old).filter(item => item.tag === 'h5').length, 0)
    assert.ok(descendants(old).some(item => item.tag === 'h4' && item.textContent === 'Claude · 2人が使用'))
  } finally { globalThis.document = previous }
})
