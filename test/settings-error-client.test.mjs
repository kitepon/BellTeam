import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderFeatureSettings, refreshFeatureSettingsStatus } from '../web/onboarding.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.value = ''; this.dataset = {} }
  append(...children) { this.children.push(...children) }
  remove() {}
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener() {}
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => child.tag === selector) }
  querySelector(selector) { return this.children.find(child => child.className?.split(' ').includes(selector.slice(1))) }
}

test('有効な機能でも反映エラーを表示し、秘密の値を表示しない', () => {
  const previous = globalThis.document
  globalThis.document = {
    createElement: tag => new Element(tag),
    createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
  }
  try {
    const container = new Element('div')
    renderFeatureSettings(container, [{
      id: 'notifications', title: '通知', enabled: true, status: 'enabled',
      fields: [{ key: 'token', label: '合言葉', secret: true, value: 'DO_NOT_DISPLAY', configured: true }],
      error: { code: 'RELAY_CONNECT_FAILED', message: '<通知送信サービスへ接続できませんでした。>', detail: 'DO_NOT_DISPLAY' },
    }, { id: 'routing', title: '自動選択', enabled: false, status: 'unconfigured', fields: [] }], { api() {}, onChange() {} })
    const failed = container.children[0]
    assert.equal(failed.children[0].textContent, '通知 · 反映エラー')
    assert.equal(failed.children[1].textContent, 'RELAY_CONNECT_FAILED: <通知送信サービスへ接続できませんでした。>')
    assert.equal(failed.children[1].attributes.role, 'alert')
    assert.equal(container.children[1].children[0].textContent, '自動選択 · 未設定')
    function descendants(element) { return [element, ...element.children.flatMap(descendants)] }
    const elements = descendants(container)
    assert.equal(elements.find(item => item.type === 'password').value, '')
    assert.equal(elements.some(item => item.textContent.includes('DO_NOT_DISPLAY')), false)
    const input = elements.find(item => item.type === 'password')
    input.value = '編集中の新しい合言葉'
    refreshFeatureSettingsStatus(container, [{
      id: 'notifications', title: '通知', enabled: true, status: 'enabled',
      fields: [{ key: 'token', secret: true, configured: false }],
      error: { code: 'RELAY_RESPONSE_FAILED', message: '送信サービスの応答が不正です。' },
    }])
    assert.equal(failed.children[0].textContent, '通知 · 反映エラー')
    assert.equal(failed.children[1].textContent, 'RELAY_RESPONSE_FAILED: 送信サービスの応答が不正です。')
    assert.equal(input.value, '編集中の新しい合言葉')
    assert.equal(input.placeholder, '未設定')
    refreshFeatureSettingsStatus(container, [{ id: 'notifications', title: '通知', status: 'enabled' }])
  } finally { globalThis.document = previous }
})

test('1Password連携: 押下中は確かめ中と示し、PATCH応答の結果をカード内に書く', async () => {
  const previous = globalThis.document
  class Live extends Element {
    constructor(tag) { super(tag); this.handlers = {} }
    addEventListener(type, handler) { this.handlers[type] = handler }
    removeAttribute(key) { delete this.attributes[key] }
  }
  globalThis.document = { createElement: tag => new Live(tag), createTextNode: text => Object.assign(new Live('#text'), { textContent: text }) }
  try {
    const item = (extra = {}) => ({ id: 'onePassword', title: '1Password連携', enabled: false, status: 'unconfigured', fields: [{ key: 'token', label: 'トークン', secret: true, value: '', configured: false }], ...extra })
    const run = async answer => {
      const container = new Live('div'), seen = {}
      let release
      renderFeatureSettings(container, [item()], { onChange: async () => {}, api: () => new Promise((resolve, reject) => { release = () => answer instanceof Error ? reject(answer) : resolve(answer) }) })
      const form = container.children[0].children.find(child => child.tag === 'form')
      const result = form.children.find(child => child.className === 'feature-result'), save = form.children.at(-1)
      form.children.find(child => child.tag === 'label' && child.className === 'field').children[1].value = 'ops_secret'
      const submitted = form.handlers.submit({ preventDefault() {} })
      Object.assign(seen, { busy: save.textContent, aria: save.attributes['aria-busy'], disabled: save.disabled, checking: result.textContent, hidden: result.hidden })
      release(); await submitted
      return { ...seen, after: save.textContent, afterAria: save.attributes['aria-busy'], result: result.hidden ? null : result.textContent, state: result.dataset.state, error: form.children.find(child => child.className === 'form-error').textContent }
    }
    const ok = await run({ setting: item({ enabled: true, status: 'enabled', connection: { vaults: ['開発工場'], sshKeys: 3 } }) })
    assert.deepEqual([ok.busy, ok.aria, ok.disabled, ok.checking, ok.hidden], ['連携を確かめています…', 'true', true, '1Passwordにつないで確かめています…', false])
    assert.equal(ok.result, '連携できました。読める保管庫：開発工場　SSH鍵：3件'); assert.equal(ok.state, 'connected')
    assert.equal(ok.after, '保存して連携を確かめる'); assert.equal(ok.afterAria, undefined)
    const failed = await run({ setting: item({ enabled: true, status: 'enabled', error: { code: 'ONEPASSWORD_TOKEN_REJECTED', message: 'トークンを確かめられませんでした。貼り直してください。' } }) })
    assert.equal(failed.result, '連携できませんでした。トークンを確かめられませんでした。貼り直してください。'); assert.equal(failed.state, 'failed')
    const off = await run({ setting: item({ enabled: false, status: 'disabled' }) })
    assert.equal(off.result, '連携を解除しました。')
    const refused = await run(new Error('有効にするには必要な項目を登録してください。'))
    assert.equal(refused.result, null); assert.equal(refused.error, '有効にするには必要な項目を登録してください。')
  } finally { globalThis.document = previous }
})

test('1Password連携: 失敗理由はカード内の結果行に一度だけ出し、上の警告を重ねない', () => {
  const previous = globalThis.document
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }) }
  try {
    const container = new Element('div')
    const message = 'このトークンで1Passwordに接続できませんでした。トークンを貼り直してください。'
    renderFeatureSettings(container, [{ id: 'onePassword', title: '1Password連携', enabled: true, status: 'enabled', error: { code: 'ONEPASSWORD_TOKEN_REJECTED', message },
      fields: [{ key: 'token', label: 'トークン', secret: true, value: '', configured: true }] }], { api() {}, onChange() {} })
    const descendants = element => [element, ...element.children.flatMap(descendants)]
    const texts = descendants(container).map(item => item.textContent).filter(text => text.includes(message))
    assert.deepEqual(texts, [`連携できませんでした。${message}`])
    assert.equal(descendants(container).find(item => item.className === 'feature-result').hidden, false)
  } finally { globalThis.document = previous }
})
