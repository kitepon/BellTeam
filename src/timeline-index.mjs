// 表示行の索引はプロセス内にだけ持ち、ページは返す行だけを配列へ写す。
// 旧APIが返す全行の配列は、返した後に書き換えない。
// load(key) を渡すと遅延の索引になる: 行は key・時刻・IDだけを持ち、表示する行（item）は読んだ時に作る。
// 作った行は直近 RECENT 件だけ残し、状態が変わった行は touch(key) で捨てる（history-store.md）。
const RECENT = 256
export class TimelineIndex {
  constructor(items = [], keys = items.map(() => Symbol()), load = null) {
    this.load = load
    this.recent = new Set()
    this.nodes = items.map((item, n) => ({ key: keys[n], item: load ? null : item, at: item.at, id: item.id, order: n })).sort(compareTime)
    this.positions = new Map()
    this.ids = new Map()
    this.nextOrder = items.length
    this.revision = 0
    this.cached = null
    this.nodes.forEach((node, index) => {
      this.positions.set(node.key, index)
      if (!this.ids.has(node.id)) this.ids.set(node.id, index)
    })
  }
  get length() { return this.nodes.length }
  value(node) {
    if (node && !node.item && this.load) {
      node.item = this.load(node.key)
      this.recent.add(node)
      if (this.recent.size > RECENT) { const old = this.recent.values().next().value; this.recent.delete(old); old.item = null }
    }
    return node?.item
  }
  get(key) { const index = this.positions.get(key); return index === undefined ? undefined : this.value(this.nodes[index]) }
  at(index) { return this.value(this.nodes.at(index)) }
  indexOfId(id) { return this.ids.get(id) ?? -1 }
  // A lazy row whose saved status changed: the next read draws it again.
  touch(key) {
    const node = this.nodes[this.positions.get(key)]
    if (!node) return
    node.item = null; this.recent.delete(node)
    this.revision++
    this.cached = null
  }
  set(key, item) {
    const previous = this.positions.get(key)
    if (previous !== undefined) {
      const node = this.nodes[previous]
      if (this.load) return this.touch(key)
      if (node.item === item) return
      if (node.id !== item.id || compareTime(node, item)) {
        Object.assign(node, { item, at: item.at, id: item.id })
        this.nodes.sort((a, b) => compareTime(a, b) || a.order - b.order)
        this.positions.clear(); this.ids.clear()
        this.nodes.forEach((value, index) => {
          this.positions.set(value.key, index)
          if (!this.ids.has(value.id)) this.ids.set(value.id, index)
        })
      } else node.item = item
    } else {
      const node = { key, item: this.load ? null : item, at: item.at, id: item.id, order: this.nextOrder++ }
      // 同時刻の行は追記順を保ち、安定ソートする従来のArray.sortと揃える。
      let index = this.length
      if (index && compareTime(this.nodes.at(-1), node) > 0) {
        let low = 0, high = index
        while (low < high) {
          const mid = (low + high) >>> 1
          if (compareTime(this.nodes[mid], node) <= 0) low = mid + 1
          else high = mid
        }
        index = low
      }
      this.nodes.splice(index, 0, node)
      for (let i = index; i < this.length; i++) this.positions.set(this.nodes[i].key, i)
      // 通常の末尾追記は1つのIDだけを追加する。時刻順の途中へ挿す場合はID位置も更新する。
      if (index === this.length - 1) {
        if (!this.ids.has(node.id)) this.ids.set(node.id, index)
      } else {
        this.ids.clear()
        for (let i = 0; i < this.length; i++) if (!this.ids.has(this.nodes[i].id)) this.ids.set(this.nodes[i].id, i)
      }
    }
    this.revision++
    this.cached = null
  }
  // A lazy index does not keep the list: each call draws every row it returns.
  snapshot() { return this.load ? this.nodes.map(node => this.value(node)) : this.cached ??= this.nodes.map(node => node.item) }
  // Keep only the rows `keep` accepts (a window that moves up: heap-oom-n102-machine-stream-window).
  retain(keep) {
    const nodes = this.nodes.filter(node => keep(this.value(node)))
    if (nodes.length === this.nodes.length) return
    this.nodes = nodes
    this.positions.clear(); this.ids.clear()
    nodes.forEach((node, index) => {
      this.positions.set(node.key, index)
      if (!this.ids.has(node.id)) this.ids.set(node.id, index)
    })
    this.revision++
    this.cached = null
  }
}

export const compareTime = (a, b) => (a.at ?? '').localeCompare(b.at ?? '')
const earlier = (sources, a, b) => compareTime(sources[a.source].at(a.index), sources[b.source].at(b.index)) || a.source - b.source || a.index - b.index

// 時刻順の履歴・秘密入力依頼・質問を結合し、カーソルのIDは各列の索引で探す。
// 同時刻では履歴、秘密入力依頼、質問の順を保つ。
// a471-page-size-scrollback: one page may hold up to 1000 rows (machine seats write many rows; apps read 100 / 500).
export const PAGE_LIMIT_MAX = 1000
export const pageLimit = value => Math.min(PAGE_LIMIT_MAX, Math.max(1, Number(value) || 10))

