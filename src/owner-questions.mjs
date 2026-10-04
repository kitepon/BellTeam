// Botがオーナーへ裁定や選択を求める選択肢カード（オーナー裁定 2026-10-01）。
// Botは待たずにターンを終え、オーナーの答えは通常のオーナーからのメッセージとしてBotへ届く。
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class OwnerQuestions {
  constructor({ root, bots, notify, onRequest = () => {}, now = () => new Date().toISOString(), id = randomUUID }) {
    this.directory = join(root, 'state/owner-questions')
    this.bots = bots
    this.notify = notify
    this.onRequest = onRequest
    this.now = now
    this.id = id
    this.items = new Map()
    this.busy = new Set()
    this.events = new EventEmitter()
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json')) continue
      const item = JSON.parse(await readFile(join(this.directory, file), 'utf8'))
      this.items.set(item.id, item)
    }
  }

  get(id) {
    const item = this.items.get(id)
    if (!item) throw new Error('OWNER_QUESTION_NOT_FOUND')
    return { ...item }
  }

  async create({ botId, question, options, allowOther = true }) {
    await this.bots.refresh?.()
    if (!this.bots.has(botId)) throw new Error('BOT_NOT_FOUND')
    const choices = Array.isArray(options) ? options.map(option => typeof option === 'string' ? option.trim() : '') : []
    if (typeof question !== 'string' || !question.trim() || question.length > 2000
      || choices.length < 2 || choices.length > 8 || choices.some(option => !option || option.length > 200)
      || new Set(choices).size !== choices.length || typeof allowOther !== 'boolean') {
      throw new Error('OWNER_QUESTION_INVALID')
    }
    const item = {
      id: this.id(), botId, question: question.trim(), options: choices, allowOther,
      at: this.now(), status: 'open',
    }
    await this.save(item)
    this.onRequest(this.get(item.id))
    return this.get(item.id)
  }

  timeline({ botId }) {
    return [...this.items.values()]
      .filter(item => item.botId === botId)
      .map(item => ({
        id: item.id, kind: 'owner_question', direction: 'incoming', at: item.at,
        message: item.question,
        sender: { id: item.botId, name: this.bots.get(item.botId)?.name ?? item.botId },
        owner_question: { ...item },
      }))
  }

  watch(listener) {
    this.events.on('change', listener)
    return () => this.events.off('change', listener)
  }

  // 選択肢を選ぶ時はchoice、「その他」で書く時はtextを渡す。
  async answer(id, { choice = null, text = null } = {}) {
    const item = this.get(id)
    if (item.status !== 'open' || this.busy.has(id)) throw new Error('OWNER_QUESTION_CLOSED')
    const answer = typeof choice === 'string' && item.options.includes(choice) ? choice
      : item.allowOther && typeof text === 'string' && text.trim() && text.length <= 4000 ? text.trim() : null
    if (!answer) throw new Error('OWNER_QUESTION_ANSWER_INVALID')
    this.busy.add(id)
    try {
      const answered = { ...item, status: 'answered', answer, answeredAt: this.now(), other: answer !== choice }
      await this.save(answered)
      await this.notify(answered)
      return this.get(id)
    } finally {
      this.busy.delete(id)
    }
  }

  async save(item) {
    const path = join(this.directory, `${item.id}.json`)
    await writeFile(`${path}.tmp`, JSON.stringify(item), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    this.items.set(item.id, item)
    this.events.emit('change')
  }
}

export function ownerAnswerMessage(item) {
  return `あなたが選択肢で尋ねた「${item.question}」への回答です。\n\n${item.answer}`
}
