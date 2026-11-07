// Registration and setup use Aiterm's public helpers; shared HOME remains SeatRuntime-owned.
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { captureRuntime } from './runtime-selection.mjs'

export const MCP_LAZY_RELAY = '/usr/local/bin/mcp-lazy'
export const AITERM_ADAPTER_DIST = '/app/scripts/runtime-aiterm'
export const RUNTIME_EXEC = '/app/scripts/runtime-exec.mjs'
const loadModule = path => import(pathToFileURL(path).href)
const providerFor = entry => createRequire(entry).resolve('aiterm-steer-delivery')

export async function aitermRelay({ path = MCP_LAZY_RELAY } = {}) {
  try { await access(path, constants.X_OK); return path } catch { return null }
}

export async function aitermRegistration({ runtimeCapture, dist, load = loadModule } = {}) {
  const runtime = runtimeCapture ?? await captureRuntime()
  const { setupNodeExecutable } = await load(join(dist ?? runtime.components['runtime-aiterm-mcp'].dist, 'setup-node.js'))
  return { command: setupNodeExecutable(), args: [RUNTIME_EXEC, 'runtime-aiterm-mcp', 'aiterm-mcp'] }
}

// The fixed adapter keeps the native basename/sibling-hook contract of Aiterm's setup API.
export async function aitermExecutionRegistration({ runtimeCapture, dist, provider, load = loadModule, resolveProvider = providerFor } = {}) {
  const runtime = runtimeCapture ?? await captureRuntime()
  dist ??= runtime.components['runtime-aiterm-mcp'].dist
  const [{ setupNodeExecutable }, { localParentWorkerRuntime }] = await Promise.all([
    load(join(dist, 'setup-node.js')), load(join(dist, 'execution-parent-worker.js')),
  ])
  const scope = localParentWorkerRuntime.scope(), entry = join(dist, 'execution-native-server.js')
  return {
    command: setupNodeExecutable(),
    args: [join(AITERM_ADAPTER_DIST, 'execution-native-server.js'), '--execution-interrupt', '--state-root', scope.state_root,
      '--socket', scope.multiplexer.key, '--steer-provider', provider ?? resolveProvider(entry)],
  }
}

// A live connection executes immutable files; persistent registrations instead use the adapters above.
export function aitermConnectionRegistration(registration, runtime, resolveProvider = providerFor) {
  const component = runtime.components['runtime-aiterm-mcp']
  const args = [...registration.args]
  if (args.includes('--execution-interrupt')) {
    args[0] = join(component.dist, 'execution-native-server.js')
    const provider = args.indexOf('--steer-provider')
    if (provider >= 0) args[provider + 1] = resolveProvider(args[0])
    return { command: registration.command, args }
  }
  if (registration.command === 'aiterm-mcp' || args[0] === RUNTIME_EXEC)
    return { command: component.origin === 'builtin' ? 'aiterm-mcp' : component.bin['aiterm-mcp'], args: args[0] === RUNTIME_EXEC ? args.slice(3) : args }
  return { ...registration, args }
}

export async function configureAitermHooks(home, { runtimeCapture, dist, load = loadModule, codex, registration, resolveProvider = providerFor } = {}) {
  const runtime = runtimeCapture ?? await captureRuntime()
  dist ??= runtime.components['runtime-aiterm-mcp'].dist
  codex ??= runtime.components['runtime-codex'].bin.codex
  registration ??= await aitermRegistration({ runtimeCapture: runtime, dist, load })
  if (registration.args.includes('--execution-interrupt')) {
    const [{ configureNativeExecutionHooks }, { parseNativeExecutionArguments }] = await Promise.all([
      load(join(dist, 'execution-native-setup.js')), load(join(dist, 'execution-native-server.js')),
    ])
    const direct = aitermConnectionRegistration(registration,
      { ...runtime, components: { ...runtime.components, 'runtime-aiterm-mcp': { ...runtime.components['runtime-aiterm-mcp'], dist } } }, resolveProvider)
    const { expectedScope, providerFile } = parseNativeExecutionArguments(direct.args.slice(1))
    const persistent = { command: registration.command,
      args: [join(AITERM_ADAPTER_DIST, 'execution-native-server.js'), ...direct.args.slice(1)] }
    const { results } = await configureNativeExecutionHooks(home,
      { registration: persistent, expectedScope, providerFile, codexBinary: codex })
    return results
  }
  const { mergeClaudeParentHooks, mergeCursorParentHooks, ensureCodexParentSteer } = await load(join(dist, 'setup-integrations.js'))
  const persistent = { command: registration.command, args: [join(AITERM_ADAPTER_DIST, 'index.js')] }
  mergeClaudeParentHooks(join(home, '.claude/settings.json'), persistent)
  mergeCursorParentHooks(join(home, '.cursor/hooks.json'), persistent)
  if (!ensureCodexParentSteer) return { codex: null }
  return { codex: await ensureCodexParentSteer(home, { binary: codex,
    runtime: { node: registration.command, hook: join(AITERM_ADAPTER_DIST, 'codex-parent-hook.js') } }) }
}
