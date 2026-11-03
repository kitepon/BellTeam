import assert from 'node:assert/strict'
import test from 'node:test'
import { createMembersProjection } from '../src/members-projection.mjs'
const context = generation => ({ generation, leaseId: null, rootId: 'initialize', ownerWrite: false, continuation: false })
const bot = id => ({ id, name: id, harness: 'codex', session: '' })
function publish(view, generation, revision, ids) {
  view.accept({ type: 'snapshot-start', revision }, context(generation))
  for (const id of ids) view.accept({ type: 'profile', revision, bot: bot(id) }, context(generation))
  view.accept({ type: 'snapshot-end', revision }, context(generation))
}
test('full snapshot is adopted atomically; an incomplete replacement remains stale', () => {
  let changes = 0
  const view = createMembersProjection({ onChange() { changes++ } })
  view.begin('a'); publish(view, 'a', 1, ['first', 'second'])
  view.begin('b')
  view.accept({ type: 'snapshot-start', revision: 1 }, context('b'))
  view.accept({ type: 'profile', revision: 1, bot: bot('new') }, context('b'))
  assert.deepEqual([...view.keys()], ['first', 'second']); assert.equal(view.snapshot().stale, true)
  assert.equal(view.snapshot().generation, 'a'); assert.equal(view.snapshot().revision, 1)
  view.unavailable(); assert.equal(changes, 1)
  assert.deepEqual([...view.keys()], ['first', 'second'])
  publish(view, 'b', 1, ['new']); assert.deepEqual([...view.keys()], ['new'])
  assert.equal(changes, 2); assert.equal(view.snapshot().available, true)
})
test('old generation, partial revisions, duplicates, images and replay cannot adopt a roster', () => {
  const cases = [
    (v) => v.accept({ type: 'snapshot-end', revision: 2 }, context('b')),
    (v) => v.accept({ type: 'snapshot-end', revision: 1 }, context('a')),
    (v) => { v.accept({ type: 'profile', revision: 1, bot: bot('new') }, context('b')); v.accept({ type: 'profile', revision: 1, bot: bot('new') }, context('b')) },
    (v) => v.accept({ type: 'profile', revision: 1, bot: { ...bot('new'), avatar: null } }, context('b')),
  ]
  for (const corrupt of cases) {
    const v = createMembersProjection(); v.begin('a'); publish(v, 'a', 1, ['old']); v.begin('b')
    v.accept({ type: 'snapshot-start', revision: 1 }, context('b'))
    assert.throws(() => corrupt(v)); assert.deepEqual([...v.keys()], ['old']); assert.equal(v.snapshot().stale, true)
    assert.throws(() => v.accept({ type: 'snapshot-end', revision: 1 }, context('b')))
  }
  const v = createMembersProjection(); v.begin('a'); publish(v, 'a', 4, ['old'])
  assert.throws(() => publish(v, 'a', 4, ['new'])); assert.equal(v.has('old'), true)
})
test('projection reads cannot mutate the committed roster and impose no member-count limit', () => {
  const v = createMembersProjection(); v.begin('a'); publish(v, 'a', 0, Array.from({ length: 1001 }, (_, i) => 'bot-' + i))
  v.get('bot-0').name = 'changed'; [...v.values()][0].name = 'changed'; v.snapshot().profiles[0].name = 'changed'
  assert.equal(v.get('bot-0').name, 'bot-0'); assert.equal(v.snapshot().profiles.length, 1001)
})

test('five-field context is required, initialization cannot claim continuation', () => {
  for (const modify of [value => { delete value.continuation }, value => { value.continuation = 'true' }, value => { value.continuation = true }]) {
    const view = createMembersProjection(); view.begin('a')
    const captured = context('a'); modify(captured)
    assert.throws(() => view.accept({ type: 'snapshot-start', revision: 1 }, captured))
    assert.equal(view.snapshot().available, false)
  }
  const view = createMembersProjection(); view.begin('a')
  const trustedLive = { ...context('a'), leaseId: 'old-live-lease', rootId: 'root', continuation: true }
  for (const record of [{ type: 'snapshot-start', revision: 1 }, { type: 'profile', revision: 1, bot: bot('continued') }, { type: 'snapshot-end', revision: 1 }]) view.accept(record, trustedLive)
  assert.equal(view.get('continued').id, 'continued')
})
