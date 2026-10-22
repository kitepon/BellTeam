import { TimelineIndex } from './timeline-index.mjs'

// Index cards once at load/save, rather than filtering the complete collection
// for every Bot in /api/bots. Only display metadata is materialized here.
export class CardTimelines {
  constructor(bots, kind) { this.bots = bots; this.kind = kind; this.groups = new Map() }
  group(key) {
    if (!this.groups.has(key)) this.groups.set(key, { index: new TimelineIndex(), items: new Map(), names: new Map(), snapshot: null })
    return this.groups.get(key)
  }
  put(item) {
    const group = this.get(item.roomId ? { roomId: item.roomId } : { botId: item.botId })
    group.items.set(item.id, item)
    group.index.set(item.id, this.row(item))
    group.names.set(item.botId, this.bots.get(item.botId)?.name ?? item.botId)
    group.snapshot = null
  }
  row(item) {
    return { id: item.id, kind: this.kind, direction: 'incoming', at: item.at,
      message: this.kind === 'secret_request' ? item.message : item.question,
      sender: { id: item.botId, name: this.bots.get(item.botId)?.name ?? item.botId },
      [this.kind]: { ...item } }
  }
  get(target) {
    const group = this.group(target.roomId ? `room:${target.roomId}` : `bot:${target.botId}`)
    // Sender names are live profile data. Check distinct senders in this group,
    // not every historical card across all Bots.
    for (const [bot, previous] of group.names) {
      const name = this.bots.get(bot)?.name ?? bot
      if (name === previous) continue
      for (const item of group.items.values()) if (item.botId === bot) group.index.set(item.id, this.row(item))
      group.names.set(bot, name); group.snapshot = null
    }
    return group
  }
  view(target) { return this.get(target).index }
  timeline(target) {
    const group = this.get(target)
    return group.snapshot ??= [...group.items.values()].map(item => this.row(item))
  }
}
