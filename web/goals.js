const statuses = { active: '進行中', paused: '一時停止', blocked: '進行できない状態', usageLimited: '利用制限', budgetLimited: '予算に到達', complete: '完了' }
const titles = { create: 'ゴールを設定', edit: '編集', pause: '一時停止', resume: '再開', clear: '削除' }
const grokPhases = { Idle: '待機', Planning: '計画中', Executing: '実行中' }
const displayGoal = original => original?.kind === 'codex-cli' ? original.native
  : original?.kind === 'claude-code' ? { objective: original.native.condition, status: original.phase }
    : original?.kind === 'grok-cli' ? { objective: original.native.objective, tokenBudget: original.native.token_budget,
      status: ['UserPaused', 'Paused'].includes(original.current_status.status) ? 'paused' : 'active' } : original
const displayStatus = original => original?.kind === 'grok-cli' && original.current_status.source === 'goal detail'
  ? original.current_status.status_display : original ? statuses[displayGoal(original).status] ?? '状態を確認できません' : 'ゴールなし'
const isKnown = snapshot => snapshot?.availability === 'available' && Object.hasOwn(snapshot, 'goal')
const element = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

// The API owns native state. This view keeps only unsaved form text and the
// latest observed snapshot, never a second goal ledger or a continuation loop.
export function goalsView(dialog, api, getBots, chat = null) {
  const body = dialog.querySelector('[data-goals-body]')
  const notice = dialog.querySelector('[data-goals-notice]')
  const refreshButton = dialog.querySelector('[data-goals-refresh]')
  const chatBody = chat?.querySelector('[data-goals-body]')
  const chatNotice = chat?.querySelector('[data-goals-notice]')
  const chatRefresh = chat?.querySelector('[data-goals-refresh]')
  const chatSummary = chat?.querySelector('[data-goal-summary]')
  const pending = new Set(), drafts = new Map()
  const observations = new Map()
  const observed = id => observations.get(id) ?? 0
  const advance = id => { const next = observed(id) + 1; observations.set(id, next); return next }
  let snapshots = [], revision = 0, refreshing = false, selectedBotId = null, selectedRead = null
  const report = (text, botId = null) => {
    notice.textContent = text; notice.hidden = !text
    if (chatNotice && (botId === null || botId === selectedBotId)) {
      chatNotice.textContent = text; chatNotice.hidden = !text
    }
  }
  const button = (label, run) => {
    const control = element('button', label)
    control.type = 'button'; control.addEventListener('click', run)
    return control
  }
  const named = id => getBots().find(bot => bot.id === id)?.displayName ?? getBots().find(bot => bot.id === id)?.name ?? id
  const amount = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('ja-JP').format(value)

  function render() {
    const configured = snapshots.filter(snapshot => isKnown(snapshot) && snapshot.goal !== null)
    renderCards(body, configured, '表示できるゴールはありません。')
    if (chat) {
      chat.hidden = selectedBotId === null
      if (selectedBotId !== null) {
        const selected = snapshots.find(snapshot => snapshot.botId === selectedBotId)
        const current = isKnown(selected) ? displayGoal(selected.goal) : null
        const original = selected?.goal
        const elapsed = original?.kind === 'grok-cli' ? original.current_status.elapsed_display
          : original?.kind === 'claude-code' ? Object.hasOwn(original.native, 'durationMs') ? `${amount(original.native.durationMs / 1000)}秒` : null
            : current?.timeUsedSeconds == null ? null : `${amount(current.timeUsedSeconds)}秒`
        const state = current?.status === 'active' ? '目標に取り組み中'
          : current?.status === 'paused' ? '目標を一時停止中' : `目標 · ${displayStatus(original)}`
        chatSummary.textContent = isKnown(selected)
          ? current ? [state, elapsed].filter(Boolean).join('  ') : '目標未設定'
          : selected?.availability === 'unsupported' ? 'ゴール · このメンバーは未対応です' : 'ゴール · 状態を取得できません'
        chatSummary.title = current?.objective ?? chatSummary.textContent
        renderCards(chatBody, snapshots.filter(snapshot => snapshot.botId === selectedBotId), 'ゴールの状態を取得できません。更新して確認してください。')
      }
      chatRefresh.disabled = refreshing || selectedRead?.id === selectedBotId || pending.has(selectedBotId)
    }
  }
  function renderCards(body, items, emptyMessage) {
    body.replaceChildren()
    if (!items.length) { body.append(element('p', emptyMessage)); return }
    for (const snapshot of items) {
      const card = element('section', undefined, 'goal-card')
      card.dataset.goalBot = snapshot.botId
      card.append(element('h3', body === chatBody ? 'ゴール' : named(snapshot.botId)))
      const available = isKnown(snapshot)
      if (!available) {
        card.append(element('p', snapshot.message || (snapshot.availability === 'unsupported' ? 'このメンバーではゴール機能を使えません。' : 'ゴールの状態を取得できません。更新して確認してください。'), 'goal-status'))
        body.append(card); continue
      }
      const original = snapshot.goal
      const claude = original?.kind === 'claude-code'
      const grok = original?.kind === 'grok-cli'
      const grokDetail = grok && original.current_status.source === 'goal detail'
      const goal = displayGoal(original)
      const codexGoal = getBots().find(bot => bot.id === snapshot.botId)?.harness === 'codex'
      card.append(element('p', displayStatus(original), 'goal-status'))
      if (goal) {
        card.append(element('p', goal.objective, 'goal-objective'))
        const budgetText = !Object.hasOwn(goal, 'tokenBudget') ? '—' : goal.tokenBudget === null ? '指定なし' : amount(goal.tokenBudget)
        const metrics = []
        if (claude) {
          for (const [key, label, suffix] of [['tokens', '使用トークン', ''], ['durationMs', '実行時間', 'ミリ秒'], ['iterations', '反復数', '']]) {
            if (Object.hasOwn(original.native, key)) metrics.push(`${label} ${amount(original.native[key])}${suffix}`)
          }
          if (Object.hasOwn(original, 'reported_turns')) metrics.push(`CLI表示ターン数 ${amount(original.reported_turns)}`)
        }
        const details = element('p', grokDetail
          ? [original.current_status.budget_display, `作業時間 ${original.current_status.elapsed_display}`, original.current_status.phase_display].filter(value => value !== null).join(' · ')
          : grok
          ? `使用量 ${amount(original.current_status.tokens_used)} / 予算 ${budgetText} · 作業時間 ${original.current_status.elapsed_display} · ${grokPhases[original.current_status.phase]}`
          : claude ? metrics.join(' · ') || '使用量・作業時間はまだ取得していません。'
          : `使用量 ${amount(goal.tokensUsed)} / 予算 ${budgetText} · 作業時間 ${amount(goal.timeUsedSeconds)}秒`, 'goal-meta')
        card.append(details)
      }
      if (snapshot.nativeHistory?.kind === 'claude-code') {
        card.append(element('p', `前のゴール：${snapshot.nativeHistory.terminal === 'cleared' ? '取消' : '達成'} · ${snapshot.nativeHistory.native.condition}`, 'goal-meta'))
      }
      if (snapshot.observedAt) card.append(element('p', `取得 ${new Date(snapshot.observedAt).toLocaleString('ja-JP')}`, 'goal-meta'))
      const actions = element('div', undefined, 'goal-actions')
      const capabilities = snapshot.capabilities ?? {}
      const editAction = goal ? 'edit' : 'create'
      const fields = snapshot.fieldCapabilities?.[editAction] ?? { objective: true, tokenBudget: codexGoal || capabilities.tokenBudget === true, combined: true }
      if (capabilities[editAction] && (fields.objective || fields.tokenBudget)) actions.append(button(titles[editAction], () => {
        drafts.set(snapshot.botId, { action: editAction, binding: { ...snapshot.binding }, objective: goal?.objective ?? '', budget: goal?.tokenBudget == null ? '' : String(goal.tokenBudget), budgetChanged: false })
        render()
        body.querySelector(`[data-goal-bot="${CSS.escape(snapshot.botId)}"] textarea`)?.focus()
      }))
      if (goal && goal.status === 'active' && capabilities.pause) actions.append(button(titles.pause, () => mutate(snapshot, 'pause')))
      if (goal && goal.status === 'paused' && capabilities.resume)
        actions.append(button(titles.resume, () => mutate(snapshot, 'resume')))
      if (goal && capabilities.clear) actions.append(button(titles.clear, () => mutate(snapshot, 'clear')))
      for (const control of actions.children) control.disabled = pending.has(snapshot.botId)
      card.append(actions)
      const draft = drafts.get(snapshot.botId)
      if (draft) {
        const bindingChanged = ['sessionId', 'launchId', 'threadId'].some(key => draft.binding[key] !== snapshot.binding?.[key])
        const form = element('form', undefined, 'goal-form')
        if (fields.objective && fields.tokenBudget && fields.combined === false) {
          const choiceLabel = element('label', undefined, 'field'); choiceLabel.append(element('span', '変更する項目'))
          const choice = element('select')
          for (const [value, title] of [['objective', '目的'], ['budget', 'トークン予算']]) {
            const option = element('option', title); option.value = value; choice.append(option)
          }
          choice.value = draft.field ?? 'objective'
          choice.addEventListener('change', () => { draft.field = choice.value; render() })
          choiceLabel.append(choice); form.append(choiceLabel)
          form.append(element('p', '目的と予算は、一項目ずつ保存してください。', 'goal-meta'))
        }
        const editObjective = fields.objective && (!fields.tokenBudget || fields.combined !== false || draft.field !== 'budget')
        const editBudget = fields.tokenBudget && (fields.combined !== false || !fields.objective || draft.field === 'budget')
        const label = element('label', undefined, 'field')
        label.append(element('span', '目的'))
        const input = element('textarea'); input.rows = 4; input.maxLength = 4000; input.required = true; input.value = draft.objective
        input.addEventListener('input', () => { draft.objective = input.value })
        label.append(input); if (editObjective) form.append(label)
        const budgetLabel = element('label', undefined, 'field'); budgetLabel.append(element('span', 'トークン予算（任意）'))
        const budget = element('input'); budget.type = 'number'; budget.min = '1'; budget.step = '1'; budget.value = draft.budget
        budget.addEventListener('input', () => { draft.budget = budget.value; draft.budgetChanged = true })
        budgetLabel.append(budget)
        if (editBudget) form.append(budgetLabel)
        if (goal && codexGoal && editObjective) form.append(element('p', '目的を変えると使用量が初期化されます。', 'goal-meta'))
        if (goal && editBudget) form.append(element('p', '予算を空にした場合、現在の指定は変更しません。', 'goal-meta'))
        const controls = element('div', undefined, 'goal-actions')
        const save = element('button', '保存'); save.type = 'submit'; save.disabled = pending.has(snapshot.botId) || bindingChanged || !capabilities[draft.action] || (!editObjective && !editBudget)
        if (bindingChanged) form.append(element('p', '会話が変わりました。この編集を閉じて、現在のゴールから編集し直してください。', 'goal-meta'))
        else if (!capabilities[draft.action]) form.append(element('p', '状態が変わり、この編集を保存できません。編集を閉じて現在のゴールを確認してください。', 'goal-meta'))
        controls.append(save, button('編集をやめる', () => { drafts.delete(snapshot.botId); render() }))
        form.append(controls)
        form.addEventListener('submit', event => {
          event.preventDefault()
          if (save.disabled) return
          if (editObjective && !draft.objective.trim()) { input.focus(); return }
          const data = editObjective ? { objective: draft.objective.trim() } : {}
          if (editBudget && draft.budgetChanged && draft.budget !== '') {
            data.tokenBudget = Number(draft.budget)
            if (!Number.isSafeInteger(data.tokenBudget) || data.tokenBudget <= 0) { budget.focus(); return }
          }
          if (!Object.keys(data).length) { budget.focus(); return }
          void mutate({ ...snapshot, binding: draft.binding }, draft.action, data)
        })
        card.append(form)
      }
      if (goal) {
        const unavailable = ['edit', ...(goal.status === 'active' ? ['pause'] : goal.status === 'paused' ? ['resume'] : []), 'clear']
          .filter(action => !capabilities[action] || action === 'edit' && !fields.objective && !fields.tokenBudget).map(action => titles[action])
        if (unavailable.length) card.append(element('p', `今のゴールでは${unavailable.join('・')}を操作できません。`, 'goal-meta'))
        if (!['active', 'paused'].includes(goal.status)) card.append(element('p', 'この状態では一時停止・再開はできません。', 'goal-meta'))
        card.append(element('p', 'ゴールの操作は、会話の停止とは別です。', 'goal-meta'))
      }
      body.append(card)
    }
  }
  function replaceSnapshot(snapshot) {
    const exists = snapshots.some(item => item.botId === snapshot.botId)
    snapshots = exists ? snapshots.map(item => item.botId === snapshot.botId ? snapshot : item) : [...snapshots, snapshot]
  }
  async function refreshSelected() {
    const id = selectedBotId
    if (id === null) return
    const reading = { id, revision: advance(id) }
    selectedRead = reading; render()
    try {
      const result = await api(`/api/bots/${encodeURIComponent(id)}/goal`)
      if (observed(id) !== reading.revision) return
      if (result.snapshot?.botId !== id) throw new Error('ゴールの状態を確認できませんでした。')
      replaceSnapshot(result.snapshot)
    } catch {
      if (observed(id) !== reading.revision) return
      replaceSnapshot({ botId: id, availability: 'unavailable', message: 'ゴールの状態を取得できません。更新して確認してください。' })
    } finally {
      if (selectedRead === reading) selectedRead = null
      render()
    }
  }
  async function select(botId) {
    selectedBotId = botId
    if (chat) chat.open = false
    report('')
    if (botId !== null) replaceSnapshot({ botId, availability: 'unavailable', message: 'ゴールの状態を確認しています。' })
    render()
    await refreshSelected()
  }
  async function refresh() {
    const current = ++revision
    const expected = new Map([...new Set([...getBots().map(bot => bot.id), ...snapshots.map(item => item.botId)])].map(id => [id, advance(id)]))
    const stillCurrent = id => observed(id) === (expected.get(id) ?? 0)
    refreshing = true
    report('')
    refreshButton.disabled = true
    try {
      const result = await api('/api/goals')
      if (current !== revision) return
      if (!Array.isArray(result?.goals)) throw new Error('ゴールの一覧を確認できませんでした')
      // A new list read supersedes earlier operations on each member. A
      // different member's later mutation keeps its own newer observation.
      const previous = new Map(snapshots.map(item => [item.botId, item]))
      const received = new Set(result.goals.map(item => item.botId))
      const newer = snapshots.filter(item => !stillCurrent(item.botId) && !received.has(item.botId))
      snapshots = [...result.goals.map(item => stillCurrent(item.botId) ? item : previous.get(item.botId)).filter(Boolean), ...newer]
      render()
    } catch (error) {
      if (current !== revision) return
      // A stale snapshot must not keep offering mutations after a failed read.
      snapshots = snapshots.filter(item => !stillCurrent(item.botId))
      render()
      if (!snapshots.length) body.replaceChildren(element('p', 'ゴールの状態を取得できません。更新して確認してください。'))
      report(error instanceof TypeError ? '接続できませんでした。更新して確認してください。' : error.message)
    } finally { if (current === revision) {
      refreshing = false; refreshButton.disabled = false
      if (chatRefresh) chatRefresh.disabled = selectedRead?.id === selectedBotId || pending.has(selectedBotId)
    } }
  }
  async function mutate(snapshot, action, data = {}) {
    if (pending.has(snapshot.botId)) return
    const expected = advance(snapshot.botId)
    const stillCurrent = () => observed(snapshot.botId) === expected
    pending.add(snapshot.botId); report('', snapshot.botId); render()
    try {
      const result = await api(`/api/bots/${encodeURIComponent(snapshot.botId)}/goal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, binding: snapshot.binding, ...data }),
      })
      if (!stillCurrent()) return
      if (!['confirmed', 'unconfirmed'].includes(result?.outcome) || result.snapshot?.botId !== snapshot.botId)
        throw new Error('ゴールの変更結果を確認できませんでした')
      snapshots = snapshots.map(item => item.botId === snapshot.botId ? result.snapshot : item)
      if (result.outcome === 'confirmed') drafts.delete(snapshot.botId)
      else report('変更結果を確認できませんでした。現在の状態を確認してから操作してください。', snapshot.botId)
    } catch (error) {
      if (!stillCurrent()) return
      // Never repeat a goal mutation after an unknown network outcome.
      report('変更結果を確認できませんでした。現在の状態を確認しています。', snapshot.botId)
      try {
        const result = await api(`/api/bots/${encodeURIComponent(snapshot.botId)}/goal`)
        if (!stillCurrent()) return
        if (result.snapshot?.botId !== snapshot.botId) throw new Error('ゴールを確認できませんでした')
        snapshots = snapshots.map(item => item.botId === snapshot.botId ? result.snapshot : item)
        report('変更の応答を確認できませんでした。現在取得できた状態を表示しています。操作前に確認してください。', snapshot.botId)
      } catch {
        if (!stillCurrent()) return
        snapshots = snapshots.map(item => item.botId === snapshot.botId ? { botId: item.botId, availability: 'unavailable', goal: null } : item)
        report('変更結果と現在の状態を確認できませんでした。更新して確認してください。', snapshot.botId)
      }
    } finally {
      // Invalidate pre-completion reads even when reselecting hid the binding.
      // Reconcile the same binding after completion; otherwise keep unknown
      // or the different thread already observed, never the old write result.
      const visible = snapshots.find(item => item.botId === snapshot.botId)
      if (!stillCurrent()) {
        const read = advance(snapshot.botId)
        if (!visible?.binding) {
          replaceSnapshot({ botId: snapshot.botId, availability: 'unavailable', message: '変更後の現在の状態を確認できません。更新して確認してください。' })
        } else if (['sessionId', 'launchId', 'threadId'].every(key => visible.binding[key] === snapshot.binding?.[key])) try {
          const result = await api(`/api/bots/${encodeURIComponent(snapshot.botId)}/goal`)
          if (observed(snapshot.botId) === read) {
            if (result.snapshot?.botId !== snapshot.botId) throw new Error('ゴールを確認できませんでした')
            snapshots = snapshots.map(item => item.botId === snapshot.botId ? result.snapshot : item)
          }
        } catch {
          if (observed(snapshot.botId) === read) {
            snapshots = snapshots.map(item => item.botId === snapshot.botId ? { botId: item.botId, availability: 'unavailable', goal: null } : item)
            report('変更後の現在の状態を確認できませんでした。更新して確認してください。', snapshot.botId)
          }
        }
      }
      pending.delete(snapshot.botId); refreshButton.disabled = refreshing; render()
    }
  }
  refreshButton.addEventListener('click', () => { report(''); void refresh() })
  chatRefresh?.addEventListener('click', () => { report(''); void refreshSelected() })
  chat?.addEventListener('toggle', () => { if (chat.open) void refreshSelected() })
  chat?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && chat.open) { chat.open = false; chatSummary.focus(); event.stopPropagation() }
  })
  if (chat) document.addEventListener?.('pointerdown', event => { if (chat.open && !chat.contains(event.target)) chat.open = false })
  return { open: async () => { dialog.showModal(); report(''); await refresh() }, refresh, select, refreshSelected,
    refreshOnEvent: () => selectedRead?.id === selectedBotId || pending.has(selectedBotId) ? undefined : refreshSelected() }
}
