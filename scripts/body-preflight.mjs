#!/usr/bin/env node
// Target-image preflight run by the host updater before swapping (container-update-bundled.md "Target-image preflight").
// It reports a definite failure only for what this image would certainly hit at install/boot; anything else is a warning.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const control = '/run/bellteam-maintenance'
// usage/diagnostics/conversation/work-graph fall back to builtin on a state-format mismatch (module-process, #822).
const FALLBACK = new Set(['usage', 'diagnostics', 'conversation', 'work-graph'])
const COMPONENTS = ['members', 'memory', 'notifications', 'web-gateway', 'execution', ...FALLBACK]

export function classifyRelease(component, role, code) {
  if (FALLBACK.has(component) && code === `${component.toUpperCase().replaceAll('-', '_')}_STATE_INCOMPATIBLE`) return 'warning'
  if (FALLBACK.has(component) || role === 'currentVersionId') return 'fail'
  return 'warning' // a previous release outside module-process is not certainly read at start
}

export function classifyBridge(status, stderr) {
  if (status === 0) return 'pass'
  const code = String(stderr).trim()
  return /^HOST_[A-Z_0-9]{1,95}$/.test(code) && code !== 'HOST_MODULE_TERMINATION_UNCONFIRMED' ? 'fail' : 'warning'
}

async function validator(component) {
  const release = await import('../src/web-gateway-release.mjs')
  if (FALLBACK.has(component)) return manifest => release.validateBusinessModuleManifest(component, manifest)
  if (component === 'execution') {
    const { EXECUTION_STATE_COMPATIBILITY } = await import('../src/execution-dispatcher.mjs')
    return manifest => release.validateExecutionReleaseManifest(manifest, EXECUTION_STATE_COMPATIBILITY)
  }
  return { members: release.validateMembersReleaseManifest, memory: release.validateMemoryReleaseManifest,
    notifications: release.validateNotificationsReleaseManifest, 'web-gateway': release.validateGatewayReleaseManifest }[component]
}

async function main() {
  const failures = [], warnings = [], report = {}
  const normal = JSON.parse(readFileSync(0, 'utf8'))
  for (const component of COMPONENTS) {
    let adoption
    try { adoption = JSON.parse(readFileSync(`${control}/state/${component}-release.json`, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT') warnings.push({ check: 'release', component, code: 'ADOPTION_UNREADABLE' })
      continue
    }
    const validate = await validator(component)
    for (const role of ['currentVersionId', 'previousVersionId']) {
      const versionId = adoption?.[role]
      if (typeof versionId !== 'string') continue
      let manifest
      try { manifest = JSON.parse(readFileSync(`${control}/${component}/releases/${versionId}/manifest.json`, 'utf8')) }
      catch { warnings.push({ check: 'release', component, role, versionId, code: 'MANIFEST_UNREADABLE' }); continue }
      try { validate(manifest) } catch (error) {
        const row = { check: 'release', component, role, versionId, code: String(error?.code ?? 'UNKNOWN') };
        (classifyRelease(component, role, row.code) === 'fail' ? failures : warnings).push(row)
      }
    }
  }
  try {
    const { moduleWorkerTerminationModel } = await import('./module-update-compose.mjs')
    const helper = moduleWorkerTerminationModel(normal)
    if (helper) {
      const args = helper.services['module-worker-termination'].command
      const run = spawnSync('/usr/bin/python3', ['-I', '-B', '/app/scripts/module-worker-termination.py', '--dry-run', ...args], { timeout: 60000, encoding: 'utf8' })
      const verdict = classifyBridge(run.status, run.stderr)
      if (verdict !== 'pass') (verdict === 'fail' ? failures : warnings).push({ check: 'bridge', code: String(run.stderr).trim().slice(0, 100) || 'UNKNOWN' })
    }
  } catch { warnings.push({ check: 'bridge', code: 'UNKNOWN' }) }
  try { report.bots = readdirSync('/srv/bellteam/bots').filter(name => name.startsWith('bot-')).length } catch {}
  report.startPeriod = normal?.services?.bellteam?.healthcheck?.start_period ?? null
  process.stdout.write(JSON.stringify({ result: failures.length ? 'fail' : 'pass', failures, warnings, report }) + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
