const comparisons = { up_to_date: '正式公開版と一致', update_available: '更新あり', unavailable: '更新情報を取得できません', incompatible: '互換性を確認できません', unknown: '確認不能' }
const legacyPhases = ['preparing', 'applying', 'reconnecting', 'verifying', 'completed', 'failed', 'unknown']
const legacyOutcomes = ['pending', 'succeeded', 'failed', 'unknown']
const jobStates = ['queued', 'downloading', 'verifying', 'swapping', 'ready', 'failed']
const inventoryPath = '/api/updates?runtime=1'
const runtimeComponents = ['runtime-aiterm-mcp', 'runtime-codex', 'runtime-claude-code', 'runtime-throughline']
const isRuntime = id => runtimeComponents.includes(id)
const runtimeApplicationText = '次回起動から適用。実行中の席は現在の版を継続'
const reasons = { MODULE_EXCHANGE_BUSY: 'ほかの更新を実行中です。完了後に状態を確認してください。', UPDATE_ALREADY_CURRENT: '正式公開版と一致しているため、更新は不要です。', MODULE_NOT_INDEPENDENT: 'この機能は、まだ個別更新に対応していません。', UPDATE_EXECUTOR_UNAVAILABLE: '更新の実行機構は未接続です。', PUBLISHED_RELEASE_UNAVAILABLE: '正式公開版の情報は未接続です。', PUSH_NOT_CONFIGURED: '端末への通知は設定されていません。', NOTIFICATIONS_UNAVAILABLE: '通知機能を利用できません。', WEB_GATEWAY_UNAVAILABLE: 'Web受付の稼働を確認できません。', AVAILABILITY_UNKNOWN: '利用状態を確認できません。', UPDATE_INCOMPATIBLE: 'この更新先との互換性を確認できません。' }
const explanation = (reason, runtime = false) => reasons[reason] ?? (runtime ? `更新を実行できません（${reason}）。` : '更新に必要な条件を確認できないため、実行できません。')
const text = value => typeof value === 'string' && value.length > 0
const nullableText = value => value === null || text(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const date = value => text(value) && Number.isFinite(Date.parse(value))
const capability = value => value && typeof value.supported === 'boolean' && (value.supported ? value.reason === null : text(value.reason))
const version = value => value === null || value && text(value.version)
  && (value.sourceCommit === null || /^[a-f0-9]{40}$/.test(value.sourceCommit))
  && (value.digest === null || /^sha256:[a-f0-9]{64}$/.test(value.digest))
  && ['container', 'builtin', 'release', 'published'].includes(value.origin)
const plan = value => value && uuid(value.planId) && ['all', 'component'].includes(value.scope) && nullableText(value.componentId)
  && (value.action === undefined || ['update', 'rollback'].includes(value.action))
  && date(value.expiresAt) && Array.isArray(value.targets) && value.targets.length > 0
  && new Set(value.targets.map(target => target?.componentId)).size === value.targets.length
  && value.targets.every(target => target && text(target.componentId) && version(target.current) && target.published !== null && version(target.published))
  && (value.scope === 'all' ? value.componentId === null && value.action !== 'rollback'
    : value.targets.length === 1 && value.targets[0].componentId === value.componentId && (value.componentId !== 'container' || value.action !== 'rollback'))
  && value.compatibility && typeof value.compatibility.compatible === 'boolean' && nullableText(value.compatibility.reason)
  && value.impact && typeof value.impact.containerRestart === 'boolean' && text(value.impact.description) && capability(value.capability)
const job = value => value && value.schema === 'bellteam.update-job.v1' && uuid(value.jobId)
  && ['module', 'container', 'runtime'].includes(value.kind) && value.target && text(value.target.moduleId)
  && typeof value.updatedAtNs === 'string' && /^(0|[1-9][0-9]*)$/.test(value.updatedAtNs)
  && jobStates.includes(value.state) && (value.state === 'failed'
    ? value.reason && text(value.reason.code) && text(value.reason.message) : value.reason === null)
const jobs = value => value === undefined || Array.isArray(value) && value.every(job)
const operation = value => value === null || value && uuid(value.requestId) && plan(value.plan)
  && ['pending', 'accepted', 'rejected', 'unknown'].includes(value.admission) && legacyPhases.includes(value.phase)
  && legacyOutcomes.includes(value.execution) && legacyOutcomes.includes(value.verification)
  && (value.error === null || value.error && text(value.error.code) && text(value.error.message)) && nullableText(value.reference)
  && jobs(value.jobs)
const publication = value => value === null || value && value.catalog && /^[a-f0-9]{64}$/.test(value.catalog.sha256)
  && date(value.catalog.publishedAt) && date(value.catalog.expiresAt) && value.check
  && ['verified', 'failed', 'unconfirmed'].includes(value.check.status)
  && (value.check.checkedAt === null || date(value.check.checkedAt)) && nullableText(value.check.error)
const errorText = error => [...new Set([error?.code, error?.message, error?.path, error?.reason].filter(text))].join(' / ')
  || ([401, 403].includes(error?.status) ? '更新情報を読む権限がありません。'
    : error?.status === 404 ? 'この接続先では更新情報が未提供です。' : '更新情報を取得できませんでした。')
const comparisonLabel = item => item.comparison.state === 'up_to_date' && item.publication?.check.status !== 'verified'
  ? '受入済み版と一致 · 公開情報の取得確認が必要です' : comparisons[item.comparison.state]
const componentStatus = value => value && text(value.line)
  && ['ok', 'updating', 'attention'].includes(value.tone) && typeof value.actionRequired === 'boolean' && nullableText(value.action)
  && (value.latestJob === null || value.latestJob && uuid(value.latestJob.jobId)
    && ['module', 'container', 'runtime'].includes(value.latestJob.kind) && jobStates.includes(value.latestJob.state)
    && ['running', 'succeeded', 'failed'].includes(value.latestJob.outcome) && date(value.latestJob.at)
    && (value.latestJob.reason === null || value.latestJob.reason && text(value.latestJob.reason.code) && text(value.latestJob.reason.message)))
const problem = value => value && text(value.fingerprint) && ['open', 'resolved'].includes(value.status)
  && value.kind === 'module_restart_limit' && text(value.moduleId) && Number.isSafeInteger(value.count)
  && value.windowSeconds === 1800 && value.lastExit
  && (value.lastExit.code === null || Number.isInteger(value.lastExit.code))
  && nullableText(value.lastExit.signal) && text(value.lastReason)

// Check consumed display values; the complete public schema remains in src/update-center-contract.mjs.
export function validUpdateInventory(value) {
  return Boolean(value && value.schema === 'bellteam.updates.v1' && value.server && nullableText(value.server.id)
    && text(value.observedAt) && Number.isFinite(Date.parse(value.observedAt)) && value.notice
    && ['ready', 'unavailable', 'updating', 'attention'].includes(value.notice.state) && nullableText(value.notice.code) && text(value.notice.message)
    && Array.isArray(value.components) && new Set(value.components.map(item => item?.id)).size === value.components.length
    && value.components.every(item => item && text(item.id) && text(item.name) && text(item.description) && version(item.current) && version(item.published)
      && item.comparison && Object.hasOwn(comparisons, item.comparison.state) && nullableText(item.comparison.reason)
      && publication(item.publication) && Array.isArray(item.changes) && item.changes.every(text) && capability(item.capability) && item.availability
      && [true, false, null].includes(item.availability.available) && nullableText(item.availability.reason)
      && (!isRuntime(item.id) || item.runtimeApplication?.policy === 'next_launch'
        && (item.runtimeApplication.generationId === null || /^[a-f0-9]{64}$/.test(item.runtimeApplication.generationId))))
    && Array.isArray(value.plans) && value.plans.every(plan) && operation(value.operation) && operation(value.previousOperation)
    && jobs(value.jobs)
    && (value.problems === undefined || Array.isArray(value.problems) && value.problems.every(problem)))
}

const versionLabel = value => value === null ? '稼働版を確認できません' : `${value.origin === 'builtin' ? '内蔵版 · ' : ''}${/^(?:sha256:)?[a-f0-9]{40,64}$/.test(value.version) ? value.version.replace(/^sha256:/, '').slice(0, 12) : value.version}`
const formatDate = value => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) + ' JST'

