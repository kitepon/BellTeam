import { readFile } from 'node:fs/promises'
import { isAbsolute, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { text as streamText } from 'node:stream/consumers'

const invalid = () => { throw new Error('SERVER_STATE_WRITER_METADATA_INVALID') }
const path = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/u.test(value)) invalid()
  return posix.resolve(value)
}
const overlaps = (a, b) => a === b || a.startsWith(b === '/' ? '/' : b + '/') || b.startsWith(a === '/' ? '/' : a + '/')

// Only retain mount identities. Compose environment/credentials never leave
// this parser or become part of the maintenance evidence.
export function stateWriterPlan(config) {
  const service = config?.services?.bellteam
  if (!Array.isArray(service?.volumes)) invalid()
  const roots = ['/srv/bellteam', '/home/bell'].map(target => {
    const matches = service.volumes.filter(volume => volume.target === target)
    if (matches.length !== 1 || matches[0].type !== 'bind' || matches[0].read_only === true) invalid()
    return path(matches[0].source)
  })
  const cursor = service.volumes.filter(volume => volume.target === '/home/bell/.local')
  if (cursor.length !== 1 || cursor[0].type !== 'volume') invalid()
  const volume = config.volumes?.[cursor[0].source]?.name
  if (typeof volume !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(volume)) invalid()
  return { roots, volume }
}

function validate(plan, containers) {
  if (!Array.isArray(plan?.roots) || plan.roots.length !== 2 || typeof plan.volume !== 'string'
    || !Array.isArray(containers)) invalid()
  plan.roots.forEach(path)
  for (const container of containers) {
    if (typeof container.id !== 'string' || !container.id || typeof container.running !== 'boolean'
      || typeof container.restarting !== 'boolean' || !Array.isArray(container.mounts)) invalid()
    for (const mount of container.mounts) {
      if (typeof mount.RW !== 'boolean') invalid()
      if (mount.Type === 'bind') path(mount.Source)
      else if (mount.Type === 'volume') { if (typeof mount.Name !== 'string' || !mount.Name) invalid() }
      else if (mount.Type !== 'tmpfs') invalid()
    }
  }
}

export function stateWriterSources(plan, containers) {
  validate(plan, containers)
  return [...new Set([...plan.roots, ...containers.filter(c => c.running || c.restarting)
    .flatMap(c => c.mounts.filter(m => m.RW && m.Type === 'bind').map(m => m.Source))])].sort()
}

export function assertStateWritersStopped(plan, containers, canonical) {
  const sources = stateWriterSources(plan, containers)
  if (!Array.isArray(canonical)) invalid()
  const aliases = new Map()
  for (const entry of canonical) {
    if (!entry || aliases.has(entry.source)) invalid()
    path(entry.source); aliases.set(entry.source, path(entry.canonical))
  }
  if (sources.some(source => !aliases.has(source))) invalid()
  const roots = plan.roots.map(source => aliases.get(source))
  const writers = containers.filter(c => c.running || c.restarting).filter(c => c.mounts.some(m => m.RW && (
    m.Type === 'volume' && m.Name === plan.volume
    || m.Type === 'bind' && roots.some(root => overlaps(root, aliases.get(m.Source)))
  ))).map(c => c.id)
  if (writers.length) throw Object.assign(new Error('SERVER_STATE_WRITERS_RUNNING'), { writers })
  return { writers: 0 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2]
    if (mode === 'plan' && process.argv.length === 3) {
      console.log(JSON.stringify(stateWriterPlan(JSON.parse(await streamText(process.stdin)))))
    } else if (['sources', 'verify'].includes(mode) && process.argv.length === 3) {
      const plan = JSON.parse(await readFile('/check/plan.json', 'utf8'))
      const text = await readFile('/check/containers.jsonl', 'utf8')
      const containers = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (mode === 'sources') {
        for (const source of stateWriterSources(plan, containers)) {
          const observed = containers.some(c => (c.running || c.restarting)
            && c.mounts.some(m => m.RW && m.Type === 'bind' && m.Source === source))
          console.log(`${observed ? 'observed' : 'planned'}\n${source}`)
        }
      }
      else {
        const lines = (await readFile('/check/canonical.txt', 'utf8')).trimEnd().split('\n')
        if (lines.length % 2) invalid()
        const canonical = []
        for (let i = 0; i < lines.length; i += 2) canonical.push({ source: lines[i], canonical: lines[i + 1] })
        console.log(JSON.stringify(assertStateWritersStopped(plan, containers, canonical)))
      }
    } else invalid()
  } catch (error) {
    // Never include untrusted JSON, Compose env or Docker errors in output.
    console.error(error.message === 'SERVER_STATE_WRITERS_RUNNING' ? error.message : 'SERVER_STATE_WRITER_METADATA_INVALID')
    process.exitCode = 1
  }
}
