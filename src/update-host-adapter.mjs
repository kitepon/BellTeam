import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, open, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { validateUpdates, validateUpdateRequest, validateUpdateResponse } from './update-center-contract.mjs'
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status })
const requireValue = (ok, code = 'UPDATE_HOST_RESPONSE_INVALID') => { if (!ok) throw failure(code) }
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'UPDATE_RESULT_UNKNOWN'
const source = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const version = (release, origin = 'published') => {
  requireValue(source(release?.sourceCommit) && digest(release?.versionId))
  return { version: release.versionId, sourceCommit: release.sourceCommit, digest: release.versionId, origin }
}
export function createHostUpdateAdapter({ root, client }) {
  const directory = join(root, 'state/update-plans')
  const load = async id => {
    validateUpdateRequest('requestId', id)
    let value
    try { value = JSON.parse(await readFile(join(directory, id + '.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') throw failure('UPDATE_PLAN_NOT_FOUND', 404); throw failure('UPDATE_PLAN_INVALID') }
    validateUpdateResponse('plan', { plan: value }); requireValue(value.planId === id)
    return value
  }
  const save = async plan => {
    validateUpdateResponse('plan', { plan })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // shortcut: retain at most 4096 immutable plans; add an archive before increasing this bound.
    requireValue((await readdir(directory)).length < 4096, 'UPDATE_PLAN_CAPACITY')
    const temporary = join(directory, randomUUID() + '.tmp'), target = join(directory, plan.planId + '.json')
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(plan) + '\n'); await file.sync() } finally { await file.close() }
    try { await link(temporary, target) } finally { await unlink(temporary) }
    const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
  }
  const selection = async () => {
    const value = await client.catalog('container')
    requireValue(value?.schema === 'bellteam.update-catalog.selection.v1' && /^[a-f0-9]{64}$/.test(value.catalogSha256)
      && date(value.publishedAt) && date(value.expiresAt))
    const release = value.release
    if (release !== null) {
      version(release)
      requireValue(release.componentId === 'container' && release.artifact?.kind === 'oci-index'
        && release.artifact.reference === 'ghcr.io/kitepon/bellteam-server@' + release.versionId
        && Array.isArray(release.changes) && release.changes.every(x => typeof x === 'string' && x.length <= 8192))
    }
    const publication = value.publication
    requireValue(['verified', 'failed', 'unconfirmed'].includes(publication?.status)
      && (publication.checkedAt === null || date(publication.checkedAt))
      && (publication.error === null || code(publication.error) === publication.error))
    return value
  }
  const operation = async id => {
    validateUpdateRequest('requestId', id)
    const value = await client.operation(id)
    requireValue(value?.requestId === id)
    const plan = await load(value.planId)
    requireValue(value.target?.versionId === plan.targets[0].published.version && value.target?.sourceCommit === plan.targets[0].published.sourceCommit)
    const result = { requestId: id, plan, admission: value.admission, phase: value.phase,
      execution: value.execution, verification: value.verification,
      error: value.error === null ? null : { code: code(value.error), message: '更新結果を確認してください。' }, reference: id }
    validateUpdateResponse('operation', { operation: result }); return result
  }
  return {
    operation,
    async snapshot(value) {
      const capability = await client.capabilities()
      const container = value.components.find(x => x.id === 'container')
      let selected = null
      try { selected = await selection() }
      catch (error) { container.capability = { supported: false, reason: code(error.code) } }
      if (selected) {
        container.publication = { catalog: { sha256: selected.catalogSha256, publishedAt: selected.publishedAt, expiresAt: selected.expiresAt }, check: selected.publication }
        if (selected.release) {
          container.published = version(selected.release); container.changes = selected.release.changes
          const compatible = selected.release.compatibility?.containerUpdate === 1
          const same = container.current?.digest === selected.release.versionId
          container.comparison = { state: !compatible ? 'incompatible' : same ? 'up_to_date' : container.current ? 'update_available' : 'unknown',
            reason: !compatible ? 'UPDATE_INCOMPATIBLE' : selected.publication.status === 'failed' ? code(selected.publication.error) : null }
          container.capability = { supported: Boolean(capability.supported && compatible && !same), reason: null }
          if (!container.capability.supported) container.capability.reason = !compatible ? 'UPDATE_INCOMPATIBLE' : same ? 'UPDATE_ALREADY_CURRENT' : code(capability.reason)
        }
      }
      if (container.capability.supported) value.notice = { state: 'ready', code: null, message: '固定計画を作成して更新対象を確認できます。' }
      for (const [key, id] of [['operation', capability.currentRequestId], ['previousOperation', capability.previousRequestId]]) {
        if (id) { try { value[key] = await operation(id) } catch { value.notice = { state: 'attention', code: 'UPDATE_RESULT_UNAVAILABLE', message: '更新結果を確認できません。同じ要求を照会してください。' } } }
      }
      if (!validateUpdates(value).valid) throw failure('UPDATE_SNAPSHOT_INVALID')
      return value
    },
    async plan(input) {
      validateUpdateRequest('plan', input)
      if (input.scope !== 'component' || input.componentId !== 'container') throw failure('UPDATE_EXECUTOR_UNAVAILABLE')
      const selected = await selection(); requireValue(selected.release !== null, 'PUBLISHED_RELEASE_UNAVAILABLE')
      const planId = randomUUID()
      const host = await client.plan({ planId, catalogSha256: selected.catalogSha256, versionId: selected.release.versionId })
      requireValue(host?.schema === 'bellteam.host-update.plan.v1' && host.planId === planId && host.catalogSha256 === selected.catalogSha256
        && host.target?.versionId === selected.release.versionId && host.target?.sourceCommit === selected.release.sourceCommit
        && date(host.expiresAt) && host.impact?.containerRestart === true)
      const currentDigest = host.expected?.imageRef?.split('@')[1]
      const current = source(host.expected?.sourceCommit) && digest(currentDigest)
        ? { version: currentDigest, sourceCommit: host.expected.sourceCommit, digest: currentDigest, origin: 'container' } : null
      const plan = { planId, scope: 'component', componentId: 'container', expiresAt: host.expiresAt,
        targets: [{ componentId: 'container', current, published: version(selected.release) }],
        compatibility: { compatible: true, reason: null }, impact: { containerRestart: true, description: '本体の再起動中は会話と処理が一時中断します。' }, capability: { supported: true, reason: null } }
      await save(plan); return plan
    },
    async start(input) {
      validateUpdateRequest('operation', input); await load(input.planId)
      if (!input.confirmContainerRestart) throw failure('UPDATE_RESTART_CONFIRMATION_REQUIRED', 409)
      const result = await client.start(input)
      requireValue(result?.requestId === input.requestId && result.planId === input.planId && result.admission === 'accepted', 'UPDATE_ADMISSION_UNCONFIRMED')
      return operation(input.requestId)
    },
  }
}
