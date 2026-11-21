import assert from 'node:assert/strict'
import test from 'node:test'
import { plainQuoteText } from '../src/reply-reference.mjs'
import { webMessage } from '../src/http-messages.mjs'

const cases = [
  ['**太字**と*斜体*と__下線__と_斜体2_と~~消す~~', '太字と斜体と下線と斜体2と消す'],
  ['`code` と ``double``', 'code と double'],
  ['```js\nconst a = 1\n```\n続き', 'const a = 1\n続き'],
  ['# 見出し\n## 小見出し', '見出し\n小見出し'],
  ['> 引用\n>> 二重', '引用\n二重'],
  ['- 項目1\n* 項目2\n+ 項目3\n1. 番号\n2) 番号2', '項目1\n項目2\n項目3\n番号\n番号2'],
  ['[リンク](https://example.com/a_b) と ![図](x.png)', 'リンク と 図'],
  // not marks: snake_case, a lone asterisk, a product 2*3*4, plain text
  ['file_name_here と 2*3*4 と a * b', 'file_name_here と 2*3*4 と a * b'],
  ['ふつうの文です。', 'ふつうの文です。'],
  // a selection that cuts a span (production Z145 cases) and lookalikes that are not marks
  ['ログインね。\n\n**GoogleとAppleのログイ', 'ログインね。\n\nGoogleとAppleのログイ'],
  ['説明が出るの。\n**Android', '説明が出るの。\nAndroid'],
  ['途中から太字になる**ところ', '途中から太字になるところ'],
  ['太字の終わりまで**', '太字の終わりまで'],
  ['~~消す途中', '消す途中'],
  ['\n*斜体の途中', '\n斜体の途中'],
  ['2**3 と a__b と x_y_z', '2**3 と a__b と x_y_z'],
]
for (const [input, expected] of cases) test(`plain quote: ${JSON.stringify(input)}`, () => {
  assert.equal(plainQuoteText(input), expected)
  assert.equal(plainQuoteText(plainQuoteText(input)), expected)
})

test('every served message gets a plain reply_to.text; the saved row, range and other fields stay', () => {
  const saved = { id: 'm1', message: '**返信**', reply_to: { id: 'm0', available: true, text: '**元**の`文`', range: { start: 0, end: 5 }, part: true } }
  const served = webMessage(saved)
  assert.equal(served.reply_to.text, '元の文')
  assert.deepEqual(served.reply_to.range, { start: 0, end: 5 })
  assert.equal(served.message, '**返信**')
  assert.equal(saved.reply_to.text, '**元**の`文`')
  assert.equal(webMessage({ id: 'm2', message: 'x' }).reply_to, undefined)
  assert.deepEqual(webMessage({ id: 'm3', reply_to: { id: 'gone', available: false } }).reply_to, { id: 'gone', available: false })
})
