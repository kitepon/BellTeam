import { TimelineIndex, timelinePage } from '../timeline-index.mjs'

// Card bodies stay in the parent; source/index refer to its captured card snapshot.
export function conversationHistoryPage(base, { query, cards }) {
  const references = new Map()
  const sources = [base, ...cards.map((rows, n) => new TimelineIndex(rows.map((row, index) => {
    const item = { ...row }
    references.set(item, { source: n + 1, index })
    return item
  })))]
  const url = { searchParams: new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null)) }
  const page = timelinePage(sources, url)
  return { ...page, items: page.items.map(item => references.get(item) ?? { source: 0, item }) }
}
