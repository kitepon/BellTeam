import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

const repo = process.argv[2]
const output = process.argv[3]
if (!repo || !output) throw new Error('usage: benchmark-server.mjs absolute-repo absolute-output')
const from = path => import(pathToFileURL(join(repo, path)))
const { ConversationStore } = await from('src/conversation-store.mjs')
const { RoomRegistry } = await from('src/room-registry.mjs')
const { createBellTeamServer } = await from('src/http-server.mjs')
const root = await mkdtemp(new URL('./synthetic-server-', import.meta.url).pathname)
const logPath = join(root, 'direct.jsonl')
const botCount = 60, messageCount = 30000, roomCount = 5, roomMessageCount = 500
const line = value => JSON.stringify(value) + '\n'
const at = i => new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()
const bots = new Map(Array.from({ length: botCount }, (_, i) => [`bot-${i}`, {
  id: `bot-${i}`, name: `Bot ${i}`, displayName: `Bot ${i}`, avatar: '', harness: 'codex',
}]))
const messages = Array.from({ length: messageCount }, (_, i) => ({
  schema: 'bellteam.direct-message.v1', delivery_id: `m${i}`, at: at(i),
  from: 'user', target: `bot-${i % botCount}`, message: 'synthetic '.repeat(40), image: false, delivery: 'running',
}))
await writeFile(logPath, messages.map(line).join('') + messages.filter((_, i) => i % 3 === 0).map(m => line({
  schema: 'bellteam.delivery-status.v1', delivery_id: m.delivery_id, delivery: 'delivered',
})).join(''))
const rooms = new RoomRegistry({ roomsRoot: join(root, 'rooms'), bots })
await rooms.initialize()
for (let i = 0; i < roomCount; i++) {
  rooms.roomId = () => `room-${i}`
  await rooms.create({ name: `Room ${i}`, memberIds: ['bot-0'] })
  const rows = Array.from({ length: roomMessageCount }, (_, j) => ({
    schema: 'bellteam.room-message.v1', id: `r${j}`, at: at(j), message: 'room synthetic '.repeat(30),
    deliveries: [{ target: 'bot-0', delivery: 'delivered' }],
  }))
  await writeFile(join(root, 'rooms', `room-${i}`, 'messages.jsonl'), rows.map(line).join(''))
}
const server = createBellTeamServer({ bots, rooms, store: new ConversationStore({ logPath }),
  transport: { async runningBots() { return new Set() }, queueItems() { return [] } },
  authorize: () => true, writeLog() {},
})
const samples = {}
global.gc?.()
const memoryBeforeReads = process.memoryUsage()
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const paths = ['/api/bots?avatar=omit', '/api/rooms?avatar=omit',
    '/api/bots/bot-0/messages?limit=10', '/api/rooms/room-0/messages?limit=10',
    '/api/bots/bot-0/messages?after=m0&limit=1']
  async function sample(path) {
    const start = performance.now()
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (response.status !== 200) throw new Error('NON_200')
    return { ms: performance.now() - start, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  for (const path of paths) {
    const cold = await sample(path)
    const warm = []
    for (let i = 0; i < 7; i++) warm.push(await sample(path))
    if (!warm.every(row => row.sha256 === cold.sha256)) throw new Error('UNSTABLE_RESPONSE')
    const times = warm.map(row => row.ms).sort((a, b) => a - b)
    samples[path] = { coldMs: cold.ms, warmMedianMs: times[3], warmMinMs: times[0],
      warmMaxMs: times.at(-1), bytes: cold.bytes, sha256: cold.sha256 }
  }
  await appendFile(logPath, line({ schema: 'bellteam.delivery-status.v1', delivery_id: 'm29940', delivery: 'failed' }))
  samples['after-status-append'] = await sample('/api/bots/bot-0/messages?limit=10')
  global.gc?.()
  const memoryAfterReads = process.memoryUsage()
  await writeFile(output, JSON.stringify({ node: process.version, botCount, messageCount, roomCount,
    roomMessageCount, warmIterations: 7, syntheticOnly: true, explicitGC: !!global.gc,
    memoryBeforeReads, memoryAfterReads, samples }, null, 2) + '\n')
  console.log(JSON.stringify({ output, samples }, null, 2))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
