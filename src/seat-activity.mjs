import { queueItem } from './delivery-job.mjs'

// 席ごとに一つだけ進む非同期の操作（設定変更、送信の順番待ち、起動）。同じ操作が終わった時だけ外す。
// 失敗を残す操作（設定反映の失敗）は、利用者が直すまで次の配送にも同じ失敗を返す。
export class PendingByBot extends Map {
  track(botId, pending, { clearOnFailure = true } = {}) {
    this.set(botId, pending)
    const clear = () => { if (this.get(botId) === pending) this.delete(botId) }
    pending.then(clear, clearOnFailure ? clear : () => {})
    return pending
  }
}

// 席で今起きていることの正本。配送job（受付前も含む）、受理後に「処理中」として見せる活動、
// 席が自分で始めたターンの見張り、席ごとの進行中操作を一つで持ち、「空いているか」「誰がターンを追っているか」
// 「停止の対象は何か」を答える。Aitermの実行判断はここに無い。
export class SeatActivity {
  constructor() {
    // 配送job。送信処理が始まってから終わるまで（受付前の予約待ちも含む）。
    this.jobs = new Set()
    // 「処理中」として見せる活動。受付済みの配送jobと、席が自分で始めたターンの見張り。
    this.active = new Map()
    // 席ごとの、BellTeamが始めていないターンを追っている見張り（watchTurn）。
    this.watches = new Map()
    // 席ごとの、最後に終わりまで追ったターン。Aitermへ聞いた後に終わったターンを、もう一度追い始めない。
    this.followedTurns = new Map()
    // 席ごとの、最後に追ったターンで合間の言葉として出した文。回答の頭から外すのに使う（self-turns.mjs）。
    this.shownWords = new Map()
    this.listeners = new Set()
    this.configurationChanges = new PendingByBot()
    this.dispatches = new PendingByBot()
    this.waking = new PendingByBot()
  }

  register(job) {
    this.jobs.add(job)
  }

  admit(job) {
    this.active.set(job.id, job)
    this.emit(job)
  }

  release(job) {
    this.active.delete(job.id)
    this.jobs.delete(job)
    this.emit(job)
  }

  beginWatch(watch) {
    this.followedTurns.set(watch.bot.id, watch.turnId)
    this.watches.set(watch.bot.id, watch)
    this.shownWords.set(watch.bot.id, watch.shown)
    this.active.set(watch.id, watch)
    this.emit(watch)
  }

  endWatch(watch) {
    this.watches.delete(watch.bot.id)
    this.active.delete(watch.id)
    this.emit(watch)
  }

  of(botId) {
    return [...this.active.values()].filter(item => item.bot.id === botId)
  }

  idle(botId) {
    return !this.of(botId).length
  }

  hasJobs(botId) {
    return [...this.jobs].some(job => job.bot.id === botId)
  }

  // その席で最後に始まった活動。差し込みの終わりを待つ親になる。
  latest(botId) {
    return [...this.active.values()].reverse().find(item => item.bot.id === botId)
  }

  // その席のターンを終わりまで追っている活動（配送で始めたターン、追っている差し込み、見つけた席のターン）。
  follower(botId) {
    return [...this.active.values()].reverse().find(item => item.bot.id === botId && item.follows)
  }

  // 停止が結論を伝える相手。配送jobだけが停止の結論を持つ。見張りは追うのをやめるだけで、停止の結論を持たない。
  stopTargets() {
    return [...this.jobs]
  }

  async whenIdle(botId) {
    while (!this.idle(botId))
      await Promise.all(this.of(botId).map(item => item.completion.catch(() => {})))
  }

  items({ botId = null, roomId = null } = {}) {
    return [...this.active.values()]
      .filter(item => !botId || item.bot.id === botId)
      .filter(item => !roomId || (item.info.context === 'room' && item.info.contextId === roomId))
      .map(queueItem)
  }

  watch(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(item) {
    const change = { all: !item?.bot?.id, topics: ['queue'], botIds: item?.bot?.id ? [item.bot.id] : [], roomIds: item?.info?.context === 'room' && item.info.contextId ? [item.info.contextId] : [] }
    for (const listener of this.listeners) listener(change)
  }
}

// 席が自分で始めたターンの見張り。「処理中」に出し、合間の言葉を出す。回答は運ばない。
export class SeatTurnWatch {
  constructor({ id, bot, turn, groupId, now }) {
    this.id = id
    this.bot = bot
    this.turnId = turn.turn_id
    this.follows = true
    this.startedAt = turn.started_at ?? now
    this.info = { context: 'self', contextId: bot.id, groupId, target: bot.id }
    this.shown = { words: [], endedAt: null }
    this.stop = new AbortController()
    this.ended = new Promise(resolve => this.stop.signal.addEventListener('abort', resolve, { once: true }))
    this.completion = null
  }

  end() {
    this.stop.abort()
  }

  queueItem() {
    return queueItem(this)
  }
}
