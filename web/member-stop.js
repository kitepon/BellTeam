// POSTは再送しない。対象ID付きの送信結果を読み、実中断の観測とは区別する。
export async function requestMemberStop(botId, api) {
  const result = await api(`/api/bots/${encodeURIComponent(botId)}/stop`, { method: 'POST' })
  if (result?.botId !== botId || !(result.status === 'stop_sent' || result.status === 'interrupted' && result.sessionPreserved === true))
    throw new Error('停止結果を確認できませんでした。')
  return result
}
