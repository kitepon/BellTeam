const comparisons = { up_to_date: '正式公開版と一致', update_available: '更新あり', unavailable: '更新情報を取得できません', incompatible: '互換性を確認できません', unknown: '確認不能' }
const phases = { preparing: '準備中', applying: '更新中', reconnecting: '再接続中', verifying: '実稼働を確認中', completed: '更新完了', failed: '失敗', unknown: '結果確認不能' }
const outcomes = { pending: '未確認', succeeded: '成功', failed: '失敗', unknown: '確認不能' }
const reasons = { MODULE_NOT_INDEPENDENT: 'この機能は、まだ個別更新に対応していません。', UPDATE_EXECUTOR_UNAVAILABLE: '更新の実行機構は未接続です。', PUBLISHED_RELEASE_UNAVAILABLE: '正式公開版の情報は未接続です。', PUSH_NOT_CONFIGURED: '端末への通知は設定されていません。', NOTIFICATIONS_UNAVAILABLE: '通知機能を利用できません。', WEB_GATEWAY_UNAVAILABLE: 'Web受付の稼働を確認できません。', AVAILABILITY_UNKNOWN: '利用状態を確認できません。', UPDATE_INCOMPATIBLE: 'この更新先との互換性を確認できません。' }
const explanation = reason => reasons[reason] ?? reason
const text = value => typeof value === 'string' && value.length > 0
const nullableText = value => value === null || text(value)
const capability = value => value && typeof value.supported === 'boolean' && (value.supported ? value.reason === null : text(value.reason))
const version = value => value === null || value && text(value.version)
  && (value.sourceCommit === null || /^[a-f0-9]{40}$/.test(value.sourceCommit))
  && (value.digest === null || /^sha256:[a-f0-9]{64}$/.test(value.digest))
  && ['container', 'builtin', 'release', 'published'].includes(value.origin)
const plan = value => value && text(value.planId) && ['all', 'component'].includes(value.scope) && nullableText(value.componentId)
  && Number.isFinite(Date.parse(value.expiresAt)) && Array.isArray(value.targets)
  && value.targets.every(target => target && text(target.componentId) && version(target.current) && target.published !== null && version(target.published))
  && value.compatibility && typeof value.compatibility.compatible === 'boolean' && nullableText(value.compatibility.reason)
  && value.impact && typeof value.impact.containerRestart === 'boolean' && text(value.impact.description) && capability(value.capability)
const operation = value => value === null || value && text(value.requestId) && plan(value.plan)
  && ['accepted', 'rejected', 'unknown'].includes(value.admission) && Object.hasOwn(phases, value.phase)
  && Object.hasOwn(outcomes, value.execution) && Object.hasOwn(outcomes, value.verification)
  && (value.error === null || value.error && text(value.error.code) && text(value.error.message)) && nullableText(value.reference)
  && (value.phase !== 'completed' || value.admission === 'accepted' && value.execution === 'succeeded' && value.verification === 'succeeded')

// Check consumed display values; the complete public schema remains in src/update-center-contract.mjs.
export function validUpdateInventory(value) {
  return Boolean(value && value.schema === 'bellteam.updates.v1' && value.server && nullableText(value.server.id)
    && text(value.observedAt) && Number.isFinite(Date.parse(value.observedAt)) && value.notice
    && ['ready', 'unavailable', 'updating', 'attention'].includes(value.notice.state) && nullableText(value.notice.code) && text(value.notice.message)
    && Array.isArray(value.components) && new Set(value.components.map(item => item?.id)).size === value.components.length
    && value.components.every(item => item && text(item.id) && text(item.name) && text(item.description) && version(item.current) && version(item.published)
      && item.comparison && Object.hasOwn(comparisons, item.comparison.state) && nullableText(item.comparison.reason)
      && Array.isArray(item.changes) && item.changes.every(text) && capability(item.capability) && item.availability
      && [true, false, null].includes(item.availability.available) && nullableText(item.availability.reason))
    && Array.isArray(value.plans) && value.plans.every(plan) && operation(value.operation) && operation(value.previousOperation))
}

const versionLabel = value => value === null ? '稼働版を確認できません' : `${value.origin === 'builtin' ? '内蔵版 · ' : ''}${/^[a-f0-9]{40,64}$/.test(value.version) ? value.version.slice(0, 12) : value.version}`

