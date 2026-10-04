// Botのターンが終わった時に、オーナーへの報告が漏れていないかを確かめ、漏れていればBotへ報告を頼む（オーナー裁定 2026-10-01）。
// 1. 処理漏れ：そのターンでオーナーの会話画面に何も残っていない。コードで判定する。
// 2. 中身の漏れ：メンバーへ送ったメッセージの要点が、オーナーへの言葉に入っていない。Jevで判定する。
import { randomUUID } from 'node:crypto'

// 2026-09-28〜30の実際の44ターンで決めた（ドリリー・ハランの漏れを拾い、誤判定は1件）。
export const OUTCOME_MIN = 0.35
export const SUBSTANCE_MIN = 0.5

const OWNER_VIEW = '(`owner_view.progress_notes`, `owner_view.messages_to_owner`, and `owner_view.final_message`)'

export class TurnReports {
  constructor({ bots, store, transport, appendInterimWords, judge = judgeOwnerReport, enabled = () => true, report = message => process.stderr.write(`${message}\n`), messageId = randomUUID }) {
    this.bots = bots
    this.store = store
    this.transport = transport
    this.appendInterimWords = appendInterimWords
    this.judge = judge
    this.enabled = enabled
    this.report = report
    this.messageId = messageId
  }

  // 配送の完了を止めないよう、呼び出し側は待たない。失敗は記録だけして、報告は頼まない。
  afterTurn(turn) {
    return this.check(turn).catch(error => this.report(`BellTeam turn report: ${turn.botId} を確かめられませんでした（${error.message}）`))
  }

  async check({ botId, context, startedAt, endedAt }) {
    const bot = this.bots.get(botId)
    if (!bot) return null
    const { ownerView, memberMessages } = turnView(await this.store.entries(), { botId, startedAt, endedAt, names: id => this.bots.get(id)?.name ?? id })
    const shown = ownerView.progress_notes.length || ownerView.messages_to_owner.length || ownerView.final_message
    // ルームの発言はオーナーもルームで読める。黙る指示に従ったターンも漏れではない。
    if (!shown && context !== 'room') return this.requestReport(bot, 'missing', [])
    if (!memberMessages.length || !this.enabled()) return null
    const { outcome, substance } = await this.judge({ ownerView, memberMessages })
    if (outcome >= OUTCOME_MIN && substance >= SUBSTANCE_MIN) return null
    return this.requestReport(bot, 'content', [...new Set(memberMessages.map(message => message.to))])
  }

  async requestReport(bot, reason, recipients) {
    const groupId = this.messageId()
    const message = reportRequestMessage(reason, recipients)
    // この依頼で始まるターンは確かめない（onTurnEndを渡さない）。返事はそのBotの会話画面にだけ出す。
    await this.transport.notify(bot, message, {
      queue: { context: 'report', contextId: bot.id, groupId, from: 'bellteam', fromName: 'BellTeam', target: bot.id, message },
      onInterim: words => this.appendInterimWords(bot.id, groupId, words),
      onAnswer: text => this.appendInterimWords(bot.id, groupId, [{ text, kind: 'answer' }]),
    })
    return { reason, recipients, groupId }
  }
}

// ターンの間にオーナーの会話画面へ出たものと、メンバーへ送ったものを集める。
export function turnView(records, { botId, startedAt, endedAt, names = id => id }) {
  const within = record => record.at >= startedAt && record.at <= endedAt
  const notes = []
  const toOwner = []
  const memberMessages = []
  for (const record of records) {
    if (!within(record)) continue
    if (record.schema === 'bellteam.interim-word.v1' && record.bot === botId) {
      notes.push({ at: record.at, text: record.text, final: record.kind === 'answer' })
    } else if (record.schema === 'bellteam.direct-message.v1' && record.from === botId) {
      if (record.target === 'user') toOwner.push({ at: record.at, text: record.message })
      else memberMessages.push({ to: names(record.target), text: record.message })
    }
  }
  const finals = [...notes.filter(note => note.final), ...toOwner].sort((a, b) => a.at.localeCompare(b.at))
  const final = finals.at(-1) ?? null
  return {
    ownerView: {
      progress_notes: notes.filter(note => !note.final).map(note => note.text),
      messages_to_owner: toOwner.filter(item => item !== final).map(item => item.text),
      final_message: final?.text ?? '',
    },
    memberMessages,
  }
}

export function reportRequestMessage(reason, recipients) {
  const body = reason === 'missing'
    ? '直前のターンでは、オーナーの会話画面に何も残りませんでした。そのターンでしたこと、メンバーとやりとりした内容、決まったことを、オーナーへ自分の言葉で伝えてください。'
    : `直前のターンで${recipients.map(name => `「${name}」`).join('、')}へ送った内容が、オーナーへの言葉に入っていませんでした。送った内容の要点（答え・結果・決めたこと・頼んだこと）を、オーナーへ自分の言葉で伝えてください。`
  return `BellTeamからの確認です。${body}この返事はそのままオーナーの会話画面に出ます。`
}

// TypeSafeのJev（https://docs.typesafe.ai/api）。Jevの主な学習言語は英語なので、問いは英語で書き、会話は原文のまま渡す。
export async function judgeOwnerReport({ ownerView, memberMessages, fetcher = fetch, apiKey = process.env.TYPESAFE_API_KEY }) {
  if (!apiKey) throw new Error('JEV_API_KEY_MISSING')
  const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: { owner_view: ownerView, member_messages: memberMessages },
      questions: {
        outcome: {
          type: 'noul',
          instructions: `Do the owner-facing messages ${OWNER_VIEW} tell the owner what came out of the exchange in \`member_messages\`: the answers given, results reported, conclusions reached, decisions made, or requests made to other members?`,
          criteria: {
            true: 'Reading only the owner-facing messages, the owner learns the substance of what was said to other members. A brief summary in different words counts.',
            false: 'The substance is only in `member_messages`. The owner-facing messages just say that something was sent or reported, or leave out what was said.',
          },
        },
        substance: {
          type: 'noul',
          instructions: 'Does `owner_view.final_message` itself state something concrete: a result, an answer, a finding, a decision, a status, or a request to the owner?',
          criteria: {
            true: 'It states at least one concrete result, answer, finding, decision, status, or request.',
            false: 'It only says that a message was sent, received, or recorded, or that the writer is waiting, with nothing concrete.',
          },
        },
      },
    }),
  })
  if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`)
  const result = await response.json()
  const outcome = result?.answers?.outcome?.noul
  const substance = result?.answers?.substance?.noul
  if (![outcome, substance].every(value => typeof value === 'number' && value >= 0 && value <= 1)) throw new Error('JEV_RESPONSE_INVALID')
  return { outcome, substance }
}
