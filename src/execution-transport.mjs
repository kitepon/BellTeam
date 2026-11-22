// The stop-button path and the helpers every delivery shares. a532b2 stage 1: the older execution-registration adapter
// (reserveExecution, dispatchExecution, interruptExecutions) is gone; production never used it.

export { applyExecutionStop, applyExecutionCancellation, finishExecution } from './delivery-job.mjs'


// 停止操作の骨格。経路（停止ボタンの一括停止と、実行登録ごとの中断）で共通: 根のBotの停止世代を進め、
// 配送jobへ停止要求を付け、進行中の停止として公開し、終わったら止まらなかったjobを解放して一覧を更新する。
// 送り方と結果の読み方だけが経路ごとに違い、runが持つ。
function stopOperation({ sessionState, activity }, bots, run, { acceptedOnly = false } = {}) {
  const roots = [...new Map(bots.map(bot => [bot.id, bot])).values()]
  const rootIds = new Set(roots.map(bot => bot.id))
  const jobs = activity.stopTargets()
  for (const bot of roots) sessionState.invalidate(bot.id)
  const operation = run({ roots, rootIds, jobs }).finally(() => {
    for (const job of jobs) job.release({ acceptedOnly })
    if (sessionState.stopping === operation) sessionState.stopping = null
    activity.emit()
  })
  operation.rootIds = rootIds
  sessionState.stopping = operation
  for (const job of jobs) if (rootIds.has(job.bot.id)) job.requestStop(operation)
  return operation
}

export function sendStopOperations(seat, bots, options = {}) {
  return stopOperation(seat, bots, ({ rootIds, roots, jobs }) => {
    // Start the actual stop RPC before any relation/status/disk read.
    let sent
    try { sent = seat.requestStop(roots.map(bot => seat.session(bot)), options) }
    catch (error) { sent = Promise.reject(error) }
    return Promise.resolve(sent).then(cascade => {
      const sentSessions = new Set(cascade.targets.filter(target => ['sent', 'idle'].includes(target.status)).map(target => target.session_id))
      for (const job of jobs) if (sentSessions.has(seat.session(job.bot))) job.markStopped()
      // Descendants can be BellTeam members too. Cancel only preparations that
      // existed when the owner clicked Stop; a new owner input is still allowed.
      seat.sessionState.invalidateReached(session => sentSessions.has(session), rootIds)
      const failed = cascade.targets.some(target => target.status === 'failed') || ['partial', 'failed'].includes(cascade.status)
      return { requestSent: true, cascade, unconfirmedBotIds: roots.filter(bot => failed || !sentSessions.has(seat.session(bot))).map(bot => bot.id) }
    })
  })
}

// One temporary list holds images and attached files; only images go to Aiterm's `image`, files reach the seat as paths in the text.
export const imagePaths = files => files.filter(file => !file.attachment).map(file => file.path)
// a521: Aiterm refuses an image for a remote seat before typing (REMOTE_IMAGE_UNSUPPORTED). The same text goes once more without the image and says so.
// shortcut: retire this and its caller when Aiterm accepts images for remote seats (Elegg a521-aiterm-remote-image).
export const IMAGE_NOT_DELIVERED_LINE = '（画像が添付されましたが、この席は別の端末にあるため、まだ画像を届けられません。）'
export const withoutImageText = text => `${text}\n\n${IMAGE_NOT_DELIVERED_LINE}`
export const plainLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max)
export function sendText(message, files) {
  const attached = files.filter(file => file.attachment)
  if (!attached.length) return message
  const lines = attached.map(({ path, attachment: { name, mime, size } }) => `- ${name}（${mime || '種類不明'}、${size}バイト）: ${path}`)
  return `${message}\n\n添付ファイル（次のパスで読めます。今回のやりとりのあとで消えます）:\n${lines.join('\n')}`
}
