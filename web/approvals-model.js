// 決裁箱の画面の、DOMを使わない部分。データは /api/approvals/*（決裁箱拡張 contract v0.1）、言葉と流れは screen-spec.md。画面に ID・コードは出さない。
import { stopTime } from './lattice-stops.js?v=__ASSET_VERSION__'
export { backoffMs } from './lattice-chart-model.js?v=__ASSET_VERSION__'

export const SUMMARY_SCHEMA = 'bellteam.approvals-summary.v1'
export const MESSAGES = {
  loading: '決裁を読んでいます…',
  reconnect: '決裁箱に再接続しています…',
  old: 'このサーバーではまだ決裁箱の拡張を使えません。サーバーが更新されると、自動で使えます。',
  notEntitled: '決裁箱の拡張は、まだ使えません。契約すると、決裁が工程表とつながります。いまお使いの決裁箱のアプリは、これまでどおり使えます。',
  expired: '決裁箱の契約が切れています。契約を更新すると、また決裁を読めます。更新するまでは、答えの送信と工程への反映を止めています。',
  noCredential: '決裁箱につながっていません。つなぐと、自動で決裁を読み込みます。',
  emptyPending: '決裁はありません。AIが判断を求めると、ここに並びます。',
  emptyHeld: '保留中の決裁はありません。',
  emptyDone: 'まだ済んだ決裁はありません。',
  retry: 'いまは送れませんでした。答えは残っています。少し待って、もう一度押してください。',
  holdFailed: 'いまは保留を切り替えられませんでした。少し待って、もう一度押してください。',
  amended: name => `答える前に、${name}が内容を直しました。もう一度、内容を確かめてください。`,
  chartLate: '答えは決裁箱に送れました。工程表への反映は少し遅れています。つながり次第、自動で済みになります。',
}

// ---- 失敗：HTTP の答え -> 画面の種類
export function failureOf(status, body) {
  const code = body?.error?.code
  if (status === 404) return code === 'not_found' ? 'gone' : 'old'
  if (status === 402) return 'expired'
  if (status === 403 && code === 'not_entitled') return ['expired', 'revoked'].includes(body.error.state) ? 'expired' : 'notEntitled'
  if (status === 409) return code === 'not_connected' ? 'noCredential' : code === 'conflict' && body.error.decision ? 'conflict' : 'refused'
  if (status === 429) return 'wait'
  if (!status || status >= 500) return 'reconnect'
  return 'refused'
}
// 画面の種類 -> 読んだ側に出す一文（読み直しで抜ける種類は feed の status と同じ名前）
export const STATUS_TEXT = { old: MESSAGES.old, notEntitled: MESSAGES.notEntitled, expired: MESSAGES.expired, noCredential: MESSAGES.noCredential }

// ---- 出どころ
const TERMINAL = ['claude-code', 'codex', 'cursor'], CHAT = ['claude.ai', 'chatgpt']
export function originOf(decision) {
  const origin = decision?.origin ?? {}, member = origin.kind === 'bellteam' && decision.requester ? decision.requester : null
  const unknown = !member && origin.kind !== 'external'
  const tool = unknown ? '出どころ不明' : origin.tool || 'その他'
  const session = origin.sessionLabel || origin.workLabel || ''
  return {
    member, unknown, external: !member,
    tile: TERMINAL.includes(origin.client) ? 'terminal' : CHAT.includes(origin.client) ? 'chat' : 'globe',
    tool, session, via: origin.via === 'remote' ? 'リモート接続' : origin.via === 'connector' ? 'コネクタ' : '',
    name: member ? member.name : unknown ? '出どころ不明' : session ? `${tool} · ${session}` : tool,
    // 答えが届く先の呼び名
    who: member ? member.name : unknown ? '出したAI' : tool,
  }
}

