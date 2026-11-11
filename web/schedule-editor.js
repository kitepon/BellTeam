import { escapeHtml, formatDateTime } from './view-format.js?v=__ASSET_VERSION__'

export function scheduleFormValues(schedule) {
  if (schedule.kind === 'once') return { type: 'once', at: localDateTimeValue(schedule.at) }
  if (schedule.kind === 'interval_days' || schedule.kind === 'interval_hours') return { ...schedule, type: schedule.kind }
  const [minute, hour, dayOfMonth, month, weekday] = String(schedule.expression ?? '').trim().split(/\s+/)
  const pad = value => String(value).padStart(2, '0')
  const plainTime = /^\d+$/.test(minute) && /^\d+$/.test(hour)
  if (dayOfMonth === '*' && month === '*' && weekday === '*') {
    if (hour === '*' && /^\d+$/.test(minute)) return { type: 'hourly', minute }
    if (plainTime) return { type: 'daily', time: `${pad(hour)}:${pad(minute)}` }
  }
  if (dayOfMonth === '*' && month === '*' && plainTime && /^[0-6](,[0-6])*$/.test(weekday ?? '')) {
    return { type: 'weekly', time: `${pad(hour)}:${pad(minute)}`, weekdays: weekday.split(',') }
  }
  return { type: 'cron' }
}

