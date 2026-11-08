import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { aitermConnectionRegistration } from './aiterm-hooks.mjs'
import { captureRuntime } from './runtime-selection.mjs'
import { loadBotEnvironment } from './bot-environment.mjs'
import { requireSeatProject, seatCommandSpec } from './seat-command.mjs'
import { createSeatProcessRunner } from './seat-process.mjs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { runtimeEnvironment, runtimeEnvironmentKeys, runtimeHome } from './runtime-home.mjs'
import { returnedExecutionError, ERROR_META } from './execution-error.mjs'
import { authenticationPreflightFailure, unpromptedLaunchActionRequired, resumeUnavailable } from './agent-launch-error.mjs'
import { captureMcpRequest } from './mcp-request-context.mjs'
import { captureMcpError } from './returned-mcp-error.mjs'
import { configurationConnection, configurationError, markConfigurationNotIssued, CONFIGURATION_SCHEMA } from './configuration-request.mjs'

export class AitermClient {
  constructor(options = {}) {
    const { command = 'aiterm-mcp', args = [], env = runtimeEnvironment() } = options
    const seatProject = Object.hasOwn(options, 'seatProject') ? options.seatProject : null
    if (seatProject !== null) requireSeatProject(seatProject)
    this.seatProject = seatProject
    this.environmentReady = options.environmentReady ?? null
    this.command = command
    this.args = [...args]
    // harness-accounts.md E1: the parent's own Aiterm learns which account roots it may use; never a seat's env.
    // Parent clients (seatProject set) get the default; a seat launcher receives it explicitly per launch.
    this.claudeConfigRoots = options.claudeConfigRoots ?? (seatProject !== null ? join(runtimeHome(), '.bellteam-accounts', 'claude') : null)
    this.env = this.claudeConfigRoots ? { ...env, AITERM_CLAUDE_CONFIG_ROOTS: this.claudeConfigRoots } : env
    this.runtimeCapture = options.runtimeCapture ?? null
    this.client = null
    this.transport = null
    this.connecting = null
  }

  runtime() {
    const inherited = this.env?.BELLTEAM_RUNTIME_GENERATION ?? process.env.BELLTEAM_RUNTIME_GENERATION
    return this.runtimeCapture ??= captureRuntime({ generation: inherited === undefined ? undefined : inherited || null })
  }

  captureHandoffConnection() {
    if (!this.client || !this.transport || this.connecting || this.client.transport !== this.transport) return null
    const expected = Object.freeze({ sdk: this.client, transport: this.transport })
    const runtime = this.runtime()
    const load = async file => import(pathToFileURL(join((await runtime).components['runtime-aiterm-mcp'].dist, file)).href)
    const binding = { expected, currentConnection: () => {
      if (this.connecting || this.client !== expected.sdk || this.transport !== expected.transport) return null
      return { sdk: this.client, transport: this.transport }
    } }
    return Object.freeze({ ...binding,
      capture: async (input, signal) => {
        const capabilities = expected.sdk.getServerCapabilities()?.experimental
        if (!['control', 'full'].every(name => {
          const value = capabilities?.[`ai.aiterm/handoff.${name}.v1`]
          return value?.version === 1 && Object.keys(value).length === 1
        })) return { schema: 'aiterm.model-handoff.capture-error.v1', status: 'unavailable',
          error_code: 'HANDOFF_CAPTURE_UNAVAILABLE', effect: 'not_started' }
        return (await load('model-handoff-transport.js')).captureModelHandoffOverMcp(input, binding, signal)
      },
      control: async (input, signal) => (await load('model-handoff-control-transport.js')).modelHandoffOverMcp(input, binding, signal),
    })
  }

