import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BellTeamMessenger } from '../src/messenger.mjs'
import { MessageAssets } from '../src/message-assets.mjs'

const launch = { session_id: 'bot-target', launch_id: 'b'.repeat(32) }
const image = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=' }

test('saved recovery retains image bytes and call identity without a content-type exclusion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-recovery-content-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-sender', { id: 'bot-sender', name: 'Sender' }],
    ['bot-target', { id: 'bot-target', name: 'Target' }]])
  const assets = new MessageAssets({ root })
  const logPath = join(root, 'messages.jsonl'), calls = [], turns = []
  const recovered = {}, closed = {}, access = []
  let initial = true, nextId = 'image-bot'
  const messenger = new BellTeamMessenger({ bots, assets, logPath,
    deliveryId: () => { assert.ok(initial, 'recovery must reuse the saved ID'); return nextId },
    requireAccess: input => { access.push(input) }, onTurnEnd: value => turns.push(value),
    transport: {
      async reconcileLaunch(bot, request, target) {
        calls.push({ kind: 'reconcile', bot: bot.id, request, target }); return recovered
      },
      async closeLaunch(bot, request, target) {
        calls.push({ kind: 'close', bot: bot.id, request, target }); return closed
      },
      async notify(bot, text, options) {
        calls.push({ kind: 'notify', bot: bot.id, text, options })
        if (initial) {
          const error = Object.assign(new Error('fixture refusal'), { code: 'BOT_SEND_FAILED' })
          await options.onStatus('failed', error)
          throw error
        }
        assert.equal(options.recoveredExecution, recovered)
        await options.onStatus('running')
        await options.onTurnEnd({})
        return { delivery: 'running' }
      },
    } })

  await assert.rejects(messenger.sendmessage({ from: 'bot-sender', target: 'bot-target', message: 'Saved image', images: [image] }))
  const imageRow = (await messenger.store.records())[0]
  assert.equal(imageRow.image_assets.length, 1, 'legacy Bot sends must retain their images too')
  assert.equal(imageRow.delivery, 'failed')

  // Earlier single-asset rows and Owner senders are also valid saved input.
  const asset = await assets.save({ owner: 'user', id: 'image-owner', image })
  await messenger.append({ ...imageRow, delivery_id: 'image-owner', from: 'user',
    from_identity: { id: 'user', name: 'Owner' }, image_assets: undefined, image_asset: asset })

  for (const [event, required, seq] of [['session.message', false, 4], ['session.reply', true, null]]) {
    nextId = `call-${event}`
    await assert.rejects(messenger.receiveCallBridge({ event, session_id: 'original-call', target_id: 'bot-target',
      source_system: 'local', source_id: 'peer:original', source_label: 'Saved caller', message: 'Saved call', reply_required: required, seq }))
    const row = (await messenger.store.records()).find(row => row.delivery_id === nextId)
    assert.equal(row.call_reply_required, required)
  }
  const originals = await messenger.store.records()
  const initialCalls = calls.filter(call => call.kind === 'notify')
  initial = false; calls.length = 0
  for (const row of originals) {
    const close = await messenger.closeDeliveryLaunch(row.delivery_id, launch)
    assert.equal(close.closed, closed)
    assert.equal((await messenger.store.records()).find(item => item.delivery_id === row.delivery_id).delivery, 'failed')
    const resumed = await messenger.resumeDelivery(row.delivery_id, launch)
    assert.equal(resumed.delivery_id, row.delivery_id)
    const [closing, reconciliation, sent] = calls.splice(0)
    for (const operation of [closing, reconciliation]) {
      assert.deepEqual(operation.request, { kind: 'delivery', delivery_id: row.delivery_id, target_session_id: launch.session_id })
      assert.deepEqual(operation.target, launch)
    }
    assert.equal(sent.options.queue.groupId, row.delivery_id)
    assert.equal(sent.options.queue.from, row.from)
    if (row.image) {
      assert.deepEqual(sent.options.images, [image])
      assert.equal(sent.options.images[0].path, undefined)
    } else {
      assert.equal(sent.text, initialCalls.find(call => call.options.queue.groupId === row.delivery_id).text)
      assert.equal(sent.text.includes('call_send'), row.call_reply_required)
      assert.deepEqual(sent.options.queue.call, { sessionId: 'original-call', event: row.call_event, seq: row.call_seq })
      assert.equal(turns.at(-1).context, 'call')
    }
    assert.deepEqual(access.at(-1), { from: row.from, target: 'bot-target' })
  }
  assert.equal((await messenger.store.records()).length, originals.length, 'no copied message')
  assert.ok((await messenger.store.records()).every(row => row.delivery === 'running'))
  assert.doesNotMatch(await readFile(logPath, 'utf8'), new RegExp(image.data.slice(0, 20)))

  const incomplete = { ...imageRow, delivery_id: 'missing-image', image_assets: [] }
  await messenger.append(incomplete)
  await assert.rejects(messenger.resumeDelivery(incomplete.delivery_id, launch), { message: 'IMAGE_ASSET_NOT_FOUND' })
  assert.equal(calls.length, 0, 'missing bytes must not silently become a text-only send or reconcile')
  await messenger.closeDeliveryLaunch(incomplete.delivery_id, launch)
  assert.equal(calls.pop().kind, 'close', 'close does not need or resend image bytes')
})
