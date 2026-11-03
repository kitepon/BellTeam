import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { text } from 'node:stream/consumers'
import { stateWriterPlan } from './server-state-writers.mjs'

const invalid = () => { throw new Error('GATEWAY_INSTALL_MODEL_INVALID') }

// A new helper gets only this server's incoming directory and private volume.
export function webGatewayInstallPlan(normal, current, component = 'web-gateway') {
  if (!['web-gateway', 'notifications', 'members', 'memory', 'usage', 'diagnostics', 'execution', 'conversation'].includes(component)) invalid()
  const plan = stateWriterPlan(normal), service = normal.services.bellteam
  if (!plan.stateVolume || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(normal.name ?? '')
    || !/^[a-f0-9]{64}$/u.test(current?.id ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(current?.image ?? '')
    || current.image !== service.image || current.running !== true || current.restarting !== false
    || current.readOnly !== true || current.project !== normal.name || !Array.isArray(current.mounts) || !Array.isArray(current.specMounts)) invalid()
  const runtime = posix.dirname(plan.roots[0])
  if (plan.roots[0] !== posix.join(runtime, 'data') || plan.roots[1] !== posix.join(runtime, 'home')) invalid()
  const actual = target => {
    const found = current.mounts.filter(m => m.Destination === target)
    if (found.length !== 1) invalid()
    return found[0]
  }
  for (const [target, source] of [['/srv/bellteam', plan.roots[0]], ['/home/bell', plan.roots[1]]]) {
    const mount = actual(target)
    if (mount.Type !== 'bind' || mount.Source !== source || mount.RW !== true) invalid()
  }
  const configured = target => {
    const found = current.specMounts.filter(m => m.Target === target)
    if (found.length !== 1 || found[0].Type !== 'volume' || found[0].Source !== plan.stateVolume
      || found[0].VolumeOptions?.NoCopy !== true) invalid()
    return found[0]
  }
  const controlSpec = configured('/run/bellteam-maintenance')
  if (controlSpec.ReadOnly !== true || controlSpec.VolumeOptions.Subpath) invalid()
  const control = actual('/run/bellteam-maintenance')
  if (control.Type !== 'volume' || control.Name !== plan.stateVolume || control.RW !== false
    || typeof control.Source !== 'string' || !posix.isAbsolute(control.Source)) invalid()
  for (const part of ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']) {
    const mount = actual('/srv/bellteam/' + part), spec = configured('/srv/bellteam/' + part)
    if (mount.Type !== 'volume' || mount.Name !== plan.stateVolume || mount.RW !== true
      // Docker inspect reports the volume root; subpath belongs to HostConfig.Mounts.
      || mount.Source !== control.Source || spec.ReadOnly === true
      || spec.VolumeOptions.Subpath !== posix.basename(part)) invalid()
  }
  if (component === 'memory') {
    const views = service.volumes.filter(mount => mount.target === '/run/bellteam-memory-code')
    if (views.length !== 1 || views[0].type !== 'volume' || views[0].read_only !== true
      || views[0].volume?.nocopy !== true || views[0].volume?.subpath !== 'memory-code'
      || normal.volumes?.[views[0].source]?.name !== plan.stateVolume) invalid()
    const mount = actual('/run/bellteam-memory-code'), spec = configured('/run/bellteam-memory-code')
    if (mount.Type !== 'volume' || mount.Name !== plan.stateVolume || mount.Source !== control.Source
      || mount.RW !== false || spec.ReadOnly !== true || spec.VolumeOptions.Subpath !== 'memory-code') invalid()
  }
  return { name: normal.name, services: { [component + '-install']: {
    image: current.image, pull_policy: 'never', user: '0:0',
    entrypoint: ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', '/usr/bin/python3', '-I', ({ 'web-gateway':'/app/scripts/install-web-gateway-release.py',notifications:'/app/scripts/install-notifications-release.py',members:'/app/scripts/install-members-release.py',memory:'/app/scripts/install-memory-release.py',usage:'/app/scripts/install-usage-release.py',diagnostics:'/app/scripts/install-diagnostics-release.py',execution:'/app/scripts/install-execution-release.py',conversation:'/app/scripts/install-conversation-release.py' })[component]],
    init: true, read_only: true, network_mode: 'none', cap_drop: ['ALL'], cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    security_opt: ['no-new-privileges:true'], cpus: 1, mem_limit: '2g', memswap_limit: '2g', pids_limit: 512,
    tmpfs: ['/tmp:rw,nosuid,nodev,size=64m'], volumes: [
      { type: 'bind', source: posix.join(runtime, component + '-incoming'), target: '/srv/bellteam-' + component + '-incoming', read_only: true, bind: { create_host_path: false } },
      { type: 'volume', source: 'server-state', target: '/srv/bellteam-private', volume: { nocopy: true } },
    ],
  } }, volumes: { 'server-state': { external: true, name: plan.stateVolume } } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) invalid()
    const [encodedNormal, current] = JSON.parse(await text(process.stdin))
    const normal = JSON.parse(JSON.stringify(encodedNormal).replaceAll('$$', '$'))
    const model = webGatewayInstallPlan(normal, current)
    console.log(JSON.stringify(model, (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value))
  } catch { console.error('GATEWAY_INSTALL_MODEL_INVALID'); process.exitCode = 1 }
}
