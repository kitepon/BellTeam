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
      if (!pageToken && result.afterCursor) await this.saveObserverCursor(botId, result.afterCursor)
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
      const rows = searchRows(db, {
        table: 'assertions',
        fts: 'assertions_fts',
        query,
        limit,
        columns: 'a.id, a.kind, a.content, a.importance, a.observed_at, a.metadata_json',
        alias: 'a',
        active: true,
      })
      return {
        scope: normalizedScope,
        items: rows.map(row => ({
          id: row.id,
          kind: row.kind,
          content: row.content,
          importance: row.importance,
          observedAt: row.observed_at,
          metadata: JSON.parse(row.metadata_json),
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

  async searchKnowledge({ botId, query, scope = 'personal', limit = 20 }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const ragRoot = await this.ensureRag(bot?.id ?? null, normalizedScope)
    const db = openKnowledgeDb(join(ragRoot, 'index.db'))
    try {
      const rows = searchRows(db, {
        table: 'documents',
        fts: 'documents_fts',
        query,
        limit,
        columns: 'd.id, d.path, d.title, d.body, d.source, d.tags, d.confidence, d.created_at',
        alias: 'd',
        textColumns: ['title', 'body', 'tags'],
      })
      return {
        scope: normalizedScope,
        items: rows.map(row => ({
          id: row.id,
          title: row.title,
          excerpt: excerpt(row.body, query),
          path: row.path,
          source: row.source,
          tags: JSON.parse(row.tags),
          confidence: row.confidence,
          createdAt: row.created_at,
        })),
      }
    } finally {
      db.close()
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
}

function searchRows(db, { table, fts, query, limit, columns, alias, active = false, textColumn = 'content', textColumns = [textColumn] }) {
  if (typeof query !== 'string' || query.trim().length === 0) throw new Error('SEARCH_QUERY_INVALID')
  const rawQuery = query.trim()
  const tokens = rawQuery.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return []
  const status = active ? ` AND ${alias}.status = 'active'` : ''
  const literalQuery = /[^\p{L}\p{N}\s]/u.test(rawQuery) && !/\s/u.test(rawQuery)
  if (!literalQuery && tokens.every(token => [...token].length >= 3)) {
    const ftsQuery = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' ')
    return db.prepare(`
      SELECT ${columns}
      FROM ${fts} f JOIN ${table} ${alias} ON ${alias}.rowid = f.rowid
      WHERE ${fts} MATCH ?${status}
      ORDER BY bm25(${fts}), ${alias}.rowid DESC
      LIMIT ?
    `).all(ftsQuery, normalizeLimit(limit))
  }
  const likeTerms = literalQuery ? [rawQuery] : tokens
  const clauses = likeTerms.map(() => `(${textColumns.map(column => `${alias}.${column} LIKE ?`).join(' OR ')})`).join(' AND ')
  return db.prepare(`
    SELECT ${columns} FROM ${table} ${alias}
    WHERE ${clauses}${status}
    ORDER BY ${active ? `${alias}.importance DESC, ` : ''}${alias}.rowid DESC
    LIMIT ?
  `).all(...likeTerms.flatMap(token => textColumns.map(() => `%${token}%`)), normalizeLimit(limit))
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

function excerpt(body, query) {
  const position = body.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase())
  if (position < 0) return body.slice(0, 240)
  return body.slice(Math.max(0, position - 80), position + query.length + 160)
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
