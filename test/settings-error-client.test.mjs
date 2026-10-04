import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderFeatureSettings, refreshFeatureSettingsStatus } from '../web/onboarding.js'

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ''; this.value = ''; this.dataset = {} }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener() {}
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
      error: { code: 'RELAY_RESPONSE_FAILED', message: '送信サービスの応答が不正です。' },
    }])
    assert.equal(failed.children[0].textContent, '通知 · 反映エラー')
    assert.equal(failed.children[1].textContent, 'RELAY_RESPONSE_FAILED: 送信サービスの応答が不正です。')
    assert.equal(input.value, '編集中の新しい合言葉')
  } finally { globalThis.document = previous }
})
