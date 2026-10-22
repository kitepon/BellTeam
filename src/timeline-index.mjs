// Process-local indexes over immutable display rows. Pages copy only returned rows;
// full legacy snapshots remain ordinary arrays and are never mutated afterwards.
export class TimelineIndex {
  constructor(items = [], keys = items.map(() => Symbol())) {
    this.nodes = items.map((item, n) => ({ key: keys[n], item, order: n })).sort((a, b) => compareTime(a.item, b.item))
    this.positions = new Map()
    this.ids = new Map()
    this.nextOrder = items.length
    this.revision = 0
    this.cached = null
    this.nodes.forEach((node, index) => {
      this.positions.set(node.key, index)
      if (!this.ids.has(node.item.id)) this.ids.set(node.item.id, index)
    })
  }
  get length() { return this.nodes.length }
  get(key) { const index = this.positions.get(key); return index === undefined ? undefined : this.nodes[index].item }
  at(index) { return this.nodes.at(index)?.item }
  indexOfId(id) { return this.ids.get(id) ?? -1 }
  set(key, item) {
    const previous = this.positions.get(key)
    if (previous !== undefined) {
      const node = this.nodes[previous]
      if (node.item === item) return
      if (node.item.id !== item.id || compareTime(node.item, item)) {
        node.item = item
        this.nodes.sort((a, b) => compareTime(a.item, b.item) || a.order - b.order)
        this.positions.clear(); this.ids.clear()
        this.nodes.forEach((value, index) => {
          this.positions.set(value.key, index)
          if (!this.ids.has(value.item.id)) this.ids.set(value.item.id, index)
        })
      } else node.item = item
    } else {
      const node = { key, item, order: this.nextOrder++ }
      // Equal timestamps retain append order, matching stable Array.sort.
      let index = this.length
      if (index && compareTime(this.at(-1), item) > 0) {
        let low = 0, high = index
        while (low < high) {
          const mid = (low + high) >>> 1
          if (compareTime(this.at(mid), item) <= 0) low = mid + 1
          else high = mid
        }
        index = low
      }
      this.nodes.splice(index, 0, node)
      for (let i = index; i < this.length; i++) this.positions.set(this.nodes[i].key, i)
      // Normally an append touches one ID. Out-of-order insertion must shift IDs.
      if (index === this.length - 1) {
        if (!this.ids.has(item.id)) this.ids.set(item.id, index)
      } else {
        this.ids.clear()
        for (let i = 0; i < this.length; i++) if (!this.ids.has(this.at(i).id)) this.ids.set(this.at(i).id, i)
      }
    }
    this.revision++
    this.cached = null
  }
  snapshot() { return this.cached ??= this.nodes.map(node => node.item) }
}

export const compareTime = (a, b) => (a.at ?? '').localeCompare(b.at ?? '')
const earlier = (sources, a, b) => compareTime(sources[a.source].at(a.index), sources[b.source].at(b.index)) || a.source - b.source || a.index - b.index

// Merge three already ordered streams (history, requests, questions). Cursor IDs
// use per-stream indexes. Stable ties put history before requests before questions.
export function timelinePage(sources, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 10))
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
  // Legacy unknown-after uses slice(-limit), whose negative index truncates
  // toward zero. Normal/before slice(end-limit, end) rounds the other way.
  const pageLimit = after && !target ? Math.trunc(limit) : limit
  const count = allAfter ? total : Math.min(pageLimit, total)
  const items = mergeItems(sources, starts, ends, allAfter, count)
  // Legacy after (including unknown cursor) never advertises a previous page.
  return { items, has_more: after ? false : total > count }
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
