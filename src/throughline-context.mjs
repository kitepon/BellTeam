import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runtimeEnvironment } from './runtime-home.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'

const execFileAsync = promisify(execFile)
export const NIGHTLY_RESTART_TURNS = 20

export async function completedThroughlineTurns(project, { run = execFileAsync, seatCommands = false } = {}) {
  const execute = seatCommands ? createSeatProcessRunner(project) : run
  const { stdout } = await execute('throughline', [
    'observer-read', '--project', project, '--limit', String(NIGHTLY_RESTART_TURNS), '--json',
  ], seatCommands ? {} : { env: runtimeEnvironment() })
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.observer_read.v1' || !Array.isArray(result.turns))
    throw new Error('THROUGHLINE_OBSERVER_READ_INVALID')
  return result.turns.length
}

// 短期記憶は、直前の1セッションだけでなく直近の複数セッションから作る（オーナー裁定 2026-10-05、Approval Box K-8GPX8C）。
// `--sessions recent` は Throughline 0.15.0 から。それより前の版は終了コード2で止まり、席が起きない。
export async function latestThroughlineHandoffContext(project, { run = execFileAsync, seatCommands = false } = {}) {
  const execute = seatCommands ? createSeatProcessRunner(project) : run
  const { stdout } = await execute('throughline', [
    'handoff-context', '--project', project, '--json', '--disclosure', 'silent', '--sessions', 'recent',
  ], seatCommands ? {} : { env: runtimeEnvironment() })
  const result = JSON.parse(stdout)
  if (result.schema !== 'throughline.handoff_context.v1')
    throw new Error('THROUGHLINE_HANDOFF_CONTEXT_INVALID')
  if (result.status === 'empty' && result.sessionId === null && result.context === '') return ''
  if (result.status !== 'ready'
    || typeof result.sessionId !== 'string'
    || !result.sessionId
    || typeof result.context !== 'string'
    || !result.context.trim()) throw new Error('THROUGHLINE_HANDOFF_CONTEXT_INVALID')
  return result.context.trim()
}
