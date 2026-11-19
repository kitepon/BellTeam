// a451: the one fact "which AI CLI is installed, which version" (docs/architecture/modules/usage/harness-cli.md).
// The box answers through two parent effects (probe / install); this class holds the answers, queues presses and says it in plain words.
// Nothing here is written to disk: the facts are on the box and a probe re-reads them.
import { CLI_IDS, cliNotice } from './usage/harness-cli-notice.mjs'
export { CLI_IDS, cliNotice }
const REASON = {
  CLI_INSTALL_NETWORK: '通信できませんでした。',
  CLI_INSTALL_TIMEOUT: '時間内に終わりませんでした。',
  CLI_INSTALL_UNSUPPORTED: 'このBellTeamの本体は、入れる機能にまだ対応していません。BellTeamを更新してください。',
  CLI_INSTALL_FAILED: '入れる途中で失敗しました。',
}
// A body that does not know the effects refuses them in one of these ways (Molly: ship order body first, then usage).
const UNSUPPORTED = new Set(['USAGE_IPC_INVALID', 'USAGE_EFFECT_UNSUPPORTED', 'USAGE_EFFECT_RESULT_INVALID', 'USAGE_EFFECT_INVALID'])
export const LABEL = '最新版を入れる'

const factValid = fact => fact && typeof fact === 'object' && typeof fact.installed === 'boolean'
  && (fact.version === null || typeof fact.version === 'string') && ['user', 'image', null].includes(fact.source)
const errorCode = error => UNSUPPORTED.has(error?.code) ? 'CLI_INSTALL_UNSUPPORTED' : Object.hasOwn(REASON, error?.code) ? error.code : 'CLI_INSTALL_FAILED'

export class HarnessCli {
  #facts = new Map()
  #busy = new Set()
  #errors = new Map()
  #listeners = new Set()
  #running = new Map()
  #last = new Map()
  #queue = Promise.resolve()
  #supported = true
  #probe
  #install
  #onChange

  constructor({ probe, install, onChange = () => {} }) { this.#probe = probe; this.#install = install; this.#onChange = onChange }

  // false once the body proved it cannot probe or install: usage then says nothing new (the window and the install objects are absent).
  get supported() { return this.#supported }

  state(id) {
    const fact = this.#facts.get(id)
    if (!fact) return 'checking'
    if (fact.installed) return 'installed'
    return this.#busy.has(id) ? 'installing' : this.#errors.has(id) ? 'failed' : 'not_installed'
  }

  get(id) {
    const fact = this.#facts.get(id)
    return { harness: id, state: this.state(id), version: fact?.version ?? null, source: fact?.source ?? null, busy: this.#busy.has(id) }
  }

  list() { return Object.fromEntries(CLI_IDS.map(id => [id, this.get(id)])) }
  notice(id) { return cliNotice(id, this.state(id)) }
  // Readiness for refusals: only a known absent CLI refuses; checking and a body that cannot tell let the old path run.
  absent(id) { return this.#supported && ['not_installed', 'installing', 'failed'].includes(this.state(id)) }

  // The `install` object of the app contract (every sentence is fixed here so the four apps say the same words).
  view(id) { return !this.#supported && !this.#facts.has(id) ? null : this.#build(id) }

  #build(id) {
    const now = this.get(id), error = this.#errors.get(id) ?? null
    const reason = error ? REASON[error] : ''
    const message = now.state === 'checking' ? '確認しています。'
      : now.state === 'not_installed' ? 'まだ入っていません。「最新版を入れる」で入れてください。'
        : now.state === 'installing' ? '入れています。数分かかることがあります。'
          : now.state === 'failed' ? `入れられませんでした。${reason}もう一度「最新版を入れる」を押してください。`
            : now.busy ? '最新版を入れています。今の版はそのまま使えます。'
              : error ? `前回、最新版を入れられませんでした。${reason}今の版はそのまま使えます。`
                : now.source === 'image' ? `入っています（バージョン ${now.version}）。BellTeamに最初から入っている物です。「最新版を入れる」で、最新版をあなたの領域へ入れてそちらを使います。`
                  : `入っています（バージョン ${now.version}）。「最新版を入れる」で最新版にできます。`
    const action = now.busy || now.state === 'checking' ? null : 'install'
    return { state: now.state, version: now.version, source: now.source, busy: now.busy,
      lastError: error ? { code: error, message: reason } : null, message, action, label: action ? LABEL : null }
  }

  watch(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  #emit(id) {
    const value = this.get(id), key = JSON.stringify([value, this.#errors.get(id) ?? null])
    if (this.#last.get(id) === key) return
    this.#last.set(id, key)
    try { this.#onChange(value) } catch {}
    for (const listener of this.#listeners) { try { listener(value) } catch {} }
  }

  // Asks the box. A probe that cannot be answered leaves the fact as it was; one that proves the body cannot answer ends the feature.
  async recheck(id, { quiet = false } = {}) {
    try {
      const fact = await this.#probe(id)
      if (!factValid(fact)) throw Object.assign(new Error('CLI_PROBE_INVALID'), { code: 'USAGE_EFFECT_RESULT_INVALID' })
      this.#facts.set(id, { installed: fact.installed, version: fact.version, source: fact.source })
    } catch (error) {
      if (UNSUPPORTED.has(error?.code)) this.#supported = false
    }
    if (!quiet) this.#emit(id)
    return this.get(id)
  }

  probeAll() { return Promise.all(CLI_IDS.map(id => this.recheck(id))) }

  // The press: queued one at a time; the same press on the same AI while it runs returns the same work.
  install(id) {
    if (this.#running.has(id)) return this.#running.get(id)
    this.#busy.add(id)
    this.#errors.delete(id)
    this.#emit(id)
    const work = this.#queue.then(async () => {
      try { await this.#install(id) }
      catch (error) {
        const code = errorCode(error)
        if (code === 'CLI_INSTALL_UNSUPPORTED') this.#supported = this.#facts.has(id)
        this.#errors.set(id, code)
      }
      await this.recheck(id, { quiet: true })
      this.#busy.delete(id)
      this.#emit(id)
      return this.#build(id)
    })
    this.#queue = work.catch(() => {})
    this.#running.set(id, work)
    void work.finally(() => this.#running.delete(id))
    return work
  }
}
