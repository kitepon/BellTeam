const comparisons = { up_to_date: '正式公開版と一致', update_available: '更新あり', unavailable: '更新情報を取得できません', incompatible: '互換性を確認できません', unknown: '確認不能' }
const phases = { preparing: '準備中', applying: '更新中', reconnecting: '再接続中', verifying: '実稼働を確認中', completed: '更新完了', failed: '失敗', unknown: '結果確認不能' }
const outcomes = { pending: '未確認', succeeded: '成功', failed: '失敗', unknown: '確認不能' }
const reasons = { MODULE_NOT_INDEPENDENT: 'この機能は、まだ個別更新に対応していません。', UPDATE_EXECUTOR_UNAVAILABLE: '更新の実行機構は未接続です。', PUBLISHED_RELEASE_UNAVAILABLE: '正式公開版の情報は未接続です。', PUSH_NOT_CONFIGURED: '端末への通知は設定されていません。', NOTIFICATIONS_UNAVAILABLE: '通知機能を利用できません。', WEB_GATEWAY_UNAVAILABLE: 'Web受付の稼働を確認できません。', AVAILABILITY_UNKNOWN: '利用状態を確認できません。', UPDATE_INCOMPATIBLE: 'この更新先との互換性を確認できません。' }
const explanation = reason => reasons[reason] ?? '更新に必要な条件を確認できないため、実行できません。'
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
const operation = value => value === null || value && uuid(value.requestId) && plan(value.plan)
  && ['accepted', 'rejected', 'unknown'].includes(value.admission) && Object.hasOwn(phases, value.phase)
  && Object.hasOwn(outcomes, value.execution) && Object.hasOwn(outcomes, value.verification)
  && (value.error === null || value.error && text(value.error.code) && text(value.error.message)) && nullableText(value.reference)
  && (value.phase !== 'completed' || value.admission === 'accepted' && value.execution === 'succeeded' && value.verification === 'succeeded')
const publication = value => value === null || value && value.catalog && /^[a-f0-9]{64}$/.test(value.catalog.sha256)
  && date(value.catalog.publishedAt) && date(value.catalog.expiresAt) && value.check
  && ['verified', 'failed', 'unconfirmed'].includes(value.check.status)
  && (value.check.checkedAt === null || date(value.check.checkedAt)) && nullableText(value.check.error)
const terminal = value => value && (value.admission === 'rejected' || value.phase === 'completed' || value.phase === 'failed' && value.execution === 'failed')
const unknown = value => value && (value.phase === 'unknown' || value.admission === 'unknown')
const comparisonLabel = item => item.comparison.state === 'up_to_date' && item.publication?.check.status !== 'verified'
  ? '受入済み版と一致 · 公開情報の取得確認が必要です' : comparisons[item.comparison.state]

// Check consumed display values; the complete public schema remains in src/update-center-contract.mjs.
export function validUpdateInventory(value) {
  return Boolean(value && value.schema === 'bellteam.updates.v1' && value.server && nullableText(value.server.id)
    && text(value.observedAt) && Number.isFinite(Date.parse(value.observedAt)) && value.notice
    && ['ready', 'unavailable', 'updating', 'attention'].includes(value.notice.state) && nullableText(value.notice.code) && text(value.notice.message)
    && Array.isArray(value.components) && new Set(value.components.map(item => item?.id)).size === value.components.length
    && value.components.every(item => item && text(item.id) && text(item.name) && text(item.description) && version(item.current) && version(item.published)
      && item.comparison && Object.hasOwn(comparisons, item.comparison.state) && nullableText(item.comparison.reason)
      && publication(item.publication) && Array.isArray(item.changes) && item.changes.every(text) && capability(item.capability) && item.availability
      && [true, false, null].includes(item.availability.available) && nullableText(item.availability.reason))
    && Array.isArray(value.plans) && value.plans.every(plan) && operation(value.operation) && operation(value.previousOperation))
}

const versionLabel = value => value === null ? '稼働版を確認できません' : `${value.origin === 'builtin' ? '内蔵版 · ' : ''}${/^(?:sha256:)?[a-f0-9]{40,64}$/.test(value.version) ? value.version.replace(/^sha256:/, '').slice(0, 12) : value.version}`
const formatDate = value => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) + ' JST'

