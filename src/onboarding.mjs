import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runtimeEnvironment } from './runtime-home.mjs'
import guide from '../config/setup-guide.json' with { type: 'json' }

const HARNESS = { claude: 'claude-code', codex: 'codex-cli', grok: 'grok-cli', cursor: 'cursor-cli' }
const HARNESSES = Object.entries({ claude: 'Claude', codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }).map(([id, name]) => ({ id, name }))
export const GUIDE_BOT_ID = 'bot-guide'
export const GUIDE_INSTRUCTIONS = `あなたはBellTeamの初期設定を案内するメンバーです。最初に利用者へ挨拶し、BellTeamで何をしたいか一つ尋ねてください。\n追加機能の現在の状態はget_settings、設定の更新はupdate_settingsを使います。必要な機能だけ有効にし、不要・未設定の機能は無効のままにします。設定の入力値を推測で作らず、外部サービスの準備が必要な場合は公式手順を調べて利用者と進めます。\nAPIキーや合言葉はrequest_secret(toolId="bellteam-settings")で専用入力を依頼してください。提出後に届くrequestIdをupdate_settingsのsecretRequestIdへ渡せます。値を表示したり、会話へ書いたりしないでください。\n利用者が希望した設定の実動作を確認し、利用者と初期設定が済んだと合意したらcomplete_setupを使います。Webアプリと共有サーバーでの会話や予定は無料で使えます。Appleアプリでも初期設定の案内と閲覧・書き出し・管理は無料です。初期設定後のAppleアプリからの会話と予定操作には購読が必要で、購入・復元はAppleアプリの設定から行います。`

export class OnboardingError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status }
}

export class Onboarding {
  constructor({ root, bots, client, subscriptions, startConversation }) {
    this.path = join(root, 'shared/onboarding.json')
    this.bots = bots
    this.client = client
    this.subscriptions = subscriptions
    this.startConversation = startConversation
    this.state = { harness: null, guideBotId: null, authSession: null, started: false, complete: false }
    this.auth = null
    this.pending = Promise.resolve()
  }

  async initialize() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'))
      if (state.schema !== 'bellteam.onboarding.v1' || (state.harness !== null && !Object.hasOwn(HARNESS, state.harness))
        || typeof state.started !== 'boolean' || typeof state.complete !== 'boolean'
        || !(state.guideBotId === null || typeof state.guideBotId === 'string')
        || !(state.authSession === null || typeof state.authSession === 'string')) throw new OnboardingError('SETUP_STATE_INVALID', 500, '初期設定の保存内容を読み取れません。')
      this.state = state
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // 既存の利用環境では初回設定を要求せず、現在のメンバーを保持する。
      if (this.bots.size) this.state = { ...this.state, started: true, complete: true }
      await this.save()
    }
  }

  snapshot() {
    return {
      phase: this.state.started ? 'ready' : this.state.harness ? 'authenticate' : 'select_harness',
      harness: this.state.harness, harnesses: HARNESSES, guideBotId: this.state.guideBotId,
      complete: this.state.complete, auth: this.auth && {
        status: this.auth.status, url: this.auth.url, user_code: this.auth.user_code,
        input_required: this.auth.input_required, message: this.auth.message,
      },
    }
  }

  status() {
    return this.change(async () => {
      if (this.state.harness && !this.state.started) await this.callAuth('status')
      return this.snapshot()
    })
  }

  select(harness) {
    return this.change(async () => {
      if (!Object.hasOwn(HARNESS, harness)) throw new OnboardingError('SETUP_HARNESS_INVALID', 400, '使うAIを選んでください。')
      if (this.state.started) throw new OnboardingError('SETUP_ALREADY_STARTED', 409, '案内役との会話は開始済みです。メンバーの設定からAIを変更してください。')
      if (this.state.authSession) await this.callAuth('cancel')
      this.state.harness = harness
      this.state.authSession = null
      await this.save()
      const existing = this.bots.get(GUIDE_BOT_ID)
      const bot = existing ? await this.bots.update(existing.id, { harness }) : await this.bots.create({ ...guide, harness }, { id: GUIDE_BOT_ID })
      this.state.guideBotId = bot.id
      await this.save()
      await this.callAuth('start')
      this.state.authSession = this.auth.session_id
      await this.save()
      return this.snapshot()
    })
  }

  input({ text, key }) {
    return this.change(async () => {
      if (!this.state.authSession || this.state.started) throw new OnboardingError('SETUP_AUTH_NOT_RUNNING', 409, '公式認証を開始してください。')
      if ((typeof text === 'string') === (typeof key === 'string')) throw new OnboardingError('SETUP_AUTH_INPUT_INVALID', 400, '認証の入力またはキーを指定してください。')
      if (text !== undefined) await this.client.call('pty_send', { session_id: this.state.authSession, text, enter: true, raw: true })
      else await this.client.call('pty_key', { session_id: this.state.authSession, key })
      await this.callAuth('status')
      return this.snapshot()
    })
  }

  start() {
    return this.change(async () => {
      if (this.state.started) return this.snapshot()
      if (!this.state.harness || !this.state.guideBotId) throw new OnboardingError('SETUP_HARNESS_REQUIRED', 409, '最初に使うAIを選んでください。')
      await this.callAuth('status')
      if (this.auth.status !== 'authenticated') throw new OnboardingError('SETUP_AUTH_REQUIRED', 409, this.auth.message || '公式認証を完了してから確認してください。')
      if (this.state.authSession) {
        const authenticated = this.auth
        await this.callAuth('cancel')
        this.auth = authenticated
        this.state.authSession = null
        await this.save()
      }
      const bot = this.bots.get(this.state.guideBotId)
      if (!bot) throw new OnboardingError('SETUP_GUIDE_MISSING', 500, '初期設定の案内役が見つかりません。')
      await this.startConversation(bot, GUIDE_INSTRUCTIONS)
      this.state.started = true
      await this.save()
      return this.snapshot()
    })
  }

  async prepareStartup(bot) {
    if (bot.id === this.state.guideBotId && !this.state.complete)
      await appendFile(join(bot.project, 'AGENTS.md'), `\n# 初期設定の案内\n\n${GUIDE_INSTRUCTIONS}\n`)
  }

  complete(botId = this.state.guideBotId) {
    return this.change(async () => {
      if (!this.state.started || botId !== this.state.guideBotId) throw new OnboardingError('SETUP_GUIDE_REQUIRED', 409, '案内役と初期設定を進めてください。')
      await this.subscriptions.completeSetup(botId)
      this.state.complete = true
      await this.save()
      return this.snapshot()
    })
  }

  async callAuth(action) {
    const result = await this.client.call('agent_auth', {
      harness: HARNESS[this.state.harness], action,
      ...(this.state.authSession ? { session_id: this.state.authSession } : {}),
      ...(this.state.guideBotId ? { cwd: this.bots.get(this.state.guideBotId)?.project } : {}),
    }, { env: runtimeEnvironment() })
    const receipt = result.structuredContent
    if (receipt?.schema !== 'aiterm.agent-auth-result.v1' || !['waiting', 'authenticated', 'blocked', 'failed'].includes(receipt.status))
      throw new OnboardingError('SETUP_AUTH_RESPONSE_INVALID', 502, 'Aitermの公式認証の応答を読み取れません。')
    this.auth = receipt
  }

  change(run) { const result = this.pending.then(run, run); this.pending = result; return result }
  async save() {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path + '.tmp', JSON.stringify({ schema: 'bellteam.onboarding.v1', ...this.state }) + '\n', { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }
}
