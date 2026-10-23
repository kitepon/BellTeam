// 検索は文字の一致で探す。記憶やナレッジを語に分けて SQLite の全文検索（FTS5）へ入れ、語から文書を引く（オーナー裁定 2026-10-06）。
// 語の分け方は2つを合わせる。単語ごと（Node.js に入っている辞書で切る）を重く、2文字ずつを支えにする。
// 単語の切り方は辞書の版で変わるので、版が変わったら索引を作り直す。索引は元の表から作り直せる。
const INDEX_VERSION = `1:${process.versions.icu}`
const WORD_SEGMENTER = new Intl.Segmenter('ja', { granularity: 'word' })
// 近い順の点（BM25）の重み。自分の文書60節と問い40件で選んだ最初の値。
const MEMORY_WEIGHTS = { words: 1.5, pairs: 0.3 }
const KNOWLEDGE_WEIGHTS = { titleWords: 4, bodyWords: 1.5, titlePairs: 1, bodyPairs: 0.3 }
// 検索語の全部は含まない物（近い物）を返す上限。
const NEAR_MATCH_LIMIT = 5
// 文書ごとに1件へまとめる前に読む節の数（返す件数の何倍か）。同じ文書の節が続いても、返す件数に届くようにする。
const SECTIONS_PER_DOCUMENT = 5
// ナレッジの文書で、本文が始まる前の行数（knowledgeMarkdown の先頭の項目と題名）。
const KNOWLEDGE_BODY_OFFSET = 11
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々'
const TERM_RUNS = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}_])+`, 'gu')
const CJK_RUN = new RegExp(`^[${CJK}]`, 'u')
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u

// 接続とscopeの選択は呼び出し元が行う。検索判断には既存のSQLite接続だけを渡す。
export function searchKnowledgeItems(knowledgeDb, memoryDb, query, limit) {
  const found = [
    ...searchSections(knowledgeDb, query, limit).map(row => knowledgeItem(row, query)),
    ...searchMemories(memoryDb, query, limit).map(row => memoryItem(row, query)),
  ]
  // 番号やファイル名をそのまま引いて、片方にだけその文字の並びがあった時も、もう片方の近い物は返さない。
  const items = splitQuery(query).literalQuery && found.some(item => !item.match) ? found.filter(item => !item.match) : found
  return items.slice(0, normalizeLimit(limit))
}

export function searchMemories(db, query, limit) {
  const expression = matchExpression(query, { words: ['words'], pairs: ['pairs'] })
  if (!expression) return []
  syncMemoryIndex(db)
  const rows = db.prepare(`
    SELECT a.id, a.kind, a.content, a.importance, a.observed_at, a.metadata_json
    FROM memory_index i JOIN assertions a ON a.rowid = i.rowid
    WHERE memory_index MATCH ? AND a.status = 'active'
    ORDER BY bm25(memory_index, ${MEMORY_WEIGHTS.words}, ${MEMORY_WEIGHTS.pairs}), a.importance DESC, a.rowid DESC
    LIMIT ?
  `).all(expression, normalizeLimit(limit))
  return capNearMatches(markNearMatches(rows, query, row => row.content))
}

function searchSections(db, query, limit) {
  const expression = matchExpression(query, { words: ['title_words', 'body_words'], pairs: ['title_pairs', 'body_pairs'] })
  if (!expression) return []
  syncSectionIndex(db)
  const weights = KNOWLEDGE_WEIGHTS
  const rows = db.prepare(`
    SELECT d.id, d.path, d.title, d.source, d.tags, d.confidence, d.created_at, s.heading, s.line, s.body
    FROM section_index i JOIN sections s ON s.rowid = i.rowid JOIN documents d ON d.id = s.document_id
    WHERE section_index MATCH ?
    ORDER BY bm25(section_index, ${weights.titleWords}, ${weights.bodyWords}, ${weights.titlePairs}, ${weights.bodyPairs}), s.rowid DESC
    LIMIT ?
  `).all(expression, normalizeLimit(limit) * SECTIONS_PER_DOCUMENT)
  const sections = markNearMatches(rows, query, row => `${row.title}\n${row.heading}\n${row.tags}\n${row.body}`)
  const seen = new Set()
  return capNearMatches(sections.filter(row => !seen.has(row.id) && seen.add(row.id)).slice(0, normalizeLimit(limit)))
}

// 検索語を、索引を引く式にする。単語の列は単語で、2文字の列は2文字の並びで引く。どれかが当たれば候補になる。
function matchExpression(query, columns) {
  splitQuery(query)
  const quoted = tokens => queryTokens(tokens).map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
  const words = quoted(wordTokens(query))
  const pairs = quoted(pairTokens(query))
  return [
    words && `{${columns.words.join(' ')}}: (${words})`,
    pairs && `{${columns.pairs.join(' ')}}: (${pairs})`,
  ].filter(Boolean).join(' OR ')
}

// 近い順に並んだ結果のうち、検索語の全部は含まない物（近い物）に印を付ける。
// 番号やファイル名をそのまま引いて、その文字の並びを含む物があった時は、近い物を返さない。
// 番号を切った切れ端（K-Z7ECDC の K）が、他の番号に当たるだけなので。
function markNearMatches(rows, query, textOf) {
  const { rawQuery, tokens, literalQuery } = splitQuery(query)
  const required = (literalQuery ? [rawQuery] : tokens).map(term => term.toLocaleLowerCase())
  const marked = rows.map(row => {
    const text = textOf(row).toLocaleLowerCase()
    return required.every(term => text.includes(term)) ? row : { ...row, near: true }
  })
  return literalQuery && marked.some(row => !row.near) ? marked.filter(row => !row.near) : marked
}

// 近い物は5件までにする。全部を含む物は減らさない。
function capNearMatches(rows) {
  let near = 0
  return rows.filter(row => !row.near || (near += 1) <= NEAR_MATCH_LIMIT)
}

// 検索語を空白で区切る。記号を含み空白を含まない検索語（ファイル名や番号）は、区切らずそのまま扱う。
function splitQuery(query) {
  if (typeof query !== 'string' || query.trim().length === 0) throw new Error('SEARCH_QUERY_INVALID')
  const rawQuery = query.trim()
  const tokens = rawQuery.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean)
  const literalQuery = /[^\p{L}\p{N}\s]/u.test(rawQuery) && !/\s/u.test(rawQuery)
  return { rawQuery, tokens, literalQuery }
}

// 索引に入っていない記憶を、語に分けて入れる。記憶の本文は書き換わらないので、入れた分は作り直さない。
function syncMemoryIndex(db) {
  const current = indexIsCurrent(db)
  const missing = 'SELECT rowid, content FROM assertions WHERE rowid NOT IN (SELECT rowid FROM memory_index) ORDER BY rowid'
  if (current && !db.prepare(`${missing} LIMIT 1`).get()) return
  inOneTransaction(db, () => {
    if (!current) {
      db.exec('DELETE FROM memory_index')
      markIndexCurrent(db)
    }
    const insert = db.prepare('INSERT INTO memory_index (rowid, words, pairs) VALUES (?, ?, ?)')
    for (const row of db.prepare(missing).all()) insert.run(row.rowid, wordTokens(row.content).join(' '), pairTokens(row.content).join(' '))
  })
}

// 節に分けていないナレッジの文書を、見出しで区切って索引へ入れる。
function syncSectionIndex(db) {
  const current = indexIsCurrent(db)
  const missing = 'SELECT id, title, body, tags FROM documents WHERE id NOT IN (SELECT document_id FROM sections) ORDER BY rowid'
  if (current && !db.prepare(`${missing} LIMIT 1`).get()) return
  inOneTransaction(db, () => {
    if (!current) {
      db.exec('DELETE FROM section_index; DELETE FROM sections;')
      markIndexCurrent(db)
    }
    const insertSection = db.prepare('INSERT INTO sections (document_id, heading, line, body) VALUES (?, ?, ?, ?)')
    const insertIndex = db.prepare('INSERT INTO section_index (rowid, title_words, body_words, title_pairs, body_pairs) VALUES (?, ?, ?, ?, ?)')
    for (const document of db.prepare(missing).all()) {
      // タグは、手で直した文書では配列でない事がある。
      const tags = [].concat(JSON.parse(document.tags) ?? []).join(' ')
      for (const section of markdownSections(document.body)) {
        const title = `${document.title} ${section.heading} ${tags}`
        const { lastInsertRowid } = insertSection.run(document.id, section.heading, section.line, section.body)
        insertIndex.run(lastInsertRowid, wordTokens(title).join(' '), wordTokens(section.body).join(' '), pairTokens(title).join(' '), pairTokens(section.body).join(' '))
      }
    }
  })
}

// 索引へ入れる分と版の印を、1回で確定する。途中でサーバーが止まっても、全部入っているか、何も入っていないかのどちらかになる。
function inOneTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    work()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function indexIsCurrent(db) {
  return db.prepare("SELECT value FROM index_state WHERE key = 'version'").get()?.value === INDEX_VERSION
}

function markIndexCurrent(db) {
  db.prepare("INSERT INTO index_state (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(INDEX_VERSION)
}

// Markdownを見出しで区切る。コードの囲みの中の # は見出しにしない。本文の無い見出しは、下の節の見出しに残る。
// 見出しの前の文は、見出しの無い節になる。line は、その節が始まる本文の行（1始まり）。
function markdownSections(markdown) {
  const sections = []
  const trail = []
  let current = { heading: '', line: 1, lines: [] }
  let fenced = false
  const flush = () => {
    const body = current.lines.join('\n').trim()
    if (body) sections.push({ heading: current.heading, line: current.line, body })
  }
  for (const [index, line] of markdown.split('\n').entries()) {
    if (/^(```|~~~)/u.test(line)) fenced = !fenced
    const heading = fenced ? null : line.match(/^(#{1,6})\s+(.*)$/u)
    if (!heading) {
      current.lines.push(line)
      continue
    }
    flush()
    trail.length = heading[1].length - 1
    trail[heading[1].length - 1] = heading[2].trim()
    current = { heading: trail.filter(Boolean).join(' > '), line: index + 1, lines: [] }
  }
  flush()
  return sections.length > 0 ? sections : [{ heading: '', line: 1, body: markdown }]
}

