import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { renderBotInstructions, renderGlobalInstructions } from '../src/members/instructions.mjs'
import { ownerInstructions } from '../src/owner-profile.mjs'
import { userRulesInstructions } from '../src/user-rules.mjs'

test('pure Bot rendering preserves baseline 9e83 bytes for defaults and Japanese multiline content', () => {
  // Hashes captured from 9e83 ProjectFiles' original template before extraction.
  const cases = [
    [{ id: 'bot-a', name: 'Synthetic' }, '', '95591b7f66b2a624887f5c20031a2f51cea8e37d44590da112f9f5d312cc3ccb'],
    [{ id: 'bot-a', name: '検証', profileText: '本文\n二行', personality: '性格', speechStyle: '口調', position: '役職', role: '役割' }, '前の会話\n次の行', '55ce1aa45a8e97c956ae2041ed30cbe7be6f7b509cb0950f0f169ff8c7593113'],
  ]
  for (const [profile, memory, hash] of cases)
    assert.equal(createHash('sha256').update(renderBotInstructions(profile, memory)).digest('hex'), hash)
})

test('pure global rendering preserves Owner, user rules, common rules order', () => {
  const owner = { name: 'Synthetic', profile: '', xUrl: '', githubUrl: '', links: [] }
  const rules = 'fixture rule', common = '# common\n'
  assert.equal(renderGlobalInstructions(owner, rules, common), `${ownerInstructions(owner)}\n\n${userRulesInstructions(rules)}\n\n${common}`)
})

test('only a 統括 position gets the assign-owner section, right after its role section', () => {
  const profile = position => ({ id: 'bot-a', name: 'N', position, role: '役割X' })
  const note = '# 統括の担当割り当て'
  const coordinator = renderBotInstructions(profile('統括'))
  assert.ok(coordinator.includes('/srv/bellteam/shared/tools/assign-owner/SKILL.md'))
  assert.ok(coordinator.indexOf('「役割X」\n\n' + note) > 0 && coordinator.indexOf(note) < coordinator.indexOf('# 作業手順'))
  assert.ok(renderBotInstructions(profile('開発統括')).includes(note))
  for (const none of ['開発', '', undefined]) assert.ok(!renderBotInstructions(profile(none)).includes(note))
})
