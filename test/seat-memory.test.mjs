import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SeatRuntime } from '../src/seat-runtime.mjs'

test('新規BotのHTTP/MCP共通ensureScopeを席ユーザーへ渡し、記憶とRAGを作成する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seat-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'bots/bot-new')
  await mkdir(project, { recursive: true })
  const runtime = new SeatRuntime({ root, home: root, run: (command, args, options) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: root }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
    child.stdin.end(options.input)
  }) })
  const memory = runtime.memory(new Map([['bot-new', { id: 'bot-new', project }]]))
  await memory.ensureScope('bot-new', 'personal')
  for (const file of ['memory', 'rag/raw', 'rag/notes', 'rag/INDEX.md', 'rag/index.db'])
    assert.ok(await stat(join(project, file)))
  await assert.rejects(memory.ensureScope('bot-missing', 'personal'), /BOT_NOT_FOUND/u)
})
