// The library's Storage over a SQLite database (a Durable Object's ctx.storage.sql): key, value, expiry. Nothing else is stored.
// `sql.exec(query, ...binds).toArray()` is the Durable Object interface; tests pass a node:sqlite adapter.
export function createSqlStorage(sql, { now = Date.now, max = 100_000 } = {}) {
  const rows = (query, ...binds) => sql.exec(query, ...binds).toArray()
  sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, until INTEGER NOT NULL)')
  sql.exec('CREATE INDEX IF NOT EXISTS kv_until ON kv (until)')
  let size = rows('SELECT COUNT(*) AS n FROM kv')[0].n
  let nextSweep = 0
  return {
    get(key) {
      return rows('SELECT v FROM kv WHERE k = ? AND until > ?', key, now())[0]?.v
    },
    // Returns 'full' at the cap so the caller can throw the library's StorageFull (an error object does not cross a Durable Object call as one).
    put(key, value, ttlMs) {
      const t = now()
      if (rows('SELECT 1 AS x FROM kv WHERE k = ? AND until > ?', key, t).length === 0) {
        // Sweep expired rows at most once a second; no alarms, so rows leave only here and by delete.
        if (t >= nextSweep) {
          nextSweep = t + 1000
          sql.exec('DELETE FROM kv WHERE until <= ?', t)
          size = rows('SELECT COUNT(*) AS n FROM kv')[0].n
        }
        if (size >= max) return 'full'
        size += 1
      }
      sql.exec('INSERT OR REPLACE INTO kv (k, v, until) VALUES (?, ?, ?)', key, value, t + ttlMs)
      return 'ok'
    },
    delete(key) {
      sql.exec('DELETE FROM kv WHERE k = ?', key)
      size = Math.max(0, size - 1)
    },
  }
}
