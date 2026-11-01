import { fileURLToPath } from 'node:url'
import { loadBotEnvironment } from './bot-environment.mjs'
import { requireSeatProject, seatCommandSpec } from './seat-command.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { runtimeEnvironment, runtimeEnvironmentKeys } from './runtime-home.mjs'
import { returnedExecutionError, ERROR_META } from './execution-bridge.mjs'
import { authenticationPreflightFailure } from './agent-launch-error.mjs'
import { captureMcpError } from './returned-mcp-error.mjs'

export class AitermClient {
  constructor(options = {}) {
    const { command = 'aiterm-mcp', args = [], env = runtimeEnvironment() } = options
    const seatProject = Object.hasOwn(options, 'seatProject') ? options.seatProject : null
    if (seatProject !== null) requireSeatProject(seatProject)
    this.seatProject = seatProject
    this.command = command
    this.args = [...args]
    this.env = env
    this.client = null
    this.transport = null
    this.connecting = null
  }

  async connect() {
    if (this.connecting) return this.connecting
    if (this.client) return
    const spec = this.seatProject !== null ? seatCommandSpec(this.command, this.args, { project: this.seatProject })
      : { command: this.command, args: this.args, ...(this.env ? { env: this.env } : {}) }
    this.client = new Client({ name: 'bellteam', version: '0.1.0' }, { capabilities: {} })
    this.transport = new StdioClientTransport({ ...spec, stderr: 'inherit' })
    const client = this.client
    const transport = this.transport
    client.onclose = () => {
      if (this.client === client) {
        this.client = null
        this.transport = null
      }
    }
    // clientを作っただけでは初期化は終わっていない。同時の呼出しも同じ接続完了を待つ。
    this.connecting = (async () => {
      try {
        await client.connect(transport)
      } catch (error) {
        // 失敗した接続を次の要求へ持ち越さない。この要求そのものを自動再送はしない。
        await transport.close().catch(() => {})
        this.client = null
        this.transport = null
        throw error
      }
    })()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async launchOptions(project) {
    return this.seatProject !== null ? { launchProject: requireSeatProject(project) }
      : { env: await loadBotEnvironment(project) }
  }

  authOptions() {
    return this.seatProject !== null ? {} : { env: runtimeEnvironment() }
  }

  async call(name, args = {}, options = {}) {
    const { env, meta, launchProject } = options
    if (this.seatProject !== null) requireSeatProject(this.seatProject)
    if (Object.hasOwn(options, 'launchProject')) {
      requireSeatProject(launchProject)
      if (this.seatProject === null || name !== 'agent_launch' || args.cwd !== launchProject
        || Object.hasOwn(options, 'env') || Object.hasOwn(args, 'env_vars'))
        throw Object.assign(new Error('SEAT_LAUNCH_ARGUMENTS'), { code: 'SEAT_LAUNCH_ARGUMENTS' })
      const { stdout } = await createSeatProcessRunner(launchProject)(process.execPath,
        [fileURLToPath(new URL('./run-seat-aiterm-launch.mjs', import.meta.url))], {
          input: JSON.stringify({ command: this.command, args: this.args, launch: args, meta }),
        })
      const response = JSON.parse(stdout)
      if (response.error) throw Object.assign(new Error(response.error.message), response.error)
      if (!response.result || !Array.isArray(response.result.content)) throw new Error('SEAT_LAUNCH_RESULT_INVALID')
      return response.result
    }
    if (env) {
      // Per-target launch environment needs the seat-side loading contract too.
      // Do not silently serialize a server-evaluated environment across this boundary.
      if (this.seatProject !== null) throw new Error('SEAT_DYNAMIC_ENV_UNWIRED')
      // Aitermは値ではなくMCPプロセスの変数名を受け取る。起動ごとに専用の短命接続を使う。
      const launcher = new AitermClient({ command: this.command, args: this.args, env })
      try {
        const env_vars = Object.keys(env).filter(key => runtimeEnvironmentKeys.includes(key) || env[key] !== process.env[key])
        return await launcher.call(name, { ...args, env_vars }, { meta })
      } finally {
        await launcher.close()
      }
    }
    await this.connect()
    const result = await this.client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })
    if (result.isError) {
      if (name === 'agent_auth' && result.structuredContent?.schema === 'aiterm.auth-response-error.v1') return result
      const message = textResult(result) || `AITERM_TOOL_FAILED: ${name}`
      const detail = captureMcpError(name, message, args)
      const error = new Error(detail?.message ?? message)
      if (detail) { error.mcp_error = detail; error.publicMessage = detail.message }
      // tool handlerがエラー結果を返し終えた事と、RPC timeout/通信断で結果が不明な事を区別する。
      error.aitermResponseReturned = true
      if (name === 'agent_configure' && result.structuredContent?.schema === 'aiterm.agent-configure-error.v1') {
        const failure = result.structuredContent
        const valid = Object.keys(failure).sort().join(',') === 'effect,outcome,schema,session_id'
          && failure.session_id === args.session_id
          && (failure.outcome === 'not_applied' && failure.effect === 'not_started'
            || failure.outcome === 'outcome_unknown' && failure.effect === 'possible')
        error.agentConfigureResult = valid ? structuredClone(failure) : null
      }
      if (name === 'agent_goal' && ['aiterm.agent-goal-result.v1', 'aiterm.agent-goal-result.v2'].includes(result.structuredContent?.schema))
        error.agentGoalResult = result.structuredContent
      if (['agent_launch', 'claude_agent'].includes(name)) {
        const preflight = authenticationPreflightFailure(result.structuredContent)
        if (preflight) {
          error.agentLaunchError = preflight
          error.code = preflight.code
        }
      }
      const executionError = returnedExecutionError(result._meta?.[ERROR_META])
      if (executionError) error.executionError = executionError
      // 起動の準備が終わらなかった時、Aitermは作った端末の名前と止まった理由を構造で返す（aiterm.agent-launch-result.v1）。
      if (name === 'agent_launch' && result.structuredContent?.schema === 'aiterm.agent-launch-result.v1')
        error.launch = result.structuredContent
      if (name === 'pty_send' && ['STEER_NOT_QUEUED', 'STEER_STILL_QUEUED'].some(code =>
        message.startsWith(`aiterm: ${code} vendor=`))) {
        error.code = 'BOT_SEND_OUTCOME_UNKNOWN'
        error.publicMessage = 'メッセージを受け付けたか確認できません。重複送信を避けるため、会話を確認してから再送してください。'
      }
      // Aitermが未送信を明示した入力受付の拒否は、その席の状態との衝突。
      // その他の送信失敗や受付後の不明な結果まで成功・未送信と決めない。
      if (name === 'pty_send'
        && message.startsWith(`aiterm: agent session '${args.session_id}' の `)
        && message.includes(' TUI が入力受付状態になりません。文字列は送信していません。')) {
        error.code = 'BOT_INPUT_NOT_READY'
        error.status = 409
        error.publicMessage = 'このBotは現在入力を受け付けられず、メッセージは送信されませんでした。Botの画面を確認してください。'
      }
      // 席の登録が無いsessionを、Aitermが打つ前に断った（require_agent、Aiterm 0.52.0）。送っていないので、起こし直して送り直せる。
      if (name === 'pty_send'
        && message.startsWith('aiterm: AGENT_SESSION_REQUIRED:')
        && message.includes('文字列は送信していません。')) error.code = 'AGENT_SESSION_REQUIRED'
      // 同じ席への先の送信が終わるのを待ち切れず、Aitermが打つ前に断った（Aiterm 0.52.1、待ちは60秒）。
      // 登録を確かめた後の断りなので席は生きている。送っていないので、後から送り直せる。
      if (name === 'pty_send'
        && message.startsWith(`aiterm: AGENT_SEND_BUSY: agent session '${args.session_id}' は`)
        && message.includes('文字列は送信していません。')) {
        error.code = 'BOT_SEND_BUSY'
        error.status = 409
        error.publicMessage = 'このBotは先に届いた送信を受け付けている途中で、メッセージは送信されませんでした。少し待ってから送り直してください。'
      }
      throw error
    }
    return result
  }

  async close() {
    await this.transport?.close()
    this.client = null
    this.transport = null
  }
}

export function textResult(result) {
  return result?.content?.find(item => item.type === 'text')?.text ?? ''
}