// 単語ごとに分ける。切るのは Node.js に入っている辞書（ICU）。記号と空白は語にしない。
function wordTokens(text) {
  const tokens = []
  for (const part of WORD_SEGMENTER.segment(text.normalize('NFKC').toLocaleLowerCase())) {
    if (part.isWordLike) tokens.push(part.segment)
  }
  return tokens
}

// 英数字は続きをそのまま1語に、日本語は2文字ずつに分ける。1文字だけの日本語は、その1文字を語にする。
function pairTokens(text) {
  const tokens = []
  for (const run of text.normalize('NFKC').toLocaleLowerCase().match(TERM_RUNS) ?? []) {
    const characters = [...run]
    if (!CJK_RUN.test(run) || characters.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index + 1 < characters.length; index += 1) tokens.push(characters[index] + characters[index + 1])
  }
  return tokens
}

// 探す時は、ひらがなだけの短い語（助詞や語尾）を使わない。どの文にもあって、近さの手がかりにならない。
function queryTokens(tokens) {
  return [...new Set(tokens)].filter(token => !(HIRAGANA_ONLY.test(token) && [...token].length <= 2))
}

function knowledgeItem(row, query) {
  return {
    id: row.id,
    title: row.heading ? `${row.title} > ${row.heading}` : row.title,
    excerpt: excerpt(row.body, query),
    path: row.path,
    line: KNOWLEDGE_BODY_OFFSET + row.line,
    source: row.source,
    tags: JSON.parse(row.tags),
    confidence: row.confidence,
    createdAt: row.created_at,
    ...(row.near ? { match: 'partial' } : {}),
  }
}

// ナレッジの検索に混ぜて返す長期記憶。本文の全体は recall_memory で読める。
function memoryItem(row, query) {
  return {
    id: row.id,
    title: `長期記憶（${row.kind}）`,
    excerpt: excerpt(row.content, query),
    source: 'memory',
    kind: row.kind,
    importance: row.importance,
    observedAt: row.observed_at,
    ...(row.near ? { match: 'partial' } : {}),
  }
}

// 当たった語のまわりを抜き出す。検索語の全体、空白で区切った語、単語、2文字の並びの順に探す。
function excerpt(body, query) {
  const lowerBody = body.toLocaleLowerCase()
  const whole = query.trim().toLocaleLowerCase()
  for (const candidate of [whole, ...whole.split(/\s+/u), ...queryTokens(wordTokens(whole)), ...queryTokens(pairTokens(whole))]) {
    const position = candidate ? lowerBody.indexOf(candidate) : -1
    if (position >= 0) return body.slice(Math.max(0, position - 80), position + candidate.length + 160)
  }
  return body.slice(0, 240)
}

function normalizeLimit(value) {
  const number = Number(value ?? 20)
  return Number.isInteger(number) && number > 0 ? Math.min(number, 100) : 20
}
