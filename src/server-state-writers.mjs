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
const stateTargets = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns'].map(name => '/srv/bellteam/' + name)

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
  if (service.volumes.some(mount => ['/srv/bellteam-legacy', '/srv/bellteam-maintenance-backups']
    .some(view => mount.target === view || typeof mount.target === 'string' && mount.target.startsWith(view + '/')))) invalid()
  const stateMounts = service.volumes.filter(mount => stateTargets.includes(mount.target))
  const normalSources = stateMounts.length ? addBinds(service, stateTargets) : []
  separate(normalSources)
  const maintenance = config.services['state-maintenance']
  if (maintenance) {
    const targets = ['/srv/bellteam-legacy', '/srv/bellteam', '/srv/bellteam-maintenance-backups', ...stateTargets]
    if (maintenance.volumes?.length !== targets.length) invalid()
    const sources = addBinds(maintenance, targets)
    if (sources[0] !== roots[0] || sources[1] !== roots[0]) invalid()
    separate(sources.slice(3))
    if (normalSources.length && normalSources.some((source, index) => source !== sources[index + 3])) invalid()
    const backup = sources[2]
    if (sources.slice(3).some(source => overlaps(source, backup))
      || service.volumes.some(mount => mount.type === 'bind' && overlaps(path(mount.source), backup))) invalid()
  }
  return { roots: [...new Set(roots)], volume }

  function addBinds(service, targets) {
    if (!Array.isArray(service.volumes)) invalid()
    const sources = []
    for (const target of targets) {
      const matches = service.volumes.filter(mount => mount.target === target)
      if (matches.length !== 1 || matches[0].type !== 'bind' || matches[0].read_only === true) invalid()
      sources.push(path(matches[0].source))
    }
    roots.push(...sources)
    return sources
  }
  function separate(sources) {
    if (sources.some((source, index) => roots.slice(0, 2).some(root => overlaps(source, root))
      || sources.slice(index + 1).some(other => overlaps(source, other)))) invalid()
  }
}

function validate(plan, containers) {
  if (!Array.isArray(plan?.roots) || plan.roots.length < 2 || typeof plan.volume !== 'string'
    || !Array.isArray(containers)) invalid()
  plan.roots.forEach(path)
  for (const container of containers) {
    if (typeof container.id !== 'string' || !container.id || typeof container.running !== 'boolean'
      || typeof container.restarting !== 'boolean' || !Array.isArray(container.mounts)) invalid()
    for (const mount of container.mounts) {
      if (typeof mount.RW !== 'boolean') invalid()
      if (mount.Type === 'bind') path(mount.Source)
      else if (mount.Type === 'volume') {
        if (typeof mount.Name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(mount.Name)) invalid()
        path(mount.Source)
      }
      else if (mount.Type !== 'tmpfs') invalid()
    }
  }
}

export function stateWriterVolumes(plan, containers) {
  validate(plan, containers)
  return [...new Set(containers.filter(c => c.running || c.restarting)
    .flatMap(c => c.mounts.filter(m => m.RW && m.Type === 'volume').map(m => m.Name)))].sort()
}

function volumePaths(plan, containers, volumes) {
  if (!Array.isArray(volumes)) invalid()
  const descriptions = new Map()
  for (const record of volumes) {
    if (typeof record?.name !== 'string' || descriptions.has(record.name)) invalid()
    descriptions.set(record.name, record)
  }
  const result = new Map()
  for (const name of stateWriterVolumes(plan, containers)) {
    const record = descriptions.get(name)
    if (!record || record.driver !== 'local') invalid()
    const paths = [path(record.mountpoint)]
    if (record.optionCount === 0) {
      if ([record.type, record.device, record.options].some(value => value !== null)) invalid()
    } else {
      if (record.optionCount !== 3 || record.type !== 'none'
        || !['bind', 'bind,rw', 'rw,bind', 'rbind'].includes(record.options)) invalid()
      paths.push(path(record.device))
    }
    result.set(name, paths)
  }
  return result
}

export function stateWriterSources(plan, containers, volumes = []) {
  const backing = volumePaths(plan, containers, volumes)
  return [...new Set([...plan.roots, ...containers.filter(c => c.running || c.restarting)
    .flatMap(c => c.mounts.filter(m => m.RW && ['bind', 'volume'].includes(m.Type)).map(m => m.Source)),
  ...[...backing.values()].flat()])].sort()
}

export function assertStateWritersStopped(plan, containers, canonical, volumes = []) {
  const sources = stateWriterSources(plan, containers, volumes)
  const backing = volumePaths(plan, containers, volumes)
  if (!Array.isArray(canonical)) invalid()
  const aliases = new Map()
  for (const entry of canonical) {
    if (!entry || aliases.has(entry.source)) invalid()
    path(entry.source); aliases.set(entry.source, path(entry.canonical))
  }
  if (sources.some(source => !aliases.has(source))) invalid()
  for (const c of containers.filter(c => c.running || c.restarting)) for (const m of c.mounts.filter(m => m.RW && m.Type === 'volume')) {
    if (aliases.get(m.Source) !== aliases.get(backing.get(m.Name)[0])) invalid()
  }
  const roots = plan.roots.map(source => aliases.get(source))
  const writers = containers.filter(c => c.running || c.restarting).filter(c => c.mounts.some(m => m.RW && (
    m.Type === 'volume' && m.Name === plan.volume
    || m.Type === 'volume' && backing.get(m.Name).some(source => roots.some(root => overlaps(root, aliases.get(source))))
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
    } else if (['volumes', 'sources', 'verify'].includes(mode) && process.argv.length === 3) {
      const plan = JSON.parse(await readFile('/check/plan.json', 'utf8'))
      const text = await readFile('/check/containers.jsonl', 'utf8')
      const containers = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (mode === 'volumes') console.log(stateWriterVolumes(plan, containers).join('\n'))
      else {
        const records = (await readFile('/check/volumes.jsonl', 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (mode === 'sources') {
        const backing = [...volumePaths(plan, containers, records).values()].flat()
        for (const source of stateWriterSources(plan, containers, records)) {
          const observed = containers.some(c => (c.running || c.restarting)
            && c.mounts.some(m => m.RW && ['bind', 'volume'].includes(m.Type) && m.Source === source)) || backing.includes(source)
          console.log(`${observed ? 'observed' : 'planned'}\n${source}`)
        }
        }
        else {
        const lines = (await readFile('/check/canonical.txt', 'utf8')).trimEnd().split('\n')
        if (lines.length % 2) invalid()
        const canonical = []
        for (let i = 0; i < lines.length; i += 2) canonical.push({ source: lines[i], canonical: lines[i + 1] })
        console.log(JSON.stringify(assertStateWritersStopped(plan, containers, canonical, records)))
        }
      }
    } else invalid()
  } catch (error) {
    // Never include untrusted JSON, Compose env or Docker errors in output.
    console.error(error.message === 'SERVER_STATE_WRITERS_RUNNING' ? error.message : 'SERVER_STATE_WRITER_METADATA_INVALID')
    process.exitCode = 1
  }
}
