const statuses = { active: '進行中', paused: '一時停止', blocked: '進行できない状態', usageLimited: '利用制限', budgetLimited: '予算に到達', complete: '完了' }
const titles = { create: 'ゴールを設定', edit: '編集', pause: '一時停止', resume: '再開', clear: '取り消す' }
const element = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

// The API owns native state. This view keeps only unsaved form text and the
// latest observed snapshot, never a second goal ledger or a continuation loop.
export function goalsView(dialog, api, getBots) {
  const body = dialog.querySelector('[data-goals-body]')
  const notice = dialog.querySelector('[data-goals-notice]')
  const refreshButton = dialog.querySelector('[data-goals-refresh]')
  const pending = new Set(), drafts = new Map()
  let snapshots = [], revision = 0
  const report = text => { notice.textContent = text; notice.hidden = !text }
  const button = (label, run) => {
    const control = element('button', label)
    control.type = 'button'; control.addEventListener('click', run)
    return control
  }
  const named = id => getBots().find(bot => bot.id === id)?.displayName ?? getBots().find(bot => bot.id === id)?.name ?? id
  const amount = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('ja-JP').format(value)

  function render() {
    body.replaceChildren()
    if (!snapshots.length) { body.append(element('p', 'メンバーがいません。')); return }
    for (const snapshot of snapshots) {
      const card = element('section', undefined, 'goal-card')
      card.dataset.goalBot = snapshot.botId
      card.append(element('h3', named(snapshot.botId)))
      const available = snapshot.availability === 'available'
      if (!available) {
        card.append(element('p', snapshot.message || (snapshot.availability === 'unsupported' ? 'このメンバーではゴール機能を使えません。' : 'ゴールの状態を取得できません。更新して確認してください。'), 'goal-status'))
        body.append(card); continue
      }
      const goal = snapshot.goal
      const codexGoal = getBots().find(bot => bot.id === snapshot.botId)?.harness === 'codex'
      card.append(element('p', goal ? statuses[goal.status] ?? '状態を確認できません' : 'ゴールなし', 'goal-status'))
      if (goal) {
        card.append(element('p', goal.objective, 'goal-objective'))
        const budgetText = !Object.hasOwn(goal, 'tokenBudget') ? '—' : goal.tokenBudget === null ? '指定なし' : amount(goal.tokenBudget)
        const details = element('p', `使用量 ${amount(goal.tokensUsed)} / 予算 ${budgetText} · 作業時間 ${amount(goal.timeUsedSeconds)}秒`, 'goal-meta')
        card.append(details)
      }
      if (snapshot.observedAt) card.append(element('p', `取得 ${new Date(snapshot.observedAt).toLocaleString('ja-JP')}`, 'goal-meta'))
      const actions = element('div', undefined, 'goal-actions')
      const capabilities = snapshot.capabilities ?? {}
      const editAction = goal ? 'edit' : 'create'
      if (capabilities[editAction]) actions.append(button(titles[editAction], () => {
        drafts.set(snapshot.botId, { action: editAction, objective: goal?.objective ?? '', budget: goal?.tokenBudget == null ? '' : String(goal.tokenBudget), budgetChanged: false })
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
        const form = element('form', undefined, 'goal-form')
        const label = element('label', undefined, 'field')
        label.append(element('span', '目的'))
        const input = element('textarea'); input.rows = 4; input.maxLength = 4000; input.required = true; input.value = draft.objective
        input.addEventListener('input', () => { draft.objective = input.value })
        label.append(input); form.append(label)
        const budgetLabel = element('label', undefined, 'field'); budgetLabel.append(element('span', 'トークン予算（任意）'))
        const budget = element('input'); budget.type = 'number'; budget.min = '1'; budget.step = '1'; budget.value = draft.budget
        budget.addEventListener('input', () => { draft.budget = budget.value; draft.budgetChanged = true })
        budgetLabel.append(budget)
        if (codexGoal || capabilities.tokenBudget === true) form.append(budgetLabel)
        if (goal && codexGoal) form.append(element('p', '目的を変えると使用量が初期化されます。', 'goal-meta'))
        if (goal && (codexGoal || capabilities.tokenBudget === true)) form.append(element('p', '予算を空にした場合、現在の指定は変更しません。', 'goal-meta'))
        const controls = element('div', undefined, 'goal-actions')
        const save = element('button', '保存'); save.type = 'submit'; save.disabled = pending.has(snapshot.botId)
        controls.append(save, button('編集をやめる', () => { drafts.delete(snapshot.botId); render() }))
        form.append(controls)
        form.addEventListener('submit', event => {
          event.preventDefault()
          if (!draft.objective.trim()) { input.focus(); return }
          const data = { objective: draft.objective.trim() }
          if ((codexGoal || capabilities.tokenBudget === true) && draft.budgetChanged && draft.budget !== '') {
            data.tokenBudget = Number(draft.budget)
            if (!Number.isSafeInteger(data.tokenBudget) || data.tokenBudget <= 0) { budget.focus(); return }
          }
          void mutate(snapshot, draft.action, data)
        })
        card.append(form)
      }
      if (goal) card.append(element('p', '一時停止したゴールは再開できます。取り消すとゴールは消えます。今の処理を中断するには会話の停止ボタンを使ってください。', 'goal-meta'))
      body.append(card)
    }
  }
  async function refresh() {
    const current = ++revision
    refreshButton.disabled = true
    try {
      const result = await api('/api/goals')
      if (current !== revision) return
      if (!Array.isArray(result?.goals)) throw new Error('ゴールの一覧を確認できませんでした')
      snapshots = result.goals; render()
    } catch (error) {
      if (current !== revision) return
      // A stale snapshot must not keep offering mutations after a failed read.
      snapshots = []; body.replaceChildren(element('p', 'ゴールの状態を取得できません。更新して確認してください。'))
      report(error instanceof TypeError ? '接続できませんでした。更新して確認してください。' : error.message)
    } finally { if (current === revision) refreshButton.disabled = false }
  }
  async function mutate(snapshot, action, data = {}) {
    if (pending.has(snapshot.botId)) return
    pending.add(snapshot.botId); report(''); render()
    ++revision // In-flight old reads must not overwrite a mutation result.
    try {
      const result = await api(`/api/bots/${encodeURIComponent(snapshot.botId)}/goal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, binding: snapshot.binding, ...data }),
      })
      if (!['confirmed', 'unconfirmed'].includes(result?.outcome) || result.snapshot?.botId !== snapshot.botId)
        throw new Error('ゴールの変更結果を確認できませんでした')
      snapshots = snapshots.map(item => item.botId === snapshot.botId ? result.snapshot : item)
      if (result.outcome === 'confirmed') drafts.delete(snapshot.botId)
      else report('変更結果を確認できませんでした。現在の状態を確認してから操作してください。')
    } catch (error) {
      // Never repeat a goal mutation after an unknown network outcome.
      report('変更結果を確認できませんでした。現在の状態を確認しています。')
      try {
        const result = await api(`/api/bots/${encodeURIComponent(snapshot.botId)}/goal`)
        if (result.snapshot?.botId !== snapshot.botId) throw new Error('ゴールを確認できませんでした')
        snapshots = snapshots.map(item => item.botId === snapshot.botId ? result.snapshot : item)
        report('変更の応答を確認できませんでした。現在取得できた状態を表示しています。操作前に確認してください。')
      } catch {
        snapshots = snapshots.map(item => item.botId === snapshot.botId ? { botId: item.botId, availability: 'unavailable', goal: null } : item)
        report('変更結果と現在の状態を確認できませんでした。更新して確認してください。')
      }
    } finally { ++revision; pending.delete(snapshot.botId); refreshButton.disabled = false; render() }
  }
  refreshButton.addEventListener('click', () => { report(''); void refresh() })
  return { open: async () => { dialog.showModal(); report(''); await refresh() }, refresh }
}
