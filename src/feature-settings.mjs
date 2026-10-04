import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSupportedServerURL } from './server-address.mjs'

const features = [
  { id: 'routing', title: 'AIによるルーム応答の振り分け', fields: [{ key: 'apiKey', label: 'TypeSafe APIキー', secret: true }] },
  { id: 'callBridge', title: '通話ブリッジ', fields: [
    { key: 'url', label: 'MCP接続先URL', url: true }, { key: 'token', label: '接続トークン', secret: true },
  ] },
  { id: 'cloudflare', title: 'Cloudflare Access', fields: [
    { key: 'teamDomain', label: 'チームドメイン', domain: true }, { key: 'audience', label: 'Audience' },
    { key: 'publicUrl', label: '公開URL', url: true, optional: true },
  ] },
  { id: 'diagnostics', title: '診断情報の連携', fields: [{ key: 'key', label: 'BugHubの合鍵', secret: true }] },
  { id: 'notifications', title: 'プッシュ通知', fields: [{ key: 'relayUrl', label: '通知中継URL', url: true }] },
]

export class FeatureSettingsError extends Error {
  constructor(code, status, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.code = code
    this.status = status
  }
}

function definition(id) {
  const feature = features.find(item => item.id === id)
  if (!feature) throw new FeatureSettingsError('FEATURE_NOT_FOUND', 404, '設定項目が見つかりません。')
  return feature
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function configured(feature, values, legacyAPNsConfigured = false) {
  if (feature.id === 'notifications' && legacyAPNsConfigured && !values.relayUrl.trim()) return true
  return feature.fields.every(field => field.optional || Boolean(values[field.key].trim()))
}

function validateValues(feature, values) {
  if (!object(values) || Object.keys(values).some(key => !feature.fields.some(field => field.key === key))) {
    throw new FeatureSettingsError('FEATURE_INPUT_INVALID', 400, '設定の項目が一致しません。')
  }
  for (const [key, value] of Object.entries(values)) {
    const field = feature.fields.find(item => item.key === key)
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new FeatureSettingsError('FEATURE_VALUE_INVALID', 400, '設定値は文字列で入力してください。')
    }
    if (!value.trim()) continue
    if (field.url || field.domain) {
      let url
      try { url = new URL(field.domain ? `https://${value}` : value) }
      catch { throw new FeatureSettingsError('FEATURE_VALUE_INVALID', 400, `${field.label}の形式が正しくありません。`) }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
        || (feature.id === 'notifications' && !isSupportedServerURL(url))
        || (field.domain && url.hostname !== value.toLowerCase())) {
        throw new FeatureSettingsError('FEATURE_VALUE_INVALID', 400, `${field.label}の形式が正しくありません。`)
      }
    }
  }
}

export class FeatureSettings {
  constructor({ root, environment = process.env, onChange = async () => {} }) {
    this.root = root
    this.path = join(root, 'shared/tools/bellteam-settings/settings.json')
    this.environment = environment
    this.onChange = onChange
    this.legacyAPNsConfigured = false
    this.errors = new Map()
    this.settings = Object.fromEntries(features.map(feature => [feature.id, {
      enabled: false, ...Object.fromEntries(feature.fields.map(field => [field.key, ''])),
    }]))
    this.pending = Promise.resolve()
  }

