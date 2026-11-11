import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { objectSchema } from './mcp-schema.mjs'
import { RUNTIME_COMPONENTS } from './runtime-selection.mjs'
const object = properties => objectSchema(properties, Object.keys(properties))
const text = { type: 'string', minLength: 1 }
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] })
const list = items => ({ type: 'array', items })
const enumeration = values => ({ type: 'string', enum: values })
const date = { type: 'string', format: 'date-time' }
const uuid = { type: 'string', format: 'uuid', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }
const idempotencyKey = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[ -~]+$' }
const jobState = enumeration(['queued', 'downloading', 'verifying', 'swapping', 'ready', 'failed'])
const nanoseconds = { type: 'string', pattern: '^[0-9]+$' }
export const updateJobSchema = object({ schema: { const: 'bellteam.update-job.v1' }, jobId: uuid, idempotencyKey,
  kind: enumeration(['container', 'module', 'runtime']), target: object({ catalogSha256: nullable({ type: 'string', pattern: '^[a-f0-9]{64}$' }), moduleId: text, versionId: text }),
  state: jobState, reason: nullable(object({ code: text, message: text })),
  transitions: list(object({ state: jobState, atNs: nanoseconds })), updatedAtNs: nanoseconds })
updateJobSchema.allOf = [{ if: { properties: { state: { const: 'failed' } } },
  then: { properties: { reason: object({ code: text, message: text }) } }, else: { properties: { reason: { type: 'null' } } } }]
export const updateComponents = [
  ['container', 'BellTeam本体', '機能を動かす実行環境と、製品全体の構成。'],
  ['web-gateway', 'Web受付', '公開接続を受け付け、画面を届けます。'],
  ['notifications', '通知', '返信や確認依頼を端末へ知らせます。'],
  ['members', 'メンバーと予定', 'メンバーの設定と仕事の予定を管理します。'],
  ['conversation', '会話と履歴', '発言と回答を受け取り、履歴に残します。'],
  ['execution', 'AI実行', 'AIへの仕事の受付、進行と停止を管理します。'],
  ['usage', '利用設定', '設定、公式認証の案内、質問と秘密入力を扱います。'],
  ['memory', '記憶と知識', '出来事と、再利用する知識を保存して探します。'],
  ['diagnostics', '診断', '機能が報告した問題を集め、調査用に記録します。'],
  ['work-graph', '相関図', '作業中のメンバーとBot間の依頼を、図のデータにして届けます。'],
  ['lattice', 'Lattice工程表', 'プロジェクトごとの工程表を保管し、席の道具とアプリの画面へ届けます。'],
]

// Z-b2 slice D: runtime rows reach only readers that opt in with runtime=1 (docs/architecture/modules/runtime/runtime-updates.md).
const runtimeNames = { 'runtime-aiterm-mcp': 'Aiterm MCP', 'runtime-codex': 'Codex CLI', 'runtime-claude-code': 'Claude Code', 'runtime-throughline': 'Throughline' }
export const runtimeUpdateComponents = Object.keys(RUNTIME_COMPONENTS).map(id => [id, runtimeNames[id], 'AIの席が使う実行部品。次回起動から適用。実行中の席は現在の版を継続します。'])
export const runtimeComponentIds = runtimeUpdateComponents.map(([id]) => id)

const capability = { oneOf: [object({ supported: { const: true }, reason: { type: 'null' } }),
  object({ supported: { const: false }, reason: text })] }
const version = object({ version: text, sourceCommit: nullable({ type: 'string', pattern: '^[a-f0-9]{40}$' }),
  digest: nullable({ type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }), origin: enumeration(['container', 'builtin', 'release', 'published']) })
const target = object({ componentId: text, current: nullable(version), published: version })
const plan = object({ planId: uuid, scope: enumeration(['all', 'component']), componentId: nullable(text), expiresAt: date,
  targets: list(target), compatibility: object({ compatible: { type: 'boolean' }, reason: nullable(text) }),
  impact: object({ containerRestart: { type: 'boolean' }, description: text }), capability })
