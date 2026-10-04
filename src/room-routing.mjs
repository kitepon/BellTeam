import { spawn } from 'node:child_process'

const CONTEXT_SCHEMA = 'throughline.room_context.v1'

export async function roomTurnsFromThroughline({ projectPath, roomId, messageId, speaker, text, launch = spawn }) {
  const child = launch('throughline', ['room-context', '--json'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.end(JSON.stringify({ projectPath, roomId, messageId, speaker, text }))
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (exitCode !== 0) {
    let code = 'E_ROOM_CONTEXT_EXEC'
    try { code = JSON.parse(stderr)?.code ?? code } catch { /* 外部CLIの不正なエラー形式を固定コードで報告する */ }
    throw new Error(`THROUGHLINE_ROOM_CONTEXT_FAILED: ${code}`)
  }
  const result = JSON.parse(stdout)
  if (result?.schema !== CONTEXT_SCHEMA || result.status !== 'ready' ||
      !Array.isArray(result.turns) || result.turns.at(-1)?.messageId !== messageId) {
    throw new Error('THROUGHLINE_ROOM_CONTEXT_INVALID')
  }
  return result.turns.map(turn => ({ speaker: turn.speaker, text: turn.text }))
}

export async function chooseRoomResponder({ room, turns, members, fetcher = fetch, apiKey = process.env.TYPESAFE_API_KEY }) {
  if (!members.length) return []
  if (!apiKey) throw new Error('JEV_API_KEY_MISSING')
  const criteria = Object.fromEntries(members.map(member => [member.id,
    `名前: ${member.name}\n役職: ${member.position || '未設定'}\n役割: ${member.role || '未設定'}`]))
  const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: {
        room: { name: room.name, purpose: room.purpose },
        members: members.map(({ id, name, position, role }) => ({ id, name, position, role })),
        current: turns.at(-1),
        preceding: turns.slice(0, -1),
      },
      questions: {
        continue: {
          type: 'noul',
          instructions: '直近3ターンの会話に対して、部屋のメンバーから次の発言が必要か。話題が続いているだけでは必要としない。',
          criteria: {
            true: '会話に未回答の質問、依頼、判断の求め、新しい論点、メンバーへの呼びかけや挨拶があり、誰かの返事や対応を要する。雑談や様子を尋ねる問いかけも返事を要する。',
            false: '会話で求められた回答や対応は済み、次の発言を求めていない。受領、引き受け、同意、お礼、締めくくりだけなら次の発言は不要。',
          },
        },
        responder: {
          type: 'choice',
          instructions: '直近3ターンの会話に対して、次に発言するべき部屋のメンバーは誰か。',
          criteria,
        },
      },
    }),
  })
  if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`)
  const result = await response.json()
  const continuation = result?.answers?.continue?.noul
  const responder = result?.answers?.responder?.choice
  if (typeof continuation !== 'number' || continuation < 0 || continuation > 1 ||
      !members.some(member => member.id === responder)) throw new Error('JEV_RESPONSE_INVALID')
  return continuation >= 0.6 ? [responder] : []
}
