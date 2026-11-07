// Z-b2 P6: capture the selected runtime generation once per launch.
// Canonical diagram: docs/architecture/modules/runtime/runtime-updates.md. Writer: scripts/runtime_update.py (P5).
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RUNTIME_ROOT = '/srv/bellteam/shared/tools/bellteam-runtime'
export const BUILTIN_PREFIX = '/usr/local'
export const RUNTIME_COMPONENTS = Object.freeze({
  'runtime-aiterm-mcp': { bins: ['aiterm-mcp'], dist: 'lib/node_modules/aiterm-mcp/dist' },
  'runtime-codex': { bins: ['codex'], dist: null },
  'runtime-claude-code': { bins: ['claude'], dist: null },
  'runtime-throughline': { bins: ['throughline'], dist: null },
})
const SHA = /^[a-f0-9]{64}$/u

const unavailable = () => Object.assign(new Error('RUNTIME_BINDING_UNAVAILABLE'), { code: 'RUNTIME_BINDING_UNAVAILABLE' })
// Same bytes as Python json.dumps(sort_keys=True, separators=(',', ':')) for the ASCII values P5 writes.
const canonical = value => value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join()

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function paths(prefix, id) {
  const { bins, dist } = RUNTIME_COMPONENTS[id]
  return {
    prefix,
    bin: Object.fromEntries(bins.map(name => [name, join(prefix, 'bin', name)])),
    ...(dist ? { dist: join(prefix, dist) } : {}),
  }
}

// -> {generation: sha|null, components: {<id>: {origin:'release'|'builtin', prefix, bin:{name:abs}, dist?, archiveSha256?}}}
// Callers keep the returned object for the launch's whole lifetime; a later selection never changes it.
export async function captureRuntime({ root = RUNTIME_ROOT, builtin = BUILTIN_PREFIX } = {}) {
  let vector = {}, generation = null, pointer
  try { pointer = await readJson(join(root, 'current.json')) } catch (error) {
    // No selection was ever established (or no runtime volume on this installation): the image's builtin prefix.
    if (error?.code !== 'ENOENT') throw unavailable()
  }
  if (pointer !== undefined) try {
    if (!exact(pointer, ['schema', 'generation']) || pointer.schema !== 'bellteam.runtime-selection.v1' || !SHA.test(pointer.generation)) throw unavailable()
    const record = await readJson(join(root, 'generations', `${pointer.generation}.json`))
    if (!exact(record, ['schema', 'components', 'jobId']) || record.schema !== 'bellteam.runtime-generation.v1'
      || !record.components || typeof record.components !== 'object'
      || !Object.keys(record.components).every(id => id in RUNTIME_COMPONENTS && SHA.test(record.components[id]?.archiveSha256))
      || createHash('sha256').update(canonical(record.components)).digest('hex') !== pointer.generation) throw unavailable()
    vector = record.components; generation = pointer.generation
  } catch {
    // An established selection that cannot be read is never replaced by the older builtin code.
    throw unavailable()
  }
  const components = Object.fromEntries(Object.keys(RUNTIME_COMPONENTS).map(id => [id, vector[id]
    ? { origin: 'release', archiveSha256: vector[id].archiveSha256, ...paths(join(root, 'packages', id, vector[id].archiveSha256, 'prefix'), id) }
    : { origin: 'builtin', ...paths(builtin, id) }]))
  return Object.freeze({ generation, components: Object.freeze(components) })
}
