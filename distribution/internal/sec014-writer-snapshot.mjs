import { createHash } from 'node:crypto'
import { stateWriterPlan, stateWriterVolumes, stateWriterSources, assertStateWritersStopped } from '../../src/server-state-writers.mjs'

const fail = () => { throw new Error('SEC014_WRITER_SNAPSHOT_UNAVAILABLE') }
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const name = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value)
const sha = raw => createHash('sha256').update(raw).digest('hex')
const MAX_CONTAINERS = 128, MAX_VOLUMES = 128, MAX_PATHS = 512
const CONTAINER = '{"id":{{json .Id}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"mounts":{{json .Mounts}}}'
// Remote driver option values never enter an observation artifact.
const VOLUME = '{"name":{{json .Name}},"driver":{{json .Driver}},"mountpoint":{{json .Mountpoint}},"optionCount":{{len .Options}},"type":{{if and (eq .Driver "local") (eq (index .Options "type") "none")}}{{json (index .Options "type")}}{{else}}null{{end}},"device":{{if and (eq .Driver "local") (eq (index .Options "type") "none") (or (eq (index .Options "o") "bind") (eq (index .Options "o") "bind,rw") (eq (index .Options "o") "rw,bind") (eq (index .Options "o") "rbind"))}}{{json (index .Options "device")}}{{else}}null{{end}},"options":{{if and (eq .Driver "local") (eq (index .Options "type") "none") (or (eq (index .Options "o") "bind") (eq (index .Options "o") "bind,rw") (eq (index .Options "o") "rw,bind") (eq (index .Options "o") "rbind"))}}{{json (index .Options "o")}}{{else}}null{{end}}}'
const LIST = ['/usr/bin/docker', 'container', 'ls', '--all', '--quiet', '--no-trunc']

export function writerContainerInspectArgv(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_CONTAINERS
      || ids.some(value => !id(value)) || new Set(ids).size !== ids.length) fail()
  return ['/usr/bin/docker', 'inspect', '--format', CONTAINER, ...[...ids].sort()]
}

export function writerVolumeInspectArgv(volume) {
  if (!name(volume)) fail()
  return ['/usr/bin/docker', 'volume', 'inspect', '--format', VOLUME, volume]
}

export function writerSnapshotPlan(config, image, imageId) {
  if (typeof image !== 'string' || !/^(?:ghcr\.io\/kitepon\/bellteam-server@)?sha256:[a-f0-9]{64}$/u.test(image)
      || typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(imageId)
      || image.startsWith('sha256:') && image !== imageId) fail()
  if (config?.services?.bellteam?.image !== imageId
      || (config?.services?.['state-maintenance'] !== undefined
        && config.services['state-maintenance']?.image !== imageId)) fail()
  // Compose credentials are discarded by the existing planner, never retained.
  return { image, imageId, mounts: stateWriterPlan(config),
    limits: { containers: MAX_CONTAINERS, volumes: MAX_VOLUMES, canonicalPaths: MAX_PATHS },
    imageArgv: ['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .Id}}', image],
    listArgv: [...LIST], maxDockerCommands: 3 + MAX_VOLUMES,
    stage: 'docker-writer-metadata-only', phaseReceiptProduced: false }
}

function terminal(record, argv, limit) {
  if (!record || JSON.stringify(record.argv) !== JSON.stringify(argv)
      || !Number.isSafeInteger(record.clientPid) || record.clientPid <= 0
      || !Number.isSafeInteger(record.clientStartTicks) || record.clientStartTicks <= 0
      || record.unknown !== false || record.terminal?.kind !== 'exit' || record.terminal.code !== 0
      || typeof record.rawUtf8 !== 'string') fail()
  const raw = Buffer.from(record.rawUtf8)
  if (raw.length > limit || record.stdoutBytes !== raw.length || record.stdoutSha256 !== sha(raw)) fail()
  return record.rawUtf8
}

const rows = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line))