// skipped: the number of older rows the parent left out of the sources (a471-page-request-bound); they are all older than the page.
export function timelinePage(sources, url, skipped = 0) {
  const limit = pageLimit(url.searchParams.get('limit'))
  const after = url.searchParams.get('after'), before = url.searchParams.get('before')
  const cursor = id => {
    let found = null
    sources.forEach((source, n) => {
      const index = source.indexOfId(id)
      const candidate = { source: n, index }
      if (index >= 0 && (!found || earlier(sources, candidate, found) < 0)) found = candidate
    })
    return found
  }
  const target = after ? cursor(after) : before ? cursor(before) : null
  const starts = sources.map(() => 0), ends = sources.map(source => source.length)
  if (target) sources.forEach((source, n) => {
    let low = 0, high = source.length
    while (low < high) {
      const mid = (low + high) >>> 1
      const order = earlier(sources, { source: n, index: mid }, target)
      if (order < 0 || (after && order === 0)) low = mid + 1
      else high = mid
    }
    if (after) starts[n] = low
    else ends[n] = low
  })
  const allAfter = Boolean(after && target)
  const total = ends.reduce((sum, end, n) => sum + end - starts[n], 0)
  // 従来の未知afterはslice(-limit)を使い、負の添字の端数を0の方向へ丸める。
  // 通常/beforeのslice(end-limit, end)とは、整数化する向きが異なる。
  const take = after && !target ? Math.trunc(limit) : limit
  const count = allAfter ? total : Math.min(take, total)
  const items = mergeItems(sources, starts, ends, allAfter, count)
  const older = after ? 0 : skipped
  // 従来のafterは、未知のカーソルの場合も前ページの有無をfalseで返す。
  return { items, has_more: after ? false : total + older > count, ...(after ? {} : { remaining_before: total + older - items.length }) }
}

export function recentTimeline(sources) {
  let last = null
  sources.forEach(source => { if (source.length && (!last || compareTime(last, source.at(-1)) <= 0)) last = source.at(-1) })
  return last
}
export function fullTimeline(sources) {
  return mergeItems(sources, sources.map(() => 0), sources.map(source => source.length), true, sources.reduce((sum, source) => sum + source.length, 0))
}
function mergeItems(sources, starts, ends, forward, count) {
  const indexes = forward ? [...starts] : ends.map(end => end - 1)
  const items = []
  for (let i = 0; i < count; i++) {
    let best = null
    sources.forEach((_source, n) => {
      const index = indexes[n]
      if (index < starts[n] || index >= ends[n]) return
      const candidate = { source: n, index }
      if (!best || (forward ? earlier(sources, candidate, best) < 0 : earlier(sources, candidate, best) > 0)) best = candidate
    })
    items.push(sources[best.source].at(best.index))
    indexes[best.source] += forward ? 1 : -1
  }
  if (!forward) items.reverse()
  return items
}

// Card bodies stay in the parent; source/index refer to its captured card snapshot.
export function conversationHistoryPage(base, { query, cards, skipped = [] }) {
  const references = new Map()
  const sources = [base, ...cards.map((rows, n) => new TimelineIndex(rows.map((row, index) => {
    const item = { ...row }
    references.set(item, { source: n + 1, index })
    return item
  })))]
  const url = { searchParams: new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null)) }
  const page = timelinePage(sources, url, skipped.reduce((sum, count) => sum + count, 0))
  return { ...page, items: page.items.map(item => references.get(item) ?? { source: 0, item }) }
}

// a471-page-request-bound: the cards of one extra source that can fall inside the page, so the request to the child
// does not grow with the stream. rows are time ordered. hint = the `at` of the cursor row (before_at / after_at).
// Without a hint the whole list is returned (old apps, unknown cursor): same as before, the read waits for the large-body slot.
export function cardWindow(rows, { limit, before, after, hint }) {
  const size = Math.ceil(pageLimit(limit))
  const first = at => { let low = 0, high = rows.length; while (low < high) { const mid = (low + high) >>> 1; if ((rows[mid].at ?? '').localeCompare(at) < 0) low = mid + 1; else high = mid } return low }
  const past = at => { let low = 0, high = rows.length; while (low < high) { const mid = (low + high) >>> 1; if ((rows[mid].at ?? '').localeCompare(at) <= 0) low = mid + 1; else high = mid } return low }
  const slice = (start, end) => ({ rows: rows.slice(start, end), skipped: start })
  if (!before && !after) return slice(Math.max(0, rows.length - size), rows.length)
  const own = rows.findIndex(row => row.id === (before ?? after))
  const at = own >= 0 ? rows[own].at : hint
  if (typeof at !== 'string' || !at) return slice(0, rows.length)
  // ties of the cursor time stay in (they sort before or after the cursor by source), so the window starts a full page before the first of them
  if (after) return slice(first(at), rows.length)
  return slice(Math.max(0, first(at) - size), past(at))
}
