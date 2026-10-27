import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { searchKnowledgeItems, searchMemories } from './memory-search.mjs'

const MEMORY_KINDS = new Set([
  'fact', 'preference', 'policy', 'task', 'config', 'incident', 'relationship', 'episode', 'growth',
])

function closeDatabases(databases, errors = []) {
  for (const db of databases) {
    try { db?.close() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'MEMORY_DATABASE_CLOSE_FAILED')
}

export class BellTeamMemory {
  constructor({ registry, root, now = () => new Date(), id = randomUUID }) {
    this.registry = registry
    this.root = root
    this.now = now
    this.id = id
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
    const errors = []
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
      errors.push(error)
      if (db.isTransaction) {
        try { db.exec('ROLLBACK') } catch (error) { errors.push(error) }
      }
    } finally {
      closeDatabases([db], errors)
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
    const errors = []
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
      errors.push(error)
      if (db.isTransaction) {
        try { db.exec('ROLLBACK') } catch (error) { errors.push(error) }
      }
    } finally {
      closeDatabases([db], errors)
    }
    return { id: newId, supersedesId: id, kind: resolvedKind, content: content.trim(), scope: normalizedScope, observedAt }
  }

  async pinMemory({ botId, id, pinned = true, scope = 'personal' }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    const errors = []
    try {
      const row = db.prepare(`SELECT metadata_json FROM assertions WHERE id = ? AND status = 'active'`).get(id)
      if (!row) throw new Error(`MEMORY_NOT_FOUND: ${id}`)
      db.prepare(`UPDATE assertions SET metadata_json = ? WHERE id = ?`)
        .run(JSON.stringify({ ...JSON.parse(row.metadata_json), pinned: Boolean(pinned) }), id)
    } catch (error) {
      errors.push(error)
    } finally {
      closeDatabases([db], errors)
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
    const errors = []
    try {
      for (const id of memoryIds) {
        const row = db.prepare(`SELECT metadata_json FROM assertions WHERE id = ? AND status = 'active'`).get(id)
        if (!row || JSON.parse(row.metadata_json).pinned) continue
        db.prepare(`UPDATE assertions SET status = 'consolidated' WHERE id = ?`).run(id)
      }
    } catch (error) {
      errors.push(error)
    } finally {
      closeDatabases([db], errors)
    }
    return { ...growth, sourceMemoryIds: memoryIds }
  }

  async recallMemory({ botId, query, scope = 'personal', limit = 20 }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const db = await this.openMemory(bot?.id ?? null, normalizedScope)
    const errors = []
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
    } catch (error) {
      errors.push(error)
    } finally {
      closeDatabases([db], errors)
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
    const errors = []
    try {
      upsertKnowledge(db, {
        id, path: relativePath, title: title.trim(), body: content.trim(), source,
        tags: JSON.stringify(tags), confidence, createdAt,
      })
    } catch (error) {
      errors.push(error)
    } finally {
      closeDatabases([db], errors)
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
    let memoryDb
    const errors = []
    try {
      memoryDb = await this.openMemory(bot?.id ?? null, normalizedScope)
      return { scope: normalizedScope, items: searchKnowledgeItems(knowledgeDb, memoryDb, query, limit) }
    } catch (error) {
      errors.push(error)
    } finally {
      closeDatabases([memoryDb, knowledgeDb], errors)
    }
  }

  async rebuildKnowledgeIndex({ botId, scope = 'personal' }) {
    const normalizedScope = normalizeScope(scope)
    const bot = normalizedScope === 'personal' ? requireBot(this.registry, botId) : null
    const ragRoot = await this.ensureRag(bot?.id ?? null, normalizedScope)
    const dbPath = join(ragRoot, 'index.db')
    const db = openKnowledgeDb(dbPath)
    let count = 0
    const errors = []
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec('DELETE FROM section_index; DELETE FROM sections; DELETE FROM documents; DELETE FROM index_state;')
      for (const name of await readdir(join(ragRoot, 'notes'))) {
        if (!name.endsWith('.md')) continue
        const parsed = parseKnowledgeMarkdown(await readFile(join(ragRoot, 'notes', name), 'utf8'))
        upsertKnowledge(db, { ...parsed, path: `notes/${name}` })
        count += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      errors.push(error)
      if (db.isTransaction) {
        try { db.exec('ROLLBACK') } catch (error) { errors.push(error) }
      }
    } finally {
      closeDatabases([db], errors)
    }
    return { scope: normalizedScope, count }
  }

  async openMemory(botId, scope) {
    const directory = await this.ensureMemory(botId, scope)
    const db = new DatabaseSync(join(directory, 'memory.db'))
    try { db.exec(`
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
    `) } catch (error) { closeDatabases([db], [error]) }
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
  try { db.exec(`
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
  `) } catch (error) { closeDatabases([db], [error]) }
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
