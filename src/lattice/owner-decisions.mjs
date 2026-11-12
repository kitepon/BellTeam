// Owner-lane filing (README L18-L19; Owner 2026-11-12: 「決裁箱連発すんなよ。決裁箱に出した記録もつけてスクリプトで判断しろ。」):
// an Owner-lane task that is in progress or can start goes to the Approval Box once, by this script; the answer goes to the chart's creator Bot.
const SENT = ['running', 'steered', 'queued', 'delivered', 'answered']
export const OPTIONS = Object.freeze([{ id: 'done', label: '済んだ' }, { id: 'not-yet', label: 'まだ（理由を書く）' }])

const keyOf = (projectId, card) => `${projectId}/${card.plan}/${card.taskId}`

function filing(chart, card, requester) {
  const context = [`工程表「${chart.name ?? chart.projectId}」で、担当があなた（owner）の工程です。`, `工程: ${card.title}`,
    `終わりの条件: ${card.doneCondition ?? '（書かれていません）'}`, card.designMemo ? `\n設計メモ:\n${card.designMemo}` : null,
    `\n答えは、この工程表を作った ${requester} に届き、${requester} が工程表に記録します。`].filter(Boolean).join('\n')
  // session_label carries the task key, so the body can match an open request of this connection (decisions.file dedupe, L18);
  // the chart name in the title keeps titles apart (the server refuses a second open request with the same title).
  return { title: `${chart.name ?? chart.projectId}: ${card.title}`.slice(0, 120), context: context.slice(0, 20000), options: OPTIONS, requester,
    session_label: `${chart.name ?? chart.projectId} / ${card.plan}/${card.taskId}` }
}

function answerMessage(chart, item, answer) {
  const option = OPTIONS.find(entry => entry.id === answer?.optionId)
  return `Lattice: the Owner answered the Approval Box request for an Owner-lane task on your chart ${chart.projectId}`
    + ` (lattice tool, project ${chart.projectId}): ${item.plan}/${item.taskId} 「${item.title}」.\n`
    + `Answer: ${option ? option.label : answer?.optionId ?? '(no option)'}${answer?.text ? ` / ${answer.text}` : ''}\n`
    + `You created this chart, so record it: if it is done, \`lattice todo done --plan ${item.plan} --task ${item.taskId} --message "<the Owner's answer>"\`;`
    + ` otherwise \`lattice todo note --plan ${item.plan} --task ${item.taskId} --message "<the Owner's answer>"\`.`
}

// charts: [{projectId, name, createdBy, cards}]; names: Map botId -> name; bots: Set of roster Bot ids;
// records: {read() -> object, write(object)} (cli, temp + rename). Returns {filed, routed}.
export async function ownerDecisions(charts, { laneOf, names, bots, records, effect, log }) {
  const out = { filed: 0, routed: 0 }
  const record = await records.read()
  const byId = new Map(charts.map(chart => [chart.projectId, chart]))
  for (const [key, item] of Object.entries(record)) {
    if (item.status !== 'open') continue
    const chart = byId.get(item.projectId)
    let value
    try { value = await effect('decisions.read', { decisionId: item.decisionId }) } catch (error) { log(`lattice-owner-read ${key} ${error?.code ?? 'FAILED'}`); continue }
    if (value.status === 'cancelled') { record[key] = { ...item, status: 'closed' }; await records.write(record); continue }
    if (value.status !== 'answered') continue
    const creator = chart?.createdBy
    if (!creator || !bots.has(creator)) { log(`lattice-owner-route ${item.projectId} no-creator`); continue }
    const sent = await effect('messages.send', { from: 'scheduler', target: creator, message: answerMessage(chart, item, value.answer) }).catch(() => null)
    if (!SENT.includes(sent?.delivery)) { log(`lattice-owner-route ${item.projectId} not accepted`); continue }
    record[key] = { ...item, status: 'routed' }
    await records.write(record)
    out.routed++
  }
  for (const chart of charts) for (const card of chart.cards) {
    if ((card.state !== 'in-progress' && card.state !== 'ready') || laneOf(card.lane) !== 'owner') continue
    const key = keyOf(chart.projectId, card)
    // shortcut: at most once per task, even after the answer; a reopened Owner task is not filed again. Upgrade if the Owner asks for re-filing.
    if (record[key]) continue
    const requester = names.get(chart.createdBy) ?? chart.createdBy ?? 'Lattice'
    let value
    try { value = await effect('decisions.file', filing(chart, card, requester)) } catch (error) { log(`lattice-owner-file ${key} ${error?.code ?? 'FAILED'}`); continue }
    record[key] = { projectId: chart.projectId, plan: card.plan, taskId: card.taskId, title: card.title, decisionId: value.decisionId, status: 'open', filedAt: new Date().toISOString() }
    // Written before the next card: a crash after the file and before this write is caught by the body's open-request match (L18).
    await records.write(record)
    out.filed++
  }
  return out
}
