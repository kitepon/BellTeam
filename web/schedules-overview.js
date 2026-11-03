import { escapeHtml, formatDateTime } from './view-format.js?v=__ASSET_VERSION__'
import { scheduleDescription } from './schedule-editor.js?v=__ASSET_VERSION__'

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
  async function refresh() {
    if (!dialog.open) return
    const version = ++read, targets = getTargets()
    notice.textContent = '予定を取得しています…'
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
      select.replaceChildren(...targets.map(target => new Option(target.displayName ?? target.name, `${target.type}:${target.id}`)))
      if (targets.some(target => `${target.type}:${target.id}` === previous)) select.value = previous
      dialog.querySelector('[data-schedules-add]').disabled = !targets.length
      list.replaceChildren(...sources.map(source => {
        const section = document.createElement('section')
        section.className = 'schedule-source'
        section.innerHTML = `<h3>${escapeHtml(source.name)}</h3>`
        if (!source.schedules.length) section.insertAdjacentHTML('beforeend','<p class="field-help">予定はありません。</p>')
        for (const schedule of source.schedules) {
          const row = document.createElement('div')
          row.className = 'schedule-row'
          row.innerHTML = `<div><strong>${escapeHtml(schedule.name || schedule.command || schedule.prompt)}</strong><span>${escapeHtml(scheduleDescription(schedule))}</span><small>${schedule.enabled ? '有効' : '無効'} · 次回 ${escapeHtml(formatDateTime(schedule.nextRunAt))}</small></div><button type="button">管理</button>`
          row.querySelector('button').addEventListener('click', () => {
            const target=getTargets().find(item => item.type===source.kind && item.id===source.id)
            if (target) void manage(target)
            else notice.textContent='対象が名簿にありません。名簿を再取得してください。'
          })
          section.append(row)
        }
        return section
      }))
      notice.textContent = targets.length ? '対象の「管理」で作成・編集・実行・削除できます。' : 'メンバーまたはルームを追加してください。'
    } catch (error) { if (dialog.open && version === read) notice.textContent = `予定を取得できませんでした。${error.message} 表示済みの一覧は前回の内容です。` }
  }
  return { async open() { if (!dialog.open) dialog.showModal(); await refresh() }, refresh }
}
