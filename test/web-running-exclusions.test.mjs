import test from 'node:test'
import assert from 'node:assert/strict'
import { exclusionWords, scopeWords, exclusionsItem, removalFailure, validExclusions, runningExclusionsView } from '../web/running-exclusions.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.dataset = {}; this.listeners = {}; this.className = '' }
  append(...children) { this.children.push(...children.filter(child => typeof child === 'object')) }
  replaceChildren(...children) { this.children = children }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
}
const descendants = element => [element, ...element.children.flatMap(descendants)]
const texts = element => descendants(element).map(item => item.textContent).filter(Boolean)
const settle = () => new Promise(resolve => setImmediate(resolve))

const process = { id: 'e1', kind: 'process', exe: 'node', args: ['dev'], session: null, scope: ['b1', 'gone'], decisionId: 'K-1', approvedAt: '2026-11-13T05:00:00Z', reason: '開発用サーバー' }
const child = { id: 'e2', kind: 'child', harness: 'codex-cli', session: null, scope: 'all' }

test('words: a process reads "<exe> <args>", a child names its AI and seat; scope shows names, unknown ids as is', () => {
  assert.equal(exclusionWords(process), 'node dev')
  assert.equal(exclusionWords(child), 'Codex の子の席（どの席でも）')
  assert.equal(exclusionWords({ ...child, harness: 'claude-code', session: 's1' }), 'Claude Code の子の席「s1」')
  assert.equal(scopeWords('all', () => null), '全員')
  assert.equal(scopeWords(['b1', 'gone'], id => id === 'b1' ? 'アドミ' : null), 'アドミ、gone')
})

test('home row: count and waiting proposals; older body and unreadable list say so', () => {
  assert.deepEqual(exclusionsItem({ entries: [], pending: [] }), { line: 'なし', badge: '', tone: '' })
  assert.deepEqual(exclusionsItem({ entries: [process, child], pending: [{ action: 'remove', id: 'e1', decisionId: 'K-2', from: 'b1', filedAt: 'x' }] }).line, '2件・答え待ち1件')
  assert.equal(exclusionsItem('unsupported').line, '本体を更新すると使えます')
  assert.equal(exclusionsItem(null).tone, 'attention')
  assert.equal(validExclusions({ entries: [{ id: 'x', kind: 'other', scope: 'all' }], pending: [] }), false)
  assert.equal(removalFailure({ status: 404, code: 'RUNNING_EXCLUSION_NOT_FOUND' }), 'もう一覧にありませんでした。')
  assert.equal(removalFailure({ status: 503 }), '一覧を読めないため、外せませんでした。')
})

test('page: cards with names, pending waits in Approval Box, removal confirms, DELETEs and reads again', async () => {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag) }
  const calls = [], rows = []
  let list = { entries: [process, child], pending: [{ action: 'add', entry: { kind: 'process', exe: 'npm', args: ['run', 'watch'], session: null, scope: ['b1'] }, decisionId: 'K-3', from: 'b1', filedAt: '2026-11-13T06:00:00Z' }] }
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}`)
    if (options.method === 'DELETE') { list = { entries: [child], pending: list.pending }; return { removed: 'e1' } }
    return list
  }
  try {
    const root = new Element('div')
    const view = runningExclusionsView(root, api, { nameOf: id => id === 'b1' ? 'アドミ' : null, onChange: row => rows.push(row.line), confirm: () => true })
    await view.refresh()
    const shown = texts(root)
    assert.ok(shown.includes('node dev') && shown.includes('アドミ、gone') && shown.includes('開発用サーバー'))
    assert.ok(shown.includes('npm run watch') && shown.includes('追加の提案') && shown.includes('Approval Boxで、あなたの答えを待っています。'))
    const remove = descendants(root).find(item => item.tag === 'button' && item.textContent === '一覧から外す')
    await remove.listeners.click[0]()
    await settle()
    assert.deepEqual(calls, ['GET /api/running-exclusions', 'DELETE /api/running-exclusions/e1', 'GET /api/running-exclusions'])
    assert.ok(!texts(root).includes('node dev'))
    assert.deepEqual(rows, ['2件・答え待ち1件', '1件・答え待ち1件'])
    list = { entries: [], pending: [] }
    await view.refresh()
    assert.ok(texts(root).includes('いまは何もありません。メンバーの処理は、すべて作業中に数えます。'))
  } finally { globalThis.document = previous }
})