export function createUpdateCenter({ root, api, buttons, storage }) {
  const get = selector => root.querySelector(selector)
  const list = get('[data-update-components]'), detail = get('[data-update-detail]')
  const notice = get('[data-update-notice]'), refreshButton = get('[data-update-refresh]')
  let selected = 'all', generation = 0, opened = false, disposed = false, loading = false
  let opener = null, inventory = null, failure = '', planFailure = ''
  const requestKey = 'bellteam-update-request.v1'
  let planned = null, planning = false, submitting = false, confirmed = false, planGeneration = 0
  let pending = null, ownResult = null, operationMessage = '', storageFailure = '', requestStorage = storage
  let resultUnconfirmed = false
  let previousResults = [], pendingReadFailed = false
  try {
    requestStorage ??= globalThis.sessionStorage
    const saved = requestStorage?.getItem(requestKey)
    if (saved) {
      const value = JSON.parse(saved)
      if (value?.previous !== undefined) {
        if (!Array.isArray(value.previous) || value.previous.some(result => !result || !operation(result))
          || new Set(value.previous.map(result => result.requestId)).size !== value.previous.length) throw Error('INVALID_SAVED_REQUEST')
        previousResults = value.previous.map(result => ({ result, failed: true }))
      }
      if (value?.requestId !== undefined || value?.planId !== undefined) {
        if (!uuid(value.requestId) || !uuid(value.planId) || previousResults.some(entry => entry.result.requestId === value.requestId)) throw Error('INVALID_SAVED_REQUEST')
        pending = { requestId: value.requestId, planId: value.planId }; pendingReadFailed = true
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
    notice.textContent = operationMessage || storageFailure || (loading ? '接続先の更新情報を確認しています。' : failure || inventory?.notice.message || '更新センターを開くと、接続先の情報を確認します。')
    const active = pending ? ownResult : inventory?.operation
    const publicationUnknown = inventory?.components.some(item => item.published && item.publication?.check.status !== 'verified')
    let suffix = inventory && !failure ? { ready: inventory.components.some(item => item.comparison.state === 'update_available') ? ' · 更新あり' : '', unavailable: ' · 利用不能', updating: ' · 更新中', attention: ' · 要確認' }[inventory.notice.state] : ''
    if (publicationUnknown || previousResults.some(entry => entry.failed || unknown(entry.result))) suffix = ' · 要確認'
    if (active?.admission === 'accepted' && !terminal(active)) suffix = ' · 更新中'
    if (pending && (!active || resultUnconfirmed) || active && (active.admission === 'unknown' || ['failed', 'unknown'].includes(active.phase) || active.verification === 'failed')) suffix = ' · 要確認'
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
        if (!component.capability.supported) copy.append(element('span', 'update-component-reason', explanation(component.capability.reason)))
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
    if (!inventory || loading || planning || submitting || storageFailure || failure
      || previousResults.some(entry => entry.failed || !terminal(entry.result) && !unknown(entry.result))) return false
    if (!pending && !previousResults.some(entry => unknown(entry.result)) && (!inventory.operation || terminal(inventory.operation))) return true
    const component = inventory.components.find(item => item.id === selected)
    return selected !== 'all' && selected !== 'container' && component?.capability.supported
      && (!inventory.operation || terminal(inventory.operation) || unknown(inventory.operation))
      && (!pending || !pendingReadFailed && unknown(ownResult))
  }
  function canPlan(action = 'update') {
    if (!canRequest()) return false
    const component = inventory.components.find(item => item.id === selected)
    if (action === 'rollback') return selected !== 'all' && selected !== 'container' && component
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
      const phase = result.plan.action === 'rollback' && result.phase === 'completed' ? '戻し完了' : phases[result.phase]
      progress.append(element('p', 'update-result-state', result === ownResult && resultUnconfirmed ? `結果確認不能 / 最終確認: ${phase}` : phase))
      progress.append(element('p', '', `受付: ${{ accepted: '受付済み', rejected: '未受付', unknown: '確認不能' }[result.admission]} / 実行: ${outcomes[result.execution]} / 稼働確認: ${outcomes[result.verification]}`))
      if (result.error) progress.append(element('p', 'update-failure', result.error.message))
    } else progress.append(element('p', 'update-result-state', inventory ? '更新の記録はありません' : '更新の結果を確認できません'))
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
    if (component && !component.capability.supported && !selectedPlan) reasonText = explanation(component.capability.reason)
    if (selectedPlan && !selectedPlan.compatibility.compatible) reasonText = '計画の互換性を確認できないため、実行できません。'
    if (selectedPlan && !selectedPlan.capability.supported) reasonText = explanation(selectedPlan.capability.reason)
    if (selectedPlan && Date.parse(selectedPlan.expiresAt) <= Date.now()) reasonText = '計画の有効期限が切れました。計画を再取得してください。'
    if (pending) reasonText = canRequest()
      ? '前の要求は確認不能のまま保持します。新しい計画の版と影響を確認してから、別の要求として実行できます。'
      : '前の要求の状態と、この機能の操作可否を確認できるまで、新しい更新を開始しません。'
    const reason = element('p', 'update-action-reason', storageFailure || reasonText)
    reason.id = 'update-action-reason'; action.setAttribute('aria-describedby', reason.id)
    detail.append(action, reason)
    if (selected !== 'all' && selected !== 'container' && component && component.capability.reason !== 'MODULE_NOT_INDEPENDENT') {
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
      component?.publication?.check.error, displayPlan?.compatibility.reason, displayPlan?.capability.reason, result?.error?.code].filter(Boolean))
    const values = [
      ['稼働版', component?.current?.version], ['稼働配布物', component?.current?.digest],
      ['公開版', component?.published?.version], ['公開配布物', component?.published?.digest],
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
        item.append(element('summary', '', `${result.plan.targets.map(target => inventory?.components.find(component => component.id === target.componentId)?.name ?? target.componentId).join('・')} · ${phases[result.phase]}`))
        const identities = element('dl', '')
        for (const [label, value] of [['要求ID', result.requestId], ['計画ID', result.plan.planId], ['状態・理由の符号', result.error?.code]]) {
          if (value) identities.append(element('dt', '', label), element('dd', '', value))
        }
        item.append(identities, element('p', '', `受付: ${{ accepted: '受付済み', rejected: '未受付', unknown: '確認不能' }[result.admission]} / 実行: ${outcomes[result.execution]} / 稼働確認: ${outcomes[result.verification]}`))
        if (result.error) item.append(element('p', 'update-failure', result.error.message))
        if (entry.failed) item.append(element('p', 'update-failure', 'この要求の最新結果を確認できていません。前回の結果を保持しています。'))
        const read = element('button', 'update-replan', 'この要求の状態を再取得')
        read.type = 'button'; read.disabled = loading || submitting; read.dataset.updateControl = `read-${result.requestId}`
        read.addEventListener('click', () => { void refresh() })
        item.append(read); history.append(item)
      }
      detail.append(history)
    }
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
        || (next.action ?? 'update') !== action || Date.parse(next.expiresAt) <= Date.now()
        || [ownResult, inventory?.operation, ...previousResults.map(entry => entry.result)].some(result => unknown(result) && result.plan.planId === next.planId)) throw Error('INVALID_PLAN')
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
    const saved = JSON.stringify({ ...request, ...(previous.length ? { previous: previous.map(entry => entry.result) } : {}) })
    requestStorage.setItem(requestKey, saved)
    if (requestStorage.getItem(requestKey) !== saved) throw Error('STORAGE_UNAVAILABLE')
  }
  function clearPending() {
    pending = null; pendingReadFailed = false
    try { saveRequests(null) } catch { storageFailure = '照会用の要求IDを保存できません。新しい更新は開始できません。' }
  }
  function applyOperation(value, request) {
    if (!value || !operation(value) || value.requestId !== request.requestId || value.plan.planId !== request.planId
      || planned?.planId === request.planId && (value.plan.action ?? 'update') !== (planned.action ?? 'update')) throw Error('INVALID_OPERATION')
    if (ownResult?.requestId === value.requestId && terminal(ownResult) && !terminal(value)) return
    ownResult = value; pendingReadFailed = false; operationMessage = ''
    resultUnconfirmed = value.phase === 'unknown' || value.admission === 'unknown'
    if (resultUnconfirmed) operationMessage = '結果を確認できません。同じ要求の状態を再取得してください。'
    if (terminal(value)) {
      clearPending()
      if (planned?.planId === value.plan.planId) { planned = null; confirmed = false }
    }
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
      for (const result of [ownResult, inventory.operation, inventory.previousOperation]) {
        if (unknown(result) && !previous.some(entry => entry.result.requestId === result.requestId)) previous.push({ result, failed: false })
      }
      saveRequests(request, previous)
    } catch { operationMessage = '照会用の要求IDを保存できません。更新は開始していません。'; render(); return }
    previousResults = previous; pending = request; ownResult = null; pendingReadFailed = true; resultUnconfirmed = true; submitting = true; generation++
    operationMessage = '更新の受付を確認しています。'; render()
    try {
      const value = await api('/api/updates/operations', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: target.planId, requestId: request.requestId, confirmContainerRestart: target.impact.containerRestart && confirmed }) })
      if (disposed) return
      if (value?.operation?.admission !== 'accepted') throw Error('ADMISSION_UNKNOWN')
      applyOperation(value.operation, request)
    } catch (error) {
      if (disposed) return
      if (ownResult?.requestId !== request.requestId || ownResult.admission !== 'accepted') {
        if ([400, 401, 403, 404, 409].includes(error?.status)) {
          clearPending(); planned = null; confirmed = false
          operationMessage = '更新は受け付けられませんでした。状態を確認し、新しい計画を取得してください。'
        } else { resultUnconfirmed = true; operationMessage = '受付を確認できません。同じ要求の結果を確認します。更新は送り直しません。' }
      }
    } finally {
      submitting = false
      if (!disposed) { render(); await refresh() }
    }
  }
  async function refresh() {
    if (!opened || disposed) return
    const read = ++generation
    loading = true; render()
    const request = pending
    const previous = [...previousResults]
    const results = await Promise.allSettled([api('/api/updates'), ...(request ? [api(`/api/updates/operations/${request.requestId}`)] : []),
      ...previous.map(entry => api(`/api/updates/operations/${entry.result.requestId}`))])
    if (read !== generation || disposed) return
    const result = results[0]
    inventory = result.status === 'fulfilled' && validUpdateInventory(result.value) ? result.value : null
    failure = inventory ? '' : result.status === 'fulfilled' ? '更新情報の応答形式を確認できません。' : result.reason?.status === 404 ? 'レビュー用画面 · この接続先では共通更新情報が未提供です。' : [401, 403].includes(result.reason?.status) ? '更新情報を読む権限がありません。' : '接続先の更新情報を確認できません。再接続後に状態を再取得してください。'
    if (request && pending?.requestId === request.requestId) {
      try {
        if (results[1].status !== 'fulfilled') throw Error('RESULT_UNAVAILABLE')
        applyOperation(results[1].value?.operation, request)
      } catch { pendingReadFailed = true; resultUnconfirmed = true; operationMessage = '同じ要求の結果を確認できません。再接続後に状態を再取得してください。更新は送り直しません。' }
    }
    for (const [index, entry] of previous.entries()) {
      const response = results[index + (request ? 2 : 1)], value = response.status === 'fulfilled' ? response.value?.operation : null
      entry.failed = !value || !operation(value) || value.requestId !== entry.result.requestId || value.plan.planId !== entry.result.plan.planId
        || (value.plan.action ?? 'update') !== (entry.result.plan.action ?? 'update')
      if (!entry.failed && (!terminal(entry.result) || terminal(value))) entry.result = value
    }
    if (previous.length) try { saveRequests(pending) } catch { storageFailure = '保持した要求の結果を保存できません。新しい更新は開始できません。' }
    loading = false; render()
  }
  function open(button = buttons.find(item => item.getClientRects().length && window.getComputedStyle(item).visibility === 'visible') ?? buttons[0]) {
    if (disposed) return
    opener = button; opened = true; confirmed = false
    if (!root.open) root.showModal()
    return refresh()
  }
  for (const button of buttons) button.addEventListener('click', () => { void open(button) })
  refreshButton.addEventListener('click', () => { if (!loading) void refresh() })
  get('[data-update-close]').addEventListener('click', () => root.close())
  root.addEventListener('close', () => { confirmed = false; opener?.focus() })
  render()
  return { start() { opened = true; return refresh() }, open, refresh, close() { disposed = true; generation++; planGeneration++ } }
}
