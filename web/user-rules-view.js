// 「チームの決まり」の読む画面。オーナーが書いた RULES 形式の文を、SECTION・RULE・項目ごとに読める形へ並べる。
// 文は書き換えない。読めない行は、その場で元の文のまま出す（隠さない）。編集は全文のまま。
const LABELS = { PURPOSE: '目的', FACT: '前提', WHEN: '条件', DO: 'する', MAY: 'してよい', NEVER: 'しない', WHY: '理由', DEFAULT: '既定', EXCEPT: '例外', 'YOU ARE': '役割', 'NOT REQUIRED': '不要', PRECEDENCE: '優先', DEFAULTS: '既定' }
const CLAUSE = /^(PURPOSE|FACT|WHEN|DO|MAY|NEVER|WHY|DEFAULT|DEFAULTS|EXCEPT|YOU ARE|NOT REQUIRED|PRECEDENCE)(\s*\([^)]*\))?:\s*(.*)$/u

export function parseRules(text = '') {
  const result = { head: [], format: [], notes: [], sections: [], loose: [] }
  let section = null, rule = null, clause = null, inFormat = false, indent = 0
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line) { clause = null; continue }
    if (/^RULES\s/u.test(line)) { result.head.push(line); inFormat = false; continue }
    if (line === 'FORMAT') { inFormat = true; continue }
    if (inFormat && /^\s/u.test(raw)) { result.format.push(line); continue }
    let match
    if ((match = /^SECTION\s+(.+)$/u.exec(line))) { inFormat = false; section = { title: match[1], rules: [], notes: [] }; result.sections.push(section); rule = null; clause = null; continue }
    inFormat = false
    if ((match = /^RULE\s+(.+)$/u.exec(line))) {
      if (!section) { section = { title: '', rules: [], notes: [] }; result.sections.push(section) }
      rule = { id: match[1], clauses: [] }; section.rules.push(rule); clause = null; continue
    }
    if ((match = CLAUSE.exec(line))) {
      clause = { key: match[1], label: LABELS[match[1]], note: match[2]?.trim().replace(/^\(|\)$/gu, '') ?? '', text: match[3] }
      indent = raw.length - raw.trimStart().length
      if (rule) rule.clauses.push(clause)
      else if (section) section.notes.push(clause)
      else result.notes.push(clause)
      continue
    }
    // 続きの行は、項目の行より深く字下げされた行だけ。
    if (clause && raw.length - raw.trimStart().length > indent) { clause.text = clause.text ? `${clause.text} ${line}` : line; continue }
    // 形式に合わない行。直前の場所に、元の文のまま置く。
    const plain = { key: '', label: '', note: '', text: line }
    if (rule) rule.clauses.push(plain); else if (section) section.notes.push(plain); else result.loose.push(line)
    clause = null
  }
  return result
}

export const ruleCount = parsed => parsed.sections.reduce((sum, section) => sum + section.rules.length, 0)

const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text === undefined ? {} : { textContent: text })

function clauseRow(clause) {
  const row = el('div', clause.label ? `rule-clause rule-${clause.key.toLowerCase().replace(/\s+/gu, '-')}` : 'rule-clause rule-plain')
  if (clause.label) row.append(el('span', 'rule-key', clause.note ? `${clause.label}（${clause.note}）` : clause.label))
  row.append(el('p', 'rule-text', clause.text))
  return row
}

// 読む画面を描く。空の時は空の案内だけを返す。
export function renderRules(container, text) {
  const parsed = parseRules(text)
  const nodes = []
  if (!String(text ?? '').trim()) nodes.push(el('p', 'rules-empty', 'まだ決まりはありません。「文章で編集」から書けます。'))
  for (const line of parsed.loose) nodes.push(el('p', 'rule-text rule-plain', line))
  for (const note of parsed.notes) nodes.push(clauseRow(note))
  for (const section of parsed.sections) {
    const box = el('section', 'rule-section')
    if (section.title) box.append(el('h4', 'rule-section-title', section.title))
    for (const note of section.notes) box.append(clauseRow(note))
    for (const rule of section.rules) {
      const card = el('article', 'rule-card')
      card.append(el('h5', 'rule-id', rule.id), ...rule.clauses.map(clauseRow))
      box.append(card)
    }
    nodes.push(box)
  }
  if (parsed.head.length || parsed.format.length) {
    const more = el('details', 'rules-format')
    more.append(el('summary', '', '書き方の説明'), ...[...parsed.head, ...parsed.format].map(line => el('p', 'rule-text', line)))
    nodes.push(more)
  }
  container.replaceChildren(...nodes)
  return parsed
}
