import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { deferred } from './helpers/editor-dom.mjs'

// The real application.js owner paths in one context: applyOwner, loadBots (list read) and openOwnerDialog (Settings read).
const source = await readFile(new URL('../web/application.js', import.meta.url), 'utf8')
const cut = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const code = [source.match(/ {2}function applyOwner[^\n]+/u)[0], cut('async function loadBots()', '\n  function renderSeatLaunch()'),
  cut('async function openOwnerDialog()', '\n  function renderRosterError')].join('\n')
function app() {
  const lists = [], owners = [], opened = []
  const ctx = { catalogueRead: 0, ownerReads: 0, ownerApplied: 0, rosterLoaded: false,
    state: { owner: null, selected: null, selectedType: null, readReceipts: {} },
    api: path => {
      if (path === '/api/owner') { const read = deferred(); owners.push(read); return read.promise }
      if (path.startsWith('/api/bots')) { const read = deferred(); lists.push(read); return read.promise }
      return Promise.resolve({ rooms: [] })
    },
    ownerProfileButton: { disabled: false }, ownerEditor: { open: owner => opened.push(owner) },
    rosterRetry: {}, rosterError: { textContent: '' }, rosterNotice: { hidden: true },
    conversationKey: (type, id) => `${type}:${id}`, renderRosterError() {}, renderChatStatus() {}, renderBots() {},
    renderCurrentWork() {}, updateSendButton() {}, document: { querySelector() {} } }
  vm.runInNewContext(code, ctx)
  return { ctx, lists, owners, opened }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('a list read already in flight that finishes after the Settings read never overwrites the newer owner', async () => {
  const f = app()
  const list = f.ctx.loadBots(); await settle() // initial list read starts first (its owner GET is older)
  const pressed = f.ctx.openOwnerDialog(); await settle() // Settings starts a newer owner GET
  f.owners[1].resolve({ owner: { name: 'latest' } }); await pressed
  assert.deepEqual(f.opened, [{ name: 'latest' }])
  f.owners[0].resolve({ owner: { name: 'old' } }); f.lists[0].resolve({ bots: [{ id: 'a' }] }); await list
  assert.deepEqual(f.ctx.state.owner, { name: 'latest' }) // owner kept
  assert.deepEqual(f.ctx.state.bots.map(bot => bot.id), ['a']) // the rest of the valid list response still applies
  await f.ctx.openOwnerDialog() // a later Settings open uses the retained latest owner without fetching
  assert.deepEqual(f.opened.at(-1), { name: 'latest' }); assert.equal(f.owners.length, 2)
})

test('a list read that starts after the Settings read wins, whichever finishes first', async () => {
  for (const listFirst of [true, false]) {
    const f = app()
    const pressed = f.ctx.openOwnerDialog(); await settle()
    const list = f.ctx.loadBots(); await settle()
    const finishList = async () => { f.owners[1].resolve({ owner: { name: 'list' } }); f.lists[0].resolve({ bots: [] }); await list }
    if (listFirst) { await finishList(); f.owners[0].resolve({ owner: { name: 'settings' } }); await pressed }
    else { f.owners[0].resolve({ owner: { name: 'settings' } }); await pressed; await finishList() }
    assert.deepEqual(f.ctx.state.owner, { name: 'list' }, String(listFirst))
  }
})

test('Settings stores its read when nothing newer happened, and a failed read says so in place', async () => {
  const f = app()
  const pressed = f.ctx.openOwnerDialog(); await settle()
  f.owners[0].resolve({ owner: { name: 'only' } }); await pressed
  assert.deepEqual(f.ctx.state.owner, { name: 'only' }); assert.deepEqual(f.opened, [{ name: 'only' }])
  const g = app()
  const failed = g.ctx.openOwnerDialog(); await settle()
  g.owners[0].reject(Error('offline')); await failed
  assert.deepEqual(g.opened, []); assert.equal(g.ctx.rosterNotice.hidden, false)
  assert.match(g.ctx.rosterError.textContent, /設定を開けませんでした/)
})
