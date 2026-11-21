import assert from 'node:assert/strict'
import test from 'node:test'
import { createBotConversationApi } from '../src/http-conversation-api.mjs'
import { WORKING_WORDS, withWorkingWord, workingWord } from '../src/working-words.mjs'

// conversation working-word.md: one canonical list, one stable word per delivery, only on running rows.
test('the list is Claude Code\'s: plain unique words, no ellipsis', () => {
  assert.ok(WORKING_WORDS.length > 150 && WORKING_WORDS.includes('Mulling') && WORKING_WORDS.includes('Cerebrating'))
  assert.equal(new Set(WORKING_WORDS).size, WORKING_WORDS.length)
  assert.ok(WORKING_WORDS.every(word => /^[A-Za-zé'-]+$/u.test(word)))
})

test('a delivery keeps one word, every word in use is from the list, and the words vary', () => {
  assert.equal(workingWord('d1'), workingWord('d1'))
  const seen = new Set(Array.from({ length: 200 }, (_, n) => workingWord(`delivery-${n}`)))
  assert.ok(seen.size > 50 && [...seen].every(word => WORKING_WORDS.includes(word)))
})

test('only running rows get workingWord, keyed by groupId (id when it has none); other keys are untouched', () => {
  const rows = withWorkingWord([
    { id: 'a', status: 'running', groupId: 'g1', botId: 'bot-1' }, { id: 'b', status: 'queued', groupId: 'g2' },
    { id: 'c', status: 'failed' }, { id: 'd', status: 'running' }])
  assert.deepEqual(rows[0], { id: 'a', status: 'running', groupId: 'g1', botId: 'bot-1', workingWord: workingWord('g1') })
  assert.equal('workingWord' in rows[1] || 'workingWord' in rows[2], false)
  assert.equal(rows[3].workingWord, workingWord('d'))
})

test('GET /api/bots/:id/queue returns the stamped rows', async () => {
  const handle = createBotConversationApi({ bots: { has: () => true, readMember: async () => ({}) },
    transport: { queueItems: filter => [{ id: 'x', status: 'running', groupId: 'g9', botId: filter.botId }] }, messagePage: null, messenger: null })
  let body
  const response = { writeHead() {}, end: text => { body = JSON.parse(text) } }
  await handle({ method: 'GET' }, response, new URL('http://x/api/bots/bot-1/queue'))
  assert.equal(body.items[0].workingWord, workingWord('g9'))
})
