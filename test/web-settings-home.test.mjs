import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRules, ruleCount } from '../web/user-rules-view.js'
import { authStage, authSummary } from '../web/harness-auth.js'
import { featureState } from '../web/onboarding.js'
import { attentionItems } from '../web/settings-home.js'
import { aiControlSummary } from '../web/ai-control.js'
import { effortLabel } from '../web/background-agent-settings.js'
import { terminalsItem, updateItem } from '../web/owner-editor.js'

test('team rules: SECTION / RULE / clauses become a readable list, wrapped lines join, odd lines stay as written', () => {
  const text = `RULES owner.user v1
FORMAT
  SECTION <topic> groups rules.
PRECEDENCE: these rules override the product's common rules.

SECTION voice
  RULE voice.language
    DO: write Japanese in everything the Owner reads,
        whatever started the turn.
    NEVER: guess.
    WHY: the Owner reads Japanese.
  a line someone typed by hand
SECTION models
  RULE models.default
    DEFAULT (codex): latest Sol at effort high.`
  const parsed = parseRules(text)
  assert.deepEqual(parsed.head, ['RULES owner.user v1'])
  assert.deepEqual(parsed.format, ['SECTION <topic> groups rules.'])
  assert.equal(parsed.notes[0].label, '優先')
  assert.equal(ruleCount(parsed), 2)
  const [voice, models] = parsed.sections
  assert.equal(voice.title, 'voice')
  assert.deepEqual(voice.rules[0].clauses.map(item => [item.label, item.text]), [
    ['する', 'write Japanese in everything the Owner reads, whatever started the turn.'],
    ['しない', 'guess.'], ['理由', 'the Owner reads Japanese.'], ['', 'a line someone typed by hand'],
  ])
  assert.deepEqual(models.rules[0].clauses[0], { key: 'DEFAULT', label: '既定', note: 'codex', text: 'latest Sol at effort high.' })
  assert.equal(ruleCount(parseRules('- 自由に書いた決まり')), 0)
  assert.deepEqual(parseRules('- 自由に書いた決まり').loose, ['- 自由に書いた決まり'])
})

test('AI auth stage follows the server stage only; the worst row decides the settings line', () => {
  assert.equal(authStage({ auth: null, loaded: false, busy: true }), 'checking')
  assert.equal(authStage({ auth: null, loaded: true, busy: false }), 'unknown')
  assert.equal(authStage({ auth: { status: 'authenticated' }, loaded: true }), 'done')
  assert.equal(authStage({ auth: { status: 'authenticated' }, loaded: true, signedOutAt: '2026-11-11T11:00:00Z' }), 'needsLogin')
  assert.equal(authStage({ auth: { status: 'waiting', auth_ui: { stage: 'paste_code' } }, loaded: true }), 'waitingCode')
  assert.equal(authStage({ auth: { status: 'waiting', auth_ui: { stage: 'device_code' } }, loaded: true }), 'waitingSite')
  assert.equal(authStage({ auth: { status: 'waiting', auth_ui: { stage: 'waiting' } }, loaded: true }), 'confirming')
  assert.deepEqual(authSummary([{ name: 'Claude', slot: '1st', stage: 'done' }, { name: 'Claude', slot: '2nd', stage: 'needsLogin' }]),
    { line: 'Claude 2つ目のログインが必要', badge: 'ログインが必要', tone: 'attention' })
  assert.equal(authSummary([{ name: 'Codex', slot: null, stage: 'done' }]).line, 'すべて認証済み')
  assert.equal(authSummary([{ name: 'Codex', slot: null, stage: 'checking' }]).badge, '')
})

test('settings rows: a feature with an empty required field is not "in use"; old bodies without required make no claim', () => {
  const fields = [{ key: 'relayUrl', required: true, configured: false }]
  assert.equal(featureState({ status: 'enabled', fields }).badge, '設定が足りません')
  assert.equal(featureState({ status: 'enabled', fields: [{ key: 'relayUrl', configured: false }] }).badge, '使っています')
  assert.equal(featureState({ status: 'enabled', fields, error: { code: 'X', message: 'x' } }).badge, 'エラー')
  assert.equal(featureState({ status: 'unconfigured', fields: [] }).badge, '未設定')
  assert.deepEqual(terminalsItem([]), { line: 'Mac・Windows・Linux', badge: '', tone: '' })
  assert.equal(terminalsItem([{ lastCheck: { reachable: false } }, { lastCheck: null }]).line, '2台・1台つながりません')
  assert.equal(terminalsItem(null).tone, 'attention')
  assert.deepEqual(updateItem({ title: '1つ更新できます', tone: 'accent' }), { line: '1つ更新できます', badge: '更新あり', tone: 'accent' })
  assert.equal(aiControlSummary({ state: 'stopped', unconfirmedBotIds: [] }).badge, '停止中')
  assert.match(aiControlSummary({ state: 'unconfirmed', unconfirmedBotIds: ['a', 'b'] }).line, /2人/)
  assert.equal(effortLabel('high'), '高い'); assert.equal(effortLabel('turbo'), 'turbo')
  const states = new Map([['ai', { tone: 'attention' }], ['updates', { tone: 'accent' }], ['profile', { tone: '' }]])
  assert.deepEqual(attentionItems(states).map(([id]) => id), ['ai', 'updates'])
})
