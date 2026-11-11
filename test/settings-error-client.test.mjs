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
    function descendants(element) { return [element, ...element.children.flatMap(descendants)] }
    const texts = element => descendants(element).map(item => item.textContent).filter(Boolean)
    // 名前・札・一文・「変更」。符号は閉じた「詳細」の中だけ。
    assert.deepEqual(texts(failed.children[0]), ['通知', 'エラー', 'iPhoneアプリへ通知を送ります。', '変更'])
    assert.deepEqual(texts(failed.children[1]), ['<通知送信サービスへ接続できませんでした。>', '詳細', 'RELAY_CONNECT_FAILED'])
    assert.equal(failed.children[1].children[1].tag, 'details')
    assert.equal(failed.children[1].attributes.role, 'alert')
    assert.deepEqual(texts(container.children[1].children[0]), ['自動選択', '未設定', 'ルームで、誰が返事をするかをAIが選びます。', '設定する'])
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
    assert.ok(texts(failed.children[0]).includes('エラー'))
    assert.deepEqual(texts(failed.children[1]), ['送信サービスの応答が不正です。', '詳細', 'RELAY_RESPONSE_FAILED'])
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
      const token = form.children.find(child => child.tag === 'label' && child.className === 'field').children[1]
      token.value = 'ops_secret'
      const submitted = form.handlers.submit({ preventDefault() {} })
      Object.assign(seen, { busy: save.textContent, aria: save.attributes['aria-busy'], disabled: save.disabled, checking: result.textContent, hidden: result.hidden })
      release(); await submitted
      return { ...seen, token: token.value, after: save.textContent, afterAria: save.attributes['aria-busy'], result: result.hidden ? null : result.textContent, state: result.dataset.state, error: [form.children.find(child => child.className === 'form-error')].flatMap(function all(item) { return [item.textContent, ...item.children.flatMap(all)] }).filter(Boolean).join('') }
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
    assert.equal(refused.result, null); assert.equal(refused.token, 'ops_secret'); assert.equal(ok.token, ''); assert.equal(refused.error, '保存できませんでした。有効にするには必要な項目を登録してください。')
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

test('機能の保存: 応答待ちの間に書いた入力と未保存の印は残り、保存中は閉じる時に聞ける', async () => {
  const previous = globalThis.document
  class Live extends Element {
    constructor(tag) { super(tag); this.handlers = {} }
    addEventListener(type, handler) { this.handlers[type] = handler }
    removeAttribute(key) { delete this.attributes[key] }
    querySelectorAll(selector) {
      const [, tag, key] = selector.match(/^(\w+)\[data-(\w+)\]$/u) ?? []
      return key ? super.querySelectorAll(tag).filter(item => Object.hasOwn(item.dataset, key)) : super.querySelectorAll(selector)
    }
  }
  globalThis.document = { createElement: tag => new Live(tag), createTextNode: text => Object.assign(new Live('#text'), { textContent: text }) }
  const { featureFormsDirty, featureFormsSaving } = await import('../web/onboarding.js')
  try {
    const setting = { id: 'discord', title: 'Discord', enabled: true, status: 'enabled', fields: [
      { key: 'token', label: 'トークン', secret: true, value: '', configured: true },
      { key: 'other', label: '鍵', secret: true, value: '', configured: true },
    ] }
    const container = new Live('div')
    let release
    renderFeatureSettings(container, [setting], { onChange: async () => {}, api: () => new Promise(resolve => { release = resolve }) })
    const form = container.children[0].children.find(child => child.tag === 'form')
    const [token, other] = form.children.filter(child => child.tag === 'label' && child.className === 'field').map(label => label.children[1])
    token.value = 'sent'; other.value = 'sent-too'; form.handlers.input()
    const submitted = form.handlers.submit({ preventDefault() {} })
    assert.equal(featureFormsSaving(container), true)
    other.value = 'typed-while-saving'; form.handlers.input()
    release({}); await submitted
    assert.equal(token.value, '')
    assert.equal(other.value, 'typed-while-saving')
    assert.equal(featureFormsDirty(container), true)
    assert.equal(featureFormsSaving(container), false)
    const again = form.handlers.submit({ preventDefault() {} })
    release({}); await again
    assert.equal(other.value, ''); assert.equal(featureFormsDirty(container), false)
  } finally { globalThis.document = previous }
})
