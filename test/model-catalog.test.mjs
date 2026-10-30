import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveModelCatalog, ModelCatalogError } from '../src/model-catalog.mjs'

const response = (harness, id) => ({ structuredContent: {
  schema: 'aiterm.agent-models.v1', harness, source: 'CLIの一覧', harness_version: null,
  default_model: id, efforts: ['new-effort'], models: [{ id, efforts: ['new-effort'] }],
} })

test('5ハーネスを正規APIで取得し、次の取得では新モデルとエフォートが反映される', async () => {
  const calls = []
  let closed = 0
  let generation = 1
  const catalog = new LiveModelCatalog({ cwd: '/run/bellteam', client: () => ({
    call: async (name, args) => { calls.push({ name, ...args }); return response(args.harness, `model-${generation}`) },
    close: async () => { closed++ },
  }) })
  const first = await catalog.list()
  assert.equal(first.codex.models[0].id, 'model-1')
  assert.deepEqual(first.claude.efforts, ['new-effort'])
  assert.deepEqual(calls.map(call => call.harness).sort(), ['antigravity-cli', 'claude-code', 'codex-cli', 'cursor-cli', 'grok-cli'])
  assert.ok(calls.every(call => call.name === 'agent_models' && call.cwd === '/run/bellteam'))
  generation = 2
  assert.equal((await catalog.list('codex')).codex.models[0].id, 'model-2')
  assert.equal(calls.length, 6)
  assert.equal(closed, 6)
})

test('ファストモードの可否は、Aitermが返したモデルごとの項目とアカウントの理由をそのまま渡す', async () => {
  const reply = extra => ({ structuredContent: { ...response('claude-code', 'opus').structuredContent, models: [{ id: 'opus', efforts: [], fast: true }], ...extra } })
  const catalogFor = extra => new LiveModelCatalog({ client: () => ({ call: async () => reply(extra), close: async () => {} }) })

  const refused = await catalogFor({ fast_unavailable: { code: 'FAST_MODE_UNAVAILABLE', message: 'extra_usage_disabled' } }).forHarness('claude')
  assert.equal(refused.models[0].fast, true)
  assert.deepEqual(refused.fastUnavailable, { code: 'FAST_MODE_UNAVAILABLE', message: 'extra_usage_disabled' })
  assert.equal((await catalogFor({ fast_unavailable: null }).forHarness('claude')).fastUnavailable, null)
  // ファストモードを知らないAitermは項目を返さない。
  assert.equal((await catalogFor({}).forHarness('claude')).fastUnavailable, null)
  await assert.rejects(catalogFor({ fast_unavailable: 'no' }).forHarness('claude'), error => error.code === 'MODEL_CATALOG_INVALID')
})

test('一覧取得失敗はそのハーネスの理由を返し、成功した他の一覧と混ぜて代用しない', async () => {
  const catalog = new LiveModelCatalog({ client: () => ({
    call: async (_, { harness }) => {
      if (harness === 'claude-code') throw new Error('MODEL_CATALOG_UNAVAILABLE: 認証されていません')
      return response(harness, 'gpt-6.1-sol')
    }, close: async () => {},
  }) })
  const result = await catalog.list()
  assert.equal(result.claude.error.code, 'MODEL_CATALOG_UNAVAILABLE')
  assert.match(result.claude.error.message, /認証されていません/u)
  assert.deepEqual(result.claude.models, [])
  assert.equal(result.codex.models[0].id, 'gpt-6.1-sol')
  await assert.rejects(catalog.forHarness('claude'), error => error instanceof ModelCatalogError && error.code === 'MODEL_CATALOG_UNAVAILABLE')
})

test('不正なMCP応答と未知のハーネスを明示し、接続を閉じる', async () => {
  let closed = 0
  const catalog = new LiveModelCatalog({ client: () => ({
    call: async () => ({ structuredContent: { schema: 'aiterm.agent-models.v1', harness: 'codex-cli', efforts: [], models: [] } }),
    close: async () => { closed++ },
  }) })
  await assert.rejects(catalog.forHarness('codex'), error => error.code === 'MODEL_CATALOG_INVALID')
  assert.equal(closed, 1)
  await assert.rejects(catalog.list('toString'), error => error.code === 'MODEL_HARNESS_INVALID')
  assert.equal(closed, 1)
})

test('Antigravityのeffortを含む不透明なmodel IDとfast非対応をそのまま返す', async () => {
  const id = 'fixture-model/effort-high'
  const catalog = new LiveModelCatalog({ client: () => ({
    call: async (_, args) => {
      assert.equal(args.harness, 'antigravity-cli')
      return { structuredContent: { ...response(args.harness, id).structuredContent,
        efforts: [], models: [{ id, efforts: [], fast: false }] } }
    }, close: async () => {},
  }) })
  const result = await catalog.forHarness('antigravity')
  assert.equal(result.models[0].id, id)
  assert.equal(result.models[0].fast, false)
  assert.deepEqual(result.models[0].efforts, [])
})
