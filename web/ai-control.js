const labels = { enabled: '動作可能', stopping: '停止中…', stopped: '全員の処理中断を確認しました（会話は保持）', unconfirmed: '一部の停止を確認できていません' }

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
export function aiControlView(root, api) {
  const toggle = root.querySelector('input')
  const status = root.querySelector('[role="status"]')
  const refresh = root.querySelector('button')
  let busy = false, generation = 0, control = null
  const render = message => {
    toggle.hidden = !control
    toggle.disabled = busy || !control
    toggle.checked = control?.paused ?? false
    refresh.disabled = busy
    status.textContent = busy ? '停止設定を変更しています…' : control ? `${labels[control.state]}${message ? `。${message}` : ''}` : '状態を確認できません。更新してください。'
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
