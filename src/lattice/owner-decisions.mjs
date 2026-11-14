// Owner-lane hand-over (README L18-L19; Owner 2026-11-12: 「決裁箱連発すんなよ。決裁箱に出した記録もつけてスクリプトで判断しろ。」):
// an Owner-lane task that is in progress or can start is handed once to the chart's creator Bot, which files the one Approval Box request.
// Owner 2026-11-14 (bug): a script cannot write a card the Owner understands from English chart rows, so Lattice files none itself.
const SENT = ['running', 'steered', 'queued', 'delivered', 'answered']
export const OPTIONS = Object.freeze([{ id: 'done', label: '済んだ' }, { id: 'not-yet', label: 'まだ（理由を書く）' }])
// The cancel reason the Owner reads, per card state that ends the task (README L19).
const ENDED = { retired: 'この工程は工程表で取り下げられたため、申請を取り下げました。', done: 'この工程は工程表で済になったため、申請を取り下げました。' }
const OPEN = new Set(['in-progress', 'ready'])
const REASK = name => `この申請は、何を決めていただきたいのかが伝わりにくい書き方でしたので取り下げました。同じ件は${name}が、わかる言葉であらためてお尋ねします。`

const keyOf = (projectId, card) => `${projectId}/${card.plan}/${card.taskId}`
// Only a refusal of one request lets the tick go on; anything else (unavailable, an old body) ends this tick's filing (README L18, Molly review).
const goesOn = error => error?.code === 'LATTICE_DECISIONS_REFUSED'

function askMessage(chart, card) {
  const where = `${card.plan}/${card.taskId} 「${card.title}」 on your chart ${chart.projectId} (lattice tool, project ${chart.projectId})`
  return `Lattice: the Owner-lane task ${where} needs the Owner. Lattice does not file Approval Box requests itself (the Owner could not read the cards it made).\n`
    + `You created this chart, so make sure exactly ONE Approval Box request exists for this decision: if you or the Bot that added this task already filed one, file nothing; otherwise file it yourself with request_decision.\n`
    + `Write it to the Approval Box instructions, in plain Japanese: the title says in one sentence what the Owner should decide; the background gives the reason and the impact first; put on the card what he must see to decide (a draft he approves, the exact setting, the cost); each option says what happens after it. No task ids, no English chart text.\n`
    + `When he answers, record it: \`lattice todo start --plan ${card.plan} --task ${card.taskId}\` (skip if already in progress), then \`lattice todo done --plan ${card.plan} --task ${card.taskId} --message "<the Owner's answer>"\`;`
    + ` or \`lattice todo note --plan ${card.plan} --task ${card.taskId} --message "<the Owner's answer>"\`. If the task is retired or done before he answers, cancel_decision your request.`
}

function answerMessage(chart, item, answer) {
  const option = OPTIONS.find(entry => entry.id === answer?.optionId)
  return `Lattice: the Owner answered the Approval Box request for an Owner-lane task on your chart ${chart.projectId}`
    + ` (lattice tool, project ${chart.projectId}): ${item.plan}/${item.taskId} 「${item.title}」.\n`
    + `Answer: ${option ? option.label : answer?.optionId ?? '(no option)'}${answer?.text ? ` / ${answer.text}` : ''}\n`
    // Lattice refuses `todo done` on a task never started, and an Owner task usually is (README L19).
    + `You created this chart, so record it: if it is done, \`lattice todo start --plan ${item.plan} --task ${item.taskId}\` (skip if it is already in progress), then \`lattice todo done --plan ${item.plan} --task ${item.taskId} --message "<the Owner's answer>"\`;`
    + ` otherwise \`lattice todo note --plan ${item.plan} --task ${item.taskId} --message "<the Owner's answer>"\`.`
}

