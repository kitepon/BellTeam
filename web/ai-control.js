const labels = { enabled: '動作可能', stopping: '停止中…', stopped: '全員へ停止操作を送りました（会話は保持）', unconfirmed: '一部の停止を確認できていません' }

export function validAiControl(value) {
  return value && typeof value.paused === 'boolean' && Object.hasOwn(labels, value.state)
    && value.paused === (value.state !== 'enabled')
    && (value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))
    && Array.isArray(value.unconfirmedBotIds) && value.unconfirmedBotIds.every(id => typeof id === 'string')
    && (value.commandsConfirmed === null || typeof value.commandsConfirmed === 'boolean')
    && (value.error === null || typeof value.error === 'string')
    && (value.state !== 'stopped' || value.commandsConfirmed === true && !value.unconfirmedBotIds.length)
}

// The view never infers ON/OFF from a failed PATCH. Only the server's value is shown.
// 設定のホームの一行と札。
export const aiControlSummary = control => !control ? { line: '確認できません', badge: '確認できません', tone: 'attention' }
  : control.state === 'enabled' ? { line: '動作中', badge: '', tone: '' }
  : control.state === 'stopped' ? { line: '停止中', badge: '停止中', tone: 'attention' }
  : control.state === 'stopping' ? { line: '止めています', badge: '途中', tone: 'info' }
  : { line: `止まったか確かめられないメンバーが${control.unconfirmedBotIds.length}人います`, badge: '要確認', tone: 'attention' }

export function aiControlView(root, api, { onChange = () => {} } = {}) {
  const toggle = root.querySelector('input')
  const status = root.querySelector('[role="status"]')
  const refresh = root.querySelector('button')
  let busy = false, generation = 0, control = null
  const render = message => {
    root.setAttribute('data-state', busy ? 'stopping' : control?.state ?? 'unknown')
    toggle.hidden = !control
    toggle.disabled = busy || !control
    toggle.checked = control?.paused ?? false
    refresh.disabled = busy
    const unconfirmed = control?.state === 'unconfirmed' && control.unconfirmedBotIds.length ? `（${control.unconfirmedBotIds.length}人）` : ''
    status.textContent = busy ? '停止設定を変更しています…' : control ? `${labels[control.state]}${unconfirmed}${message ? `。${message}` : ''}` : '状態を確認できません。「確認し直す」を押してください。'
    onChange(aiControlSummary(busy ? { state: 'stopping', unconfirmedBotIds: [] } : control))
  }
  const read = async message => {
    const token = ++generation
    try {
      const result = await api('/api/ai-control')
      if (!validAiControl(result?.control)) throw Error('INVALID_CONTROL')
      if (token === generation) { control = result.control; render(message) }
    } catch {
      if (token === generation) { control = null; render() }
    }
  }
  toggle.addEventListener('change', async () => {
    if (busy || !control) return
    const paused = toggle.checked
    busy = true; generation++; render()
    let message = ''
    try {
      const result = await api('/api/ai-control', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) })
      if (!validAiControl(result?.control)) throw Error('INVALID_CONTROL')
    } catch { message = '変更結果を読み直しました' }
    await read(message)
    busy = false; render(message)
  })
  refresh.addEventListener('click', () => { if (!busy) void read() })
  render()
  return { refresh: read }
}
