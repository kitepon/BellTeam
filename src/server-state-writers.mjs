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
// A snapshot finds existing writers; maintenance locks and the sealed data root cover the mutation interval.
const participates = (plan, c) => c.running || c.restarting || !['', 'no'].includes(c.restartPolicy)
  && !(c.id === plan.stoppedContainer && c.restartPolicy === 'unless-stopped')

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
  let stateVolume
  if (stateMounts.length) {
    if (stateMounts.length !== stateTargets.length) invalid()
    const source = stateMounts[0].source
    stateVolume = config.volumes?.[source]?.name
    if (typeof stateVolume !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(stateVolume)
      || stateVolume === volume || config.volumes[source].external !== true) invalid()
    for (const target of stateTargets) {
      const matches = stateMounts.filter(mount => mount.target === target)
      if (matches.length !== 1 || matches[0].type !== 'volume' || matches[0].source !== source
        || matches[0].read_only === true || matches[0].volume?.nocopy !== true
        || matches[0].volume?.subpath !== target.split('/').at(-1)) invalid()
    }
    const control = service.volumes.filter(mount => mount.target === '/run/bellteam-maintenance')
    if (control.length !== 1 || control[0].type !== 'volume' || control[0].source !== source
      || control[0].read_only !== true || control[0].volume?.nocopy !== true || control[0].volume?.subpath) invalid()
  }
  const maintenance = config.services['state-maintenance']
  if (maintenance) {
    const mounts = maintenance.volumes
    if (mounts?.length !== 2) invalid()
    const bind = mounts.find(mount => mount.target === '/srv/bellteam-runtime')
    const privateMount = mounts.find(mount => mount.target === '/srv/bellteam-private')
    if (bind?.type !== 'bind' || bind.read_only === true || privateMount?.type !== 'volume'
      || privateMount.read_only === true || privateMount.volume?.nocopy !== true || privateMount.volume?.subpath) invalid()
    const runtime = path(bind.source), name = config.volumes?.[privateMount.source]?.name
    if (roots[0] !== posix.join(runtime, 'data') || roots[1] !== posix.join(runtime, 'home')
      || typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name)
      || name === volume || config.volumes[privateMount.source].external !== true || stateVolume && name !== stateVolume) invalid()
    stateVolume = name
    roots.push(runtime)
  }
  return { roots: [...new Set(roots)], volume, ...(stateVolume ? { stateVolume } : {}) }
}

function validate(plan, containers) {
  if (!Array.isArray(plan?.roots) || plan.roots.length < 2 || typeof plan.volume !== 'string'
    || !Array.isArray(containers) || plan.stateVolume !== undefined
      && (typeof plan.stateVolume !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(plan.stateVolume))) invalid()
  plan.roots.forEach(path)
  for (const container of containers) {
    if (typeof container.id !== 'string' || !container.id || typeof container.running !== 'boolean'
      || typeof container.restarting !== 'boolean' || !Array.isArray(container.mounts)
      || !['', 'no', 'on-failure', 'always', 'unless-stopped'].includes(container.restartPolicy)) invalid()
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
  if (plan.stoppedContainer !== undefined) {
    if (typeof plan.stoppedContainer !== 'string' || !/^[a-f0-9]{64}$/u.test(plan.stoppedContainer)) invalid()
    const selected = containers.filter(c => c.id === plan.stoppedContainer)
    if (selected.length !== 1 || selected[0].running || selected[0].restarting) invalid()
  }
}

export function stateWriterVolumes(plan, containers) {
  validate(plan, containers)
  return [...new Set([...(plan.stateVolume ? [plan.stateVolume] : []), ...containers.filter(c => participates(plan, c))
    .flatMap(c => c.mounts.filter(m => m.RW && m.Type === 'volume').map(m => m.Name))])].sort()
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
      const device = path(record.device)
      if (name === plan.stateVolume && device !== posix.join(posix.dirname(plan.roots[0]), 'server-only/state-data')) invalid()
      paths.push(device)
    }
    result.set(name, paths)
  }
  return result
}

export function stateWriterSources(plan, containers, volumes = []) {
  const backing = volumePaths(plan, containers, volumes)
  return [...new Set([...plan.roots, ...containers.filter(c => participates(plan, c))
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
  for (const c of containers.filter(c => participates(plan, c))) for (const m of c.mounts.filter(m => m.RW && m.Type === 'volume')) {
    const root = aliases.get(backing.get(m.Name)[0]), source = aliases.get(m.Source)
    if (source !== root && !source.startsWith(root + '/')) invalid()
  }
  const roots = [...plan.roots, ...(backing.get(plan.stateVolume) ?? [])].map(source => aliases.get(source))
  const writers = containers.filter(c => participates(plan, c)).filter(c => c.mounts.some(m => m.RW && (
    m.Type === 'volume' && [plan.volume, plan.stateVolume].includes(m.Name)
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
      // Compose config doubles dollars in its JSON output, unlike inspect metadata.
      console.log(JSON.stringify(stateWriterPlan(JSON.parse((await streamText(process.stdin)).replaceAll('$$', '$')))))
    } else if (['volumes', 'sources', 'verify'].includes(mode) && process.argv.length === 3) {
      const plan = JSON.parse(await readFile('/check/plan.json', 'utf8'))
      const stoppedContainer = (await readFile('/check/stopped-container.txt', 'utf8')).trim()
      if (stoppedContainer) plan.stoppedContainer = stoppedContainer
      const text = await readFile('/check/containers.jsonl', 'utf8')
      const containers = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
      if (mode === 'volumes') console.log(stateWriterVolumes(plan, containers).join('\n'))
      else {
        const records = (await readFile('/check/volumes.jsonl', 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (mode === 'sources') {
        const backing = volumePaths(plan, containers, records)
        const active = containers.filter(c => participates(plan, c))
        const host = [...active.flatMap(c => c.mounts.filter(m => m.RW && m.Type === 'bind').map(m => m.Source)),
          ...[...backing.values()].flatMap(paths => paths.slice(1))]
        const virtual = [...active.flatMap(c => c.mounts.filter(m => m.RW && m.Type === 'volume').map(m => m.Source)),
          ...[...backing.values()].map(paths => paths[0])]
        for (const source of stateWriterSources(plan, containers, records)) {
          const kind = host.includes(source) ? 'observed' : virtual.includes(source) ? 'volume' : 'planned'
          console.log(`${kind}\n${source}`)
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
