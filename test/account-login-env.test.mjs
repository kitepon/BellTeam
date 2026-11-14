import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountLoginEnvironment } from '../src/aiterm-client.mjs'

// harness-accounts.md: a 2nd seat differs only in its login, CLAUDE_CODE_OAUTH_TOKEN read from the slot's oauth-token.
test('the 2nd login is read from the slot token file; missing or malformed fails, never falls back to the 1st', async t => {
  const home = await mkdtemp(join(tmpdir(), 'account-login-')); t.after(() => rm(home, { recursive: true, force: true }))
  const environment = { BELLTEAM_HOME: home }
  await assert.rejects(accountLoginEnvironment('2nd', environment), { code: 'ACCOUNT_LOGIN_UNAVAILABLE' })
  await mkdir(join(home, '.bellteam-accounts/claude/2nd'), { recursive: true })
  await writeFile(join(home, '.bellteam-accounts/claude/2nd/oauth-token'), 'not-a-token')
  await assert.rejects(accountLoginEnvironment('2nd', environment), { code: 'ACCOUNT_LOGIN_UNAVAILABLE' })
  const token = `sk-ant-oat01-${'a'.repeat(40)}`
  await writeFile(join(home, '.bellteam-accounts/claude/2nd/oauth-token'), `${token}\n`)
  assert.deepEqual(await accountLoginEnvironment('2nd', environment), { CLAUDE_CODE_OAUTH_TOKEN: token })
  // One login per slot: a legacy 1st without its file adds nothing (the root's/host's own login); with it, its token; malformed fails.
  assert.deepEqual(await accountLoginEnvironment('1st', environment), {})
  await mkdir(join(home, '.bellteam-accounts/claude/1st'), { recursive: true })
  await writeFile(join(home, '.bellteam-accounts/claude/1st/oauth-token'), 'not-a-token')
  await assert.rejects(accountLoginEnvironment('1st', environment), { code: 'ACCOUNT_LOGIN_UNAVAILABLE' })
  const first = `sk-ant-oat01-${'b'.repeat(40)}`
  await writeFile(join(home, '.bellteam-accounts/claude/1st/oauth-token'), first)
  assert.deepEqual(await accountLoginEnvironment('1st', environment), { CLAUDE_CODE_OAUTH_TOKEN: first })
  await assert.rejects(accountLoginEnvironment('3rd', environment), { code: 'ACCOUNT_LOGIN_UNAVAILABLE' })
})

// a77: a slot's full CLI login (refreshable store) wins over its older setup-token in the container; a terminal keeps the token.
test('a container seat on the slot store gets the store dir and an emptied token; terminal and stale store keep the token', async t => {
  const home = await mkdtemp(join(tmpdir(), 'account-store-')); t.after(() => rm(home, { recursive: true, force: true }))
  const environment = { BELLTEAM_HOME: home }, second = join(home, '.bellteam-accounts/claude/2nd')
  const token = `sk-ant-oat01-${'c'.repeat(40)}`
  await mkdir(second, { recursive: true })
  await writeFile(join(second, 'oauth-token'), token)
  // A dead store (no refresh token, like the expired 1st root of 2026-11-11) is not a login.
  await writeFile(join(second, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: null, expiresAt: 0 } }))
  assert.deepEqual(await accountLoginEnvironment('2nd', environment), { CLAUDE_CODE_OAUTH_TOKEN: token })
  await writeFile(join(second, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } }))
  assert.deepEqual(await accountLoginEnvironment('2nd', environment), { CLAUDE_SECURESTORAGE_CONFIG_DIR: second, CLAUDE_CODE_OAUTH_TOKEN: '' })
  assert.deepEqual(await accountLoginEnvironment('2nd', environment, { terminal: true }), { CLAUDE_CODE_OAUTH_TOKEN: token })
  // A setup-token written after the store is the newer login.
  await utimes(join(second, '.credentials.json'), new Date(1_000_000), new Date(1_000_000))
  assert.deepEqual(await accountLoginEnvironment('2nd', environment), { CLAUDE_CODE_OAUTH_TOKEN: token })
  // The 1st store is the shared root itself; no token file needed.
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }))
  assert.deepEqual(await accountLoginEnvironment('1st', environment), { CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_OAUTH_TOKEN: '' })
})
