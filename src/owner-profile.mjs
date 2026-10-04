import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exists, writeAtomic } from './bot-registry.mjs'

const FIELDS = new Set(['name', 'profile', 'avatar', 'xUrl', 'githubUrl', 'links'])
const DEFAULT_PROFILE = Object.freeze({
  schema: 'bellteam.owner-profile.v1',
  name: 'オーナー',
  profile: '',
  avatar: '',
  xUrl: '',
  githubUrl: '',
  links: [],
})

export class OwnerProfile {
  constructor({ root }) {
    this.directory = join(root, 'owner')
    this.path = join(this.directory, 'profile.json')
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true })
    if (!await exists(this.path)) await writeAtomic(this.path, DEFAULT_PROFILE)
    return this.get()
  }

  async get() {
    if (!await exists(this.path)) return this.initialize()
    const value = JSON.parse(await readFile(this.path, 'utf8'))
    if (value?.schema !== 'bellteam.owner-profile.v1') throw new Error('OWNER_PROFILE_FILE_INVALID')
    return normalize(value)
  }

  async update(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('OWNER_PROFILE_UPDATE_INVALID')
    for (const key of Object.keys(changes)) {
      if (!FIELDS.has(key)) throw new Error(`OWNER_PROFILE_FIELD_INVALID: ${key}`)
    }
    const profile = normalize({ ...await this.get(), ...changes })
    await writeAtomic(this.path, profile)
    return profile
  }
}

export function ownerInstructions(owner) {
  const links = owner.links.length
    ? owner.links.map(link => `- 「${link.label}」: ${link.url}`).join('\n')
    : '- 未設定'
  return [
    '# オーナー情報',
    '',
    `名前: 「${owner.name}」`,
    `プロフィール: 「${owner.profile || '未設定'}」`,
    `X: ${owner.xUrl || '未設定'}`,
    `GitHub: ${owner.githubUrl || '未設定'}`,
    'その他の情報源:',
    links,
    '',
    'この情報はBellTeamの設定から生成された現在のオーナー情報である。',
  ].join('\n')
}

function normalize(value) {
  const name = stringField(value.name, 'OWNER_NAME_INVALID', 100).trim()
  if (!name) throw new Error('OWNER_NAME_INVALID')
  const profile = stringField(value.profile ?? '', 'OWNER_PROFILE_INVALID', 8_000)
  const avatar = stringField(value.avatar ?? '', 'OWNER_AVATAR_INVALID', 3_000_000)
  if (avatar && !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/iu.test(avatar))
    throw new Error('OWNER_AVATAR_INVALID')
  const xUrl = profileUrl(value.xUrl ?? '', new Set(['x.com', 'twitter.com']), 'OWNER_X_URL_INVALID')
  const githubUrl = profileUrl(value.githubUrl ?? '', new Set(['github.com']), 'OWNER_GITHUB_URL_INVALID')
  if (!Array.isArray(value.links) || value.links.length > 20) throw new Error('OWNER_LINKS_INVALID')
  const links = value.links.map(link => normalizeLink(link))
  return { schema: 'bellteam.owner-profile.v1', name, profile, avatar, xUrl, githubUrl, links }
}

function normalizeLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['label', 'url'].includes(key))) throw new Error('OWNER_LINK_INVALID')
  const label = stringField(value.label, 'OWNER_LINK_LABEL_INVALID', 100).trim()
  if (!label) throw new Error('OWNER_LINK_LABEL_INVALID')
  return { label, url: webUrl(value.url, 'OWNER_LINK_URL_INVALID') }
}

function profileUrl(value, hosts, error) {
  if (value === '') return ''
  const normalized = webUrl(value, error)
  const url = new URL(normalized)
  const host = url.hostname.toLowerCase().replace(/^www\./u, '')
  if (!hosts.has(host) || url.pathname.split('/').filter(Boolean).length === 0) throw new Error(error)
  return normalized
}

function webUrl(value, error) {
  const content = stringField(value, error, 2_048).trim()
  try {
    const url = new URL(content)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(error)
    return url.toString()
  } catch {
    throw new Error(error)
  }
}

function stringField(value, error, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(error)
  return value
}
