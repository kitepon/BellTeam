import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { UserRules, userRulesDiff, userRulesInstructions } from '../src/user-rules.mjs'

test('ユーザー規範は空で初期化し、更新は別インスタンスからも読める', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-rules-'))
  const rules = new UserRules({ root })
  const initial = await rules.initialize()
  assert.equal(initial, '')
  assert.equal(await readFile(join(root, 'owner', 'user-rules.md'), 'utf8'), '')
  await rules.update('- 全員、日本語で話す。\r\n')
  assert.equal(await new UserRules({ root }).get(), '- 全員、日本語で話す。\n')
  assert.equal(await new UserRules({ root }).initialize(), '- 全員、日本語で話す。\n')
  assert.equal(await readFile(join(root, 'owner', 'user-rules.md'), 'utf8'), '- 全員、日本語で話す。\n')
  await assert.rejects(rules.update(42), /USER_RULES_INVALID/u)
})

test('ユーザー規範の指示文は見出しと優先の説明を持つ', () => {
  const text = userRulesInstructions('- 日本語で話す。')
  assert.match(text, /^# ユーザー規範\n/u)
  assert.match(text, /- 日本語で話す。/u)
  assert.match(text, /製品規範と矛盾する場合はこちらを優先する/u)
  assert.match(userRulesInstructions(''), /（未設定）/u)
})

test('本文が変わった保存だけを誰が・前後つきで履歴に残し、新しい順に返す', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-user-rules-history-'))
  const rules = new UserRules({ root })
  await rules.initialize()
  await rules.change('- a', { actor: { kind: 'owner' } })
  await rules.change('- a', { actor: { kind: 'owner' } })
  const instruction = { messageId: 'm-1', at: '2026-11-10T00:00:00.000Z', quote: 'bを足して' }
  assert.deepEqual(await rules.change('- a\n- b', { actor: { kind: 'bot', botId: 'bot-a' }, instruction }), { text: '- a\n- b\n', before: '- a\n' })
  const [latest, first, ...rest] = await rules.history()
  assert.equal(rest.length, 0)
  assert.deepEqual({ ...latest, at: undefined }, { schema: 'bellteam.user-rules-change.v1', at: undefined, actor: { kind: 'bot', botId: 'bot-a' }, instruction, before: '- a\n', after: '- a\n- b\n' })
  assert.deepEqual([first.actor, first.before, first.after], [{ kind: 'owner' }, '', '- a\n'])
  assert.equal(userRulesDiff('x\ny\nz', 'x\nY\nz\nw'), '- y\n+ Y\n+ w')
})
