// ハーネス固有の取得・モデルID・エフォートの変換はAitermが所有する。
// BellTeamは編集時と設定変更時に実行環境の一覧を取得し、永続化・再試行はしない。
import { AitermClient } from './aiterm-transport.mjs'

const HARNESSES = { claude: 'claude-code', codex: 'codex-cli', grok: 'grok-cli', cursor: 'cursor-cli' }

export class ModelCatalogError extends Error {
  constructor(code, harness, detail) {
    super(`${harness}のモデル一覧を取得できません（${detail}）`)
    this.code = code
    this.harness = harness
  }
}

export class LiveModelCatalog {
  constructor({ client = () => new AitermClient(), cwd = process.env.BELLTEAM_ROOT ?? process.cwd() } = {}) {
    this.client = client
    this.cwd = cwd
  }

  async forHarness(harness) {
    const kind = HARNESSES[harness]
    if (!Object.hasOwn(HARNESSES, harness)) throw new ModelCatalogError('MODEL_HARNESS_INVALID', harness, '未対応のCLIです')
    // CLIの一覧取得で会話・配送用のMCP接続を待たせないよう、短命の接続を使う。
    const client = this.client()
    try {
      const result = await client.call('agent_models', { harness: kind, cwd: this.cwd })
      const value = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text')?.text)
      // 外部MCPの形式異常を空の候補として扱わない。
      if (value?.schema !== 'aiterm.agent-models.v1' || value.harness !== kind
        || !Array.isArray(value.efforts) || !value.efforts.every(effort => typeof effort === 'string')
        || !Array.isArray(value.models) || value.models.length === 0
        || !value.models.every(model => typeof model.id === 'string' && Array.isArray(model.efforts)
          && model.efforts.every(effort => typeof effort === 'string')))
        throw new ModelCatalogError('MODEL_CATALOG_INVALID', harness, 'Aitermの応答形式が一致しません')
      return { efforts: value.efforts, models: value.models, source: value.source,
        harnessVersion: value.harness_version, defaultModel: value.default_model }
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error
      const code = error instanceof SyntaxError ? 'MODEL_CATALOG_INVALID'
        : error.message.includes('MODEL_CATALOG_INVALID') ? 'MODEL_CATALOG_INVALID' : 'MODEL_CATALOG_UNAVAILABLE'
      throw new ModelCatalogError(code, harness, error.message)
    } finally {
      await client.close()
    }
  }

  async list(harness) {
    const names = harness ? [harness] : Object.keys(HARNESSES)
    if (harness && !Object.hasOwn(HARNESSES, harness)) throw new ModelCatalogError('MODEL_HARNESS_INVALID', harness, '未対応のCLIです')
    const results = await Promise.allSettled(names.map(name => this.forHarness(name)))
    return Object.fromEntries(results.map((result, i) => [names[i], result.status === 'fulfilled' ? result.value
      : { efforts: [], models: [], error: { code: result.reason.code, message: result.reason.message } }]))
  }
}
