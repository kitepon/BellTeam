// Registration and setup use only Aiterm's public entries (package.json exports); shared HOME remains SeatRuntime-owned.
import { readFileSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { captureRuntime } from './runtime-selection.mjs'

export const MCP_LAZY_RELAY = '/usr/local/bin/mcp-lazy'
export const AITERM_ROOT = '/usr/local/lib/node_modules/aiterm-mcp'
const loadModule = path => import(pathToFileURL(path).href)

// Aiterm promises only its exports table (aiterm-mcp bellteam-boundary.md 公開の入口). Read it from the chosen root:
// a bare import('aiterm-mcp/...') would hit BellTeam's own node_modules copy, not the selected version.
export function aitermEntry(root, name) {
  const target = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports?.[`./${name}`]
  const path = typeof target === 'string' && target.startsWith('./') ? join(root, target) : ''
  if (!path.startsWith(`${root}/`)) throw Object.assign(new Error(`AITERM_ENTRY_UNAVAILABLE: ${name}`), { code: 'AITERM_ENTRY_UNAVAILABLE' })
  return path
}
const providerFor = entry => createRequire(entry).resolve('aiterm-steer-delivery')

export async function aitermRelay({ path = MCP_LAZY_RELAY } = {}) {
  try { await access(path, constants.X_OK); return path } catch { return null }
}

// Same shape plain aiterm-setup writes, so it preserves BellTeam's Codex/Grok timeout fields.
export async function aitermRegistration({ root = AITERM_ROOT, load = loadModule } = {}) {
  return (await load(aitermEntry(root, 'setup-node'))).mcpRegistration()
}

// Persistent helpers stay image-owned across body recovery to previous-normal.
export async function aitermExecutionRegistration({ root = AITERM_ROOT, provider, load = loadModule, resolveProvider = providerFor } = {}) {
  const [{ setupNodeExecutable }, { localParentWorkerRuntime }] = await Promise.all([
    load(aitermEntry(root, 'setup-node')), load(aitermEntry(root, 'execution-parent-worker')),
  ])
  const scope = localParentWorkerRuntime.scope(), entry = aitermEntry(root, 'execution-native-server')
  return {
    command: setupNodeExecutable(),
    args: [entry, '--execution-interrupt', '--state-root', scope.state_root,
      '--socket', scope.multiplexer.key, '--steer-provider', provider ?? resolveProvider(entry)],
  }
}

// A live connection keeps its captured files; persistent registration remains image-owned.
export function aitermConnectionRegistration(registration, runtime, resolveProvider = providerFor) {
  const component = runtime.components['runtime-aiterm-mcp']
  const args = [...registration.args]
  if (args.includes('--execution-interrupt')) {
    args[0] = aitermEntry(component.root, 'execution-native-server')
    const provider = args.indexOf('--steer-provider')
    if (provider >= 0) args[provider + 1] = resolveProvider(args[0])
    return { command: registration.command, args }
  }
  if (registration.command === 'aiterm-mcp')
    return { command: component.origin === 'builtin' ? 'aiterm-mcp' : component.bin['aiterm-mcp'], args }
  return { ...registration, args }
}

// The native registration comes from aitermExecutionRegistration of the same image root.
export async function configureAitermHooks(home, { runtimeCapture, root = AITERM_ROOT, load = loadModule, codex, registration } = {}) {
  codex ??= (runtimeCapture ?? await captureRuntime()).components['runtime-codex'].bin.codex
  registration ??= await aitermRegistration({ root, load })
  if (registration.args.includes('--execution-interrupt')) {
    const [{ configureNativeExecutionHooks }, { parseNativeExecutionArguments }] = await Promise.all([
      load(aitermEntry(root, 'execution-native-setup')), load(aitermEntry(root, 'execution-native-server')),
    ])
    const { expectedScope, providerFile } = parseNativeExecutionArguments(registration.args.slice(1))
    const { results } = await configureNativeExecutionHooks(home,
      { registration, expectedScope, providerFile, codexBinary: codex })
    return results
  }
  const { mergeClaudeParentHooks, mergeCursorParentHooks, ensureCodexParentSteer } = await load(aitermEntry(root, 'setup-integrations'))
  mergeClaudeParentHooks(join(home, '.claude/settings.json'), registration)
  mergeCursorParentHooks(join(home, '.cursor/hooks.json'), registration)
  if (!ensureCodexParentSteer) return { codex: null }
  return { codex: await ensureCodexParentSteer(home, { binary: codex }) }
}
