import { isAbsolute } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CharacterSheets } from './character-sheets.mjs'

let started = false
try {
  if (process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000)
    throw new Error('SEAT_RUNTIME_IDENTITY')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const { project, file } = JSON.parse(Buffer.concat(chunks).toString())
  if (!isAbsolute(project)) throw new Error('SEAT_RUNTIME_ARGUMENTS')
  const sheets = new CharacterSheets({ projectPath: () => project })
  const { mime, size, stream } = await sheets.open(null, file)
  process.stdout.write(JSON.stringify({ result: { mime, size } }) + '\n')
  started = true
  await pipeline(stream, process.stdout)
} catch (error) {
  if (!started) process.stdout.write(JSON.stringify({ error: Object.fromEntries(
    ['name', 'message', 'code'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) }) + '\n')
  else process.stderr.write('BELLTEAM_SEAT_STREAM_FAILED\n')
  process.exitCode = 1
}
