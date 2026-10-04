// Cursor CLIのmodel catalogは「素のmodel ID + エフォート（+ -fast）」を連結した完成形で並ぶ。
// aitermはBotのmodelとエフォートを `${model}-${effort}` に連結して渡すため、
// 設定画面の候補は素のmodel IDだけにする。完成形のままだと連結で二重になる。
const EFFORT_TOKENS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'])
// 末尾一致は長いtokenから試す（extra-high を high として剥がさない）
const EFFORT_SUFFIXES = [...EFFORT_TOKENS].sort((a, b) => b.length - a.length)
const SPEED_TOKEN = 'fast'

// aitermは起動中のBotのエフォートをCursorのparameter画面で選び直す。画面の選択肢にラベルを持たないminimalは候補にしない。
const SELECTABLE_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max']

export function cursorBaseModels(catalog) {
  return cursorModelCatalog(catalog).map(model => model.id)
}

// 素のmodel IDごとに、catalogに完成形がある選べるエフォートを並べる。
export function cursorModelCatalog(catalog) {
  const models = new Map()
  for (const id of catalog) {
    const parsed = parseModelId(id)
    if (parsed === null) continue
    if (!models.has(parsed.base)) models.set(parsed.base, new Set())
    if (parsed.effort) models.get(parsed.base).add(parsed.effort)
  }
  return [...models].map(([id, efforts]) => ({ id, efforts: SELECTABLE_EFFORTS.filter(effort => efforts.has(effort)) }))
}

// 末尾の -fast と末尾のエフォートを剥がして素のIDにする。
// エフォートが途中に埋まるID（claude-4.6-sonnet-medium-thinking 等）は連結で作れないので候補にしない。
function parseModelId(id) {
  let rest = id
  let effort = ''
  if (rest.endsWith(`-${SPEED_TOKEN}`)) rest = rest.slice(0, -(SPEED_TOKEN.length + 1))
  for (const token of EFFORT_SUFFIXES) {
    if (rest.endsWith(`-${token}`)) {
      rest = rest.slice(0, -(token.length + 1))
      effort = token
      break
    }
  }
  return containsEffortOrSpeed(rest) ? null : { base: rest, effort }
}

function containsEffortOrSpeed(id) {
  return id.split('-').some(part => EFFORT_TOKENS.has(part) || part === SPEED_TOKEN)
    || [...EFFORT_TOKENS].some(token => token.includes('-') && id.includes(`-${token}`))
}

export function parseCursorCatalog(text) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
  if (!/^Available models\s*$/mu.test(clean)) throw new Error('CURSOR_CATALOG_INVALID')
  return clean.split(/\r?\n/u).flatMap(line => {
    const match = line.match(/^(\S+)\s+-\s+.+$/u)
    return match ? [match[1]] : []
  })
}