function localDateTimeValue(iso) {
  const date = new Date(iso)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// W64: when it runs, in words. A cron that has no plain form says 「詳しい指定」; the expression stays in the editor.
const days = ['日', '月', '火', '水', '木', '金', '土']
const clock = (hour, minute) => `${Number(hour)}:${String(minute).padStart(2, '0')}`
export function scheduleDescription(schedule) {
  const zone = schedule.timezone && schedule.timezone !== 'Asia/Tokyo' ? `（${schedule.timezone}）` : ''
  if (schedule.kind === 'once') return `${formatDateTime(schedule.at)} に1回`
  if (schedule.kind === 'interval_days') return `${schedule.intervalDays}日おき ${schedule.time}（${schedule.startDate.slice(5).replace('-', '/').replace(/^0/u, '')}から）${zone}`
  if (schedule.kind === 'interval_hours') return `${schedule.intervalHours}時間おき ${schedule.startHour}時〜${schedule.endHour < schedule.startHour ? '翌' : ''}${schedule.endHour}時${schedule.minute ? `（${schedule.minute}分）` : ''}${zone}`
  const form = scheduleFormValues(schedule)
  if (form.type === 'hourly') return `毎時 ${Number(form.minute)}分${zone}`
  if (form.type === 'daily') return `毎日 ${clock(...form.time.split(':'))}${zone}`
  if (form.type === 'weekly') return `毎週 ${form.weekdays.map(day => days[day]).join('・')} ${clock(...form.time.split(':'))}${zone}`
  return `詳しい指定${zone}`
}
// 有効 / 停止 / 済み (a one-time item that ran and has no next run).
export const finishedSchedule = schedule => schedule.kind === 'once' && Boolean(schedule.lastRunAt) && !schedule.enabled && !schedule.nextRunAt
export function scheduleState(schedule) {
  return finishedSchedule(schedule) ? { text: '済み', tone: 'done' } : schedule.enabled === false ? { text: '停止', tone: 'stopped' } : { text: '有効', tone: 'active' }
}
// A nameless command item is called 「コマンドの予定」; the command itself is only under 「内容を見る」 (W65).
export const scheduleTitle = schedule => schedule.name || (schedule.command ? 'コマンドの予定' : String(schedule.prompt ?? '').split('\n')[0])
export const scheduleNext = schedule => schedule.nextRunAt ? `次回 ${formatDateTime(schedule.nextRunAt)}` : ''

export function scheduleRequest(values, targetType, timezone) {
  const type = values.kind
  const command = targetType !== 'room' && values.action === 'command'
  const base = { name: values.name.trim(), ...(command ? { command: values.command.trim() } : { prompt: values.prompt.trim() }), enabled: true }
  if (targetType === 'room') base.targets = values.targets?.length ? values.targets : null
  if (type === 'once') return { ...base, kind: 'once', at: new Date(values.once).toISOString() }
  if (type === 'interval_days') return { ...base, kind: type, timezone, intervalDays: Number(values['interval-days']), startDate: values['start-date'], time: values.time }
  if (type === 'interval_hours') return { ...base, kind: type, timezone, intervalHours: Number(values['interval-hours']), startHour: Number(values['start-hour']), endHour: Number(values['end-hour']), minute: Number(values.minute) }
  const [hour, minute] = (values.time ?? '0:0').split(':').map(Number)
  let expression
  if (type === 'hourly') expression = `${Number(values.minute)} * * * *`
  if (type === 'daily') expression = `${minute} ${hour} * * *`
  if (type === 'weekly') {
    if (!values.weekdays.length) throw new Error('WEEKDAY_REQUIRED')
    expression = `${minute} ${hour} * * ${values.weekdays.join(',')}`
  }
  if (type === 'cron') expression = values.cron.trim()
  return { ...base, kind: 'cron', expression, timezone }
}

export function createScheduleEditor(dialog, { api, getBot }) {
  let target = null, editingSchedule = null, readVersion = 0, editVersion = 0, saving = null
  const scheduleList = dialog.querySelector('#schedule-list')
  const scheduleForm = dialog.querySelector('#schedule-form')
  const scheduleKind = dialog.querySelector('#schedule-kind')
  const scheduleFields = dialog.querySelector('#schedule-fields')
  const scheduleFormError = dialog.querySelector('#schedule-form-error')
  const scheduleAction = dialog.querySelector('#schedule-action')
  const scheduleActionField = dialog.querySelector('#schedule-action-field')
  const schedulePromptField = dialog.querySelector('#schedule-prompt-field')
  const scheduleCommandField = dialog.querySelector('#schedule-command-field')
  const scheduleTargetsField = dialog.querySelector('#schedule-targets-field')
  const scheduleTargets = dialog.querySelector('#schedule-targets')
  const scheduleFormTitle = dialog.querySelector('#schedule-form-title')
  const scheduleSubmit = dialog.querySelector('#schedule-submit')
  const scheduleCancel = dialog.querySelector('#schedule-cancel')
  const scheduleTitleNode = dialog.querySelector('#schedule-title')
  const scheduleAdd = dialog.querySelector('#schedule-add')
  const scheduleResult = dialog.querySelector('#schedule-result')
  // W66: the form opens on 「予定を追加」 or 「編集」; the list stays the first thing in the sheet.
  scheduleAdd.addEventListener('click', () => { resetScheduleForm(); scheduleResult.textContent = ''; scheduleForm.hidden = false; scheduleForm.scrollIntoView({ block: 'start' }) })
  scheduleKind.addEventListener('change', renderScheduleFields)
  scheduleAction.addEventListener('change', renderScheduleAction)
  scheduleForm.addEventListener('submit', saveSchedule)
  scheduleCancel.addEventListener('click', resetScheduleForm)
  scheduleForm.addEventListener('input', () => { editVersion++ })
  scheduleForm.addEventListener('change', () => { editVersion++ })
  dialog.addEventListener('close', () => { if (!dialog.open) { target = null; readVersion++ } })
  async function open(value) {
    target = { ...value, memberIds: [...(value.memberIds ?? [])] }
    const owner = target
    scheduleSubmit.disabled = false
    resetScheduleForm()
    // W65: the title names the target and the previous target's rows never stay while loading.
    scheduleTitleNode.textContent = `${target.name ?? target.displayName ?? ''}の自動実行`
    scheduleResult.textContent = ''
    scheduleList.replaceChildren(Object.assign(document.createElement('p'), { className: 'field-help', textContent: '予定を読み込んでいます…' }))
    if (!dialog.open) dialog.showModal()
    try { await loadSchedules() }
    catch {
      if (owner !== target) return
      const box = Object.assign(document.createElement('div'), { className: 'inline-error' })
      box.innerHTML = '<p>予定を読み込めませんでした。通信を確かめて、もう一度読み込んでください。</p><button type="button">もう一度読み込む</button>'
      box.querySelector('button').addEventListener('click', () => { void open(owner) })
      scheduleList.replaceChildren(box)
    }
  }

  function resetScheduleForm() {
    editVersion++
    editingSchedule = null
    scheduleForm.reset()
    scheduleFormError.textContent = ''
    scheduleFormTitle.textContent = '予定を追加'
    scheduleSubmit.textContent = '保存'
    scheduleForm.hidden = true
    renderScheduleFields()
    renderScheduleAction()
    renderScheduleTargets()
  }

  // コマンド予定はBot専用。ルームではAIへの指示だけ。
  function renderScheduleAction() {
    const command = target.type !== 'room' && scheduleAction.value === 'command'
    scheduleActionField.hidden = target.type === 'room'
    schedulePromptField.hidden = command
    scheduleCommandField.hidden = !command
    dialog.querySelector('#schedule-prompt').required = !command
    dialog.querySelector('#schedule-command').required = command
  }

  function editSchedule(schedule) {
    resetScheduleForm()
    editingSchedule = schedule
    scheduleFormTitle.textContent = '予定を編集'
    scheduleSubmit.textContent = '保存'
    scheduleForm.hidden = false
    dialog.querySelector('#schedule-name').value = schedule.name ?? ''
    dialog.querySelector('#schedule-prompt').value = schedule.prompt ?? ''
    dialog.querySelector('#schedule-command').value = schedule.command ?? ''
    scheduleAction.value = schedule.command ? 'command' : 'prompt'
    renderScheduleAction()
    const form = scheduleFormValues(schedule)
    scheduleKind.value = form.type
    renderScheduleFields()
    if (form.type === 'once') dialog.querySelector('#schedule-once').value = form.at
    if (form.type === 'hourly') dialog.querySelector('#schedule-minute').value = form.minute
    if (form.type === 'daily' || form.type === 'weekly') dialog.querySelector('#schedule-time').value = form.time
    if (form.type === 'interval_days') {
      dialog.querySelector('#schedule-interval-days').value = form.intervalDays
      dialog.querySelector('#schedule-start-date').value = form.startDate
      dialog.querySelector('#schedule-time').value = form.time
    }
    if (form.type === 'interval_hours') {
      dialog.querySelector('#schedule-interval-hours').value = form.intervalHours
      dialog.querySelector('#schedule-start-hour').value = form.startHour
      dialog.querySelector('#schedule-end-hour').value = form.endHour
      dialog.querySelector('#schedule-minute').value = form.minute
    }
    if (form.type === 'weekly') {
      for (const input of dialog.querySelectorAll('input[name="weekday"]')) input.checked = form.weekdays.includes(input.value)
    }
    if (form.type === 'cron') dialog.querySelector('#schedule-cron').value = schedule.expression
    if (target.type === 'room' && Array.isArray(schedule.targets)) {
      for (const input of scheduleTargets.querySelectorAll('input')) input.checked = schedule.targets.includes(input.value)
    }
    scheduleForm.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 保存済みの予定を入力欄の形へ戻す。cron式が毎時・毎日・曜日指定の形なら同じ選択肢で開き、それ以外はcron式のまま開く。
  async function loadSchedules() {
    const owner = target
    const reading = ++readVersion
    let result
    try { result = await api(schedulePath(owner)) }
    catch (error) { if (owner === target && reading === readVersion) throw error; return }
    if (owner !== target || reading !== readVersion) return
    const schedules = result.schedules.filter(schedule => !finishedSchedule(schedule))
    if (schedules.length === 0) {
      scheduleList.innerHTML = '<p class="empty-schedules">予定はまだありません。「予定を追加」から作れます。</p>'
      return
    }
    scheduleList.replaceChildren(...schedules.map(schedule => {
      const row = document.createElement('div')
      row.className = 'schedule-row'
      row.dataset ??= {}
      row.dataset.scheduleId = schedule.id
      // W65: one line per item; the full instruction or command is one tap away.
      const body = schedule.command ? `コマンド（AIを起こさない）\n${schedule.command}` : schedule.prompt ?? ''
      const state = scheduleState(schedule), next = scheduleNext(schedule)
      row.innerHTML = `<div><strong>${escapeHtml(scheduleTitle(schedule))}</strong><span>${escapeHtml(scheduleDescription(schedule))}</span><small><b class="schedule-state is-${state.tone}">${state.text}</b>${next ? ` ${escapeHtml(next)}` : ''}</small>${body ? `<details class="schedule-body"><summary>内容を見る</summary><p>${escapeHtml(body)}</p></details>` : ''}</div><div class="schedule-actions"><button class="run" type="button">今すぐ実行</button><button class="edit" type="button">編集</button><button class="remove" type="button">削除</button><button class="keep" type="button" hidden>やめる</button></div>`
      const runButton = row.querySelector('button.run')
      runButton.addEventListener('click', async () => {
        runButton.disabled = true
        try {
          await api(`${schedulePath(owner)}/${encodeURIComponent(schedule.id)}/run`, { method: 'POST' })
          runButton.textContent = '送りました'
        } catch {
          runButton.textContent = '送れませんでした'
        }
        setTimeout(() => { runButton.textContent = '今すぐ実行'; runButton.disabled = false }, 2500)
      })
      row.querySelector('button.edit').addEventListener('click', () => { if (owner === target) editSchedule(schedule) })
      const remove = row.querySelector('button.remove'), keep = row.querySelector('button.keep')
      // W65: delete asks once in the row: 「削除」 -> 「削除する」 / 「やめる」.
      let confirming = false
      keep.addEventListener('click', () => { confirming = false; remove.textContent = '削除'; keep.hidden = true })
      remove.addEventListener('click', async () => {
        if (remove.disabled) return
        if (!confirming) { confirming = true; remove.textContent = '削除する'; keep.hidden = false; return }
        remove.disabled = true; keep.hidden = true
        let removed = false
        try {
          await api(`${schedulePath(owner)}/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' })
          removed = true
          if (owner !== target) return
          if (editingSchedule?.id === schedule.id) resetScheduleForm()
          await loadSchedules()
        } catch {
          if (owner === target) scheduleResult.textContent = removed ? '削除しました。予定一覧を更新できませんでした。' : '予定を削除できませんでした。もう一度押してください。'
        } finally { remove.disabled = false; confirming = false; remove.textContent = '削除' }
      })
      return row
    }))
  }

  function renderScheduleTargets() {
    scheduleTargetsField.hidden = target.type !== 'room'
    if (target.type !== 'room') return scheduleTargets.replaceChildren()
    // W66: the same rows as the 返信する人 picker (name + check).
    scheduleTargets.replaceChildren(...target.memberIds.map(id => {
      const bot = getBot(id)
      const label = document.createElement('label')
      label.className = 'target-row'
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(id)}"><span>${escapeHtml(bot?.name ?? bot?.displayName ?? id)}</span><i class="target-check"></i>`
      return label
    }))
  }

  function schedulePath(owner = target) {
    return owner.type === 'room'
      ? `/api/rooms/${owner.id}/schedules`
      : `/api/bots/${owner.id}/schedules`
  }

  function renderScheduleFields() {
    const type = scheduleKind.value
    if (type === 'once') scheduleFields.innerHTML = '<label class="field"><span>実行日時</span><input id="schedule-once" type="datetime-local" required></label>'
    if (type === 'hourly') scheduleFields.innerHTML = '<label class="field"><span>毎時の何分</span><input id="schedule-minute" type="number" min="0" max="59" value="0" required></label>'
    if (type === 'daily') scheduleFields.innerHTML = '<label class="field"><span>時刻</span><input id="schedule-time" type="time" value="09:00" required></label>'
    if (type === 'interval_days') scheduleFields.innerHTML = `<label class="field"><span>何日おき</span><input id="schedule-interval-days" type="number" min="1" step="1" value="2" required></label><label class="field"><span>開始日</span><input id="schedule-start-date" type="date" value="${localDateTimeValue(new Date()).slice(0, 10)}" required></label><label class="field"><span>時刻</span><input id="schedule-time" type="time" value="09:00" required></label><small>開始日から数えます。2日おきなら、開始日・2日後・4日後に実行します。</small>`
    if (type === 'interval_hours') scheduleFields.innerHTML = '<label class="field"><span>何時間おき</span><input id="schedule-interval-hours" type="number" min="1" max="24" step="1" value="3" required></label><div class="field-row"><label class="field"><span>開始（時）</span><input id="schedule-start-hour" type="number" min="0" max="23" step="1" value="9" required></label><label class="field"><span>終了（時）</span><input id="schedule-end-hour" type="number" min="0" max="23" step="1" value="18" required></label></div><label class="field"><span>実行する分</span><input id="schedule-minute" type="number" min="0" max="59" step="1" value="0" required></label><small>9時〜18時・3時間おきなら9・12・15・18時に実行します。終了が開始より早ければ翌日まで、同じならその時刻に一回実行します。</small>'
    if (type === 'weekly') scheduleFields.innerHTML = '<label class="field"><span>曜日</span><span class="weekday-checks">' + ['日','月','火','水','木','金','土'].map((day, index) => `<label><input type="checkbox" name="weekday" value="${index}" ${index === 1 ? 'checked' : ''}><b>${day}</b></label>`).join('') + '</span><small class="form-error" id="schedule-weekday-error" role="alert"></small></label><label class="field"><span>時刻</span><input id="schedule-time" type="time" value="09:00" required></label>'
    if (type === 'cron') scheduleFields.innerHTML = '<label class="field"><span>詳しい指定（cron式）</span><input id="schedule-cron" value="0 9 * * 1-5" required placeholder="0 9 * * 1-5"><small>分 時 日 月 曜日 の順に書きます。例: 平日9時は「0 9 * * 1-5」。</small></label>'
  }

  async function saveSchedule(event) {
    event.preventDefault()
    if (!target || saving === target) return
    const owner = target, version = editVersion, editing = editingSchedule
    saving = owner
    scheduleSubmit.disabled = true
    scheduleFormError.textContent = ''
    let accepted = false
    try {
      const values = Object.fromEntries([...scheduleForm.querySelectorAll('input, select, textarea')].map(input => [input.id.replace('schedule-', ''), input.value]))
      values.targets = [...scheduleTargets.querySelectorAll('input:checked')].map(input => input.value)
      values.weekdays = [...dialog.querySelectorAll('input[name="weekday"]:checked')].map(input => input.value)
      const body = scheduleRequest(values, owner.type, editing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Tokyo')
      await api(editing ? `${schedulePath(owner)}/${encodeURIComponent(editing.id)}` : schedulePath(owner), {
        method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      accepted = true
      if (owner !== target) return
      if (version === editVersion) resetScheduleForm()
      // W65: the result sits by the list, where the saved row is.
      scheduleResult.textContent = '保存しました'
      await loadSchedules()
    } catch (error) {
      if (owner !== target) return
      // W67: a weekly item without a weekday says so next to the weekdays.
      if (error?.message === 'WEEKDAY_REQUIRED') { dialog.querySelector('#schedule-weekday-error').textContent = '曜日を選んでください'; return }
      scheduleFormError.textContent = accepted ? '保存しました。予定一覧を更新できませんでした。' : '予定を保存できませんでした。日時と実行内容を確かめて、もう一度保存してください。'
    } finally {
      if (saving === owner) saving = null
      if (owner === target) scheduleSubmit.disabled = false
    }
  }

  return { open, async refresh() { if (!dialog.open || !target) return; try { await loadSchedules() } catch { scheduleFormError.textContent = '予定一覧を更新できませんでした。入力を残しています。' } } }
}