  async connect() {
    if (this.connecting) return this.connecting
    if (this.client) return
    // clientを作っただけでは初期化は終わっていない。同時の呼出しも同じ接続完了を待つ。
    this.connecting = (async () => {
      const runtime = await this.runtime()
      const registration = aitermConnectionRegistration({ command: this.command, args: this.args }, runtime)
      const generation = runtime.generation ?? ''
      const spec = this.seatProject !== null ? seatCommandSpec('/usr/bin/env',
        [`BELLTEAM_RUNTIME_GENERATION=${generation}`, registration.command, ...registration.args], { project: this.seatProject })
        : { ...registration, env: { ...this.env, BELLTEAM_RUNTIME_GENERATION: generation } }
      const client = this.client = new Client({ name: 'bellteam', version: '0.1.0' }, { capabilities: {} })
      const transport = this.transport = new StdioClientTransport({ ...spec, stderr: 'inherit' })
      client.onclose = () => {
        if (this.client === client) { this.client = null; this.transport = null }
      }
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

  async launchOptions(project, runtime = null) {
    // 席の起動は全てここを通る。そのBotのsetup.shが終わるまで待つ（終了は成功も失敗も）。
    await this.environmentReady?.(project)
    if (this.seatProject !== null) return { launchProject: requireSeatProject(project), ...(runtime ? { runtime } : {}) }
    const env = await loadBotEnvironment(project)
    return runtime ? { env: { ...env, ...runtimeLaunchEnv(runtime, env.PATH) }, runtime } : { env }
  }

  authOptions() {
    return this.seatProject !== null ? {} : { env: runtimeEnvironment() }
  }

  prepareAuthConnection() { return authCapability(this) }

  async call(name, args = {}, options = {}) {
    const { env, meta, launchProject, expectedAuthConnection, expectedConfiguration, admissionCheck, runtime } = options
    if (Object.hasOwn(options, 'admissionCheck') && (name !== 'pty_send' || typeof admissionCheck !== 'function'
      || ['env', 'launchProject', 'expectedAuthConnection', 'expectedAuthServerVersion', 'expectedConfiguration'].some(key => Object.hasOwn(options, key))))
      throw Object.assign(new Error('AITERM_SEND_GUARD_INVALID'), { code: 'AITERM_SEND_GUARD_INVALID', effect: 'not_issued' })
    const boundConfiguration = Object.hasOwn(options, 'expectedConfiguration')
    if (boundConfiguration && (!expectedConfiguration || name !== 'agent_configure' || Object.hasOwn(options, 'env')
      || Object.hasOwn(options, 'launchProject') || Object.hasOwn(options, 'expectedAuthConnection') || Object.hasOwn(options, 'expectedAuthServerVersion')))
      throw markConfigurationNotIssued(configurationError('CONFIGURATION_CONNECTION_ARGUMENTS'))
    const boundAuth = Object.hasOwn(options, 'expectedAuthConnection') || Object.hasOwn(options, 'expectedAuthServerVersion')
    if (boundAuth && (name !== 'agent_auth' || !expectedAuthConnection
      || Object.hasOwn(options, 'expectedAuthServerVersion')
      || Object.hasOwn(options, 'env') || Object.hasOwn(options, 'launchProject')))
      throw Object.assign(new Error('AITERM_AUTH_CONNECTION_ARGUMENTS'), { code: 'AITERM_AUTH_CONNECTION_ARGUMENTS', effect: 'not_issued' })
    if (this.seatProject !== null) requireSeatProject(this.seatProject)
    if (Object.hasOwn(options, 'launchProject')) {
      requireSeatProject(launchProject)
      if (this.seatProject === null || name !== 'agent_launch' || args.cwd !== launchProject
        || Object.hasOwn(options, 'env') || Object.hasOwn(args, 'env_vars'))
        throw Object.assign(new Error('SEAT_LAUNCH_ARGUMENTS'), { code: 'SEAT_LAUNCH_ARGUMENTS' })
      const { stdout } = await createSeatProcessRunner(launchProject)(process.execPath,
        [fileURLToPath(new URL('./run-seat-aiterm-launch.mjs', import.meta.url))], {
          input: JSON.stringify({ command: this.command, args: this.args, launch: args, meta, ...(runtime ? { runtime } : {}),
            ...(this.claudeConfigRoots && args.configuration_root ? { claudeConfigRoots: this.claudeConfigRoots } : {}) }),
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
      const launcher = new AitermClient({ command: this.command, args: this.args, env, claudeConfigRoots: this.claudeConfigRoots, ...(runtime ? { runtimeCapture: runtime } : {}) })
      try {
        const env_vars = Object.keys(env).filter(key => runtimeEnvironmentKeys.includes(key) || env[key] !== process.env[key])
        return await launcher.call(name, { ...args, env_vars }, { meta })
      } finally {
        await launcher.close()
      }
    }
    if (!boundAuth && !boundConfiguration) {
      try { await this.connect() } catch (error) {
        captureMcpRequest(error, 'connect', name)
        throw error
      }
    }
    const callClient = this.client
    if (boundConfiguration) configurationConnection(this, expectedConfiguration.sdk, expectedConfiguration.transport)
    if (boundAuth) authConnection(this, expectedAuthConnection)
    // An Aiterm without the account inputs would drop them silently and run on the wrong account.
    const accountInput = name === 'agent_launch' && Object.hasOwn(args, 'configuration_root') ? ['agent_launch', 'configuration_root', 'string']
      : name === 'pty_close' && args.hibernate === true ? ['pty_close', 'hibernate', 'boolean'] : null
    if (accountInput) {
      let supported = false
      try {
        const tools = await callClient.listTools()
        supported = tools.tools.some(tool => tool.name === accountInput[0] && tool.inputSchema?.properties?.[accountInput[1]]?.type === accountInput[2])
      } catch { /* Nothing was issued by the capability read. */ }
      if (!supported) throw Object.assign(new Error('ACCOUNT_CAPABILITY_UNAVAILABLE'), { code: 'ACCOUNT_CAPABILITY_UNAVAILABLE', effect: 'not_started' })
    }
    if (name === 'agent_launch' && args.require_existing_resume === true) {
      let supported = false
      try {
        const tools = await callClient.listTools()
        supported = tools.tools.some(tool => tool.name === 'agent_launch' && tool.inputSchema?.properties?.require_existing_resume?.type === 'boolean')
      } catch { /* No launch was issued by the capability read. */ }
      if (!supported) throw Object.assign(new Error('RESUME_CAPABILITY_UNAVAILABLE'), { code: 'RESUME_CAPABILITY_UNAVAILABLE', effect: 'not_started' })
    }
    let result
    admissionCheck?.()
    try { result = await callClient.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }) }
    catch (error) {
      captureMcpRequest(error, 'call', name)
      throw error
    }
    if (result.isError) {
      if (name === 'agent_configure' && expectedConfiguration && result.structuredContent?.schema === CONFIGURATION_SCHEMA) return result
      if (name === 'agent_auth'
        && ['aiterm.auth-response-error.v1', 'aiterm.auth-operation-error.v1'].includes(result.structuredContent?.schema)) return result
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
      const unavailableResume = name === 'agent_launch' && args.require_existing_resume === true
        ? resumeUnavailable(result._meta?.['aiterm/resume_unavailable'], args.session_name) : null
      if (unavailableResume) Object.assign(error, { code: unavailableResume.code, effect: unavailableResume.effect, resumeUnavailable: unavailableResume })
      if (['agent_launch', 'claude_agent'].includes(name)) {
        const preflight = authenticationPreflightFailure(result.structuredContent)
        if (preflight) {
          error.agentLaunchError = preflight
          error.code = preflight.code
        }
      }
      const executionError = returnedExecutionError(result._meta?.[ERROR_META])
      if (executionError) error.executionError = executionError
      const resume = result.structuredContent
      if (name === 'pty_send' && !executionError && resume?.schema === 'aiterm.agent-resume-error.v1'
        && Object.keys(resume).sort().join(',') === 'code,input,launch_id,recovery,schema,session_id'
        && ['AGENT_RESUME_UNCONFIRMED', 'AGENT_RESUME_FAILED'].includes(resume.code)
        && /^[A-Za-z0-9_-]{1,64}$/u.test(resume.session_id ?? '') && resume.session_id === args.session_id
        && typeof resume.launch_id === 'string' && /^[a-f0-9]{32}$/u.test(resume.launch_id)
        && resume.input === 'not_sent' && resume.recovery === 'inspect_session') {
        error.agentResumeResult = structuredClone(resume)
        error.code = 'BOT_INPUT_NOT_READY'
        error.status = 409
        error.publicMessage = 'このBotの復帰状態を確認できないため、今回のメッセージは送信されませんでした。再送せず、席の状態を確認してください。'
      }
      // 起動の準備が終わらなかった時、Aitermは作った端末の名前と止まった理由を構造で返す（aiterm.agent-launch-result.v1）。
      if (name === 'agent_launch' && result.structuredContent?.schema === 'aiterm.agent-launch-result.v1') {
        error.launch = result.structuredContent
        if (!executionError && unpromptedLaunchActionRequired(error.launch, args)) {
          error.launchActionRequired = true
          error.code = 'BOT_INPUT_NOT_READY'
          error.status = 409
          error.publicMessage = 'このBotのAIは起動時の確認が必要です。今回のメッセージは送信されませんでした。AIの認証・初期設定を確認してください。'
          error.message = error.publicMessage
        }
      }
      if (name === 'pty_send' && ['STEER_NOT_QUEUED', 'STEER_STILL_QUEUED'].some(code =>
        message.startsWith(`aiterm: ${code} vendor=`))) {
        error.code = 'BOT_SEND_OUTCOME_UNKNOWN'
        error.publicMessage = 'メッセージを受け付けたか確認できません。重複送信を避けるため、会話を確認してから再送してください。'
      }
      // Aitermが未送信を明示した入力受付の拒否は、その席の状態との衝突。
      // その他の送信失敗や受付後の不明な結果まで成功・未送信と決めない。
      if (name === 'pty_send'
        && ['', 'AGENT_INPUT_NOT_READY: ', 'AGENT_INPUT_TARGET_UNAVAILABLE: '].some(prefix =>
          message.startsWith(`aiterm: ${prefix}agent session '${args.session_id}' の `))
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

const prepared = new WeakMap()
const authConnectionError = code => Object.assign(new Error(code), { code, effect: 'not_issued' })
const unavailable = () => authConnectionError('AITERM_AUTH_CAPABILITY_UNCONFIRMED')
const variants = schema => {
  const values = schema?.anyOf ?? schema?.oneOf ?? [schema]
  return Array.isArray(values) ? values : []
}
const type = (schema, name) => variants(schema).some(value => value?.type === name || Array.isArray(value?.type) && value.type.includes(name))
const literal = (schema, value) => schema?.const === value || Array.isArray(schema?.enum) && schema.enum.includes(value)
const includes = (schema, values) => Array.isArray(schema?.enum) && values.every(value => schema.enum.includes(value))
const fields = (schema, names) => schema?.type === 'object' && schema.additionalProperties === false
  && Object.keys(schema.properties ?? {}).sort().join(',') === [...names].sort().join(',')
  && Array.isArray(schema.required) && names.every(name => schema.required.includes(name))
const strings = ['session_id', 'metadata_identity', 'native_id', 'pane_id', 'server_started', 'pane_started']
function binding(schema) {
  const p = schema?.properties
  return fields(schema, [...strings, 'launch_id', 'server_pid', 'pane_pid'])
    && strings.every(name => p[name]?.type === 'string')
    && type(p.launch_id, 'string') && type(p.launch_id, 'null')
    && ['server_pid', 'pane_pid'].every(name => p[name]?.type === 'integer'
      && (p[name].exclusiveMinimum === 0 || p[name].minimum >= 1))
}
function compatible(tool) {
  const p = tool?.inputSchema?.properties, out = tool?.outputSchema?.properties, ui = out?.auth_ui?.properties
  const response = variants(p?.response)
  return includes(p?.action, ['start', 'status', 'cancel', 'respond'])
    && includes(p?.harness, ['claude-code']) && p.session_id?.type === 'string' && p.relogin?.type === 'boolean'
    && binding(p.expected_binding) && p.expected_prompt_digest?.type === 'string'
    && ['^[a-f0-9]{64}$', '^[0-9a-f]{64}$'].includes(p.expected_prompt_digest.pattern)
    && response.some(s => fields(s, ['kind', 'value']) && literal(s.properties.kind, 'authorization_code')
      && s.properties.value?.type === 'string' && s.properties.value.minLength >= 1
      && s.properties.value.maxLength <= 8192 && s.properties.value.pattern === '^[!-~]+$')
    && response.some(s => fields(s, ['kind', 'id']) && literal(s.properties.kind, 'choice')
      && s.properties.id?.type === 'string' && s.properties.id.pattern === '^option-[1-9]$')
    && literal(out?.schema, 'aiterm.agent-auth-result.v1')
    && ['schema', 'harness', 'status', 'session_id', 'url', 'user_code', 'input_required', 'message'].every(name => tool.outputSchema.required?.includes(name))
    && out?.input_required?.type === 'boolean'
    && ['session_id', 'url', 'user_code', 'message'].every(name => type(out?.[name], 'string') && type(out?.[name], 'null'))
    && includes(out?.status, ['waiting', 'authenticated', 'blocked', 'failed'])
    && literal(ui?.schema, 'aiterm.auth-ui.v1')
    && ['schema', 'stage', 'title', 'message', 'binding', 'url', 'user_code', 'input', 'prompt_digest', 'choices'].every(name => out.auth_ui.required?.includes(name))
    && includes(ui?.stage, ['open_url', 'device_code', 'paste_code', 'select', 'waiting', 'complete', 'failed', 'unavailable'])
    && variants(ui?.binding).some(binding) && type(ui?.binding, 'null')
    && ['authorization_code', 'choice', null].every(value => variants(ui?.input).some(s => literal(s, value) || value === null && s?.type === 'null'))
    && type(ui?.prompt_digest, 'string') && type(ui?.prompt_digest, 'null')
    && ui?.choices?.type === 'array' && fields(ui.choices.items, ['id', 'label'])
    && ['id', 'label'].every(name => ui.choices.items.properties[name]?.type === 'string')
}
function sameConnection(client, sdk, transport, pid) {
  if (!sdk || client.client !== sdk || client.transport !== transport || client.connecting || !transport
    || sdk.transport !== transport || !Number.isSafeInteger(pid) || pid <= 0 || transport.pid !== pid
    || sdk.getServerVersion?.()?.name !== 'aiterm')
    throw authConnectionError('AITERM_AUTH_CONNECTION_UNCONFIRMED')
}
function authConnection(client, sdk) {
  const evidence = prepared.get(sdk)
  if (!evidence) {
    sameConnection(client, sdk, client.transport, client.transport?.pid)
    throw unavailable()
  }
  if (evidence.owner !== client) throw authConnectionError('AITERM_AUTH_CONNECTION_UNCONFIRMED')
  sameConnection(client, sdk, evidence.transport, evidence.pid)
}
async function authCapability(client) {
  await client.connect()
  const sdk = client.client, transport = client.transport, pid = transport?.pid
  sameConnection(client, sdk, transport, pid)
  let cursor, found
  const cursors = new Set()
  for (let page = 0; page < 16; page++) {
    let result
    try { result = await sdk.listTools(cursor ? { cursor } : {}) } catch { throw unavailable() }
    sameConnection(client, sdk, transport, pid)
    if (!Array.isArray(result?.tools)) throw unavailable()
    for (const tool of result.tools) if (tool?.name === 'agent_auth') {
      if (found) throw unavailable()
      found = tool
    }
    if (!result.nextCursor) { cursor = null; break }
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw unavailable()
    cursor = result.nextCursor; cursors.add(cursor)
  }
  if (cursor || !compatible(found)) throw unavailable()
  prepared.set(sdk, { owner: client, transport, pid })
  return sdk
}

// Z-b2 C3: Aiterm resolves CODEX_BIN/CLAUDE_BIN and PATH from the launcher MCP's own process.env,
// so these are set before that short-lived process starts. Only release components change tool resolution:
// a builtin capture leaves the Bot's own PATH order (.local/bin, node_modules/.bin, env.sh) untouched.
export function runtimeLaunchEnv(runtime, path = '') {
  const { components } = runtime
  const release = id => components[id].origin === 'release' ? components[id] : null
  // Release prefixes hold only their own package's bins, so prepending them shadows nothing else.
  const dirs = [...new Set(Object.keys(components).filter(release).flatMap(id => Object.values(components[id].bin).map(bin => dirname(bin))))]
  return {
    ...(release('runtime-codex') ? { CODEX_BIN: components['runtime-codex'].bin.codex } : {}),
    ...(release('runtime-claude-code') ? { CLAUDE_BIN: components['runtime-claude-code'].bin.claude } : {}),
    ...(dirs.length ? { PATH: [...dirs, ...(path ? [path] : [])].join(':') } : {}),
    // '' = builtin; unset would let later hooks/lazy MCP follow a newer selection mid-session (runtime-exec.mjs).
    BELLTEAM_RUNTIME_GENERATION: runtime.generation ?? '',
  }
}
