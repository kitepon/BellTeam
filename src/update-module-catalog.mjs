import { isDeepStrictEqual } from 'node:util'
import { DIAGNOSTICS_STATE_COMPATIBILITY } from './diagnostics-protocol.mjs'
import { MEMORY_STATE_COMPATIBILITY } from './memory/state-compatibility.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from './members/state-compatibility.mjs'

const ids = ['web-gateway', 'notifications', 'members', 'memory', 'diagnostics']
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const requireValue = ok => { if (!ok) throw Object.assign(new Error('UPDATE_MODULE_CATALOG_INVALID'), { code: 'UPDATE_MODULE_CATALOG_INVALID' }) }
const errorCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'UPDATE_MODULE_CATALOG_UNAVAILABLE'

function selection(value, id) {
  requireValue(exact(value, 'schema,catalogSha256,publishedAt,expiresAt,release,publication')
    && value.schema === 'bellteam.update-catalog.selection.v1' && hex(value.catalogSha256, 64) && date(value.publishedAt) && date(value.expiresAt))
  const check = value.publication
  requireValue(exact(check, 'status,checkedAt,error') && ['verified', 'failed', 'unconfirmed'].includes(check.status)
    && (check.checkedAt === null || date(check.checkedAt)) && (check.error === null || typeof check.error === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(check.error)))
  const release = value.release
  if (release === null) return value
  requireValue(exact(release, 'componentId,sourceCommit,versionId,platform,artifact,compatibility,changes')
    && release.componentId === id && hex(release.sourceCommit, 40) && hex(release.versionId, 64)
    && exact(release.platform, 'os,arch') && release.platform.os === 'linux' && ['amd64', 'arm64'].includes(release.platform.arch)
    && Array.isArray(release.changes) && release.changes.length <= 16 && release.changes.every(text => typeof text === 'string' && text.length > 0 && text.length <= 1000 && !/[\x00-\x1f\x7f]/.test(text)))
  const artifact = release.artifact
  requireValue(exact(artifact, 'kind,archive,bundle,signerCommit') && artifact.kind === 'archive' && hex(artifact.signerCommit, 40))
  for (const [key, limit] of [['archive', 512 * 1024 ** 2], ['bundle', 16 * 1024 ** 2]]) {
    const item = artifact[key]
    requireValue(exact(item, 'url,sha256,bytes') && hex(item.sha256, 64) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= limit)
  }
  const url = `https://github.com/kitepon/BellTeam/releases/download/updates-\\d{8}T\\d{6}Z/${id}-${release.sourceCommit}-linux-${release.platform.arch}\\.tar\\.gz`
  requireValue(typeof artifact.archive.url === 'string' && new RegExp(`^${url.replace('github.com', 'github\\.com')}$`).test(artifact.archive.url)
    && artifact.archive.sha256 === release.versionId && artifact.bundle.url === artifact.archive.url + '.sigstore.json')
  const compatibility = release.compatibility
  requireValue(exact(compatibility, ['members', 'memory', 'diagnostics'].includes(id) ? 'nodeMajor,parentProtocol,stateSchema,containerUpdate,stateCompatibility' : 'nodeMajor,parentProtocol,stateSchema,containerUpdate'))
  requireValue(['nodeMajor', 'parentProtocol', 'stateSchema', 'containerUpdate'].every(key => compatibility[key] === null || Number.isInteger(compatibility[key]) && compatibility[key] > 0 && compatibility[key] <= 65535))
  if (['members', 'memory', 'diagnostics'].includes(id)) requireValue(compatibility.nodeMajor === 26 && compatibility.parentProtocol === 1 && compatibility.stateSchema === null
    && compatibility.containerUpdate === null && isDeepStrictEqual(compatibility.stateCompatibility, id === 'members' ? MEMBERS_STATE_COMPATIBILITY : id === 'memory' ? MEMORY_STATE_COMPATIBILITY : DIAGNOSTICS_STATE_COMPATIBILITY))
  return value
}

export function moduleReleaseCompatible(id, release) {
  const value = release?.compatibility
  return value?.nodeMajor === 26 && value.containerUpdate === null
    && value.parentProtocol === (id === 'notifications' ? 2 : 1)
    && (['members', 'memory', 'diagnostics'].includes(id) ? isDeepStrictEqual(value.stateCompatibility, id === 'members' ? MEMBERS_STATE_COMPATIBILITY : id === 'memory' ? MEMORY_STATE_COMPATIBILITY : DIAGNOSTICS_STATE_COMPATIBILITY) && value.stateSchema === null
      : value.stateSchema === (id === 'notifications' ? 2 : 1))
}

// Trust and freshness belong to the Host catalog reader; this maps its closed selection only.
export function createModuleUpdateCatalog({ client }) {
  const select = async id => { requireValue(ids.includes(id)); return selection(await client.catalog(id), id) }
  return {
    select,
    async snapshot(inventory) {
      await Promise.all(ids.map(async id => {
        const component = inventory.components.find(value => value.id === id)
        if (!component) return
        try {
          const selected = await select(id)
          component.publication = { catalog: { sha256: selected.catalogSha256, publishedAt: selected.publishedAt, expiresAt: selected.expiresAt }, check: selected.publication }
          if (!selected.release) return
          const release = selected.release, compatibility = release.compatibility
          component.published = { version: release.versionId, sourceCommit: release.sourceCommit, digest: 'sha256:' + release.versionId, origin: 'published' }
          component.changes = release.changes
          const compatible = moduleReleaseCompatible(id, release)
          const same = component.current?.digest === component.published.digest
            || component.current?.origin === 'builtin' && component.current.sourceCommit === release.sourceCommit
          component.comparison = { state: !compatible ? 'incompatible' : same ? 'up_to_date' : component.current ? 'update_available' : 'unknown',
            reason: !compatible ? 'UPDATE_INCOMPATIBLE' : selected.publication.status === 'failed' ? selected.publication.error : null }
          component.capability = { supported: false, reason: !compatible ? 'UPDATE_INCOMPATIBLE' : 'UPDATE_EXECUTOR_UNAVAILABLE' }
        } catch (error) {
          component.capability = { supported: false, reason: errorCode(error) }
          component.comparison = { state: 'unavailable', reason: errorCode(error) }
        }
      }))
      return inventory
    },
  }
}