// charts: [{projectId, name, createdBy, cards}]; names: Map botId -> name; bots: Set of roster Bot ids;
// records: {read() -> object, write(object)} (cli, temp + rename). Returns {filed, routed}.
export async function ownerDecisions(charts, { laneOf, names, bots, records, effect, log }) {
  const out = { filed: 0, routed: 0 }
  const record = await records.read()
  const byId = new Map(charts.map(chart => [chart.projectId, chart]))
  const cards = new Map(charts.flatMap(chart => chart.cards.map(card => [keyOf(chart.projectId, card), card])))
  for (const [key, item] of Object.entries(record)) {
    if (item.status !== 'open') continue
    const chart = byId.get(item.projectId)
    let value
    try { value = await effect('decisions.read', { decisionId: item.decisionId }) } catch (error) {
      log(`lattice-owner-read ${key} ${error?.code ?? 'FAILED'}`)
      if (goesOn(error)) continue
      return out
    }
    if (value.status === 'cancelled') { record[key] = { ...item, status: 'closed' }; await records.write(record); continue }
    // An Owner task that ended on its chart takes its open request with it (Chime 2026-11-13); an unseen card is never taken as ended.
    const ended = ENDED[cards.get(key)?.state]
    if (ended && (value.status === 'pending' || value.status === 'held')) {
      try { await effect('decisions.cancel', { decisionId: item.decisionId, reason: ended }) } catch (error) {
        log(`lattice-owner-cancel ${key} ${error?.code ?? 'FAILED'}`)
        if (error?.code === 'LATTICE_DECISIONS_UNAVAILABLE') return out
        continue
      }
      record[key] = { ...item, status: 'closed' }
      await records.write(record)
      log(`lattice-owner-cancelled ${key}`)
      continue
    }
    // A legacy Lattice-filed card the Owner cannot read is withdrawn and handed to the creator below, in this tick (L19).
    const creator = chart?.createdBy
    if ((value.status === 'pending' || value.status === 'held') && OPEN.has(cards.get(key)?.state) && bots.has(creator)) {
      try { await effect('decisions.cancel', { decisionId: item.decisionId, reason: REASK(names.get(creator) ?? creator) }) } catch (error) {
        log(`lattice-owner-cancel ${key} ${error?.code ?? 'FAILED'}`)
        if (error?.code === 'LATTICE_DECISIONS_UNAVAILABLE') return out
        continue
      }
      delete record[key]
      await records.write(record)
      log(`lattice-owner-reask ${key}`)
      continue
    }
    if (value.status !== 'answered') continue
    if (!creator || !bots.has(creator)) { log(`lattice-owner-route ${item.projectId} no-creator`); continue }
    const sent = await effect('messages.send', { from: 'scheduler', target: creator, message: answerMessage(chart, item, value.answer) }).catch(() => null)
    if (!SENT.includes(sent?.delivery)) { log(`lattice-owner-route ${item.projectId} not accepted`); continue }
    record[key] = { ...item, status: 'routed' }
    await records.write(record)
    out.routed++
  }
  for (const chart of charts) for (const card of chart.cards) {
    if (!OPEN.has(card.state) || laneOf(card.lane) !== 'owner') continue
    const key = keyOf(chart.projectId, card)
    // shortcut: at most once per task, even after the answer; a reopened Owner task is not handed over again. Upgrade if the Owner asks for it.
    if (record[key]) continue
    if (!bots.has(chart.createdBy)) { log(`lattice-owner-ask ${chart.projectId} no-creator`); continue }
    const sent = await effect('messages.send', { from: 'scheduler', target: chart.createdBy, message: askMessage(chart, card) }).catch(() => null)
    if (!SENT.includes(sent?.delivery)) { log(`lattice-owner-ask ${key} not accepted`); continue }
    record[key] = { projectId: chart.projectId, plan: card.plan, taskId: card.taskId, title: card.title, status: 'asked', askedAt: new Date().toISOString() }
    await records.write(record)
    out.filed++
  }
  return out
}
