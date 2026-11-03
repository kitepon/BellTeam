import { isDeepStrictEqual } from 'node:util'
import { MEMORY_SEARCH_INDEX_VERSION } from '../memory-search.mjs'

// Existing storage formats only; these fingerprints do not authorize migration or inspect live DBs.
export const MEMORY_STATE_COMPATIBILITY = Object.freeze({
  memoryUserVersion: 0,
  knowledgeUserVersion: 0,
  memoryRequiredSchemaSha256: 'aac945fb2c594987168317fd857233fb41274072ad6b0d032563459fb4b3733f',
  knowledgeRequiredSchemaSha256: '7197ac37c820132a47c4404887df9880058e504db9d42a255b726ebed5d8eccd',
  knowledgeEncoding: 'utf8',
  knowledgeFrontmatterFields: 'id,title,source,created_at,confidence,tags',
  searchIndexVersion: MEMORY_SEARCH_INDEX_VERSION,
})

export function assertMemoryStateCompatibility(value) {
  if (!isDeepStrictEqual(value, MEMORY_STATE_COMPATIBILITY))
    throw Object.assign(new Error('MEMORY_STATE_INCOMPATIBLE'), { code: 'MEMORY_STATE_INCOMPATIBLE' })
}
