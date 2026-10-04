import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { UserRules, userRulesInstructions } from '../src/user-rules.mjs'

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