// ---- 時刻（JST）
const DAY = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
const CLOCK = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const valid = value => Boolean(value) && !Number.isNaN(Date.parse(value))
export const clock = value => valid(value) ? CLOCK.format(new Date(value)) : ''
export function ageText(value, now) {
  if (!valid(value)) return ''
  const minutes = Math.floor((now - Date.parse(value)) / 60000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  return minutes < 1440 ? `${Math.floor(minutes / 60)}時間前` : stopTime(value, now)
}
export function dayHeading(value, now) {
  const day = DAY.format(new Date(value))
  if (day === DAY.format(now)) return '今日'
  return day === DAY.format(now - 86400000) ? '昨日' : `${Number(day.split('/')[1])}月${Number(day.split('/')[2])}日`
}

// ---- 一覧の札
const badge = (text, tone, glyph) => ({ text, tone, glyph })
export function badgesOf(decision) {
  const origin = originOf(decision), list = []
  if (decision.status === 'pending') list.push(badge('回答待ち', 'vio', 'inbox'))
  if (decision.status === 'held') list.push(badge('保留', 'pen', 'pause'))
  if (decision.status === 'answered') list.push(badge('回答済み', 'ok', 'seal'))
  if (decision.status === 'cancelled') list.push(badge('取り下げ', 'pen', 'xmark'))
  if (['pending', 'held'].includes(decision.status) && decision.urgency === 'high') list.push(badge('急ぎ', 'amb', 'bolt'))
  if (decision.amended?.is) list.push(badge('修正あり', 'ind', 'pencil'))
  if (origin.external) list.push(badge('外部から', 'pen', 'globe'))
  return list
}
// 工程とのつながりの一行。外のものは中立（失敗ではない）。
export function linkNote(decision) {
  const origin = originOf(decision), link = decision.link
  if (decision.status === 'held') return { text: origin.external && !link ? '保留中です' : '保留中です。戻すまで工程は待ちます', tone: 'plain' }
  if (!link) return origin.external ? { text: '工程表とはつながっていません', tone: 'muted' } : { text: '工程表につなげています', tone: 'muted' }
  if (link.state === 'diverged') return { text: '工程はすでに済みです。この決裁は、まだ答えられます。', tone: 'plain' }
  return { text: `工程表「${link.task?.title ?? ''}」が、この回答を待っています`, tone: 'link' }
}
export function cardRow(decision, now) {
  const origin = originOf(decision), badges = badgesOf(decision), note = linkNote(decision)
  const chips = []
  if (valid(decision.deadline) && ['pending', 'held'].includes(decision.status)) chips.push(`期限 ${stopTime(decision.deadline, now)}`)
  if ((decision.options ?? []).some(option => option.recommended)) chips.push('推奨あり')
  const done = decision.status === 'answered' || decision.status === 'cancelled'
  return {
    id: decision.id, status: decision.status, title: decision.title ?? '', badges, note, chips, origin,
    urgent: decision.urgency === 'high' && !done,
    age: decision.status === 'held' ? stopTime(decision.updatedAt, now) : ageText(decision.createdAt, now),
    label: [...badges.map(item => item.text), decision.title, origin.name, chips.find(chip => chip.startsWith('期限')), note.text].filter(Boolean).join('、'),
  }
}

// ---- 済み
export const doneAt = decision => decision.answer?.answeredAt ?? decision.updatedAt
export function answerText(decision) {
  const answer = decision.answer
  if (!answer) return ''
  const option = (decision.options ?? []).find(item => item.id === answer.optionId)
  return answer.text ? `あなたの指示：${answer.text}` : `あなたの答え：${option?.label ?? ''}`
}
export function groupDone(items, now) {
  const rows = items.filter(item => ['answered', 'cancelled'].includes(item.status)).toSorted((a, b) => (Date.parse(doneAt(b)) || 0) - (Date.parse(doneAt(a)) || 0))
  const groups = []
  for (const decision of rows) {
    const heading = valid(doneAt(decision)) ? dayHeading(doneAt(decision), now) : ''
    if (groups.at(-1)?.heading !== heading) groups.push({ heading, rows: [] })
    const origin = originOf(decision), cancelled = decision.status === 'cancelled'
    groups.at(-1).rows.push({
      id: decision.id, title: decision.title ?? '', cancelled, origin, external: origin.external,
      line: cancelled ? decision.cancelReason ?? '' : answerText(decision), time: clock(doneAt(decision)),
      delivery: cancelled ? null : deliveryBadge(decision),
    })
  }
  return groups
}
export function deliveryBadge(decision) {
  if (decision.status !== 'answered') return null
  if (decision.delivery === 'unknown') return { text: '届いたか不明', tone: 'amb' }
  return decision.delivery === 'waiting' ? { text: '会話に戻ると届きます', tone: 'vio' } : { text: '届きました', tone: 'ok' }
}

// ---- 答える
const task = decision => decision.link?.task?.title
export function confirmText(decision, { label = '', text = '' } = {}) {
  const origin = originOf(decision), title = task(decision)
  const head = text ? 'この指示を送りますか？ ' : `「${label}」で答えますか？ `
  if (origin.external && !decision.link || !title) return `${head}答えると、${origin.who}に届きます。`
  return `${head}答えると、${origin.who}が続きに進み、工程「${title}」が済みになります。`
}
export function answerOutcome(status, body) {
  if (status === 200) return { kind: 'ok' }
  const kind = failureOf(status, body), message = body?.error?.message
  if (kind === 'conflict') return { kind, decision: body.error.decision }
  if (kind === 'gone') return { kind }
  if (kind === 'reconnect' || kind === 'wait') return { kind: 'retry', message: MESSAGES.retry }
  if (kind === 'expired') return { kind: 'stop', message: '決裁箱の契約が切れています。' }
  if (kind === 'noCredential') return { kind: 'stop', message: MESSAGES.noCredential }
  if (kind === 'notEntitled') return { kind: 'stop', message: MESSAGES.notEntitled }
  return { kind: 'stop', message: typeof message === 'string' && message ? message : MESSAGES.retry }
}
// 200 のあとに出す一文。unknown だけ再開の文のコピーを付ける。
export function deliveryNote(decision) {
  const who = originOf(decision).who
  if (decision.delivery === 'waiting') return { tone: 'vio', text: `答えました。${who}が会話に戻ると受け取ります。` }
  if (decision.delivery === 'unknown') {
    const next = decision.link && !originOf(decision).external ? '工程は済みになったので、次の担当にはこちらから知らせます。' : ''
    return { tone: 'amb', copy: true, text: `答えは保存しました。ただ、${who}に届いたかを確かめられませんでした。${next}念のため、再開の文を${who}の会話に貼ってください。` }
  }
  return { tone: 'ok', text: `答えました。${who}に届きました。` }
}

// ---- 詳細
const FIELD = { options: '選択肢', title: '題名', context: '背景', deadline: '期限', urgency: '急ぎ度', recommendation: '推奨' }
export function historyRows(decision, now) {
  const who = originOf(decision).who
  const stamp = value => dayHeading(value, now) === '今日' ? clock(value) : `${DAY.format(new Date(value)).split('/').slice(1).join('/')} ${clock(value)}`
  return (decision.history ?? []).filter(item => valid(item.at)).map(item => ({
    time: stamp(item.at), kind: item.kind,
    text: item.kind === 'created' ? `${item.by === 'user' ? 'あなた' : who}が申請しました`
      : item.kind === 'amended' ? `${who}が内容を直しました${item.fields?.length ? `（${item.fields.map(field => FIELD[field] ?? 'その他').join('、')}）` : ''}`
        : item.kind === 'held' ? 'あなたが保留にしました' : item.kind === 'unheld' ? '保留を戻しました'
          : item.kind === 'answered' ? 'あなたが答えました' : item.kind === 'cancelled' ? `${who}が取り下げました` : 'その他の動きがありました',
    amended: item.kind === 'amended',
  }))
}
// 右の「工程とのつながり」。つながる先が無い時は、その理由を中立に言う。
export function linkPanel(decision) {
  const origin = originOf(decision), link = decision.link
  const ids = link?.chart?.projectId && link?.task?.cardId ? { projectId: link.chart.projectId, cardId: link.task.cardId } : null
  if (!link) {
    return origin.external
      ? { kind: 'unlinked', title: 'つながっていません', lines: ['この決裁は、BellTeamの外から届きました。工程は作りません。', `答えは、出したAI（${origin.tool}）へそのまま届きます。BellTeamの工程には何も起こりません。`,
        '出したAIが、BellTeamの工程表の工程を指して申請した時だけ（セッション名に工程の宛先がある時）、通常の決裁と同じようにつながります。'] }
      : { kind: 'connecting', title: '工程表につなげています', lines: [] }
  }
  const next = link.next?.[0], answered = link.state === 'answered' || decision.status === 'answered'
  const sentence = answered ? `答えました。工程「${link.task.title}」は済みです。`
    : `答えると、「${link.task.title}」が済みになり、${next ? `${origin.who}が「${next.title}」へ進めます。` : '次の工程へ進めます。'}答えで決まらない時は、新しい決裁が工程に差し込まれます。`
  return { kind: 'linked', previous: link.previous ?? [], task: link.task, next: link.next ?? [], chart: link.chart?.name ?? '', projectId: link.chart?.projectId ?? null, sentence, ids }
}

// ---- 数え方と絞り込み
export function countsOf(summary) {
  const answered = summary?.answeredToday ?? 0, filed = Math.max(summary?.filedToday ?? 0, answered)
  return { pending: summary?.pending ?? 0, urgent: summary?.urgent ?? 0, held: summary?.held ?? 0, answered, filed, fraction: filed ? answered / filed : 0 }
}
export const originFilter = (items, filter) => filter === 'all' ? items : items.filter(item => (originOf(item).member ? 'bellteam' : 'external') === filter)
export function originCounts(items) {
  const bellteam = items.filter(item => originOf(item).member).length
  return { all: items.length, bellteam, external: items.length - bellteam }
}
// 入口の行：数は全部の回答待ち（絞り込みに関わらない）
export function entryView(summary, status) {
  const pending = summary?.pending ?? 0
  return {
    pending, urgent: (summary?.urgent ?? 0) > 0,
    sub: summary ? (pending ? 'あなたの回答を待っています' : '待っている決裁はありません') : status === 'old' ? 'このサーバーではまだ使えません' : '決裁箱を開く',
    label: pending ? `決裁箱、回答待ち${pending}件` : '決裁箱',
  }
}

// ---- つなぐ（screen-spec「つなぐ」）：コードは見せず、貼らせない。許可は決裁箱自身の画面でする。
export const CONNECT = {
  expired: '決裁箱とのつなぎの期限が切れました。もう一度つないでください。',
  waiting: '決裁箱の画面で、許可してください。終わると、ここが自動で読み込みます。',
  denied: '許可されませんでした。もう一度つなげます。',
  lapsed: '許可の待ち時間が過ぎました。もう一度つないでください。',
  failed: 'いまは決裁箱につなげませんでした。少し待って、もう一度押してください。',
  blocked: '決裁箱の画面が開かなかったようです。「もう一度開く」を押してください。',
  dropAsk: '決裁箱とのつなぎを外します。外すと、また決裁箱につなぐまで決裁は読めません。',
  dropFailed: 'いまはつなぎを外せませんでした。少し待って、もう一度押してください。',
}
// phase: idle（つながっていない）/ opening（要求を出している）/ waiting（許可待ち）/ denied。server は GET /connection の state。
export function connectView({ phase = 'idle', server = null, note = '' } = {}) {
  const act = (key, label, primary = false) => ({ key, label, primary })
  if (phase === 'opening') return { text: CONNECT.waiting, tone: 'wait', spinner: true, note, actions: [] }
  if (phase === 'waiting') return { text: CONNECT.waiting, tone: 'wait', spinner: true, note, actions: [act('again', 'もう一度開く', true), act('cancel', 'やめる')] }
  if (phase === 'denied') return { text: CONNECT.denied, tone: 'denied', spinner: false, note, actions: [act('connect', 'もう一度つなぐ', true)] }
  return { text: server === 'expired' ? CONNECT.expired : MESSAGES.noCredential, tone: 'idle', spinner: false, note, actions: [act('connect', '決裁箱につなぐ', true), act('reload', '読み直す')] }
}
// POST /api/approvals/connect の答え。authorizationUrl は https だけ開く。
export function connectOutcome(status, body) {
  const url = body?.authorizationUrl
  if (status === 200 && typeof url === 'string' && /^https:\/\//u.test(url)) return { kind: 'ok', url }
  if ([402, 403, 404, 409].includes(status)) return { kind: 'again' } // 契約・旧サーバーの画面は feed が決める
  return { kind: 'retry', message: CONNECT.failed }
}

// ---- 深いリンク： #approvals と #approvals/<決裁>
export const decisionHash = id => `#approvals/${encodeURIComponent(id)}`
export function parseHash(hash) {
  const match = /^#approvals(?:\/(.+))?$/u.exec(hash ?? '')
  if (!match) return null
  try { return { id: match[1] ? decodeURIComponent(match[1]) : null } } catch { return { id: null } }
}
