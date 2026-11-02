import assert from 'node:assert/strict'
import test from 'node:test'
import { renderFeatureMap } from '../scripts/render-feature-map.mjs'

test('個別の接続を本体図と外部接点へ一度ずつ合成し、正本へ辿れる', () => {
  const modules = {
    ui: { title: '画面', owner: 'A', external: false, provides: [], uses: [{ module: 'core', port: 'read' }] },
    core: { title: '本体', owner: 'B', external: false, provides: ['read'], uses: [{ module: 'native', port: 'run' }] },
    native: { title: '外部', owner: 'C', external: true, provides: ['run'], uses: [] },
  }
  const first = renderFeatureMap(modules)
  assert.equal(first.split('m_ui -->|"read"| m_core').length, 2)
  assert.equal(first.split('m_core -->|"run"| m_native').length, 2)
  assert.ok(first.includes('(modules/core/README.md)'))
  modules.core.title = '変更後の本体'
  const next = renderFeatureMap(modules)
  assert.ok(next.includes('変更後の本体'))
  assert.equal(next.includes('[本体]'), false)
})

test('接続先のない図を完成図として出力しない', () => {
  assert.throws(() => renderFeatureMap({ ui: { title: '画面', owner: 'A', provides: [], uses: [{ module: 'missing', port: 'read' }] } }), /Unknown connection: ui -> missing:read/u)
})
