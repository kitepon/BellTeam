#!/usr/bin/env node
// Z-b2 stable launcher for registrations that outlive one launch's capture (docs/architecture/modules/runtime/runtime-updates.md).
//   runtime-exec.mjs <componentId> <binName> [args...]   run that bin of the inherited generation
//   runtime-exec.mjs --resolve <componentId> <binName|dist>  print its absolute path
// Generation: BELLTEAM_RUNTIME_GENERATION = sha (that generation), '' (builtin), unset (current selection).
import { spawn } from 'node:child_process'
import { captureRuntime, RUNTIME_COMPONENTS } from '../src/runtime-selection.mjs'

const fail = code => { process.stderr.write(`${code}\n`); process.exit(1) }
const args = process.argv.slice(2), resolveOnly = args[0] === '--resolve'
if (resolveOnly) args.shift()
const [componentId, entry, ...rest] = args
if (!Object.hasOwn(RUNTIME_COMPONENTS, componentId ?? '')) fail('RUNTIME_COMPONENT_INVALID')
const inherited = process.env.BELLTEAM_RUNTIME_GENERATION
let capture
try { capture = await captureRuntime({ generation: inherited === undefined ? undefined : inherited || null }) }
catch { fail('RUNTIME_BINDING_UNAVAILABLE') }
const component = capture.components[componentId]
const path = entry === 'dist' ? component.dist : Object.hasOwn(component.bin, entry ?? '') ? component.bin[entry] : undefined
if (typeof path !== 'string' || resolveOnly && rest.length || !resolveOnly && entry === 'dist') fail('RUNTIME_ENTRY_INVALID')
if (resolveOnly) { process.stdout.write(`${path}\n`); process.exit(0) }
// Builtin keeps today's PATH lookup (a Bot's .local/bin may shadow the image CLI); only a release capture pins an absolute path.
// Descendants (late hooks, lazy MCP) resolve the same generation as this process.
const child = spawn(component.origin === 'release' ? path : entry, rest, { stdio: 'inherit', env: { ...process.env, BELLTEAM_RUNTIME_GENERATION: capture.generation ?? '' } })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.once('error', () => fail('RUNTIME_EXEC_FAILED'))
child.once('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 1)
  process.removeAllListeners(signal); process.kill(process.pid, signal)
})
