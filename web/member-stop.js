// POSTは再送しない。queueが消えただけではなく、対象ID付きの確認済み結果を読む。
export async function requestMemberStop(botId, api) {
  const result = await api(`/api/bots/${encodeURIComponent(botId)}/stop`, { method: 'POST' })
  if (result?.botId !== botId || !(result.status === 'stop_sent' || result.status === 'interrupted' && result.sessionPreserved === true))
    throw new Error('停止結果を確認できませんでした。')
  return result
}