const cardIcons = ['container', 'web-gateway', 'notifications', 'members', 'conversation', 'execution', 'usage', 'memory', 'diagnostics']
const jobSteps = { queued: 1, downloading: 2, verifying: 3, swapping: 4 }
const stepText = { queued: '順番を待っています', downloading: '新しい版を取り込んでいます', verifying: '新しい版を確かめています', swapping: '新しい版に切り替えています' }
const shortTime = value => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
// People-facing version name (dated when a time is known); hashes and the server line stay in 詳細.
const versionName = (item, job) => {
  if (isRuntime(item.id)) return { name: '本体に同梱', origin: '' }
  if (!item.current) return { name: '版を確認できません', origin: '' }
  const at = item.current.origin === 'release' && job?.outcome === 'succeeded' ? job.at
    : item.comparison.state === 'up_to_date' && item.publication ? item.publication.catalog.publishedAt : null
  const origin = { builtin: '本体に同梱', release: '更新で導入', container: '本体' }[item.current.origin] ?? ''
  return at ? { name: `${shortTime(at)} 版`, origin }
    : { name: { builtin: '本体に同梱の版', release: '更新で入れた版', container: '稼働中の版' }[item.current.origin] ?? '現在の版', origin: '' }
}
// Swap kept, a later step failed (container-update-bundled.md): the new version runs, so never say the old one does.
const swappedThenFailed = job => job?.reason?.code === 'HOST_UPDATE_AITERM_STATE_FAILED'
// Badge from the newest job record for this part (fresher via SSE), else the server's latestJob; wording stays with the server line.
export function cardState(item, records = []) {
  const status = componentStatus(item.status) ? item.status : null, latestAt = status?.latestJob ? BigInt(Date.parse(status.latestJob.at)) * 1000000n : -1n
  // The server's latest job wins unless an SSE/operation record is the same job or newer.
  const record = records.filter(job => job.target.moduleId === item.id && (!status?.latestJob || job.jobId === status.latestJob.jobId || BigInt(job.updatedAtNs) > latestAt))
    .reduce((latest, job) => !latest || BigInt(job.updatedAtNs) > BigInt(latest.updatedAtNs) ? job : latest, null)
  const job = record ? { state: record.state, outcome: record.state === 'ready' ? 'succeeded' : record.state === 'failed' ? 'failed' : 'running', at: new Date(Number(BigInt(record.updatedAtNs) / 1000000n)).toISOString(), reason: record.reason }
    : status?.latestJob ? { state: status.latestJob.state, outcome: status.latestJob.outcome, at: status.latestJob.at, reason: status.latestJob.reason } : null
  const serving = item.id === 'container' || item.availability.available === true
  if (job?.outcome === 'running') return { badge: '更新中', tone: 'info', job, step: jobSteps[job.state] ?? 1 }
  if (status?.tone === 'attention') return { badge: '要対応', tone: 'danger', job, step: 0 }
  if (job?.outcome === 'failed' && (swappedThenFailed(job) || !(serving && item.comparison.state === 'up_to_date'))) return { badge: '失敗', tone: 'danger', job, step: 0 }
  // Owner rule: Aiterm/CLIs update only with the body release.
  if (isRuntime(item.id)) return { badge: '本体と一緒に更新', tone: 'neutral', job, step: 0 }
  const [badge, tone] = { update_available: ['更新あり', 'accent'], up_to_date: ['最新', 'ok'], incompatible: ['使えない版', 'muted'] }[item.comparison.state] ?? ['確認できません', 'muted']
  return { badge, tone, job, step: 0 }
}

