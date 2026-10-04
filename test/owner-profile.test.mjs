import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OwnerProfile, ownerInstructions } from '../src/owner-profile.mjs'

test('オーナープロフィールを既定値で初期化しJSON正本へ保存する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-owner-default-'))
  const service = new OwnerProfile({ root })

  assert.deepEqual(await service.initialize(), {
    schema: 'bellteam.owner-profile.v1',
    name: 'オーナー',
    profile: '',
    avatar: '',
    xUrl: '',
    githubUrl: '',
    links: [],
  })
  assert.deepEqual(JSON.parse(await readFile(join(root, 'owner/profile.json'), 'utf8')), await service.get())
})

test('オーナープロフィールを検証して更新し、別インスタンスから再読込できる', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-owner-update-'))
  const service = new OwnerProfile({ root })
  await service.initialize()

  const saved = await service.update({
    name: ' 利用者 ',
    profile: 'BellTeamを作っている。',
    avatar: 'data:image/png;base64,iVBORw0KGgo=',
    xUrl: 'https://x.com/example-user',
    githubUrl: 'https://github.com/example-user',
    links: [{ label: 'ブログ', url: 'https://example.com/example-user' }],
  })

  assert.equal(saved.name, '利用者')
  assert.deepEqual(await new OwnerProfile({ root }).get(), saved)
})

test('SNS URLとその他URLは公開Webプロフィールだけを受け付ける', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-owner-url-'))
  const service = new OwnerProfile({ root })
  await service.initialize()

  await assert.rejects(service.update({ xUrl: 'https://example.com/example-user' }), /OWNER_X_URL_INVALID/u)
  await assert.rejects(service.update({ githubUrl: 'https://gitlab.com/example-user' }), /OWNER_GITHUB_URL_INVALID/u)
  await assert.rejects(service.update({ links: [{ label: 'ローカル', url: 'file:///tmp/profile' }] }), /OWNER_LINK_URL_INVALID/u)
})

test('共通起動指示へ生成するオーナー情報は情報源を含み、アバター本体を含めない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-owner-context-'))
  const service = new OwnerProfile({ root })
  await service.initialize()
  await service.update({
    name: '利用者', profile: 'プロダクトオーナー', avatar: 'data:image/png;base64,iVBORw0KGgo=',
    xUrl: 'https://x.com/example-user', githubUrl: 'https://github.com/example-user',
    links: [{ label: '仕様書', url: 'https://example.com/spec' }],
  })

  const context = ownerInstructions(await service.get())
  assert.match(context, /^# オーナー情報/u)
  assert.match(context, /名前: 「利用者」/u)
  assert.match(context, /GitHub: https:\/\/github\.com\/example-user/u)
  assert.match(context, /「仕様書」: https:\/\/example\.com\/spec/u)
  assert.doesNotMatch(context, /iVBORw0KGgo/u)
})
