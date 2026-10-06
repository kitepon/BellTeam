import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { runtimeEnvironment } from './runtime-home.mjs'

const execFileAsync = promisify(execFile)

const MEMORY_KINDS = new Set([
  'fact', 'preference', 'policy', 'task', 'config', 'incident', 'relationship', 'episode', 'growth',
])

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

export class BellTeamMemory {
  constructor({ registry, root, now = () => new Date(), id = randomUUID, observeTurns = observeThroughlineTurns }) {
    this.registry = registry
    this.root = root
    this.now = now
    this.id = id
    this.observeTurns = observeTurns
  }

  async initialize() {
    await this.registry.refresh?.()
    await this.ensureScope(null, 'shared')
    for (const bot of this.registry.values()) await this.ensureScope(bot.id, 'personal')
  }

  async remember({ botId, content, kind = 'fact', scope = 'personal', importance = 5, sourceRef = 'bellteam', metadata = {}, rawContent = content }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    if (!MEMORY_KINDS.has(kind)) throw new Error(`MEMORY_KIND_INVALID: ${kind}`)
    if (typeof content !== 'string' || content.trim().length === 0) throw new Error('MEMORY_CONTENT_INVALID')
    const observedAt = this.now().toISOString()
    const rawEventId = `raw-${this.id()}`
    let assertionId = `memory-${this.id()}`
    const evidenceId = `evidence-${this.id()}`
    let duplicate = false
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    try {
      db.exec('BEGIN')
      db.prepare(`
        INSERT INTO raw_events (id, source_kind, speaker, content, observed_at, source_ref)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(rawEventId, sourceRef, bot?.id ?? 'shared', rawContent.trim(), observedAt, sourceRef)
      const duplicateRow = db.prepare(`
        SELECT id, importance FROM assertions
        WHERE status = 'active' AND kind = ? AND content = ?
      `).get(kind, content.trim())
      if (duplicateRow) {
        duplicate = true
        assertionId = duplicateRow.id
        db.prepare(`UPDATE assertions SET importance = ?, observed_at = ? WHERE id = ?`)
          .run(Math.max(duplicateRow.importance, normalizeImportance(importance)), observedAt, assertionId)
      } else {
        db.prepare(`
          INSERT INTO assertions (id, kind, content, status, importance, observed_at, metadata_json)
          VALUES (?, ?, ?, 'active', ?, ?, ?)
        `).run(assertionId, kind, content.trim(), normalizeImportance(importance), observedAt, JSON.stringify(metadata ?? {}))
      }
      db.prepare(`
        INSERT INTO evidence (id, assertion_id, raw_event_id, quote_span, observed_at, speaker, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(evidenceId, assertionId, rawEventId, content.trim(), observedAt, bot?.id ?? 'shared', sourceRef)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
    return { id: assertionId, kind, content: content.trim(), scope: normalizedScope, observedAt, duplicate }
  }

  async reviseMemory({ botId, id, content, kind, importance, scope = 'personal' }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    if (typeof content !== 'string' || content.trim().length === 0) throw new Error('MEMORY_CONTENT_INVALID')
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    const observedAt = this.now().toISOString()
    const newId = `memory-${this.id()}`
    const rawEventId = `raw-${this.id()}`
    let resolvedKind
    try {
      const current = db.prepare(`SELECT * FROM assertions WHERE id = ? AND status = 'active'`).get(id)
      if (!current) throw new Error(`MEMORY_NOT_FOUND: ${id}`)
      const nextKind = kind ?? current.kind
      resolvedKind = nextKind
      if (!MEMORY_KINDS.has(nextKind)) throw new Error(`MEMORY_KIND_INVALID: ${nextKind}`)
      db.exec('BEGIN')
      db.prepare(`UPDATE assertions SET status = 'superseded' WHERE id = ?`).run(id)
      db.prepare(`
        INSERT INTO raw_events (id, source_kind, speaker, content, observed_at, source_ref)
        VALUES (?, 'revision', ?, ?, ?, ?)
      `).run(rawEventId, bot?.id ?? 'shared', content.trim(), observedAt, id)
      db.prepare(`
        INSERT INTO assertions (id, kind, content, status, importance, observed_at, metadata_json)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(newId, nextKind, content.trim(), normalizeImportance(importance ?? current.importance), observedAt,
        JSON.stringify({ ...JSON.parse(current.metadata_json), supersedesId: id }))
      db.prepare(`
        INSERT INTO evidence (id, assertion_id, raw_event_id, quote_span, observed_at, speaker, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`evidence-${this.id()}`, newId, rawEventId, content.trim(), observedAt, bot?.id ?? 'shared', id)
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
    return { id: newId, supersedesId: id, kind: resolvedKind, content: content.trim(), scope: normalizedScope, observedAt }
  }

  async pinMemory({ botId, id, pinned = true, scope = 'personal' }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    try {
      const row = db.prepare(`SELECT metadata_json FROM assertions WHERE id = ? AND status = 'active'`).get(id)
      if (!row) throw new Error(`MEMORY_NOT_FOUND: ${id}`)
      db.prepare(`UPDATE assertions SET metadata_json = ? WHERE id = ?`)
        .run(JSON.stringify({ ...JSON.parse(row.metadata_json), pinned: Boolean(pinned) }), id)
    } finally {
      db.close()
    }
    return { id, pinned: Boolean(pinned), scope: normalizedScope }
  }

  async consolidateGrowth({ botId, memoryIds, content, importance = 7, scope = 'personal' }) {
    if (!Array.isArray(memoryIds) || memoryIds.length === 0) throw new Error('MEMORY_IDS_INVALID')
    const growth = await this.remember({
      botId, content, kind: 'growth', importance, scope, sourceRef: 'consolidation',
      metadata: { sourceMemoryIds: memoryIds },
    })
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    try {
      for (const id of memoryIds) {
        const row = db.prepare(`SELECT metadata_json FROM assertions WHERE id = ? AND status = 'active'`).get(id)
        if (!row || JSON.parse(row.metadata_json).pinned) continue
        db.prepare(`UPDATE assertions SET status = 'consolidated' WHERE id = ?`).run(id)
      }
    } finally {
      db.close()
    }
    return { ...growth, sourceMemoryIds: memoryIds }
  }

  async captureConversation(botId) {
    const bot = requireBot(this.registry, botId)
    let afterCursor = await this.observerCursor(botId)
    let throughCursor = null
    let pageToken = null
    let imported = 0
    let resynced = false
    let status = 'snapshot'
    do {
      const result = await this.observeTurns({ project: bot.project, afterCursor, throughCursor, pageToken, limit: 100 })
      status = result.status
      if (status === 'resync_required') {
        if (resynced) throw new Error('THROUGHLINE_RESYNC_FAILED')
        afterCursor = null
        throughCursor = null
        pageToken = null
        resynced = true
        continue
      }
      if (status === 'projection_pending') return { status, imported, resynced }
      imported += await this.importConversationTurns(bot, result.turns ?? [])
      throughCursor = result.throughCursor ?? throughCursor
      pageToken = result.page?.complete === false ? result.page.nextToken : null
      if (!pageToken && throughCursor) await this.saveObserverCursor(botId, throughCursor)
    } while (pageToken || status === 'resync_required')
    return { status, imported, resynced }
  }

  async listMemoryCandidates({ botId, limit = 20 }) {
    const capture = await this.captureConversation(botId)
    const db = await this.openMemory(botId, 'personal')
    try {
      const items = db.prepare(`
        SELECT id, user_text, assistant_text, completed_at, truncated
        FROM conversation_candidates WHERE status = 'pending'
        ORDER BY completed_at ASC LIMIT ?
      `).all(normalizeLimit(limit)).map(row => ({
        id: row.id,
        user: row.user_text,
        assistant: row.assistant_text,
        completedAt: new Date(row.completed_at).toISOString(),
        truncated: Boolean(row.truncated),
      }))
      return { ...capture, items }
    } finally {
      db.close()
    }
  }

  async organizeMemoryCandidate({ botId, candidateId, memories }) {
    if (!Array.isArray(memories) || memories.length === 0) throw new Error('MEMORY_CANDIDATE_MEMORIES_INVALID')
    const db = await this.openMemory(botId, 'personal')
    let candidate
    try {
      candidate = db.prepare(`SELECT * FROM conversation_candidates WHERE id = ? AND status = 'pending'`).get(candidateId)
    } finally {
      db.close()
    }
    if (!candidate) throw new Error(`MEMORY_CANDIDATE_NOT_FOUND: ${candidateId}`)
    const saved = []
    for (const memory of memories) {
      saved.push(await this.remember({
        botId, ...memory, sourceRef: `throughline:${candidate.source_sha256}`,
        metadata: { candidateId, sourceSha256: candidate.source_sha256 },
        rawContent: `user: ${candidate.user_text}\nassistant: ${candidate.assistant_text}`,
      }))
    }
    const updateDb = await this.openMemory(botId, 'personal')
    try {
      updateDb.prepare(`
        UPDATE conversation_candidates
        SET status = 'organized', resolved_at = ?, user_text = '', assistant_text = ''
        WHERE id = ?
      `)
        .run(this.now().toISOString(), candidateId)
    } finally {
      updateDb.close()
    }
    return { id: candidateId, status: 'organized', memories: saved }
  }

  async dismissMemoryCandidate({ botId, candidateId }) {
    const db = await this.openMemory(botId, 'personal')
    try {
      const result = db.prepare(`
        UPDATE conversation_candidates
        SET status = 'dismissed', resolved_at = ?, user_text = '', assistant_text = ''
        WHERE id = ? AND status = 'pending'
      `).run(this.now().toISOString(), candidateId)
      if (result.changes === 0) throw new Error(`MEMORY_CANDIDATE_NOT_FOUND: ${candidateId}`)
    } finally {
      db.close()
    }
    return { id: candidateId, status: 'dismissed' }
  }

  async recallMemory({ botId, query, scope = 'personal', limit = 20 }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    try {
      return {
        scope: normalizedScope,
        items: searchMemories(db, query, limit).map(row => ({
          id: row.id,
          kind: row.kind,
          content: row.content,
          importance: row.importance,
          observedAt: row.observed_at,
          metadata: JSON.parse(row.metadata_json),
          ...(row.near ? { match: 'partial' } : {}),
        })),
      }
    } finally {
      db.close()
    }
  }

  async recordKnowledge({ botId, title, content, source = '', tags = [], confidence = 'medium', scope = 'personal' }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    if (typeof title !== 'string' || title.trim().length === 0) throw new Error('KNOWLEDGE_TITLE_INVALID')
    if (typeof content !== 'string' || content.trim().length === 0) throw new Error('KNOWLEDGE_CONTENT_INVALID')
    const createdAt = this.now().toISOString()
    const id = `knowledge-${this.id()}`
    const ragRoot = await this.ensureRag(bot?.id ?? null, normalizedScope)
    const relativePath = `notes/${id}.md`
    const markdown = knowledgeMarkdown({ id, title: title.trim(), source, createdAt, confidence, tags, content: content.trim() })
    await writeFile(join(ragRoot, relativePath), markdown, 'utf8')
    await appendIndex(ragRoot, { id, title: title.trim(), relativePath, createdAt, confidence })
    const db = openKnowledgeDb(join(ragRoot, 'index.db'))
    try {
      upsertKnowledge(db, {
        id, path: relativePath, title: title.trim(), body: content.trim(), source,
        tags: JSON.stringify(tags), confidence, createdAt,
      })
    } finally {
      db.close()
    }
    return { id, title: title.trim(), path: relativePath, scope: normalizedScope, createdAt }
  }

  // ナレッジの検索は、ナレッジと長期記憶の両方から探す（オーナー裁定 2026-10-06）。記憶の検索は長期記憶だけ。
  // ナレッジを先、長期記憶を後に並べる。ナレッジは見出しで区切った節ごとに探し、文書ごとにいちばん近い節を返す。
  async searchKnowledge({ botId, query, scope = 'personal', limit = 20 }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const ragRoot = await this.ensureRag(bot?.id ?? null, normalizedScope)
    const knowledgeDb = openKnowledgeDb(join(ragRoot, 'index.db'))
    const memoryDb = await this.openMemory(bot?.id ?? null, normalizedScope)
    try {
      const items = [
        ...searchSections(knowledgeDb, query, limit).map(row => knowledgeItem(row, query)),
        ...searchMemories(memoryDb, query, limit).map(row => memoryItem(row, query)),
      ]
      return { scope: normalizedScope, items: items.slice(0, normalizeLimit(limit)) }
    } finally {
      knowledgeDb.close()
      memoryDb.close()
    }
  }

  async rebuildKnowledgeIndex({ botId, scope = 'personal' }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const ragRoot = await this.ensureRag(bot?.id ?? null, normalizedScope)
    const dbPath = join(ragRoot, 'index.db')
    await rm(dbPath, { force: true })
    const db = openKnowledgeDb(dbPath)
    let count = 0
    try {
      for (const name of await readdir(join(ragRoot, 'notes'))) {
        if (!name.endsWith('.md')) continue
        const parsed = parseKnowledgeMarkdown(await readFile(join(ragRoot, 'notes', name), 'utf8'))
        upsertKnowledge(db, { ...parsed, path: `notes/${name}` })
        count += 1
      }
    } finally {
      db.close()
    }
    return { scope: normalizedScope, count }
  }

  async importConversationTurns(bot, turns) {
    const db = await this.openMemory(bot.id, 'personal')
    let imported = 0
    try {
      db.exec('BEGIN')
      for (const turn of turns) {
        const sourceSha = turn.source_sha256
        const candidateId = `turn-${sourceSha}`
        const result = db.prepare(`
          INSERT OR IGNORE INTO conversation_candidates
            (id, source_sha256, user_text, assistant_text, completed_at, truncated, status, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)
        `).run(candidateId, sourceSha, turn.user ?? '', turn.assistant ?? '', Number(turn.completed_at), turn.truncated ? 1 : 0)
        if (result.changes === 0) continue
        imported += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
    return imported
  }

  async observerCursor(botId) {
    const db = await this.openMemory(botId, 'personal')
    try {
      return db.prepare(`SELECT value FROM observer_state WHERE key = 'completed_turns_cursor'`).get()?.value ?? null
    } finally {
      db.close()
    }
  }

  async saveObserverCursor(botId, cursor) {
    const db = await this.openMemory(botId, 'personal')
    try {
      db.prepare(`
        INSERT INTO observer_state (key, value) VALUES ('completed_turns_cursor', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(cursor)
    } finally {
      db.close()
    }
  }

  async openMemory(botId, scope) {
    const directory = await this.ensureMemory(botId, scope)
    const db = new DatabaseSync(join(directory, 'memory.db'))
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS raw_events (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        speaker TEXT,
        content TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS assertions (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        importance INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        assertion_id TEXT NOT NULL,
        raw_event_id TEXT NOT NULL,
        quote_span TEXT,
        observed_at TEXT NOT NULL,
        speaker TEXT,
        source_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS observer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_candidates (
        id TEXT PRIMARY KEY,
        source_sha256 TEXT NOT NULL UNIQUE,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        status TEXT NOT NULL,
        resolved_at TEXT
      );
      -- assertions_fts は前の索引（3文字ずつ）。検索では使っていない。新しい索引（memory_index）を本番で確かめた後に消す。
      CREATE VIRTUAL TABLE IF NOT EXISTS assertions_fts USING fts5(
        id UNINDEXED, kind, content,
        content='assertions', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS assertions_ai AFTER INSERT ON assertions BEGIN
        INSERT INTO assertions_fts(rowid, id, kind, content) VALUES (new.rowid, new.id, new.kind, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS assertions_ad AFTER DELETE ON assertions BEGIN
        INSERT INTO assertions_fts(assertions_fts, rowid, id, kind, content)
        VALUES ('delete', old.rowid, old.id, old.kind, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS assertions_au AFTER UPDATE ON assertions BEGIN
        INSERT INTO assertions_fts(assertions_fts, rowid, id, kind, content)
        VALUES ('delete', old.rowid, old.id, old.kind, old.content);
        INSERT INTO assertions_fts(rowid, id, kind, content) VALUES (new.rowid, new.id, new.kind, new.content);
      END;
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_index USING fts5(words, pairs, tokenize="unicode61 remove_diacritics 0");
      CREATE TABLE IF NOT EXISTS index_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    return db
  }

  async ensureScope(botId, scope) {
    await Promise.all([this.ensureMemory(botId, scope), this.ensureRag(botId, scope)])
  }

  async ensureMemory(botId, scope) {
    const directory = join(this.scopeRoot(botId, scope), 'memory')
    await mkdir(directory, { recursive: true })
    return directory
  }

  async ensureRag(botId, scope) {
    const directory = join(this.scopeRoot(botId, scope), 'rag')
    await Promise.all([
      mkdir(join(directory, 'raw'), { recursive: true }),
      mkdir(join(directory, 'notes'), { recursive: true }),
    ])
    try { await readFile(join(directory, 'INDEX.md')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(join(directory, 'INDEX.md'), '# RAG INDEX\n\n', 'utf8')
    }
    const db = openKnowledgeDb(join(directory, 'index.db'))
    db.close()
    return directory
  }

  scopeRoot(botId, scope) {
    return scope === 'shared' ? join(this.root, 'shared') : requireBot(this.registry, botId).project
  }
}

function openKnowledgeDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      tags TEXT NOT NULL,
      confidence TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- documents_fts は前の索引（3文字ずつ）。検索では使っていない。新しい索引（section_index）を本番で確かめた後に消す。
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      id UNINDEXED, title, body, tags,
      content='documents', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, id, title, body, tags)
      VALUES (new.rowid, new.id, new.title, new.body, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, id, title, body, tags)
      VALUES ('delete', old.rowid, old.id, old.title, old.body, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, id, title, body, tags)
      VALUES ('delete', old.rowid, old.id, old.title, old.body, old.tags);
      INSERT INTO documents_fts(rowid, id, title, body, tags)
      VALUES (new.rowid, new.id, new.title, new.body, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS sections (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      heading TEXT NOT NULL,
      line INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sections_document ON sections (document_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS section_index USING fts5(
      title_words, body_words, title_pairs, body_pairs, tokenize="unicode61 remove_diacritics 0"
    );
    CREATE TABLE IF NOT EXISTS index_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  return db
}

function upsertKnowledge(db, value) {
  db.prepare(`
    INSERT INTO documents (id, path, title, body, source, tags, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path, title = excluded.title, body = excluded.body, source = excluded.source,
      tags = excluded.tags, confidence = excluded.confidence, created_at = excluded.created_at
  `).run(value.id, value.path, value.title, value.body, value.source ?? '', value.tags, value.confidence, value.createdAt)
  // 文書が入れ替わったら、前の節を消す。次の検索の時に、節と索引を作り直す。
  db.prepare('DELETE FROM section_index WHERE rowid IN (SELECT rowid FROM sections WHERE document_id = ?)').run(value.id)
  db.prepare('DELETE FROM sections WHERE document_id = ?').run(value.id)
}

function searchMemories(db, query, limit) {
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
  return limitNearMatches(rows, query, row => row.content)
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
  const seen = new Set()
  const nearest = rows.filter(row => !seen.has(row.id) && seen.add(row.id)).slice(0, normalizeLimit(limit))
  return limitNearMatches(nearest, query, row => `${row.title}\n${row.heading}\n${row.tags}\n${row.body}`)
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

// 近い順に並んだ結果のうち、検索語の全部は含まない物（近い物）に印を付け、5件までにする。全部を含む物は減らさない。
function limitNearMatches(rows, query, textOf) {
  const { rawQuery, tokens, literalQuery } = splitQuery(query)
  const required = (literalQuery ? [rawQuery] : tokens).map(term => term.toLocaleLowerCase())
  let near = 0
  return rows
    .map(row => {
      const text = textOf(row).toLocaleLowerCase()
      return required.every(term => text.includes(term)) ? row : { ...row, near: true }
    })
    .filter(row => !row.near || (near += 1) <= NEAR_MATCH_LIMIT)
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
  if (!indexIsCurrent(db)) {
    db.exec('DELETE FROM memory_index')
    markIndexCurrent(db)
  }
  const missing = db.prepare('SELECT rowid, content FROM assertions WHERE rowid NOT IN (SELECT rowid FROM memory_index)').all()
  const insert = db.prepare('INSERT INTO memory_index (rowid, words, pairs) VALUES (?, ?, ?)')
  for (const row of missing) insert.run(row.rowid, wordTokens(row.content).join(' '), pairTokens(row.content).join(' '))
}

// 節に分けていないナレッジの文書を、見出しで区切って索引へ入れる。
function syncSectionIndex(db) {
  if (!indexIsCurrent(db)) {
    db.exec('DELETE FROM section_index; DELETE FROM sections;')
    markIndexCurrent(db)
  }
  const missing = db.prepare('SELECT id, title, body, tags FROM documents WHERE id NOT IN (SELECT document_id FROM sections)').all()
  const insertSection = db.prepare('INSERT INTO sections (document_id, heading, line, body) VALUES (?, ?, ?, ?)')
  const insertIndex = db.prepare('INSERT INTO section_index (rowid, title_words, body_words, title_pairs, body_pairs) VALUES (?, ?, ?, ?, ?)')
  for (const document of missing) {
    for (const section of markdownSections(document.body)) {
      const title = `${document.title} ${section.heading} ${JSON.parse(document.tags).join(' ')}`
      const { lastInsertRowid } = insertSection.run(document.id, section.heading, section.line, section.body)
      insertIndex.run(lastInsertRowid, wordTokens(title).join(' '), wordTokens(section.body).join(' '), pairTokens(title).join(' '), pairTokens(section.body).join(' '))
    }
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

function knowledgeMarkdown({ id, title, source, createdAt, confidence, tags, content }) {
  return `---\nid: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(source ?? '')}\ncreated_at: ${JSON.stringify(createdAt)}\nconfidence: ${JSON.stringify(confidence)}\ntags: ${JSON.stringify(tags ?? [])}\n---\n\n# ${title}\n\n${content}\n`
}

function parseKnowledgeMarkdown(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\n# .*?\n\n([\s\S]*)$/u)
  if (!match) throw new Error('KNOWLEDGE_FILE_INVALID')
  const metadata = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    metadata[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1).trim())
  }
  return {
    id: metadata.id,
    title: metadata.title,
    source: metadata.source,
    createdAt: metadata.created_at,
    confidence: metadata.confidence,
    tags: JSON.stringify(metadata.tags ?? []),
    body: match[2].trim(),
  }
}

async function appendIndex(root, { title, relativePath, createdAt, confidence }) {
  const path = join(root, 'INDEX.md')
  const current = await readFile(path, 'utf8')
  await writeFile(path, `${current}- [${relativePath}](${relativePath}) — ${title} (${createdAt.slice(0, 10)}・${confidence})\n`, 'utf8')
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

function requireBot(registry, id) {
  const bot = registry.get(id)
  if (!bot) throw new Error(`BOT_NOT_FOUND: ${id}`)
  return bot
}

function normalizeScope(scope) {
  if (scope === undefined || scope === null || scope === 'personal') return 'personal'
  if (scope === 'shared') return 'shared'
  throw new Error(`MEMORY_SCOPE_INVALID: ${scope}`)
}

function normalizeImportance(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 10) throw new Error('MEMORY_IMPORTANCE_INVALID')
  return number
}

function normalizeLimit(value) {
  const number = Number(value ?? 20)
  return Number.isInteger(number) && number > 0 ? Math.min(number, 100) : 20
}

async function observeThroughlineTurns({ project, afterCursor, throughCursor, pageToken, limit }) {
  const args = ['observer-read', '--project', project, '--limit', String(limit), '--json']
  if (afterCursor) args.push('--after-cursor', afterCursor)
  if (throughCursor) args.push('--through-cursor', throughCursor)
  if (pageToken) args.push('--page-token', pageToken)
  const { stdout } = await execFileAsync('throughline', args, { env: runtimeEnvironment(), maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(stdout)
}
