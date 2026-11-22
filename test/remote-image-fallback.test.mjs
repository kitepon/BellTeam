import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { IMAGE_NOT_DELIVERED_LINE } from '../src/execution-transport.mjs'

const refused = 'aiterm: REMOTE_IMAGE_UNSUPPORTED: 別端末への画像添付には未対応です'
const png = { mime: 'image/png', data: Buffer.from('synthetic image bytes').toString('base64') }

// a521 (delivery-details.md): an image for a remote seat is refused before typing; the same text goes once more without it, said so in the text.
function seatClient(mode) {
  const calls = [], sends = []
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    calls.push(name)
    if (name === 'pty_send') {
      sends.push(args)
      if (args.image) return { isError: true, content: [{ type: 'text', text: refused }] }
      return { structuredContent: { mode, event_cursor: 1, wait_process: { executable: '/node', args: ['wait'] } } }
    }
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'ok' } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  return { client, calls, sends }
}

for (const mode of ['agent_dispatch', 'agent_steer']) {
  test(`a remote seat refuses the image: the text is sent once more without it (${mode}), nothing failed, nothing closed or launched`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bellteam-image-fallback-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const { client, calls, sends } = seatClient(mode)
    const transport = new AitermTransport({ client, tempRoot: root, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
    t.mock.method(process.stderr, 'write', () => true)
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }
    await transport.notify(bot, '画像を見てください', { images: [png] })
    await transport.idle(bot.id)
    assert.equal(sends.length, 2, 'refused once, resent once')
    assert.ok(sends[0].image?.length === 1 && sends[0].text === '画像を見てください')
    assert.equal('image' in sends[1], false, 'the resend carries no image')
    assert.equal(sends[1].text, `画像を見てください\n\n${IMAGE_NOT_DELIVERED_LINE}`)
    assert.equal(sends[1].require_agent, true)
    for (const name of ['pty_observe', 'pty_close', 'agent_launch']) assert.equal(calls.includes(name), false, name)
  })
}

test('a send WITHOUT an image refused with the same error still fails (no resend)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-image-fallback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sends = []
  const classifier = new AitermClient()
  const client = { call: (name, args) => classifier.call(name, args) }
  classifier.client = { async callTool({ name, arguments: args }) {
    if (name === 'pty_send') { sends.push(args); return { isError: true, content: [{ type: 'text', text: refused }] } }
    throw new Error(`unexpected tool: ${name}`)
  } }
  const transport = new AitermTransport({ client, tempRoot: root, handoffContext: async () => '', waitProcess: async () => ({ outcome: 'done' }) })
  t.mock.method(process.stderr, 'write', () => true)
  await assert.rejects(transport.notify({ id: 'bot-a', session: 'bot-a', harness: 'claude', project: root }, '本文だけ'), { code: 'BOT_IMAGE_UNSUPPORTED' })
  assert.equal(sends.length, 1)
})

