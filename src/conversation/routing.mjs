const endpoint = 'https://api.typesafe.ai/v1/systemone'
const failure = code => Object.assign(new Error(code), { code })
function state(value, credential = false) {
  const keys = ['enabled', 'epoch', ...(credential ? ['apiKey'] : [])]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || credential && !(value.apiKey === null || typeof value.apiKey === 'string' && value.apiKey.length > 0))
    throw failure('CONVERSATION_ROUTING_INPUT_INVALID')
}

export class ConversationRouting {
  #known = false
  #state = { enabled: false, epoch: 0 }
  #active = new Set()

  constructor({ read, fetcher = fetch }) {
    this.read = read
    this.fetcher = fetcher
  }

  changed(value) {
    state(value)
    if (this.#known && (value.epoch < this.#state.epoch
      || value.epoch === this.#state.epoch && value.enabled !== this.#state.enabled))
      throw failure('CONVERSATION_ROUTING_STALE')
    if (!this.#known || value.epoch !== this.#state.epoch) {
      for (const reference of this.#active) { reference.valid = false; reference.apiKey = null }
      this.#state = { ...value }
      this.#known = true
    }
    return { applied: true, epoch: value.epoch }
  }

  snapshot() { return { ...this.#state } }

  async withRouting(context, operation) {
    let value = await this.read(context)
    state(value, true)
    if (this.#known && (value.epoch < this.#state.epoch
      || value.epoch === this.#state.epoch && value.enabled !== this.#state.enabled)) {
      value = null
      throw failure('CONVERSATION_ROUTING_STALE')
    }
    this.changed({ enabled: value.enabled, epoch: value.epoch })
    const reference = { ...value, valid: true }
    value = null
    this.#active.add(reference)
    const check = () => {
      if (!reference.valid || reference.epoch !== this.#state.epoch || reference.enabled !== this.#state.enabled)
        throw failure('CONVERSATION_ROUTING_STALE')
    }
    const configuration = { enabled: reference.enabled, epoch: reference.epoch,
      fetcher: (url, options) => {
        check()
        if (!reference.enabled || !reference.apiKey) throw failure('JEV_API_KEY_MISSING')
        if (String(url) !== endpoint) throw failure('CONVERSATION_ROUTING_ENDPOINT_INVALID')
        return this.fetcher(url, options)
      } }
    Object.defineProperty(configuration, 'apiKey', { get: () => { check(); return reference.apiKey } })
    Object.freeze(configuration)
    try { return await operation(configuration) }
    finally {
      reference.apiKey = null
      reference.valid = false
      this.#active.delete(reference)
    }
  }
}
