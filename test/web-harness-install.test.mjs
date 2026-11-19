import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderHarnessAuth, authSummary, STAGES } from '../web/harness-auth.js'
import { installStage, installPolling, renderInstall } from '../web/auth-flow.js'
import { attentionItems } from '../web/settings-home.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.value = ''; this.dataset = {}; this.listeners = {}; this.className = '' }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
  fire(type) { for (const listener of this.listeners[type] ?? []) listener({}) }
}
const descendants = element => [element, ...element.children.flatMap(descendants)]
const texts = element => descendants(element).map(item => item.textContent).filter(Boolean)
const settle = () => new Promise(resolve => setImmediate(resolve))
const install = (state, extra = {}) => ({ state, version: null, source: null, busy: false, lastError: null, message: 'M:' + state, action: 'install', label: '最新版を入れる', ...extra })

test('install state: only the server states that cannot run are a stage; an older body (no install) is judged by nothing', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag) }
  try {
  assert.equal(installStage(undefined), null)
  assert.equal(installStage(install('installed')), null)
  assert.deepEqual(['checking', 'not_installed', 'installing', 'failed'].map(state => installStage(install(state))), ['checking', 'notInstalled', 'installing', 'installFailed'])
  assert.equal(installPolling(install('installed')), false)
  assert.equal(installPolling(install('installed', { busy: true })), true)
  assert.equal(installPolling(install('not_installed')), false)
  assert.equal(installPolling(install('installing')), true)
  const [text, button] = renderInstall(install('not_installed'), { press() {} })
  assert.equal(text.textContent, 'M:not_installed')
  assert.equal(button.textContent, '最新版を入れる')
  assert.equal(renderInstall(install('installing', { action: null }), { press() {} }).length, 1)
  } finally { globalThis.document = previous }
})

test('not installed counts in the settings home attention band', () => {
  const summary = authSummary([{ name: 'Codex', slot: null, stage: 'done' }, { name: 'Grok', slot: null, stage: 'notInstalled' }])
  assert.deepEqual(summary, { line: 'Grokが入っていません', badge: STAGES.notInstalled.badge, tone: 'attention' })
  assert.equal(attentionItems(new Map([['ai', summary]])).length, 1)
  assert.equal(authSummary([{ name: 'Grok', slot: null, stage: 'installing' }]).line, 'Grokを入れています')
})

test('a missing AI shows the server sentence and the button, never asks for login, then the login row appears once it is installed', async () => {
  const previous = globalThis.document
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} }
  const calls = [], summaries = []
  let state = install('not_installed')
  const api = async (path, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${path}`)
    if (path === '/api/harness-auth') return { harnesses: [{ id: 'grok', name: 'Grok', members: 0, install: state }, { id: 'codex', name: 'Codex', members: 1, install: install('installed', { message: 'M:codex' }) }] }
    if (path === '/api/harness-auth/grok/install') { if (options.method === 'POST') state = install('installed', { message: 'M:grok installed' }); return { harness: 'grok', install: state } }
    if (path.startsWith('/api/harness-auth/')) return { auth: { status: 'authenticated', session_id: null } }
    throw Error(`unexpected ${path}`)
  }
  let section
  try {
    const container = new Element('div')
    section = await renderHarnessAuth(container, { api, onSummary: list => summaries.push(list) })
    await settle()
    const [grok, codex] = container.children
    assert.ok(texts(grok).includes('M:not_installed'))
    assert.ok(texts(grok).includes(STAGES.notInstalled.badge))
    assert.equal(calls.some(call => call.includes('/api/harness-auth/grok') && !call.includes('/install')), false, 'no login read for a missing AI')
    assert.deepEqual(summaries.at(-1).find(item => item.name === 'Grok').stage, 'notInstalled')
    // an installed AI keeps its login row and also shows the server sentence and the update button
    assert.ok(texts(codex).includes('認証済み') && texts(codex).includes('M:codex'))
    descendants(grok).find(item => item.tag === 'button' && item.textContent === '最新版を入れる').fire('click')
    await settle()
    assert.ok(calls.includes('POST /api/harness-auth/grok/install'))
    assert.ok(calls.includes('GET /api/harness-auth/grok'), 'login is read after it is installed')
    assert.ok(texts(grok).includes('認証済み') && texts(grok).includes('M:grok installed'))
    assert.equal(summaries.at(-1).find(item => item.name === 'Grok').stage, 'done')
  } finally {
    section?.stop()
    globalThis.document = previous
  }
})