export function createUpdateCenter({ root, api, buttons, storage }) {
  const get = selector => root.querySelector(selector)
  const list = get('[data-update-components]'), detail = get('[data-update-detail]')
  const product = get('[data-update-product]')
  const notice = get('[data-update-notice]'), refreshButton = get('[data-update-refresh]')
  let selected = 'all', generation = 0, opened = false, disposed = false, loading = false
  let opener = null, inventory = null, recentJobs = [], failure = '', planFailure = ''
  const requestKey = 'bellteam-update-request.v1'
  let planned = null, planning = false, submitting = false, confirmed = false, planGeneration = 0
  let pending = null, ownResult = null, operationMessage = '', storageFailure = '', requestStorage = storage
  let operationReadError = ''
  let previousResults = []
  const readers = new Map()
  let eventRevision = 0
  try {
    requestStorage ??= globalThis.sessionStorage
    const saved = requestStorage?.getItem(requestKey)
    if (saved) {
      const value = JSON.parse(saved)
      if (value?.previous !== undefined) {
        if (!Array.isArray(value.previous) || value.previous.some(result => !result
          || !(result.plan ? operation(result) : uuid(result.requestId) && uuid(result.planId)))
          || new Set(value.previous.map(result => result.requestId)).size !== value.previous.length) throw Error('INVALID_SAVED_REQUEST')
        previousResults = value.previous.map(result => ({ requestId: result.requestId, planId: result.plan?.planId ?? result.planId,
          result: result.plan ? result : null, saved: result.plan ? result : null, error: '' }))
      }
      if (value?.requestId !== undefined || value?.planId !== undefined) {
        if (!uuid(value.requestId) || !uuid(value.planId) || previousResults.some(entry => entry.requestId === value.requestId)) throw Error('INVALID_SAVED_REQUEST')
        pending = { requestId: value.requestId, planId: value.planId }
      } else if (!previousResults.length) throw Error('INVALID_SAVED_REQUEST')
    }
  } catch { storageFailure = '保存された更新要求を確認できません。新しい更新は開始できません。' }
  const element = (tag, className, value) => {
    const node = document.createElement(tag)
    node.className = className
    if (value !== undefined) node.textContent = value
    return node
  }
  function render() {
    refreshButton.disabled = loading
    root.setAttribute('aria-busy', String(loading))
    notice.textContent = operationReadError || operationMessage || storageFailure || (loading ? '接続先の更新情報を確認しています。' : failure || inventory?.notice.message || '更新センターを開くと、接続先の情報を確認します。')
    const publicationUnknown = inventory?.components.some(item => item.published && item.publication?.check.status !== 'verified')
    let suffix = inventory && !failure ? { ready: inventory.components.some(item => item.comparison.state === 'update_available') ? ' · 更新あり' : '', unavailable: ' · 利用不能', updating: ' · 更新中', attention: ' · 要確認' }[inventory.notice.state] : ''
    if (publicationUnknown || operationReadError || previousResults.some(entry => entry.error)) suffix = ' · 要確認'
    for (const button of buttons) {
      button.textContent = `Update${suffix}`
      button.setAttribute('aria-label', button.textContent + ' 更新センターを開く')
    }
    get('[data-update-observed]').textContent = inventory ? `取得 ${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(inventory.observedAt))} JST` : '情報を確認できていません'
    const focused = document.activeElement?.dataset?.component
    const focusedControl = document.activeElement?.dataset?.updateControl
    if (selected !== 'all' && !inventory?.components.some(item => item.id === selected)) { selected = 'all'; planned = null; confirmed = false; planGeneration++; planning = false }
    list.replaceChildren()
    const choices = [{ id: 'all', name: '全体アップデート', description: '互換性を確認した計画で、必要な機能をまとめて更新。' }, ...(inventory?.components ?? [])]
    for (const component of choices) {
      const button = element('button', `update-component${selected === component.id ? ' is-selected' : ''}`)
      button.type = 'button'; button.dataset.component = component.id
      button.setAttribute('aria-pressed', String(selected === component.id))
      const mark = element('span', 'update-component-mark', component.id === 'all' ? '✳' : component.name.slice(0, 1))
      mark.setAttribute('aria-hidden', 'true')
      const copy = element('span', 'update-component-copy')
      copy.append(element('strong', '', component.name), element('span', 'update-description', component.description))
      const current = element('span', 'update-component-version', component.id === 'all' ? '製品全体の計画' : versionLabel(component.current))
      if (component.current) current.title = component.current.version
      copy.append(current)
      if (component.id !== 'all') {
        copy.append(element('span', 'update-component-status', comparisonLabel(component)))
        if (isRuntime(component.id)) copy.append(element('span', 'update-description', runtimeApplicationText))
        if (!component.capability.supported) copy.append(element('span', 'update-component-reason', explanation(component.capability.reason, isRuntime(component.id))))
      }
      button.append(mark, copy, element('span', 'update-component-arrow', '›'))
      button.addEventListener('click', () => {
        selected = component.id; planned = null; confirmed = false; planGeneration++; planning = false; renderDetail()
        for (const row of list.children) {
          row.classList.toggle('is-selected', row.dataset.component === selected)
          row.setAttribute('aria-pressed', String(row.dataset.component === selected))
        }
        if (window.matchMedia?.('(max-width: 780px)').matches) detail.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      })
      list.append(button)
      if (component.id === focused) button.focus()
    }
    renderDetail()
    if (focusedControl) root.querySelector(`[data-update-control="${focusedControl}"]`)?.focus()
  }
  function canRequest() {
    return Boolean(inventory && !loading && !planning && !submitting && !storageFailure && !failure)
  }
  function canPlan(action = 'update') {
    if (!canRequest()) return false
    const component = inventory.components.find(item => item.id === selected)
    if (action === 'rollback') return selected !== 'all' && selected !== 'container' && !isRuntime(selected) && component
      && component.capability.reason !== 'MODULE_NOT_INDEPENDENT'
    return selected === 'all' ? inventory.components.some(item => item.capability.supported) : component?.capability.supported
  }
  function canExecute() {
    return canRequest() && planned && planned.capability.supported && planned.compatibility.compatible
      && Date.parse(planned.expiresAt) > Date.now() && (!planned.impact.containerRestart || confirmed)
  }
  function renderDetail() {
    const supportOpen = Array.from(detail.children).find(node => node.className === 'update-support')?.open ?? false
    const component = inventory?.components.find(item => item.id === selected)
    const status = componentStatus(component?.status) ? component.status : null
    const selectedPlan = planned
    const affects = item => item && (selected === 'all' || item.plan.targets.some(target => target.componentId === selected))
    const current = inventory?.operation, previous = inventory?.previousOperation
    const result = affects(ownResult) ? ownResult : affects(current) ? current : affects(previous) ? previous : null
    const displayPlan = selectedPlan ?? result?.plan ?? inventory?.plans.find(item => selected === 'all' ? item.scope === 'all' : item.scope === 'component' && item.componentId === selected)
    detail.replaceChildren()
    const back = element('button', 'update-back-to-components', '対象一覧へ ↑')
    back.type = 'button'; back.addEventListener('click', () => {
      list.scrollIntoView({ block: 'start' })
      Array.from(list.children).find(row => row.dataset.component === selected)?.focus()
    })
    detail.append(back)
    detail.append(element('p', 'update-kicker', selected === 'all' ? 'PRODUCT UPDATE' : selected === 'container' ? 'CONTAINER' : 'MODULE UPDATE'))
    detail.append(element('h3', 'update-detail-title', component?.name ?? '製品全体のアップデート'))
    detail.append(element('p', 'update-detail-description', component?.description ?? '各機能の状態を確認し、互換性のある更新計画を選びます。'))
    if (isRuntime(selected)) detail.append(element('p', 'update-detail-description', runtimeApplicationText))
    const versions = element('div', 'update-versions')
    const multiple = selectedPlan?.targets.length > 1
    for (const [label, value] of [[selectedPlan ? '計画時の稼働版' : '現在稼働', selectedPlan ? multiple ? `${selectedPlan.targets.length}項目の固定対象を下で確認` : versionLabel(selectedPlan.targets[0].current) : component ? versionLabel(component.current) : '一覧で各機能を確認'], [selectedPlan?.action === 'rollback' ? '固定した戻し先' : selectedPlan ? '固定した更新先' : '正式公開版', selectedPlan ? multiple ? '対象と実行順は計画に固定されています' : versionLabel(selectedPlan.targets[0].published) : component?.published ? versionLabel(component.published) : '情報を取得できません']]) {
      const column = element('div', '')
      column.append(element('span', 'update-field-label', label), element('strong', '', value))
      versions.append(column)
    }
    detail.append(versions)
    if (component) {
      const available = component.availability
      const section = element('section', 'update-detail-section')
      const unavailableMessage = available.reason === 'PUSH_NOT_CONFIGURED' ? '通知が未設定のため、端末へのお知らせを送れません。'
        : available.reason === 'NOTIFICATIONS_UNAVAILABLE' ? '通知を現在利用できないため、端末へのお知らせを送れません。' : 'この機能は現在利用できません。'
      section.append(element('h4', '', '機能の利用状態'), element('p', '', available.available === true ? 'この機能は利用できます。' : available.available === false ? unavailableMessage : '機能の稼働状況を取得できていません。更新可否は計画で確認します。'))
      detail.append(section)
      const published = element('section', 'update-detail-section update-publication')
      published.append(element('h4', '', '公開情報の確認'))
      if (component.publication) {
        const { catalog, check } = component.publication
        published.append(element('p', check.status === 'verified' ? '' : 'update-failure', { verified: '配布情報の取得を確認しました。', failed: '配布情報の取得確認に失敗しました。最新版とは確認できていません。', unconfirmed: '配布情報の取得確認は未確定です。最新版とは確認できていません。' }[check.status]))
        if (check.status === 'verified') published.append(element('p', '', component.comparison.state === 'unknown' ? '稼働版の情報が不足しているため、公開版との比較はできません。' : comparisons[component.comparison.state]))
        published.append(element('p', '', `受入済み情報の公開日時: ${formatDate(catalog.publishedAt)} / 有効期限: ${formatDate(catalog.expiresAt)}`))
        if (check.checkedAt) published.append(element('p', '', `取得の確認日時: ${formatDate(check.checkedAt)}`))
      } else published.append(element('p', '', component.published ? '配布情報の取得確認が未完了のため、表示中の版が最新版かどうかは確認できません。' : '正式公開版の情報を取得できていないため、更新先を案内できません。'))
      detail.append(published)
    }
    const changes = element('section', 'update-detail-section')
    changes.append(element('h4', '', 'この更新で変わること'))
    const changed = selected === 'all' ? (displayPlan?.targets.map(target => inventory?.components.find(item => item.id === target.componentId)) ?? inventory?.components ?? []).filter(Boolean) : component ? [component] : []
    if (displayPlan?.action === 'rollback') changes.append(element('p', '', '成功確認済みの交換のコードを戻します。対象と影響は下の計画を確認してください。'))
    else if (changed.some(item => item.changes.length)) for (const item of changed) for (const change of item.changes) changes.append(element('p', '', selected === 'all' ? `${item.name}: ${change}` : change))
    else changes.append(element('p', '', '正式版の変更内容を取得できていません。'))
    detail.append(changes)
    const impact = element('section', 'update-impact')
    impact.append(element('h4', '', '対象と影響'), element('p', '', displayPlan?.impact.description ?? '更新計画が未提供のため、実際の更新対象と影響は確認できません。'))
    if (displayPlan?.impact.containerRestart) impact.append(element('p', 'update-failure', 'コンテナの再起動が必要です。実行前に中断の影響を確認してください。'))
    if (displayPlan) {
      for (const target of displayPlan.targets) {
        const name = inventory?.components.find(item => item.id === target.componentId)?.name ?? target.componentId
        impact.append(element('p', 'update-fixed-target', `${name} · ${displayPlan.action === 'rollback' ? '固定した戻し先' : '固定した更新先'}: ${versionLabel(target.published)}`))
      }
      if (displayPlan.action === 'rollback') impact.append(element('p', '', '機能のコードを戻します。現在のデータ・設定・更新履歴は巻き戻しません。'))
      if (selectedPlan) impact.append(element('p', '', `計画の有効期限: ${formatDate(selectedPlan.expiresAt)}`))
    }
    detail.append(impact)
    const progress = element('section', 'update-detail-section update-result')
    progress.append(element('h4', '', '進行と実際の結果'))
    if (result) {
      if (selectedPlan && selectedPlan.planId !== result.plan.planId) progress.append(element('p', '', '直前の操作結果です。表示中の計画はまだ実行していません。'))
      else if (result === previous) progress.append(element('p', '', '前回の更新'))
      if (result.jobs?.length) renderJobs(progress, result.jobs)
      else {
        progress.append(element('p', 'update-result-state', '保存されたジョブの記録はありません。'))
        if (result.error) progress.append(element('p', 'update-failure', `${result.error.code} / ${result.error.message}`))
      }
    } else progress.append(element('p', 'update-result-state', '更新の記録はありません'))
    if (operationReadError) progress.append(element('p', 'update-failure', operationReadError))
    detail.append(progress)
    if (pending || operationMessage) {
      const message = element('p', 'update-operation-message', operationMessage || '同じ要求の進行と結果を確認しています。')
      message.setAttribute('role', 'status'); detail.append(message)
    }
    const action = element('button', 'update-execute', submitting ? '受付を確認しています…' : planning ? '計画を取得しています…' : selectedPlan ? selectedPlan.action === 'rollback' ? 'この計画で戻す' : 'この計画で更新' : canPlan() ? '更新計画を確認' : '更新を実行できません')
    action.type = 'button'; action.dataset.updateControl = 'execute'
    if (selectedPlan?.impact.containerRestart) {
      const label = element('label', 'update-restart-confirm')
      const checkbox = element('input', '')
      checkbox.type = 'checkbox'; checkbox.checked = confirmed; checkbox.disabled = submitting
      checkbox.dataset.updateControl = 'restart-confirm'
      checkbox.addEventListener('change', () => { confirmed = checkbox.checked; action.disabled = !canExecute() })
      label.append(checkbox, element('span', '', '全Botの会話と処理が一時中断することを確認しました。'))
      detail.append(label)
    }
    action.disabled = selectedPlan ? !canExecute() : !canPlan()
    action.addEventListener('click', () => { if (selectedPlan) void execute(); else void requestPlan() })
    let reasonText = '対象版と影響を計画で確認してから、明示的に実行します。'
    if (component && !component.capability.supported && !selectedPlan) reasonText = explanation(component.capability.reason, isRuntime(component.id))
    if (selectedPlan && !selectedPlan.compatibility.compatible) reasonText = '計画の互換性を確認できないため、実行できません。'
    if (selectedPlan && !selectedPlan.capability.supported) reasonText = explanation(selectedPlan.capability.reason, isRuntime(selectedPlan.componentId))
    if (selectedPlan && Date.parse(selectedPlan.expiresAt) <= Date.now()) reasonText = '計画の有効期限が切れました。計画を再取得してください。'
    if (pending) reasonText = '前の要求の照会用IDを保持しています。新しい更新は、計画の版と影響を確認してから実行します。'
    const reason = element('p', 'update-action-reason', storageFailure || reasonText)
    reason.id = 'update-action-reason'; action.setAttribute('aria-describedby', reason.id)
    detail.append(action, reason)
    if (selected !== 'all' && selected !== 'container' && !isRuntime(selected) && component && component.capability.reason !== 'MODULE_NOT_INDEPENDENT') {
      const rollback = element('button', 'update-replan', '戻しの可否を確認')
      rollback.type = 'button'; rollback.disabled = !canPlan('rollback'); rollback.dataset.updateControl = 'rollback'
      rollback.addEventListener('click', () => { void requestPlan('rollback') }); detail.append(rollback)
    }
    if (selectedPlan && canRequest()) {
      const replan = element('button', 'update-replan', '計画を再取得')
      replan.type = 'button'; replan.disabled = planning; replan.dataset.updateControl = 'replan'
      replan.addEventListener('click', () => { void requestPlan(selectedPlan.action ?? 'update') }); detail.append(replan)
    }
    const support = element('details', 'update-support')
    support.open = supportOpen
    const summary = element('summary', '', 'サポート用の詳細')
    summary.dataset.updateControl = 'support-summary'; support.append(summary)
    const fields = element('dl', '')
    const codes = new Set([planFailure, component?.availability.reason, component?.comparison.reason, component?.capability.reason,
      component?.publication?.check.error, displayPlan?.compatibility.reason, displayPlan?.capability.reason, result?.error?.code, status?.latestJob?.reason?.code].filter(Boolean))
    const values = [
      ['状態の説明', status?.line], ['稼働版', component?.current?.version], ['稼働配布物', component?.current?.digest],
      ['公開版', component?.published?.version], ['公開配布物', component?.published?.digest],
      ['最新ジョブID', status?.latestJob?.jobId], ['最新ジョブ種別', status?.latestJob?.kind],
      ['最新ジョブ状態', status?.latestJob?.state], ['最新ジョブ結果', status?.latestJob?.outcome],
      ['最新ジョブ日時', status?.latestJob ? formatDate(status.latestJob.at) : null],
      ['最新ジョブの理由', status?.latestJob?.reason?.message],
      ...(displayPlan?.targets.map(target => [`固定した更新先 · ${target.componentId}`, target.published.version]) ?? []),
      ['計画ID', displayPlan?.planId], ['要求ID', result?.requestId ?? pending?.requestId],
      ['状態・理由の符号', [...codes].join(' / ')],
    ]
    for (const [label, value] of values) if (value) fields.append(element('dt', '', label), element('dd', '', value))
    if (!fields.children.length) fields.append(element('dd', '', '詳細情報はまだ取得できていません。'))
    support.append(fields); detail.append(support)
    if (previousResults.length) {
      const history = element('section', 'update-detail-section')
      history.append(element('h4', '', '保持している操作結果'))
      for (const entry of previousResults) {
        const result = entry.result, item = element('details', 'update-support')
        item.open = entry.open ?? false
        item.addEventListener('toggle', () => { entry.open = item.open })
        item.append(element('summary', '', result?.plan.targets.map(target => inventory?.components.find(component => component.id === target.componentId)?.name ?? target.componentId).join('・') || '保持している要求'))
        const identities = element('dl', '')
        for (const [label, value] of [['要求ID', entry.requestId], ['計画ID', entry.planId]]) {
          if (value) identities.append(element('dt', '', label), element('dd', '', value))
        }
        item.append(identities)
        if (result?.jobs?.length) renderJobs(item, result.jobs)
        else {
          item.append(element('p', '', '保存されたジョブの記録はありません。'))
          if (result?.error) item.append(element('p', 'update-failure', `${result.error.code} / ${result.error.message}`))
        }
        if (entry.error) item.append(element('p', 'update-failure', entry.error))
        const read = element('button', 'update-replan', 'この要求の状態を再取得')
        read.type = 'button'; read.disabled = loading || submitting; read.dataset.updateControl = `read-${entry.requestId}`
        read.addEventListener('click', () => { void refresh() })
        item.append(read); history.append(item)
      }
      detail.append(history)
    }
    renderProduct({ action, result, selectedPlan })
  }
  const newerJob = (left, right) => !left || BigInt(right.updatedAtNs) > BigInt(left.updatedAtNs) ? right : left
  function renderJobs(parent, records) {
    for (let record of records) {
      const recent = recentJobs.find(item => item.kind === record.kind && item.jobId === record.jobId)
      if (recent) record = newerJob(record, recent)
      const row = element('article', 'update-job')
      row.dataset.jobId = record.jobId
      const name = inventory?.components.find(item => item.id === record.target.moduleId)?.name ?? record.target.moduleId
      row.append(element('p', '', name), element('p', 'update-result-state', `状態: ${record.state}`),
        element('p', '', `ジョブID: ${record.jobId}`))
      if (record.reason) row.append(element('p', 'update-failure', `${record.reason.code} / ${record.reason.message}`))
      parent.append(row)
    }
  }
  function renderProduct({ action, result, selectedPlan }) {
    const focus = document.activeElement?.dataset?.updateControl
    const recordsById = new Map()
    for (const record of [...(ownResult?.jobs ?? []), ...(inventory?.operation?.jobs ?? []), ...recentJobs]) {
      const key = `${record.kind}:${record.jobId}`
      recordsById.set(key, newerJob(recordsById.get(key), record))
    }
    const records = [...recordsById.values()]
    const components = inventory?.components ?? []
    const states = new Map(components.map(item => [item.id, cardState(item, records)]))
    const product_ = components.filter(item => !isRuntime(item.id)), runtime = components.filter(item => isRuntime(item.id))
    const count = badge => product_.filter(item => states.get(item.id).badge === badge).length
    const candidates = components.filter(item => item.comparison.state === 'update_available' && item.capability.supported && states.get(item.id).badge !== '更新中')
    const readError = failure || storageFailure
    const running = components.filter(item => states.get(item.id).badge === '更新中')
    let title, description = '', tone = 'ok'
    if (readError) [title, tone] = ['更新情報を取得できません', 'danger']
    else if (loading && !inventory) [title, tone] = ['更新を確認しています', 'info']
    else if (submitting) [title, tone] = ['更新を受け付けています', 'info']
    else if (selectedPlan) {
      const names = selectedPlan.targets.map(target => components.find(item => item.id === target.componentId)?.name ?? '選択した項目').join('・')
      ;[title, tone] = [`${names}を${selectedPlan.action === 'rollback' ? '戻します' : '更新します'}`, 'info']
    } else if (running.length) [title, tone] = ['更新しています', 'info']
    else if (count('要対応')) [title, tone] = ['対応が必要です', 'danger']
    else if (candidates.filter(item => !isRuntime(item.id)).length) [title, tone] = [`${candidates.filter(item => !isRuntime(item.id)).length}つ更新できます`, 'accent']
    else if (count('失敗')) [title, tone] = ['前回の更新に失敗したものがあります', 'danger']
    else if (product_.length && count('最新') === product_.length) title = 'すべて最新です'
    else [title, tone] = [inventory ? '一部の状態を確認できません' : '更新情報', 'muted']
    if (!selectedPlan && !readError && inventory) description = running.length ? '進み具合はこの画面で確認できます。閉じても更新は続きます。'
      : title === 'すべて最新です' ? `${product_.length}つの機能はどれも最新版です。` : candidates.length ? '更新したい機能の「更新」を押してください。' : ''
    product.replaceChildren()
    product.dataset.tone = tone
    const header = element('header', 'update-summary')
    const icon = element('span', 'update-summary-icon'); icon.dataset.tone = tone; icon.setAttribute('aria-hidden', 'true')
    const copy = element('div', 'update-summary-copy')
    const heading = element('h3', 'update-status-title', title); heading.setAttribute('aria-live', 'polite')
    copy.append(heading)
    if (description) copy.append(element('p', 'update-status-copy', description))
    const meta = element('div', 'update-summary-meta')
    if (inventory) meta.append(element('span', 'update-summary-time', `確認 ${shortTime(inventory.observedAt)}`))
    const again = element('button', 'update-recheck', loading ? '確認中…' : '再確認'); again.type = 'button'
    again.dataset.updateControl = 'recheck'; again.disabled = loading || planning || submitting
    again.addEventListener('click', () => { void checkThenRefresh() })
    meta.append(again)
    header.append(icon, copy, meta); product.append(header)
    renderBanner({ components, states, readError, selectedPlan })
    if (selectedPlan) renderReview({ action, selectedPlan, components })
    else if (inventory) {
      renderCards(product_, states, candidates, null)
      if (runtime.length) renderCards(runtime, states, candidates, 'AIの実行部品 · 次回起動から適用')
    }
    if (records.length) {
      const section = element('section', 'update-release-notes update-jobs')
      section.append(element('h4', '', '保存されたジョブ')); renderJobs(section, records); detail.append(section)
    }
    if (inventory?.problems?.length) {
      const section = element('section', 'update-release-notes update-problems')
      section.append(element('h4', '', '機能の問題'))
      for (const problem of inventory.problems) {
        const row = element('article', 'update-problem')
        row.dataset.problemFingerprint = problem.fingerprint
        const name = components.find(item => item.id === problem.moduleId)?.name ?? problem.moduleId
        row.append(element('p', '', `${name} · 再起動の繰り返し · ${problem.status === 'resolved' ? '解決済み' : '問題あり'}`),
          element('p', '', `再起動回数: ${problem.count} / 集計期間（秒）: ${problem.windowSeconds}`),
          element('p', '', `直近の終了コード: ${problem.lastExit.code ?? '未観測'} / シグナル: ${problem.lastExit.signal ?? '未観測'}`),
          element('p', '', `直近の理由: ${problem.lastReason}`))
        section.append(row)
      }
      detail.append(section)
    }
    if (focus) product.querySelector(`[data-update-control="${focus}"]`)?.focus()
  }
  function renderBanner({ components, states, readError, selectedPlan }) {
    const name = id => components.find(item => item.id === id)?.name ?? '機能'
    const lines = [], banner = element('section', 'update-banner')
    let tone = 'danger', heading = ''
    if (readError) {
      heading = storageFailure ? 'この端末に更新の記録を保存できません' : '更新情報を読み取れませんでした'
      lines.push(storageFailure ? 'ブラウザーの保存を許可してから、画面を開き直してください。' : '接続を確かめて、「再確認」を押してください。')
    }
    if (operationReadError) { heading ||= '更新の結果を確認できませんでした'; lines.push('接続を確かめて、「再確認」を押してください。更新は二重には始まりません。') }
    if (operationMessage && !submitting) { heading ||= '更新を始められませんでした'; lines.push(operationMessage) }
    for (const item of components) {
      const state = states.get(item.id), status = componentStatus(item.status) ? item.status : null
      if (state.badge === '要対応') { heading ||= `${item.name}が使えません`; lines.push(`${item.name}: ${status?.action ?? 'この機能は今使えません。「詳細」の内容を担当に伝えてください。'}`) }
      if (state.badge === '失敗') { heading ||= '前回の更新ができませんでした'; lines.push(`${item.name}: ${item.availability.available === false ? 'この機能は今使えません。「詳細」の内容を担当に伝えてください。' : swappedThenFailed(state.job) ? '新しい版で動いていますが、席の状態を整える手順で失敗しました。「詳細」の内容を担当に伝えてください。' : '元の版のまま動いています。' + (item.comparison.state === 'update_available' ? '「もう一度更新」でやり直せます。' : '対応は不要です。')}`) }
    }
    for (const problem of inventory?.problems ?? []) if (problem.status === 'open') {
      heading ||= `${name(problem.moduleId)}が再起動を繰り返しています`; lines.push(`${name(problem.moduleId)}: 「詳細」の内容を担当に伝えてください。`)
    }
    const done = !selectedPlan && ownResult && (ownResult.jobs?.length ? ownResult.jobs.every(job => (recentJobs.find(item => item.jobId === job.jobId) ?? job).state === 'ready') : ownResult.phase === 'completed' && ownResult.execution === 'succeeded')
    if (!heading && done) {
      tone = 'ok'; heading = `${ownResult.plan.targets.map(target => name(target.componentId)).join('・')}を${ownResult.plan.action === 'rollback' ? '戻しました' : '更新しました'}`
    }
    if (!heading) return
    banner.dataset.tone = tone; banner.setAttribute('role', tone === 'ok' ? 'status' : 'alert')
    banner.append(element('strong', '', heading))
    for (const line of [...new Set(lines)]) banner.append(element('p', '', line))
    product.append(banner)
  }
  function renderCards(items, states, candidates, label) {
    const group = element('section', 'update-cards')
    if (label) { group.classList.add('is-runtime'); group.append(element('h4', 'update-cards-label', label)) }
    for (const item of items) {
      const state = states.get(item.id), card = element('article', 'update-card')
      card.dataset.component = item.id; card.dataset.tone = state.tone
      const top = element('div', 'update-card-top')
      const icon = element('span', 'update-card-icon'); icon.dataset.icon = cardIcons.includes(item.id) ? item.id : isRuntime(item.id) ? 'runtime' : 'module'
      icon.setAttribute('aria-hidden', 'true')
      const badge = element('span', 'update-badge', state.badge); badge.dataset.tone = state.tone
      top.append(icon, badge)
      const version = versionName(item, state.job), line = element('p', 'update-card-version')
      line.append(element('span', 'update-card-version-name', version.name))
      if (version.origin) line.append(element('span', 'update-card-origin', version.origin))
      if (item.comparison.state === 'update_available') line.append(element('span', 'update-card-next', item.publication ? `新しい版 ${shortTime(item.publication.catalog.publishedAt)}` : '新しい版あり'))
      card.append(top, element('h4', 'update-card-name', item.name), line, element('p', 'update-card-description', item.description))
      if (state.step) {
        const progress = element('div', 'update-progress'); progress.setAttribute('role', 'progressbar')
        progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '4'); progress.setAttribute('aria-valuenow', String(state.step))
        progress.setAttribute('aria-label', `${item.name}の更新 ${state.step}/4`)
        const bar = element('span', ''); bar.style.width = `${state.step * 25}%`; progress.append(bar)
        card.append(progress, element('p', 'update-card-step', `${state.step}/4 · ${stepText[state.job.state]}`))
      }
      if (item.comparison.state === 'update_available') {
        const notes = item.changes.filter(line => line.length <= 120 && !/sha256|commit|protocol|schema|\bnull\b|[a-f0-9]{12,}/i.test(line) && !/\b[A-Z][A-Z_]{5,}\b/.test(line)).slice(0, 2)
        if (notes.length) { const list = element('ul', 'update-card-notes'); for (const line of notes) list.append(element('li', '', line)); card.append(list) }
      }
      const foot = element('div', 'update-card-foot')
      foot.append(element('span', 'update-card-time', state.job ? `${{ succeeded: '最終更新', running: '開始', failed: '失敗' }[state.job.outcome]} ${shortTime(state.job.at)}` : '更新の記録なし'))
      if (candidates.includes(item)) {
        const button = element('button', 'update-card-action', state.badge === '失敗' ? 'もう一度更新' : '更新'); button.type = 'button'
        button.dataset.updateControl = `card-${item.id}`; button.disabled = loading || planning || submitting
        button.setAttribute('aria-label', `${item.name}を${button.textContent}`)
        button.addEventListener('click', () => { selected = item.id; planned = null; confirmed = false; planGeneration++; planning = false; void requestPlan() })
        foot.append(button)
      }
      card.append(foot); group.append(card)
    }
    product.append(group)
  }
  function renderReview({ action, selectedPlan, components }) {
    const review = element('section', 'update-plan-review')
    for (const target of selectedPlan.targets) {
      const item = components.find(component => component.id === target.componentId)
      const row = element('div', 'update-review-target')
      const icon = element('span', 'update-card-icon'); icon.dataset.icon = cardIcons.includes(target.componentId) ? target.componentId : isRuntime(target.componentId) ? 'runtime' : 'module'
      icon.setAttribute('aria-hidden', 'true')
      const copy = element('div', '')
      copy.append(element('strong', '', item?.name ?? '選択した項目'), element('p', 'update-card-version', `${item ? versionName(item, cardState(item, [])?.job).name : '現在の版'} → ${selectedPlan.action === 'rollback' ? '以前の版' : item?.publication ? `新しい版 ${shortTime(item.publication.catalog.publishedAt)}` : '新しい版'}`))
      row.append(icon, copy); review.append(row)
    }
    review.append(element('p', 'update-review-impact', selectedPlan.impact.containerRestart ? '更新中は全Botの会話と処理が一時中断します。再接続後に結果を確認します。' : isRuntime(selectedPlan.componentId) ? runtimeApplicationText : '本体の再起動はありません。使いながら更新できます。'))
    const check = Array.from(detail.children).find(node => node.className === 'update-restart-confirm')
    if (check) review.append(check)
    action.textContent = submitting ? '受付を確認しています…' : selectedPlan.action === 'rollback' ? '確認して戻す' : '確認して更新する'
    action.className = 'update-execute update-primary'
    const buttons = element('div', 'update-review-actions')
    const cancel = element('button', 'update-cancel', 'やめる'); cancel.type = 'button'; cancel.dataset.updateControl = 'cancel'; cancel.disabled = submitting
    cancel.addEventListener('click', () => { planned = null; confirmed = false; planGeneration++; render() })
    buttons.append(cancel, action); review.append(buttons)
    if (!selectedPlan.capability.supported || !selectedPlan.compatibility.compatible || Date.parse(selectedPlan.expiresAt) <= Date.now()) {
      review.append(element('p', 'update-review-impact', 'この内容では更新できません。「更新内容を再確認」で取り直してください。'))
      const retry = element('button', 'update-replan', '更新内容を再確認'); retry.type = 'button'; retry.disabled = !canPlan(selectedPlan.action ?? 'update')
      retry.addEventListener('click', () => { void requestPlan(selectedPlan.action ?? 'update') }); review.append(retry)
    }
    product.append(review)
  }
  async function requestPlan(action = 'update') {
    if (!canPlan(action)) return
    const read = ++planGeneration
    const componentId = selected
    planning = true; planned = null; confirmed = false; operationMessage = ''; planFailure = ''; renderDetail()
    try {
      const value = await api('/api/updates/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(componentId === 'all' ? { scope: 'all' } : { scope: 'component', componentId }), ...(action === 'rollback' ? { action } : {}) }) })
      if (read !== planGeneration || disposed) return
      const next = value?.plan
      if (!plan(next) || next.scope !== (componentId === 'all' ? 'all' : 'component') || next.componentId !== (componentId === 'all' ? null : componentId)
        || (next.action ?? 'update') !== action || Date.parse(next.expiresAt) <= Date.now()) throw Error('INVALID_PLAN')
      planned = next
    } catch (error) {
      if (read === planGeneration && !disposed) planFailure = error.message
      if (read === planGeneration && !disposed) operationMessage = error.message === 'UPDATE_ROLLBACK_UNAVAILABLE'
        ? '戻せる直前の個別更新を確認できません。戻しは開始していません。'
        : error.message === 'UPDATE_ROLLBACK_UNSUPPORTED' ? 'この対象の戻しには対応していません。'
        : error.message === 'RELEASE_NOT_INSTALLED' ? '対象の配布物がこの環境に配置されていません。実行は開始していません。'
        : '操作の計画を確認できませんでした。状態を確認して、計画を再取得してください。'
    } finally {
      if (read === planGeneration && !disposed) { planning = false; render() }
    }
  }
  function saveRequests(request, previous = previousResults) {
    if (!requestStorage) throw Error('STORAGE_UNAVAILABLE')
    if (!request && !previous.length) {
      requestStorage.removeItem(requestKey)
      if (requestStorage.getItem(requestKey) !== null) throw Error('STORAGE_UNAVAILABLE')
      return
    }
    const saved = JSON.stringify({ ...request, ...(previous.length ? { previous: previous.map(entry => entry.saved ?? { requestId: entry.requestId, planId: entry.planId }) } : {}) })
    requestStorage.setItem(requestKey, saved)
    if (requestStorage.getItem(requestKey) !== saved) throw Error('STORAGE_UNAVAILABLE')
  }
  function applyOperation(value, request) {
    if (!value || !operation(value) || value.requestId !== request.requestId || value.plan.planId !== request.planId
      || planned?.planId === request.planId && (value.plan.action ?? 'update') !== (planned.action ?? 'update')) throw Error('INVALID_OPERATION')
    ownResult = value; operationReadError = ''; operationMessage = ''
    if (planned?.planId === value.plan.planId) { planned = null; confirmed = false }
  }
  async function execute() {
    if (!canExecute()) {
      if (planned && Date.parse(planned.expiresAt) <= Date.now()) { operationMessage = '計画の有効期限が切れました。計画を再取得してください。'; render() }
      return
    }
    const target = planned
    let request, previous = [...previousResults]
    try {
      let requestId = globalThis.crypto.randomUUID?.()
      if (!requestId) {
        // randomUUID is unavailable on non-local HTTP; getRandomValues still provides platform randomness.
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
        bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
        requestId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
      }
      request = { requestId, planId: target.planId }
      if (!uuid(request.requestId) || !requestStorage) throw Error('STORAGE_UNAVAILABLE')
      if (pending && !previous.some(entry => entry.requestId === pending.requestId)) {
        previous.push({ ...pending, result: ownResult, error: operationReadError })
      }
      for (const result of [ownResult, inventory.operation, inventory.previousOperation]) {
        if (result && !previous.some(entry => entry.requestId === result.requestId)) {
          previous.push({ requestId: result.requestId, planId: result.plan.planId, result, error: '' })
        }
      }
      saveRequests(request, previous)
    } catch { operationMessage = '照会用の要求IDを保存できません。更新は開始していません。'; render(); return }
    previousResults = previous; pending = request; ownResult = null; operationReadError = ''; submitting = true; generation++
    operationMessage = '更新の受付を確認しています。'; render()
    try {
      const value = await api('/api/updates/operations', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: target.planId, requestId: request.requestId, confirmContainerRestart: target.impact.containerRestart && confirmed }) })
      if (disposed) return
      if (value?.operation?.admission !== 'accepted' || !value.operation.jobs?.length) throw Error('UPDATE_RESPONSE_INVALID')
      applyOperation(value.operation, request)
    } catch (error) {
      if (disposed) return
      operationReadError = errorText(error); operationMessage = ''; planned = null; confirmed = false
    } finally {
      submitting = false
      if (!disposed) { render(); await refresh() }
    }
  }
  function readLatest(path, apply) {
    const active = readers.get(path)
    if (active) { active.again = true; active.apply = apply; return active.promise }
    const entry = { again: false, apply, promise: null }
    readers.set(path, entry)
    entry.promise = (async () => {
      do {
        entry.again = false
        const read = generation, revision = eventRevision
        let response
        try { response = { status: 'fulfilled', value: await api(path) } }
        catch (reason) { response = { status: 'rejected', reason } }
        if (!disposed && read === generation) { entry.apply(response, revision); render() }
      } while (entry.again && !disposed)
    })().finally(() => {
      readers.delete(path)
      loading = readers.has(inventoryPath)
      if (!disposed) render()
    })
    return entry.promise
  }
  async function refresh(event) {
    if (!opened || disposed) return
    const updateEvent = event?.type === 'updates'
    const eventError = updateEvent && (event.error ? errorText(event.error)
      : !jobs(event.jobs) ? '更新ジョブの通知形式を確認できません。' : '')
    if (updateEvent && Array.isArray(event.jobs) && jobs(event.jobs)) { recentJobs = event.jobs; eventRevision++ }
    if (eventError) operationReadError = eventError
    else if (!pending) operationReadError = ''
    loading = true; render()
    const reads = [readLatest(inventoryPath, (result, revision) => {
      inventory = result.status === 'fulfilled' && validUpdateInventory(result.value) ? result.value : null
      if (inventory && revision === eventRevision) recentJobs = inventory.jobs ?? []
      failure = inventory ? '' : result.status === 'fulfilled' ? '更新情報の応答形式を確認できません。' : errorText(result.reason)
    })]
    const request = pending
    if (request) reads.push(readLatest(`/api/updates/operations/${request.requestId}`, result => {
      if (pending?.requestId !== request.requestId) return
      try {
        if (result.status !== 'fulfilled') throw result.reason
        applyOperation(result.value?.operation, request)
      } catch (error) { operationReadError = errorText(error); operationMessage = '' }
      if (eventError) operationReadError = eventError
    }))
    for (const entry of previousResults) reads.push(readLatest(`/api/updates/operations/${entry.requestId}`, response => {
      try {
        if (response.status !== 'fulfilled') throw response.reason
        const value = response.value?.operation
        if (!value || !operation(value) || value.requestId !== entry.requestId || value.plan.planId !== entry.planId
          || entry.result && (value.plan.action ?? 'update') !== (entry.result.plan.action ?? 'update')) throw Error('INVALID_OPERATION')
        entry.result = value; entry.error = ''
      } catch (error) { entry.error = errorText(error) }
      try { saveRequests(pending) } catch { storageFailure = '保持した要求の結果を保存できません。新しい更新は開始できません。' }
    }))
    await Promise.allSettled(reads)
  }
  function open(button = buttons.find(item => item.getClientRects().length && window.getComputedStyle(item).visibility === 'visible') ?? buttons[0]) {
    if (disposed) return
    opener = button; opened = true; confirmed = false
    if (!root.open) root.showModal()
    return refresh()
  }
  for (const button of buttons) button.addEventListener('click', () => { void open(button) })
  async function checkThenRefresh() {
    if (!opened || disposed) return
    loading = true; render()
    // An older module-installer rejects the check; the cached catalog is still re-read below.
    try { await api('/api/updates/catalog-check', { method: 'POST' }) } catch {}
    return refresh()
  }
  refreshButton.addEventListener('click', () => { if (!loading) void checkThenRefresh() })
  get('[data-update-close]').addEventListener('click', () => root.close())
  root.addEventListener('close', () => { confirmed = false; opener?.focus() })
  render()
  return { start() { opened = true; return refresh() }, open, refresh, close() { disposed = true; generation++; planGeneration++ } }
}
