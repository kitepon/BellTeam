import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../json-file.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0')
export const backgroundHarnesses = ['claude', 'codex', 'grok', 'cursor', 'antigravity']
const messages = {
  BACKGROUND_AGENT_INPUT_INVALID: '設定変更の形式を確認してください。',
  BACKGROUND_AGENT_HARNESS_INVALID: '使えるハーネスを選んでください。',
  BACKGROUND_AGENT_MODEL_INVALID: 'このハーネスで使えるモデルを選んでください。',
  BACKGROUND_AGENT_EFFORT_INVALID: 'このモデルで使えるエフォートを選んでください。',
  BACKGROUND_AGENT_REVISION_CONFLICT: '設定が変更されています。読み直して確認してください。',
  BACKGROUND_AGENT_MODELS_UNAVAILABLE: 'モデル一覧を確認できません。保存していません。',
  BACKGROUND_AGENT_UNAVAILABLE: 'この版では背景agentの設定を取得できません。',
  BACKGROUND_AGENT_STATE_INVALID: '保存済みの背景agent設定を読み取れません。',
  BACKGROUND_AGENT_STATE_FAILED: '背景agent設定の読み書きに失敗しました。',
  BACKGROUND_AGENT_APPLY_FAILED: '設定は保存しましたが、要約の実行側への反映を確認できません。',
}
export const backgroundAgentError = (code, status = 400) => Object.assign(new Error(messages[code] ?? code), { code, status })
export function backgroundSelectionValid(value) {
  return exact(value, ['harness', 'model', 'reasoningEffort']) && backgroundHarnesses.includes(value.harness)
    && text(value.model) && typeof value.reasoningEffort === 'string' && value.reasoningEffort.length <= 50 && !value.reasoningEffort.includes('\0')
}
export function backgroundRecordValid(value) {
  return exact(value, ['revision', 'selection']) && (value.revision === null && value.selection === null
    || uuid(value.revision) && backgroundSelectionValid(value.selection))
}
export function backgroundInputValid(value) {
  return exact(value, ['expectedRevision', 'harness', 'model', 'reasoningEffort'])
    && (value.expectedRevision === null || uuid(value.expectedRevision))
    && text(value.harness) && text(value.model) && typeof value.reasoningEffort === 'string'
    && value.reasoningEffort.length <= 50 && !value.reasoningEffort.includes('\0')
}
export function backgroundModelsValid(value) {
  return Array.isArray(value) && value.length > 0 && new Set(value.map(model => model?.id)).size === value.length
    && value.every(model => exact(model, ['id', 'efforts']) && text(model.id)
      && Array.isArray(model.efforts) && model.efforts.every(text))
}

export class BackgroundAgentSettings {
  constructor({ root, models, onChange = async () => {} }) {
    this.path = join(root, 'shared/tools/bellteam-settings/background-agent.json')
    this.models = models
    this.onChange = onChange
    this.record = { revision: null, selection: null }
    this.error = null
    this.pending = Promise.resolve()
  }

  async initialize() {
    let value
    try { value = JSON.parse(await readFile(this.path, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') this.error = backgroundAgentError(error instanceof SyntaxError ? 'BACKGROUND_AGENT_STATE_INVALID' : 'BACKGROUND_AGENT_STATE_FAILED', 500)
      return
    }
    const { schema, ...record } = value ?? {}
    if (schema !== 'bellteam.background-agent-settings.v1' || !backgroundRecordValid(record) || record.selection === null) {
      this.error = backgroundAgentError('BACKGROUND_AGENT_STATE_INVALID', 500)
      return
    }
    this.record = record
  }

  configuration() {
    if (this.error) throw this.error
    return structuredClone(this.record)
  }

  projection() {
    return this.error ? { backgroundAgentError: this.error.code } : { backgroundAgent: this.configuration() }
  }

  update(input) {
    const run = async () => {
      if (!backgroundInputValid(input)) throw backgroundAgentError('BACKGROUND_AGENT_INPUT_INVALID')
      if (!backgroundHarnesses.includes(input.harness)) throw backgroundAgentError('BACKGROUND_AGENT_HARNESS_INVALID')
      const current = this.configuration()
      if (input.expectedRevision !== current.revision) throw backgroundAgentError('BACKGROUND_AGENT_REVISION_CONFLICT', 409)
      let models
      try { models = await this.models(input.harness) }
      catch { throw backgroundAgentError('BACKGROUND_AGENT_MODELS_UNAVAILABLE', 503) }
      if (!backgroundModelsValid(models)) throw backgroundAgentError('BACKGROUND_AGENT_MODELS_UNAVAILABLE', 503)
      const model = models.find(model => model.id === input.model)
      if (!model) throw backgroundAgentError('BACKGROUND_AGENT_MODEL_INVALID')
      if (model.efforts.length ? !model.efforts.includes(input.reasoningEffort) : input.reasoningEffort !== '') throw backgroundAgentError('BACKGROUND_AGENT_EFFORT_INVALID')
      const selection = { harness: input.harness, model: input.model, reasoningEffort: input.reasoningEffort }
      if (current.selection && Object.keys(selection).every(key => selection[key] === current.selection[key])) return current
      const record = { revision: randomUUID(), selection }
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeAtomic(this.path, { schema: 'bellteam.background-agent-settings.v1', ...record })
      } catch { throw backgroundAgentError('BACKGROUND_AGENT_STATE_FAILED', 500) }
      this.record = record
      try { await this.onChange(this.configuration()) }
      catch { throw backgroundAgentError('BACKGROUND_AGENT_APPLY_FAILED', 500) }
      return this.configuration()
    }
    const result = this.pending.then(run, run)
    this.pending = result.catch(() => {})
    return result
  }
}