plan.properties.action = enumeration(['update', 'rollback'])
const operation = object({ requestId: uuid, plan, admission: enumeration(['pending', 'accepted', 'rejected', 'unknown']),
  phase: enumeration(['preparing', 'applying', 'reconnecting', 'verifying', 'completed', 'failed', 'unknown']),
  execution: enumeration(['pending', 'succeeded', 'failed', 'unknown']), verification: enumeration(['pending', 'succeeded', 'failed', 'unknown']),
  error: nullable(object({ code: text, message: text })), reference: nullable(text) })
operation.properties.jobs = list(updateJobSchema)
operation.allOf = [{ if: { properties: { phase: { const: 'completed' } } }, then: {
  properties: { admission: { const: 'accepted' }, execution: { const: 'succeeded' }, verification: { const: 'succeeded' } },
} }]
export const updatesSchema = { $id: 'urn:bellteam:updates:v1', ...object({ schema: { const: 'bellteam.updates.v1' },
  server: object({ id: nullable(text) }), observedAt: date,
  notice: object({ state: enumeration(['ready', 'unavailable', 'updating', 'attention']), code: nullable(text), message: text }),
  components: list(object({ id: text, name: text, description: text, current: nullable(version), published: nullable(version),
    comparison: object({ state: enumeration(['up_to_date', 'update_available', 'unavailable', 'incompatible', 'unknown']), reason: nullable(text) }),
    publication: nullable(object({ catalog: object({ sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, publishedAt: date, expiresAt: date }), check: object({ status: enumeration(['verified', 'failed', 'unconfirmed']), checkedAt: nullable(date), error: nullable(text) }) })),
    changes: list(text), capability, availability: object({ available: nullable({ type: 'boolean' }), reason: nullable(text) }) })),
  plans: list(plan), operation: nullable(operation), previousOperation: nullable(operation),
}) }
updatesSchema.properties.components.items.properties.runtimeApplication = object({
  generationId: nullable({ type: 'string', pattern: '^[a-f0-9]{64}$' }), policy: { const: 'next_launch' } })
// Optional on older servers: one plain-Japanese status per part (docs/architecture/modules/integration/update-jobs.md).
updatesSchema.properties.components.items.properties.status = object({ line: text, tone: enumeration(['ok', 'updating', 'attention']),
  actionRequired: { type: 'boolean' }, action: nullable(text),
  latestJob: nullable(object({ jobId: uuid, kind: enumeration(['container', 'module', 'runtime']), state: jobState,
    outcome: enumeration(['running', 'succeeded', 'failed']), at: date, reason: nullable(object({ code: text, message: text })) })) })
// Optional on older snapshots; notification eligibility is decided by the server.
updatesSchema.properties.notificationCandidates = list(object({ componentId: enumeration(updateComponents.map(([id]) => id)), id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }))
updatesSchema.properties.jobs = list(updateJobSchema)
updatesSchema.properties.problems = list(object({ fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  status: enumeration(['open', 'resolved']), kind: { const: 'module_restart_limit' }, moduleId: text,
  count: { type: 'integer', minimum: 5 }, windowSeconds: { const: 1800 },
  lastExit: object({ code: nullable({ type: 'integer' }), signal: nullable(text) }),
  lastReason: enumeration(['process_exit', 'ready_timeout', 'ready_probe_failed', 'recovery_failed']) }))