export function verifyWriterSnapshot(plan, bundle, context = {}) {
  if (plan?.stage !== 'docker-writer-metadata-only' || plan.phaseReceiptProduced !== false
      || plan.maxDockerCommands !== 3 + MAX_VOLUMES
      || typeof plan.image !== 'string' || !/^(?:ghcr\.io\/kitepon\/bellteam-server@)?sha256:[a-f0-9]{64}$/u.test(plan.image)
      || typeof plan.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(plan.imageId)
      || plan.image.startsWith('sha256:') && plan.image !== plan.imageId
      || Object.keys(plan.limits ?? {}).sort().join(',') !== 'canonicalPaths,containers,volumes'
      || plan.limits.containers !== MAX_CONTAINERS || plan.limits.volumes !== MAX_VOLUMES || plan.limits.canonicalPaths !== MAX_PATHS
      || JSON.stringify(plan.listArgv) !== JSON.stringify(LIST) || !bundle) fail()
  const imageArgv = ['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .Id}}', plan.image]
  if (JSON.stringify(plan.imageArgv) !== JSON.stringify(imageArgv)
      || JSON.parse(terminal(bundle.image, imageArgv, 128)) !== plan.imageId) fail()
  if (Object.keys(plan.mounts ?? {}).sort().join(',') !== 'roots,volume') fail()
  const ids = terminal(bundle.list, LIST, MAX_CONTAINERS * 65).split('\n').filter(Boolean)
  if (ids.length > MAX_CONTAINERS || ids.some(value => !id(value)) || new Set(ids).size !== ids.length) fail()
  ids.sort()
  const containers = ids.length ? rows(terminal(bundle.containers, writerContainerInspectArgv(ids), 1048576)) : []
  if ((!ids.length && bundle.containers !== null) || containers.length !== ids.length
      || containers.some(c => !id(c?.id) || !Array.isArray(c.mounts) || c.mounts.length > 64)
      || containers.some(c => Object.keys(c).sort().join(',') !== 'id,mounts,restartPolicy,restarting,running')
      || JSON.stringify(containers.map(c => c.id).sort()) !== JSON.stringify(ids)) fail()
  const volumes = stateWriterVolumes(plan.mounts, containers)
  if (volumes.length > MAX_VOLUMES || volumes.some(value => !name(value))
      || !Array.isArray(bundle.volumes) || bundle.volumes.length !== volumes.length) fail()
  const backing = volumes.map((volume, index) => {
    const record = bundle.volumes[index]
    const value = JSON.parse(terminal(record, writerVolumeInspectArgv(volume), 16384))
    if (value?.name !== volume || Object.keys(value).sort().join(',') !== 'device,driver,mountpoint,name,optionCount,options,type') fail()
    return value
  })
  const sources = stateWriterSources(plan.mounts, containers, backing)
  if (sources.length > MAX_PATHS || !Array.isArray(bundle.canonical) || bundle.canonical.length !== sources.length
      || bundle.canonical.some(x => !x || Object.keys(x).sort().join(',') !== 'canonical,source'
        || typeof x.source !== 'string' || typeof x.canonical !== 'string'
        || x.source.length > 4096 || x.canonical.length > 4096)
      || JSON.stringify(bundle.canonical.map(x => x?.source).sort()) !== JSON.stringify(sources)) fail()
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key => !['stoppedContainer', 'activeContainer'].includes(key))
      || Object.values(context).some(value => !id(value))
      || context.stoppedContainer && !ids.includes(context.stoppedContainer)
      || context.activeContainer && (!ids.includes(context.activeContainer) || context.activeContainer === context.stoppedContainer)) fail()
  const checked = context.stoppedContainer ? { ...plan.mounts, stoppedContainer: context.stoppedContainer } : plan.mounts
  assertStateWritersStopped(checked, containers.filter(c => c.id !== context.activeContainer), bundle.canonical, backing)
  return { stage: 'docker-writer-metadata-only', image: plan.image, imageId: plan.imageId,
    containerIds: ids, volumeNames: volumes, canonical: bundle.canonical,
    terminalRefs: [bundle.image, bundle.list, ...(ids.length ? [bundle.containers] : []), ...bundle.volumes]
      .map(x => ({ argv: x.argv, clientPid: x.clientPid, clientStartTicks: x.clientStartTicks,
        stdoutBytes: x.stdoutBytes, stdoutSha256: x.stdoutSha256 })),
    phaseReceiptProduced: false, hostWriterAuthorityVerified: false,
    participatingWritersVerified: false, nonparticipatingWritersVerified: false,
    bothNormalIdentitiesVerified: false }
}