export function createUpdateCenter({ root, api, buttons }) {
  const get = selector => root.querySelector(selector)
  const list = get('[data-update-components]'), detail = get('[data-update-detail]')
  const notice = get('[data-update-notice]'), refreshButton = get('[data-update-refresh]')
  let selected = 'all', generation = 0, opened = false, disposed = false, loading = false
  let opener = null, inventory = null, failure = ''
  const element = (tag, className, value) => {
    const node = document.createElement(tag)
    node.className = className
    if (value !== undefined) node.textContent = value
    return node
  }
  function render() {
    refreshButton.disabled = loading
    root.setAttribute('aria-busy', String(loading))
    notice.textContent = loading ? '接続先の更新情報を確認しています。' : failure || inventory?.notice.message || '更新センターを開くと、接続先の情報を確認します。'
    for (const button of buttons) {
      button.textContent = `Update${inventory && !failure ? ({ ready: inventory.components.some(item => item.comparison.state === 'update_available') ? ' · 更新あり' : '', unavailable: ' · 利用不能', updating: ' · 更新中', attention: ' · 要確認' })[inventory.notice.state] : ''}`
      button.setAttribute('aria-label', button.textContent + ' 更新センターを開く')
    }
    get('[data-update-observed]').textContent = inventory ? `取得 ${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(inventory.observedAt))} JST` : '情報を確認できていません'
    const focused = document.activeElement?.dataset?.component
    if (selected !== 'all' && !inventory?.components.some(item => item.id === selected)) selected = 'all'
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
        copy.append(element('span', 'update-component-status', comparisons[component.comparison.state]))
        if (!component.capability.supported) copy.append(element('span', 'update-component-reason', explanation(component.capability.reason)))
      }
      button.append(mark, copy, element('span', 'update-component-arrow', '›'))
      button.addEventListener('click', () => {
        selected = component.id; renderDetail()
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
  }
  function renderDetail() {
    const component = inventory?.components.find(item => item.id === selected)
    const selectedPlan = inventory?.plans.find(item => selected === 'all' ? item.scope === 'all' : item.scope === 'component' && item.componentId === selected)
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
    for (const [label, value] of [['現在稼働', component ? versionLabel(component.current) : '一覧で各機能を確認'], ['正式公開版', component?.published ? versionLabel(component.published) : '情報を取得できません']]) {
      const column = element('div', '')
      column.append(element('span', 'update-field-label', label), element('strong', '', value))
      versions.append(column)
    }
    detail.append(versions)
    if (component) {
      const available = component.availability
      const section = element('section', 'update-detail-section')
      section.append(element('h4', '', '機能の利用状態'), element('p', '', available.available === true ? '利用可能' : available.available === false ? '利用できません' : '確認不能'))
      if (available.reason) section.append(element('p', '', explanation(available.reason)))
      section.append(element('p', '', comparisons[component.comparison.state]))
      if (component.comparison.reason) section.append(element('p', '', explanation(component.comparison.reason)))
      detail.append(section)
    }
    const changes = element('section', 'update-detail-section')
    changes.append(element('h4', '', 'この更新で変わること'))
    if (component?.changes.length) for (const change of component.changes) changes.append(element('p', '', change))
    else changes.append(element('p', '', '正式版の変更内容を取得できていません。'))
    detail.append(changes)
    const impact = element('section', 'update-impact')
    impact.append(element('h4', '', '対象と影響'), element('p', '', selectedPlan?.impact.description ?? '更新計画が未提供のため、実際の更新対象と影響は確認できません。'))
    if (selectedPlan?.impact.containerRestart) impact.append(element('p', 'update-failure', 'コンテナの再起動が必要です。実行前に中断の影響を確認してください。'))
    detail.append(impact)
    const progress = element('section', 'update-detail-section update-result')
    progress.append(element('h4', '', '進行と実際の結果'))
    const current = inventory?.operation
    const previous = inventory?.previousOperation
    const affects = item => item && (selected === 'all' || item.plan.targets.some(target => target.componentId === selected))
    const result = affects(current) ? current : affects(previous) ? previous : null
    if (result) {
      if (result === previous) progress.append(element('p', '', '前回の更新'))
      progress.append(element('p', 'update-result-state', phases[result.phase]))
      progress.append(element('p', '', `受付: ${{ accepted: '受付済み', rejected: '未受付', unknown: '確認不能' }[result.admission]} / 実行: ${outcomes[result.execution]} / 稼働確認: ${outcomes[result.verification]}`))
      if (result.error) progress.append(element('p', 'update-failure', result.error.message))
    } else progress.append(element('p', 'update-result-state', inventory ? '更新の記録はありません' : '更新の結果を確認できません'))
    detail.append(progress)
    const action = element('button', 'update-execute', '更新を実行できません')
    action.type = 'button'; action.disabled = true
    const reason = element('p', 'update-action-reason', component && !component.capability.supported ? explanation(component.capability.reason) : selectedPlan && !selectedPlan.capability.supported ? explanation(selectedPlan.capability.reason) : '更新計画と実行機構の接続後に操作できます。')
    reason.id = 'update-action-reason'; action.setAttribute('aria-describedby', reason.id)
    detail.append(action, reason)
  }
  async function refresh() {
    if (!opened || disposed) return
    const read = ++generation
    loading = true; render()
    let next = null, message = ''
    try {
      next = await api('/api/updates')
      if (!validUpdateInventory(next)) { next = null; message = '更新情報の応答形式を確認できません。' }
    } catch (error) {
      message = error?.status === 404 ? 'レビュー用画面 · この接続先では共通更新情報が未提供です。' : error?.status === 401 || error?.status === 403 ? '更新情報を読む権限がありません。' : '接続先の更新情報を確認できません。再接続後に状態を再取得してください。'
    }
    if (read !== generation || disposed) return
    inventory = next; failure = message; loading = false; render()
  }
  for (const button of buttons) button.addEventListener('click', () => {
    if (disposed) return
    opener = button; opened = true
    if (!root.open) root.showModal()
    void refresh()
  })
  refreshButton.addEventListener('click', () => { if (!loading) void refresh() })
  get('[data-update-close]').addEventListener('click', () => root.close())
  root.addEventListener('close', () => opener?.focus())
  render()
  return { start() { opened = true; return refresh() }, refresh, close() { disposed = true; generation++ } }
}
