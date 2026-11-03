import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { assertMembersStateCompatibility } from './members/state-compatibility.mjs'

const controlRoot = '/run/bellteam-maintenance'
const digest = /^[a-f0-9]{64}$/
const source = /^[a-f0-9]{40}$/
const failure = code => Object.assign(new Error(code), { code })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const json = bytes => { try { return JSON.parse(bytes) } catch { throw failure('GATEWAY_RELEASE_INVALID') } }
const version = value => {
  if (typeof value !== 'string' || !digest.test(value)) throw failure('GATEWAY_VERSION_INVALID')
  return value
}

// This checks content compatibility only; it never authenticates an unsigned manifest.
export function validateGatewayReleaseManifest(manifest) {
  return validateManifest(manifest, 'web-gateway')
}

function validateManifest(manifest, component) {
  const notifications = component === 'notifications', members = component === 'members'
  if (!exactKeys(manifest, 'schema,component,sourceCommit,entry,runtime,files')
    || manifest.schema !== `bellteam.${component}.artifact.v1` || manifest.component !== component
    || !source.test(manifest.sourceCommit) || manifest.entry !== (members ? 'payload/src/members-entry.mjs' : notifications ? 'payload/src/notifications-entry.mjs' : 'payload/src/http-gateway-entry.mjs')
    || !exactKeys(manifest.runtime, members ? 'os,arch,nodeMajor,parentProtocol,stateCompatibility' : notifications ? 'os,arch,nodeMajor,parentProtocol,stateSchema' : 'os,arch,nodeMajor,parentProtocol')
    || manifest.runtime.os !== process.platform
    || manifest.runtime.arch !== ({ x64: 'amd64', arm64: 'arm64' })[process.arch]
    || manifest.runtime.nodeMajor !== 26 || Number(process.versions.node.split('.')[0]) !== 26
    || notifications && manifest.runtime.stateSchema !== 2
    || manifest.runtime.parentProtocol !== (notifications ? 2 : 1) || !Array.isArray(manifest.files) || !manifest.files.length)
    throw failure('GATEWAY_RELEASE_INCOMPATIBLE')
  if (members) assertMembersStateCompatibility(manifest.runtime.stateCompatibility)
  const names = new Set()
  for (const file of manifest.files) {
    if (!exactKeys(file, 'path,bytes,sha256') || typeof file.path !== 'string'
      || !file.path.startsWith('payload/') || /[\\\u0000-\u001f\u007f]/u.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.sha256 !== 'string' || !digest.test(file.sha256)) throw failure('GATEWAY_RELEASE_INVENTORY_INVALID')
    names.add(file.path)
  }
  for (const required of [manifest.entry, 'payload/package.json', 'payload/package-lock.json', ...(members ? ['payload/config/common-agents.md', 'payload/src/members/state-compatibility.mjs'] : notifications ? [] : ['payload/web/assets.mjs'])])
    if (!names.has(required)) throw failure('GATEWAY_RELEASE_INVENTORY_INVALID')
  return manifest
}

async function rootDirectory(path, immutable = false) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o7022
    || immutable && (info.mode & 0o7777) !== 0o555) throw failure('GATEWAY_RELEASE_UNTRUSTED_PATH')
}
async function rootFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o7777) !== 0o444)
      throw failure('GATEWAY_RELEASE_UNTRUSTED_FILE')
    return await file.readFile()
  } finally { await file.close() }
}

// Only root's authenticated installer publishes installation.json; this reader writes nothing.
export function prepareGatewayRelease(versionId, options) { return prepareRelease('web-gateway', versionId, options) }
export function prepareMembersRelease(versionId, options) { return prepareRelease('members', versionId, options) }
export function validateMembersReleaseManifest(manifest) { return validateManifest(manifest, 'members') }
export function prepareNotificationsRelease(versionId, options) { return prepareRelease('notifications', versionId, options) }
export function validateNotificationsReleaseManifest(manifest) { return validateManifest(manifest, 'notifications') }

async function prepareRelease(component, versionId, { signal } = {}) {
  version(versionId)
  signal?.throwIfAborted()
  let directory = controlRoot
  await rootDirectory(directory)
  for (const part of [component, 'releases', versionId]) {
    directory = join(directory, part)
    await rootDirectory(directory, part === versionId)
  }
  const installation = json(await rootFile(join(directory, 'installation.json')))
  const bytes = await rootFile(join(directory, 'manifest.json'))
  if (!exactKeys(installation, 'schema,component,archiveSha256,manifestSha256,sourceCommit,verification')
    || installation.schema !== `bellteam.${component}.installation.v1`
    || installation.component !== component || installation.archiveSha256 !== versionId
    || installation.manifestSha256 !== sha256(bytes)
    || !exactKeys(installation.verification, 'method,repositoryId')
    || installation.verification.method !== 'github-oidc-attestation'
    || installation.verification.repositoryId !== '1404510084') throw failure('GATEWAY_RELEASE_INSTALLATION_INVALID')
  const manifest = validateManifest(json(bytes), component)
  if (installation.sourceCommit !== manifest.sourceCommit) throw failure('GATEWAY_RELEASE_INSTALLATION_INVALID')
  const inventory = new Map(manifest.files.map(file => [file.path, file]))
  const found = new Set()
  async function inspect(relative) {
    signal?.throwIfAborted()
    const path = join(directory, relative)
    await rootDirectory(path, true)
    for (const name of await readdir(path, { withFileTypes: true })) {
      const child = relative + '/' + name.name
      if (name.isDirectory()) await inspect(child)
      else {
        const expected = inventory.get(child)
        if (!expected || !name.isFile()) throw failure('GATEWAY_RELEASE_INVENTORY_INVALID')
        const content = await rootFile(join(directory, child))
        if (content.length !== expected.bytes || sha256(content) !== expected.sha256)
          throw failure('GATEWAY_RELEASE_CONTENT_CHANGED')
        found.add(child)
      }
    }
  }
  await inspect('payload')
  if (found.size !== inventory.size) throw failure('GATEWAY_RELEASE_INVENTORY_INVALID')
  signal?.throwIfAborted()
  return { versionId, appRoot: join(directory, 'payload'), protocolVersion: component === 'notifications' ? 2 : 1, sourceCommit: manifest.sourceCommit, platform: { os: manifest.runtime.os, arch: manifest.runtime.arch }, ...(component === 'members' ? { sourceCommit: manifest.sourceCommit, platform: { os: manifest.runtime.os, arch: manifest.runtime.arch }, stateCompatibility: manifest.runtime.stateCompatibility } : component === 'notifications' ? { sourceCommit: manifest.sourceCommit, platform: { os: manifest.runtime.os, arch: manifest.runtime.arch }, stateSchema: 2 } : {}) }
}
