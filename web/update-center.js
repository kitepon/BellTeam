const modules = [
  { id: 'core', name: 'BellTeam本体', description: 'すべての機能を支える実行環境と、製品全体の構成。', mark: 'B', endpoint: null },
  { id: 'web-gateway', name: 'WebとAPI', description: 'アプリの画面と接続を届ける、BellTeamの窓口。', mark: '↗', endpoint: '/api/web-gateway-release', key: 'webGatewayRelease' },
  { id: 'notifications', name: '通知', description: 'メッセージや確認依頼を、お使いの端末へ届けます。', mark: '◉', endpoint: '/api/notifications-release', key: 'notificationsRelease' },
]
const statusLabels = { accepted: '受付済み', running: '更新中', succeeded: '交換機構の成功を確認', failed: '更新に失敗', not_started: '開始していません' }

export function validGatewayRelease(value) {
  const version = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  return Boolean(value && !Array.isArray(value) && version(value.currentVersionId) && (value.update === null || value.update
    && typeof value.update.versionId === 'string' && /^[a-f0-9]{64}$/.test(value.update.versionId)
    && Object.hasOwn(statusLabels, value.update.status)
    && (value.update.error === undefined || typeof value.update.error === 'string')))
}

export function createUpdateCenter({ root, api, buttons }) {
  const get = selector => root.querySelector(selector)
  const list = get('[data-update-components]'), detail = get('[data-update-detail]')
  const notice = get('[data-update-notice]'), refreshButton = get('[data-update-refresh]')
  let selected = 'all', generation = 0, opened = false, disposed = false, loading = false
  let opener = null, observedAt = null
  const snapshots = new Map()
  const element = (tag, className, text) => {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const record = id => snapshots.get(id)
  const versionText = item => {
    if (!item?.value) return item?.message ?? '実稼働版の情報は未接続'
    return item.value.currentVersionId === null ? '内蔵版 · image/source情報は未接続' : item.value.currentVersionId.slice(0, 12)
  }
  function render() {
    refreshButton.disabled = loading
    root.setAttribute('aria-busy', String(loading))
    notice.textContent = loading ? '接続先の実稼働情報を確認しています。' : 'レビュー用画面 · 正式公開版と更新計画は未接続です。更新は実行されません。'
    const timestamp = get('[data-update-observed]')
    timestamp.textContent = observedAt ? `最終照会 ${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(observedAt)} JST` : 'まだ照会していません'
    list.replaceChildren()
    const choices = [{ id: 'all', name: '全体アップデート', description: '互換性を確認した計画で、必要な機能をまとめて更新。', mark: '✳' }, ...modules]
    for (const component of choices) {
      const button = element('button', `update-component${selected === component.id ? ' is-selected' : ''}`)
      button.type = 'button'
      button.setAttribute('aria-pressed', String(selected === component.id))
      button.dataset.component = component.id
      const mark = element('span', 'update-component-mark', component.mark)
      mark.setAttribute('aria-hidden', 'true')
      const copy = element('span', 'update-component-copy')
      copy.append(element('strong', '', component.name), element('span', 'update-description', component.description))
      const version = element('span', 'update-component-version', component.id === 'all' ? '製品全体の計画' : versionText(record(component.id)))
      const fullVersion = record(component.id)?.value?.currentVersionId
      if (fullVersion) version.title = fullVersion
      copy.append(version)
      button.append(mark, copy, element('span', 'update-component-arrow', '›'))
      button.addEventListener('click', () => {
        selected = component.id; renderDetail(); renderSelection()
        if (window.matchMedia?.('(max-width: 780px)').matches) detail.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      })
      list.append(button)
    }
    renderDetail()
  }
  function renderSelection() {
    for (const button of list.querySelectorAll('[data-component]')) {
      button.classList.toggle('is-selected', button.dataset.component === selected)
      button.setAttribute('aria-pressed', String(button.dataset.component === selected))
    }
  }
  function renderDetail() {
    const component = modules.find(item => item.id === selected)
    const snapshot = record(selected)
    detail.replaceChildren()
    detail.append(element('p', 'update-kicker', selected === 'all' ? 'PRODUCT UPDATE' : selected === 'core' ? 'CONTAINER' : 'MODULE UPDATE'))
    detail.append(element('h3', 'update-detail-title', component?.name ?? 'BellTeamを、まとめて最新に。'))
    detail.append(element('p', 'update-detail-description', component?.description ?? '接続している製品全体を確認し、互換性のある更新を一つの計画から実行します。'))
    const versions = element('div', 'update-versions')
    for (const [label, value] of [['現在稼働', selected === 'all' ? '左の一覧で各機能を確認' : versionText(snapshot)], ['更新先', '正式公開版は未接続']]) {
      const column = element('div', '')
      column.append(element('span', 'update-field-label', label), element('strong', '', value))
      versions.append(column)
    }
    detail.append(versions)
    const changes = element('section', 'update-detail-section')
    changes.append(element('h4', '', 'この更新で変わること'), element('p', '', '正式版の変更内容が接続されると、ここで確認できます。未公開の候補は更新先に表示しません。'))
    detail.append(changes)
    const impact = element('section', 'update-impact')
    impact.append(element('h4', '', '対象と影響'))
    impact.append(element('p', '', selected === 'all' ? '全体更新でも、コンテナの再起動が必要とは限りません。実際の計画で再起動が必要な場合に、実行前の警告と確認を表示します。'
      : selected === 'core' ? 'コンテナの入替・再起動を含む計画では、全Botの会話と処理が一時中断します。実行前に対象と影響を確認します。'
      : selected === 'notifications' ? '通知機能だけを交換します。会話の保存とAIの処理は継続します。交換中は端末登録や設定適用が一時利用できません。'
      : '画面とAPIの接続が一時的に切れます。Botの会話とAIの処理は継続します。コンテナ全体の再起動は行いません。'))
    detail.append(impact)
    const progress = element('section', 'update-detail-section update-result')
    progress.append(element('h4', '', '進行と実際の結果'))
    const update = snapshot?.value?.update
    progress.append(element('p', 'update-result-state', update ? statusLabels[update.status] : snapshot?.value ? '進行中の記録はありません' : '共通の実結果は未接続です'))
    if (update) {
      progress.append(element('p', '', `対象 ${update.versionId.slice(0, 12)} · ${update.status === 'succeeded' ? 'アプリからの実稼働確認は未接続です。' : '実稼働版と結果は再接続後にも確認します。'}`))
      if (update.error) progress.append(element('p', 'update-failure', update.error))
    }
    if (snapshot?.message) progress.append(element('p', 'update-failure', snapshot.message))
    detail.append(progress)
    const action = element('button', 'update-execute', '更新計画の接続を待っています')
    action.type = 'button'; action.disabled = true
    const reason = element('p', 'update-action-reason', '更新先・互換性・影響を確認できるまで、実行できません。')
    reason.id = 'update-action-reason'
    action.setAttribute('aria-describedby', reason.id)
    detail.append(action, reason)
  }
  async function refresh() {
    if (!opened || disposed) return
    const read = ++generation
    loading = true; render()
    await Promise.all(modules.filter(item => item.endpoint).map(async component => {
      let result
      try {
        const response = await api(component.endpoint)
        // shortcut: only the gateway's current public schema is supplied; connect notifications after its contract is fixed.
        if (component.id !== 'web-gateway') result = { message: '公開形式の接続待ち' }
        else if (!validGatewayRelease(response?.[component.key])) result = { message: '応答形式を確認できません' }
        else result = { value: response[component.key] }
      } catch (error) {
        result = { message: error?.status === 404 ? '更新状態の公開は未接続' : error?.status === 401 || error?.status === 403 ? '更新状態を読む権限がありません' : '接続先の状態を確認できません' }
      }
      if (read === generation && !disposed) snapshots.set(component.id, result)
    }))
    if (read !== generation || disposed) return
    loading = false; observedAt = new Date(); render()
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
  return { refresh, close() { disposed = true; generation++ } }
}
