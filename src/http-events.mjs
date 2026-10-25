// 会話の知らせ（SSE）を黙らせない間隔。
export const EVENT_KEEPALIVE_MS = 25000
// 一つの変更で複数の監視が続けて鳴る。この間の知らせは1件にまとめる。
export const MESSAGE_EVENT_WINDOW_MS = 50

export function createMessageEvents({ store, secretRequests, ownerQuestions, rooms, bots, transport, aiControl, eventKeepalive, messageEventWindow }) {
  const subscribers = new Set()
  let closeWatch = null
  let pendingNotify = null
  const connect = (request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    response.write('event: ready\ndata: {}\n\n')
    subscribers.add(response)
    // 知らせの無い間も流れを止めない。アプリ（URLSessionの既定60秒）や途中の中継が、黙った接続を時間切れにするため。
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), eventKeepalive)
    request.on('close', () => {
      clearInterval(keepalive)
      subscribers.delete(response)
    })
  }
  const writeEvent = data => {
    for (const subscriber of subscribers) subscriber.write(`event: messages\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const notifyNow = data => writeEvent({ at: new Date().toISOString(), topics: data.type ? [data.type] : [], botIds: [], roomIds: [], ...data, all: true })
  const startMessageWatch = async () => {
    if (closeWatch) return
    const knownTopics = new Set(['timeline', 'queue', 'bots', 'rooms', 'owner', 'settings', 'requests', 'questions', 'ai-control', 'setup', 'schedules'])
    let changes = null
    const notify = change => {
      changes ??= { all: false, topics: new Set(), botIds: new Set(), roomIds: new Set() }
      if (!change || typeof change.all !== 'boolean' || !Array.isArray(change.topics) || !change.topics.length
        || !Array.isArray(change.botIds) || !Array.isArray(change.roomIds)) changes.all = true
      else {
        changes.all ||= change.all
        for (const topic of change.topics) {
          if (!knownTopics.has(topic)) changes.all = true
          else changes.topics.add(topic)
        }
        for (const name of ['botIds', 'roomIds']) for (const id of change[name]) {
          if (typeof id !== 'string' || !id) changes.all = true
          else changes[name].add(id)
        }
        if (change.topics.some(topic => ['timeline', 'queue', 'requests', 'questions', 'schedules'].includes(topic))
          && !change.botIds.length && !change.roomIds.length) changes.all = true
      }
      if (pendingNotify) return
      pendingNotify = setTimeout(() => {
        pendingNotify = null
        const current = changes; changes = null
        writeEvent({ at: new Date().toISOString(), all: current.all, topics: [...current.topics], botIds: [...current.botIds], roomIds: [...current.roomIds] })
      }, messageEventWindow)
    }
    const stops = [await store.watch(notify)]
    if (secretRequests) stops.push(secretRequests.watch(notify))
    if (ownerQuestions) stops.push(ownerQuestions.watch(notify))
    if (rooms?.watch) stops.push(await rooms.watch(notify))
    if (bots?.watch) stops.push(bots.watch(notify))
    if (transport?.watchQueue) stops.push(transport.watchQueue(notify))
    if (aiControl) stops.push(aiControl.watch(() => notifyNow({ type: 'ai-control' })))
    closeWatch = () => stops.forEach(stop => stop())
  }
  const stopWatching = () => {
    closeWatch?.()
    closeWatch = null
    clearTimeout(pendingNotify)
    pendingNotify = null
  }
  const endConnections = () => {
    for (const subscriber of subscribers) subscriber.end()
  }
  return { connect, notify: notifyNow, startMessageWatch, stopWatching, endConnections }
}
