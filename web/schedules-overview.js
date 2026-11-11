import { escapeHtml } from './view-format.js?v=__ASSET_VERSION__'
import { scheduleDescription, scheduleState, scheduleTitle, scheduleNext, finishedSchedule } from './schedule-editor.js?v=__ASSET_VERSION__'

export function checkedScheduleSources(sources, targets) {
  if (!Array.isArray(sources)) throw new Error('予定一覧の応答形式が一致しません。')
  const seen = new Set()
  for (const source of sources) {
    const key = `${source.kind}:${source.id}`
    if (!['bot','room'].includes(source.kind) || seen.has(key) || !Array.isArray(source.schedules)) throw new Error('予定一覧に不正な対象が含まれています。')
    seen.add(key)
  }
  if (targets.some(target => !seen.has(`${target.type}:${target.id}`))) throw new Error('一部の対象の予定が取得できません。名簿と予定を再取得してください。')
  return sources
}

export function createSchedulesOverview(dialog, { api, getTargets, onManage }) {
  const list = dialog.querySelector('[data-schedules-list]')
  const notice = dialog.querySelector('[data-schedules-notice]')
  const select = dialog.querySelector('[data-schedules-target]')
  let read = 0
  const manage = target => { dialog.close(); return onManage(target) }
  dialog.querySelector('[data-schedules-refresh]').addEventListener('click', () => { void refresh() })
  dialog.querySelector('[data-schedules-add]').addEventListener('click', () => {
    const target = getTargets().find(item => `${item.type}:${item.id}` === select.value)
    if (target) void manage(target)
  })
  dialog.addEventListener('close', () => { read++ })
  // W64: grouped by member/room, active first by next run; finished one-time items under a closed 「終わった予定」.
  function row(source, schedule) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'schedule-row schedule-open'
    const state = scheduleState(schedule), next = scheduleNext(schedule)
    button.innerHTML = `<div><strong>${escapeHtml(scheduleTitle(schedule))}</strong><span>${escapeHtml(scheduleDescription(schedule))}</span><small><b class="schedule-state is-${state.tone}">${state.text}</b>${next ? ` ${escapeHtml(next)}` : ''}</small></div><i aria-hidden="true">›</i>`
    button.addEventListener('click', () => {
      const target = getTargets().find(item => item.type === source.kind && item.id === source.id)
      if (target) void manage(target)
      else notice.textContent = 'この相手は一覧にいません。一覧を読み込み直してください。'
    })
    return button
  }
  async function refresh() {
    if (!dialog.open) return
    const version = ++read, targets = getTargets()
    notice.textContent = ''
    if (!list.children.length) list.replaceChildren(Object.assign(document.createElement('p'), { className: 'field-help', textContent: '予定を読み込んでいます…' }))
    try {
      let sources
      try { sources = (await api('/api/schedules')).sources }
      catch (error) {
        if (error.status !== 404) throw error
        sources = await Promise.all(targets.map(async target => ({ kind:target.type,id:target.id,name:target.displayName ?? target.name,
          schedules:(await api(`/api/${target.type === 'room' ? 'rooms' : 'bots'}/${encodeURIComponent(target.id)}/schedules`)).schedules })))
      }
      checkedScheduleSources(sources, targets)
      if (!dialog.open || version !== read) return
      const previous = select.value
      select.replaceChildren(...targets.map(target => new Option(target.name ?? target.displayName, `${target.type}:${target.id}`)))
      if (targets.some(target => `${target.type}:${target.id}` === previous)) select.value = previous
      dialog.querySelector('[data-schedules-add]').disabled = !targets.length
      const nextAt = schedule => Date.parse(schedule.nextRunAt ?? '') || Infinity
      const sections = sources.filter(source => source.schedules.length).map(source => {
        const section = document.createElement('section')
        section.className = 'schedule-source'
        const name = targets.find(item => item.type === source.kind && item.id === source.id)
        section.innerHTML = `<h3>${escapeHtml(name?.name ?? source.name)}</h3>`
        const live = source.schedules.filter(schedule => !finishedSchedule(schedule))
          .sort((a, b) => (a.enabled === false) - (b.enabled === false) || nextAt(a) - nextAt(b))
        const done = source.schedules.filter(finishedSchedule)
        section.append(...live.map(schedule => row(source, schedule)))
        if (done.length) {
          const fold = document.createElement('details')
          fold.className = 'schedule-done'
          fold.innerHTML = `<summary>終わった予定（${done.length}）</summary>`
          fold.append(...done.map(schedule => row(source, schedule)))
          section.append(fold)
        }
        return section
      })
      list.replaceChildren(...(sections.length ? sections : [Object.assign(document.createElement('p'), { className: 'empty-schedules', textContent: targets.length ? '予定はまだありません。下で相手を選んで「予定を追加」から作れます。' : 'メンバーまたはルームを追加すると、予定を作れます。' })]))
    } catch {
      if (!dialog.open || version !== read) return
      const box = Object.assign(document.createElement('div'), { className: 'inline-error' })
      box.innerHTML = '<p>予定を読み込めませんでした。通信を確かめて、もう一度読み込んでください。</p><button type="button">もう一度読み込む</button>'
      box.querySelector('button').addEventListener('click', () => { void refresh() })
      list.replaceChildren(box)
    }
  }
  return { async open() { if (!dialog.open) dialog.showModal(); await refresh() }, refresh }
}