export const updateRequestSchemas = {
  plan: { oneOf: [object({ scope: { const: 'all' } }), object({ scope: { const: 'component' }, componentId: enumeration([...updateComponents.map(([id]) => id), ...runtimeComponentIds]) })].map(schema => ({ ...schema, properties: { ...schema.properties, action: enumeration(['update', 'rollback']) } })) },
  operation: object({ planId: uuid, requestId: uuid, confirmContainerRestart: { type: 'boolean' } }),
  requestId: uuid,
}
updateRequestSchemas.operation.properties.idempotencyKey = idempotencyKey
const validator = new AjvJsonSchemaValidator()
export const validateUpdates = validator.getValidator(updatesSchema)
const requests = Object.fromEntries(Object.entries(updateRequestSchemas).map(([name, schema]) => [name, validator.getValidator(schema)]))
export function validateUpdateRequest(name, value) {
  if (!requests[name](value).valid) throw Object.assign(new Error('UPDATE_INPUT_INVALID'), { code: 'UPDATE_INPUT_INVALID', status: 400 })
}

export const updateEventSchema = object({ at: date, topics: { const: ['updates'] }, botIds: { const: [] }, roomIds: { const: [] }, type: { const: 'updates' }, all: { const: true } })
updateEventSchema.properties.jobs = list(updateJobSchema)
updateEventSchema.properties.error = objectSchema({ code: text, message: text, path: text, reason: text }, ['code', 'message'])
export const updateResponseSchemas = { inventory: updatesSchema, plan: object({ plan }), operation: object({ operation }),
  job: object({ job: updateJobSchema }), jobs: object({ jobs: list(updateJobSchema) }),
  error: objectSchema({ error: text, message: text, path: text, reason: text }, ['error']), event: updateEventSchema }
const exampleCurrent = { version: 'a'.repeat(64), sourceCommit: '1'.repeat(40), digest: 'sha256:' + 'a'.repeat(64), origin: 'container' }
const examplePublished = { version: 'b'.repeat(64), sourceCommit: '2'.repeat(40), digest: 'sha256:' + 'b'.repeat(64), origin: 'published' }
const examplePlan = { planId: '11111111-1111-4111-8111-111111111111', scope: 'component', componentId: 'container',
  expiresAt: '2026-11-03T14:05:00+09:00', targets: [{ componentId: 'container', current: exampleCurrent, published: examplePublished }],
  compatibility: { compatible: true, reason: null }, impact: { containerRestart: true, description: '会話と処理が一時中断します。' },
  capability: { supported: true, reason: null } }
const baseExample = { schema: 'bellteam.updates.v1', server: { id: 'example-server' }, observedAt: '2026-11-03T14:00:00+09:00',
  notice: { state: 'unavailable', code: 'UPDATE_PROVIDERS_UNAVAILABLE', message: '正式公開版と更新計画は未接続です。' },
  components: [{ id: 'container', name: 'BellTeam本体', description: updateComponents[0][2], current: exampleCurrent, published: null, publication: null,
    comparison: { state: 'unavailable', reason: 'PUBLISHED_RELEASE_UNAVAILABLE' }, changes: [],
    capability: { supported: false, reason: 'UPDATE_EXECUTOR_UNAVAILABLE' }, availability: { available: true, reason: null } }],
  plans: [], operation: null, previousOperation: null }
