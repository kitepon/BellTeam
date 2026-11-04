import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { updateExamples, updateModuleExamples } from '../src/update-center-contract.mjs'

const path = new URL('../ios/BellBot/BellBotTests/Fixtures/update-examples.json', import.meta.url)
const expected = JSON.stringify({ ...updateExamples, ...updateModuleExamples }, null, 2) + '\n'
// UPDATE_APPLE_FIXTURES=1 で、サーバーの有限例からAppleの試験用fixtureを作り直す。
if (process.env.UPDATE_APPLE_FIXTURES === '1') writeFileSync(path, expected)

test('Appleの試験用fixtureがサーバーの有限例13種と同じ内容である', () => {
  assert.equal(Object.keys(JSON.parse(expected)).length, 13)
  assert.equal(readFileSync(path, 'utf8'), expected)
})
