// Claude Code's own limit line -> model scope and reset time (harness-accounts.md, "Limit detection").
export const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY = 86_400_000
// A weekly limit resets within 7 days; anything outside (past, or beyond 8 days) is a mis-parse and is not trusted.
const MAX_AHEAD = 8 * DAY

export function modelScope(model) {
  const value = String(model ?? '').toLowerCase()
  return MODEL_FAMILIES.find(family => value.includes(family)) ?? null
}

function validZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}

function zoneParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms).map(part => [part.type, part.value]))
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second }
}

// Wall-clock time in a zone -> UTC ms (re-checked once so a DST edge lands on the right offset).
function zonedToUtc({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const offset = ms => { const p = zoneParts(ms, timeZone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms }
  const first = wall - offset(wall)
  return wall - offset(first)
}

const hour24 = (hour, meridiem) => (Number(hour) % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0)

export function parseLimitText(text, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const line = String(text ?? '')
  // `keep using Fable 5.1`: Claude Code's model-limit line, also with usage credits off (production 2026-11-09).
  const named = (line.match(/\byour\s+([A-Za-z]+)\s+limit\b/iu) ?? line.match(/\bkeep using\s+([A-Za-z]+)/iu))?.[1]?.toLowerCase()
  const scope = MODEL_FAMILIES.includes(named) ? named
    : /\b(weekly|session|usage)\s+limit\b|Usage limit reached/iu.test(line) ? 'all' : null
  const tagged = line.match(/\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\)/u)?.[1]
  const zone = tagged && validZone(tagged) ? tagged : timeZone
  const today = zoneParts(now, zone)
  let wall = null
  const absolute = line.match(/try again at ([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}),? (\d{1,2}):(\d{2}) ?([AaPp][Mm])/u)
  const relative = line.match(/(?:resets|continuing automatically at)\s+(?:([A-Za-z]{3})[a-z]* (\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])/u)
  if (absolute) {
    const month = MONTHS.indexOf(absolute[1].toLowerCase()) + 1
    if (month) wall = { year: +absolute[3], month, day: +absolute[2], hour: hour24(absolute[4], absolute[6]), minute: +absolute[5] }
  } else if (relative) {
    const month = relative[1] ? MONTHS.indexOf(relative[1].toLowerCase()) + 1 : today.month
    if (month) {
      wall = { year: today.year, month, day: relative[1] ? +relative[2] : today.day, hour: hour24(relative[3], relative[5]), minute: +(relative[4] ?? 0) }
      // No date: the next occurrence. A date without a year that already passed: next year.
      if (zonedToUtc(wall, zone) <= now) {
        if (!relative[1]) { const next = zoneParts(zonedToUtc(wall, zone) + DAY, zone); wall = { ...wall, year: next.year, month: next.month, day: next.day } }
        else wall = { ...wall, year: wall.year + 1 }
      }
    }
  }
  const at = wall ? zonedToUtc(wall, zone) : null
  const trusted = at !== null && at > now && at - now <= MAX_AHEAD
  return { scope, resetAt: trusted ? new Date(at).toISOString() : null, zone, parsedAt: at === null ? null : new Date(at).toISOString() }
}

// A Claude limit line as Aiterm classifies it (claudeFailureCategory), or Claude Code's own limit notice.
export function isLimitText(text) {
  return /^\s*(?:You've (?:reached your [^.\r\n]{1,80} limit\b|hit your (?:[a-z0-9-]+ ){0,3}limit\b)|Usage limit reached\b)/iu.test(String(text ?? ''))
}

// harness-accounts.md "limit hold": the footer below the composer while Claude Code keeps a limited turn and will continue it at
// its own reset ("Continuing automatically at 7pm · Esc to cancel"). Returns that footer text, or null.
export function claudeLimitHold(screen) {
  const lines = String(screen ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u)
  let composer = lines.length - 1
  while (composer >= 0 && !/^\s*❯/u.test(lines[composer])) composer--
  if (composer < 0) return null
  const rule = lines.findIndex((line, index) => index > composer && /^\s*─{8,}\s*$/u.test(line))
  if (rule < 0) return null
  const footer = lines.slice(rule + 1).join(' ').replace(/\s+/gu, ' ').trim()
  return /\bContinuing automatically at\b/iu.test(footer) ? footer : null
}
