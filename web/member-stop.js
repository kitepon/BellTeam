// POSTは再送しない。queueが消えただけではなく、対象ID付きの確認済み結果を読む。
export async function requestMemberStop(botId, api) {
  const result = await api(`/api/bots/${encodeURIComponent(botId)}/stop`, { method: 'POST' })
  if (result?.botId !== botId || result.status !== 'stopped' || result.online !== false)
    throw new Error('停止結果を確認できませんでした。')
  return result
}
