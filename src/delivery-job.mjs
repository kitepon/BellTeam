import { isDeepStrictEqual as same } from 'node:util'
import { confirmedSessionInterruption } from './session-interruption.mjs'
import { stoppedError } from './bot-execution-errors.mjs'

// 一回の配送（BellTeamが席へ送る文と、その文が始めた・差し込まれたターンの追跡）の事実を持つ。
// 停止の結論を決めるのはこのjobだけ。停止経路は「要求した」「Aitermがこう返した」「操作が終わった」を伝え、
// 送信処理は「続けてよいか」を聞く。受理済み（receipt）の送信を停止で成功へ丸めず、再送もしない。
export class DeliveryJob {
  constructor({ id, bot, info, startedAt, executionSource = null, stopping = () => null }) {
    this.id = id
    this.bot = bot
    this.info = info
    this.startedAt = startedAt
    this.controller = new AbortController()
    this.executionSource = executionSource
    this.stopping = stopping
    this.execution = null
    this.executionWasPresent = false
    this.receipt = null
    this.follows = false
    this.completion = null
    this.stopRequested = false
    this.stopped = false
    this.interruption = null
    this.executionStopResult = null
    this.executionFinishUnconfirmed = false
  }

  // Aitermへ何も発行していない（受理も、実行登録の発行も無い）。
  get unsent() {
    return !this.receipt && !this.execution?.issued.size
  }

  // 停止操作が始まった。結論はoperationの結果とAitermの返却から決める。
  requestStop(operation) {
    this.stopRequested = true
    this.interruption = operation
  }

  markStopped() {
    this.stopped = true
    this.controller.abort()
  }

  // 停止操作が終わった。止まらなかったjobは続ける。acceptedOnlyは、受理済みの送信だけを続けさせる
  // （未受理の送信は停止要求のまま残り、次の確認で停止として終わる）。
  release({ acceptedOnly = false } = {}) {
    if (!this.stopped && (!acceptedOnly || this.receipt)) this.stopRequested = false
  }

  // Aitermの停止結果を受けて、この配送が止まったかを決める。
  applyStopResult(result) {
    this.executionStopResult = result
    return applyExecutionStop(this)
  }

  assertNotStopped() {
    if (this.stopRequested) throw stoppedError()
  }

  // 送信処理の節目。進行中の停止操作を待ち、停止が確定していれば止め、受理済みで停止未確認なら続ける。
  async checkpoint() {
    await this.stopping()?.catch(() => {})
    if (this.stopped) throw stoppedError()
    if (this.executionStopResult && this.receipt) this.stopRequested = false
    if (!this.stopRequested) return
    try { await this.interruption } catch (error) {
      if (!this.receipt) throw error
      this.stopRequested = false
      return
    }
    if (this.stopped) throw stoppedError()
  }

  // 送信処理が失敗した。停止の結論を反映した最終のエラーを返し、未送信の実行登録を閉じる。
  async failure(error) {
    await this.stopping()?.catch(() => {})
    applyExecutionCancellation(this, error)
    if (this.stopped) error = stoppedError()
    if (this.stopRequested) {
      try { await this.interruption } catch (stopError) { error = stopError }
      if (this.stopped) error = stoppedError()
    }
    if (['BOT_STOPPED', 'AI_GLOBAL_PAUSED'].includes(error.code) && !this.receipt) this.stopped = true
    if (this.execution && this.unsent) await finishExecution(this, 'not_sent')
    return error
  }

  finishExecution(kind) {
    return finishExecution(this, kind)
  }

  queueItem() {
    return queueItem(this)
  }
}

export function queueItem(item) {
  return {
    id: item.id, botId: item.bot.id, botName: item.bot.displayName ?? item.bot.name ?? item.bot.id,
    status: 'running', startedAt: item.startedAt, ...item.info,
  }
}

export async function finishExecution(job, kind) {
  const handle = job.execution
  if (!handle) return
  const target = handle.binding?.target
  if (!['completion', 'not_sent'].includes(kind) || kind === 'completion' && !target?.boundary) return
  try {
    await handle.finish(kind === 'not_sent' ? { kind } : { kind, target })
  } catch {
    // Delivery completion is separate from relation/fence confirmation. Keep
    // the accepted result; the Aiterm record remains unresolved, never resent.
    job.executionFinishUnconfirmed = true
  }
}

export async function applyExecutionStop(job) {
  const point = job.execution?.binding?.target
  // A launch can host several successive runs. Only the exact accepted run
  // may be stopped; an idle launch or an old run is not this job's receipt.
  if (!job.receipt || !point?.boundary || !job.executionStopResult?.targets.some(value =>
    value.interruption === 'interrupted' && confirmedSessionInterruption(value) && same(value.run, point))) return false
  job.stopped = true
  job.controller?.abort()
  // Aiterm owns relation updates for v2. The v1 interrupted finish means
  // launch closure and must never be synthesized for a preserved session.
  return true
}

export function applyExecutionCancellation(job, error) {
  if (job.receipt || error?.effect !== 'not_started' || !job.executionStopResult) return
  const record = job.execution?.record
  const source = record?.source.status === 'verified' ? record.source.point?.launch : null
  const expected = job.execution?.reservation.target
  const target = expected?.expected_launch_id ? { session_id: expected.session_id, launch_id: expected.expected_launch_id } : null
  if (job.executionStopResult.targets.some(value => confirmedSessionInterruption(value)
    && (same(value.launch, source) || same(value.launch, target)))) job.stopped = true
}
