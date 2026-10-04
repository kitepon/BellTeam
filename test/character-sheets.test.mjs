import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CharacterSheets } from '../src/character-sheets.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-sheets-'))
  const sheets = new CharacterSheets({ projectPath: id => join(root, 'bots', id) })
  return { root, sheets }
}

test('直下の画像だけを名前順に一覧し、下書きフォルダと画像以外は見せない', async () => {
  const { root, sheets } = await fixture()
  const directory = join(root, 'bots/bot-a/assets/character-sheet')
  await mkdir(join(directory, 'drafts'), { recursive: true })
  await writeFile(join(directory, 'bell-sheet-v2.jpg'), 'v2')
  await writeFile(join(directory, 'bell-sheet.jpg'), 'main')
  await writeFile(join(directory, 'notes.md'), '# memo')
  await writeFile(join(directory, 'drafts/try.png'), 'draft')
  const listed = await sheets.list('bot-a')
  assert.deepEqual(listed.map(sheet => sheet.file), ['bell-sheet-v2.jpg', 'bell-sheet.jpg'])
  assert.equal(listed[1].size, 4)
  assert.match(listed[1].updatedAt, /^\d{4}-\d{2}-\d{2}T/u)
})

test('フォルダが無いBotは空一覧を返す', async () => {
  const { sheets } = await fixture()
  assert.deepEqual(await sheets.list('bot-none'), [])
})

test('画像本体を拡張子のMIMEで開き、不正名・不在・symlinkは拒む', async () => {
  const { root, sheets } = await fixture()
  const directory = join(root, 'bots/bot-a/assets/character-sheet')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'sheet.PNG'), 'png!')
  await symlink('/etc/hostname', join(directory, 'link.png'))
  const opened = await sheets.open('bot-a', 'sheet.PNG')
  assert.equal(opened.mime, 'image/png')
  assert.equal(opened.size, 4)
  let body = ''
  for await (const chunk of opened.stream) body += chunk
  assert.equal(body, 'png!')
  await assert.rejects(sheets.open('bot-a', '../bot.json'), /CHARACTER_SHEET_INVALID/u)
  await assert.rejects(sheets.open('bot-a', 'missing.jpg'), /CHARACTER_SHEET_NOT_FOUND/u)
  await assert.rejects(sheets.open('bot-a', 'link.png'), error => error.code === 'ELOOP')
})