  async initialize() {
    this.legacyAPNsConfigured = false
    try {
      await access(join(this.root, 'shared/tools/apns/config.json'))
      this.legacyAPNsConfigured = true
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    let text
    try { text = await readFile(this.path, 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (text !== undefined) {
      try {
        const settings = JSON.parse(text)
        if (!object(settings) || Object.keys(settings).length !== features.length) throw new Error('設定項目が一致しません。')
        for (const feature of features) {
          const entry = settings[feature.id]
          if (!object(entry) || typeof entry.enabled !== 'boolean') throw new Error('設定の形式が一致しません。')
          const { enabled, ...values } = entry
          if (Object.keys(values).length !== feature.fields.length) throw new Error('設定項目が一致しません。')
          validateValues(feature, values)
          if (enabled && !configured(feature, values, this.legacyAPNsConfigured)) throw new Error('有効な設定に必要な値がありません。')
        }
        this.settings = settings
      } catch (cause) {
        throw new FeatureSettingsError('FEATURE_SETTINGS_INVALID', 500, '保存済みの設定を読み取れません。', cause)
      }
      return this.list()
    }
    const assignments = [
      ['routing', 'apiKey', 'TYPESAFE_API_KEY'], ['callBridge', 'url', 'BELLTEAM_CALL_BRIDGE_MCP_URL'],
      ['cloudflare', 'teamDomain', 'BELLTEAM_CF_TEAM_DOMAIN'], ['cloudflare', 'audience', 'BELLTEAM_CF_AUD'],
      ['diagnostics', 'key', 'BELLTEAM_BUGHUB_KEY'],
    ]
    for (const [id, key, name] of assignments) this.settings[id][key] = this.environment[name] ?? ''
    let header
    try { header = await readFile(join(this.root, 'shared/tools/call-bridge/headers'), 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (header !== undefined) {
      const token = header.match(/^Authorization:\s*Bearer ([^\r\n]+)\r?\n?$/iu)?.[1]
      if (!token?.trim()) throw new FeatureSettingsError('FEATURE_VALUE_INVALID', 400, '通話ブリッジの認証ファイルの形式が正しくありません。')
      this.settings.callBridge.token = token
    }
    for (const feature of features) {
      const { enabled, ...values } = this.settings[feature.id]
      validateValues(feature, values)
      this.settings[feature.id].enabled = configured(feature, values, this.legacyAPNsConfigured)
    }
    await this.save(this.settings)
    return this.list()
  }

  list() {
    return features.map(feature => {
      const values = this.settings[feature.id]
      return {
        id: feature.id, title: feature.title, enabled: values.enabled,
        status: !configured(feature, values, this.legacyAPNsConfigured) ? 'unconfigured' : values.enabled ? 'enabled' : 'disabled',
        ...(this.errors.has(feature.id) ? { error: this.errors.get(feature.id) } : {}),
        fields: feature.fields.map(field => ({
          key: field.key, label: field.label, secret: field.secret === true,
          value: field.secret ? '' : values[field.key], configured: Boolean(values[field.key].trim()),
        })),
      }
    })
  }

  configuration(id) {
    definition(id)
    return { ...this.settings[id] }
  }

  setError(id, error) {
    definition(id)
    if (!error) this.errors.delete(id)
    else this.errors.set(id, { code: /^[A-Z_0-9]+$/u.test(error.code ?? '') ? error.code : 'FEATURE_APPLY_FAILED', message: '設定を保存しましたが、反映できませんでした。設定を確認して再度保存してください。' })
  }

  update(id, input, { secretRequests, botId, allowSecretValues = false } = {}) {
    const run = async () => {
      const feature = definition(id)
      if (!object(input) || Object.keys(input).some(key => !['enabled', 'values', 'secretRequestId'].includes(key))
        || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) {
        throw new FeatureSettingsError('FEATURE_INPUT_INVALID', 400, '設定変更の形式が正しくありません。')
      }
      const values = input.values === undefined ? {} : { ...input.values }
      if (input.values !== undefined && !object(input.values)) throw new FeatureSettingsError('FEATURE_INPUT_INVALID', 400, '設定値の形式が正しくありません。')
      validateValues(feature, values)
      const secret = feature.fields.find(field => field.secret)
      if (!allowSecretValues && feature.fields.some(field => field.secret && Object.hasOwn(values, field.key))) {
        throw new FeatureSettingsError('FEATURE_SECRET_VALUE_FORBIDDEN', 400, '秘密情報は専用の入力画面から登録してください。')
      }
      if (input.secretRequestId !== undefined) {
        if (!secret || Object.hasOwn(values, secret.key) || typeof input.secretRequestId !== 'string'
          || !input.secretRequestId || typeof botId !== 'string' || !botId || !secretRequests?.get) {
          throw new FeatureSettingsError('FEATURE_SECRET_REQUEST_INVALID', 400, '提出済みの秘密入力依頼が必要です。')
        }
        try {
          const request = secretRequests.get(input.secretRequestId)
          if (request.toolId !== 'bellteam-settings' || request.botId !== botId || request.status !== 'submitted'
            || typeof request.path !== 'string' || !request.path) throw new Error('提出済みの対象依頼ではありません。')
          values[secret.key] = await readFile(request.path, 'utf8')
          if (!values[secret.key].trim()) throw new Error('提出値が空です。')
          validateValues(feature, values)
        } catch (cause) {
          throw new FeatureSettingsError('FEATURE_SECRET_REQUEST_INVALID', 400, '提出済みの秘密入力依頼を読み取れません。', cause)
        }
      }
      const next = { ...this.settings[id], ...values, enabled: input.enabled ?? this.settings[id].enabled }
      if (next.enabled && !configured(feature, next, this.legacyAPNsConfigured)) {
        throw new FeatureSettingsError('FEATURE_UNCONFIGURED', 400, '有効にするには必要な項目を登録してください。')
      }
      const settings = { ...this.settings, [id]: next }
      await this.save(settings)
      this.settings = settings
      this.setError(id, null)
      try { await this.onChange(id, this.configuration(id)) }
      catch (cause) {
        this.setError(id, cause)
        throw new FeatureSettingsError('FEATURE_APPLY_FAILED', 500, '設定を保存しましたが、反映できませんでした。', cause)
      }
      return this.list().find(item => item.id === id)
    }
    const result = this.pending.then(run, run)
    this.pending = result
    return result
  }

  async save(settings) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(`${this.path}.tmp`, JSON.stringify(settings) + '\n', { mode: 0o600 })
    await chmod(`${this.path}.tmp`, 0o600)
    await rename(`${this.path}.tmp`, this.path)
  }
}