export const updateExamples = Object.fromEntries(['running', 'no_update', 'published_unavailable', 'incompatible', 'restart_required',
  'accepted', 'disconnected_unknown', 'execution_failed', 'verified_completed'].map(name => {
  const value = structuredClone(baseExample), component = value.components[0]
  if (name === 'no_update') { component.published = { ...exampleCurrent, origin: 'published' }; component.comparison = { state: 'up_to_date', reason: null }; value.notice = { state: 'ready', code: null, message: '正式公開版と同じ版です。' } }
  if (name === 'incompatible') { component.published = examplePublished; component.comparison = { state: 'incompatible', reason: 'UPDATE_INCOMPATIBLE' }; component.capability.reason = 'UPDATE_INCOMPATIBLE' }
  if (!['no_update', 'published_unavailable', 'incompatible'].includes(name)) {
    component.published = examplePublished; component.comparison = { state: 'update_available', reason: null }; component.changes = ['機能を更新します。']
    component.capability = { supported: true, reason: null }; value.plans = [examplePlan]
    value.notice = { state: 'ready', code: null, message: '更新する対象を確認してください。' }
    if (name !== 'restart_required') {
      value.operation = { requestId: '22222222-2222-4222-8222-222222222222', plan: examplePlan, admission: 'accepted',
        phase: name === 'accepted' ? 'preparing' : 'applying', execution: 'pending', verification: 'pending', error: null, reference: null }
      value.notice = { state: 'updating', code: null, message: '更新の実状態を確認しています。' }
    }
  }
  if (name === 'disconnected_unknown') { Object.assign(value.operation, { admission: 'unknown', phase: 'unknown', execution: 'unknown', verification: 'unknown', error: { code: 'UPDATE_RESULT_UNKNOWN', message: '同じ要求の結果を照会してください。' } }); value.notice.state = 'attention' }
  if (name === 'execution_failed') { Object.assign(value.operation, { phase: 'failed', execution: 'failed', verification: 'unknown', error: { code: 'UPDATE_EXECUTION_FAILED', message: '更新処理が失敗しました。' } }); value.notice.state = 'attention' }
  if (name === 'verified_completed') { Object.assign(value.operation, { phase: 'completed', execution: 'succeeded', verification: 'succeeded' }); component.current = { ...examplePublished, origin: 'container' }; component.comparison = { state: 'up_to_date', reason: null }; value.notice = { state: 'ready', code: null, message: '更新先の稼働を確認しました。' } }
  return [name, value]
}))

const responses = Object.fromEntries(Object.entries(updateResponseSchemas).map(([name, schema]) => [name, validator.getValidator(schema)]))
export function validateUpdateResponse(name, value) {
  if (!responses[name](value).valid) throw Object.assign(new Error('UPDATE_RESPONSE_INVALID'), { code: 'UPDATE_RESPONSE_INVALID', status: 503 })
}

// action is optional on old plans; omitted requests always mean update.
export const updateActionExamples = {
  update: { scope: 'component', componentId: 'notifications' },
  rollback: { scope: 'component', componentId: 'notifications', action: 'rollback' },
  all: { scope: 'all', action: 'update' },
}

export const updateModuleExamples = Object.fromEntries(['module_update', 'module_rollback', 'all_modules', 'interrupted'].map(name => {
  const value = structuredClone(updateExamples.verified_completed)
  const plan = { ...value.operation.plan, scope: name === 'all_modules' ? 'all' : 'component', componentId: name === 'all_modules' ? null : 'notifications',
    action: name === 'module_rollback' ? 'rollback' : 'update', impact: { containerRestart: false, description: '対象の機能を切り替えます。本体は再起動しません。' } }
  const ids = name === 'all_modules' ? ['web-gateway', 'notifications', 'members'] : ['notifications']
  plan.targets = ids.map(componentId => ({ componentId, current: { ...exampleCurrent, origin: 'release' },
    published: name === 'module_rollback' ? { version: '3'.repeat(40), sourceCommit: '3'.repeat(40), digest: null, origin: 'builtin' } : examplePublished }))
  value.components = ids.map(id => ({ ...structuredClone(value.components[0]), id, name: updateComponents.find(entry => entry[0] === id)[1],
    description: updateComponents.find(entry => entry[0] === id)[2], current: { ...plan.targets.find(target => target.componentId === id).published, origin: name === 'module_rollback' ? 'builtin' : 'release' } }))
  value.plans = [plan]; value.operation.plan = plan
  if (name === 'interrupted') {
    Object.assign(value.operation, { phase: 'unknown', execution: 'unknown', verification: 'unknown', error: { code: 'UPDATE_PARENT_INTERRUPTED', message: '同じ要求の結果を確認してください。' } })
    value.notice = { state: 'attention', code: 'UPDATE_PARENT_INTERRUPTED', message: '処理が中断されました。再実行せず同じ要求を照会してください。' }
  }
  return [name, value]
}))
