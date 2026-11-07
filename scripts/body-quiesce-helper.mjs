#!/usr/bin/env node
// Fixed entry the installer runs as UID1001 in the exact old body: one request, one bounded answer.
// Exit 0 prints the body's answer; exit 2 is an invalid stdin request; exit 75 is unconfirmed.
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { BODY_QUIESCE_SOCKET, QUIESCE_RESULTS, parseQuiesceRequest } from '../src/body-quiesce.mjs'

export async function requestQuiesce(line, { path = BODY_QUIESCE_SOCKET, now = Date.now() } = {}) {
  const request = parseQuiesceRequest(line.trim(), now)
  if (!request) return { code: 2 }
  return new Promise(resolve => {
    let buffer = '', done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value) }
    const timer = setTimeout(() => finish({ code: 75 }), Math.max(0, request.deadline - Date.now()))
    const socket = connect(path, () => socket.write(JSON.stringify(request) + '\n'))
    socket.setEncoding('utf8')
    socket.on('error', () => finish({ code: 75 }))
    socket.on('close', () => finish({ code: 75 }))
    socket.on('data', chunk => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) { if (buffer.length > 4096) finish({ code: 75 }); return }
      let answer
      try { answer = JSON.parse(buffer.slice(0, end)) } catch { return finish({ code: 75 }) }
      finish(answer?.requestId === request.requestId && QUIESCE_RESULTS.includes(answer.result)
        ? { code: 0, line: JSON.stringify({ requestId: answer.requestId, result: answer.result }) } : { code: 75 })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 4096) break }
  const { code, line } = input.length > 4096 ? { code: 2 } : await requestQuiesce(input)
  if (line) process.stdout.write(line + '\n')
  else process.stderr.write(code === 2 ? 'QUIESCE_REQUEST_INVALID\n' : 'QUIESCE_UNCONFIRMED\n')
  process.exit(code)
}
