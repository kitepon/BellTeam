import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { deferred } from './helpers/editor-dom.mjs'

const source = await readFile(new URL('../web/application.js', import.meta.url), 'utf8')
const slice = source.slice(source.indexOf('async function openOwnerDialog()'), source.indexOf('\n  function renderRosterError'))
function settings(api) {
  const opened = [], ctx = { catalogueRead: 0, state: { owner: null }, api, ownerProfileButton: { disabled: false },
    ownerEditor: { open: owner => opened.push(owner) }, rosterError: { textContent: '' }, rosterNotice: { hidden: true } }
  vm.runInNewContext(slice, ctx)
  return { ctx, opened }
}

test('Settings never lets its slow owner read overwrite a newer list read, and opens with the current owner', async () => {
  const slow = deferred(), f = settings(() => slow.promise)
  const pressed = f.ctx.openOwnerDialog()
  assert.equal(f.ctx.ownerProfileButton.disabled, true)
  // loadBots finishes first with the newer owner (it bumps catalogueRead and sets state.owner).
  f.ctx.catalogueRead++; f.ctx.state.owner = { name: 'new' }
  slow.resolve({ owner: { name: 'old' } }); await pressed
  assert.deepEqual(f.ctx.state.owner, { name: 'new' })
  assert.deepEqual(f.opened, [{ name: 'new' }])
  assert.equal(f.ctx.ownerProfileButton.disabled, false)
})

test('Settings opens with its own read while a started list read has not finished, without storing it', async () => {
  const slow = deferred(), f = settings(() => slow.promise)
  const pressed = f.ctx.openOwnerDialog()
  f.ctx.catalogueRead++ // a list read started and is still running
  slow.resolve({ owner: { name: 'read' } }); await pressed
  assert.equal(f.ctx.state.owner, null)
  assert.deepEqual(f.opened, [{ name: 'read' }])
})

test('Settings stores its read when nothing newer happened, and a failed read says so in place', async () => {
  const ok = settings(async () => ({ owner: { name: 'only' } }))
  await ok.ctx.openOwnerDialog()
  assert.deepEqual(ok.ctx.state.owner, { name: 'only' }); assert.deepEqual(ok.opened, [{ name: 'only' }])
  const failed = settings(async () => { throw Error('offline') })
  await failed.ctx.openOwnerDialog()
  assert.deepEqual(failed.opened, []); assert.equal(failed.ctx.rosterNotice.hidden, false)
  assert.match(failed.ctx.rosterError.textContent, /設定を開けませんでした/)
})
