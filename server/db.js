// SQLite persistence layer — better-sqlite3, schema, migrations, prepared
// statements. Single file: data/tagteam.db (path from DATA_DIR env, gitignored).
// Fallback to sql.js is documented in DEPLOY.md; this module assumes
// better-sqlite3 is installed (prebuilds exist for Node 20+ on darwin).
//
// The DB is the durable source of truth; the in-memory Maps in sessions.js are
// the hot read path. Every state mutation in sessions.js writes through here
// inside a transaction (DB first, then memory, so a failed write cannot leave
// memory diverged). On boot, loadFromDisk() rebuilds the in-memory Maps.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

/** @type {Database.Database | null} */
let db = null;
let dbPath = null;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE,
  name       TEXT,
  passhash   TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  host_user_id      TEXT,
  host_key          TEXT,
  created_at        INTEGER,
  last_activity_at  INTEGER,
  title             TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       TEXT,
  name          TEXT,
  role          TEXT,
  can_send      INTEGER,
  status        TEXT,
  joined_at     INTEGER,
  resume_key    TEXT,
  hidden_ranges TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at  INTEGER,
  expires_at  INTEGER,
  used_by     TEXT,
  revoked     INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq              INTEGER,
  role             TEXT,
  author_id        TEXT,
  author_name      TEXT,
  text             TEXT,
  ts               INTEGER,
  streaming        INTEGER,
  tool_events_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  ts          INTEGER,
  session_id  TEXT,
  user_id     TEXT,
  kind        TEXT,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  sid        TEXT PRIMARY KEY,
  user_id    TEXT,
  created_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
CREATE INDEX IF NOT EXISTS idx_invites_session      ON invites(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_session        ON audit_events(session_id);
`;

/** Idempotent migration list (CREATE TABLE IF NOT EXISTS). */
export const migrations = [SCHEMA];

function resolveDefaultPath() {
  const dir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'tagteam.db');
}

function open() {
  dbPath = process.env.TAGTEAM_DB_PATH || resolveDefaultPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

function migrateInternal() {
  if (!db) return;
  db.exec(SCHEMA);
}

function prepareStmts() {
  if (!db) return;
  stmts = {
    // sessions
    insertSession: db.prepare(
      `INSERT INTO sessions (id, host_user_id, host_key, created_at, last_activity_at, title)
       VALUES (@id, @host_user_id, @host_key, @created_at, @last_activity_at, @title)`,
    ),
    updateSessionActivity: db.prepare(
      `UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
    ),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
    getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
    loadRecentSessions: db.prepare(
      `SELECT * FROM sessions WHERE last_activity_at >= ? ORDER BY created_at`,
    ),

    // participants
    insertParticipant: db.prepare(
      `INSERT INTO participants
         (id, session_id, user_id, name, role, can_send, status, joined_at, resume_key, hidden_ranges)
       VALUES
         (@id, @session_id, @user_id, @name, @role, @can_send, @status, @joined_at, @resume_key, @hidden_ranges)`,
    ),
    updateParticipantStatus: db.prepare(
      `UPDATE participants SET status = ?, can_send = ? WHERE id = ?`,
    ),
    updateParticipantCanSend: db.prepare(
      `UPDATE participants SET can_send = ? WHERE id = ?`,
    ),
    updateParticipantHiddenRanges: db.prepare(
      `UPDATE participants SET hidden_ranges = ? WHERE id = ?`,
    ),
    loadParticipants: db.prepare(
      `SELECT * FROM participants WHERE session_id = ?`,
    ),

    // invites
    insertInvite: db.prepare(
      `INSERT INTO invites (token, session_id, created_at, expires_at, used_by, revoked)
       VALUES (@token, @session_id, @created_at, @expires_at, @used_by, @revoked)`,
    ),
    updateInviteUsed: db.prepare(
      `UPDATE invites SET used_by = ? WHERE token = ?`,
    ),
    updateInviteRevoked: db.prepare(
      `UPDATE invites SET revoked = ? WHERE token = ?`,
    ),
    deleteInvite: db.prepare(`DELETE FROM invites WHERE token = ?`),
    loadInvites: db.prepare(`SELECT * FROM invites WHERE session_id = ?`),

    // messages
    insertMessage: db.prepare(
      `INSERT INTO messages
         (id, session_id, seq, role, author_id, author_name, text, ts, streaming, tool_events_json)
       VALUES
         (@id, @session_id, @seq, @role, @author_id, @author_name, @text, @ts, @streaming, @tool_events_json)`,
    ),
    loadMessages: db.prepare(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY seq`,
    ),

    // users (M1 auth dispatch — defined here so the schema is complete)
    insertUser: db.prepare(
      `INSERT INTO users (id, email, name, passhash, created_at)
       VALUES (@id, @email, @name, @passhash, @created_at)`,
    ),
    findUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
    findUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),

    // auth_sessions (M1 auth dispatch)
    insertAuthSession: db.prepare(
      `INSERT INTO auth_sessions (sid, user_id, created_at, expires_at)
       VALUES (@sid, @user_id, @created_at, @expires_at)`,
    ),
    deleteAuthSession: db.prepare(`DELETE FROM auth_sessions WHERE sid = ?`),
    findAuthSession: db.prepare(`SELECT * FROM auth_sessions WHERE sid = ?`),

    // audit_events (M1 observe dispatch)
    insertAuditEvent: db.prepare(
      `INSERT INTO audit_events (id, ts, session_id, user_id, kind, detail_json)
       VALUES (@id, @ts, @session_id, @user_id, @kind, @detail_json)`,
    ),
  };
}

/**
 * Get the open DB handle, opening + migrating + preparing on first call.
 * @returns {Database.Database}
 */
export function getDb() {
  if (db) return db;
  open();
  migrateInternal();
  prepareStmts();
  return db;
}

/**
 * Run idempotent migrations. Safe to call multiple times.
 */
export function migrate() {
  getDb();
  migrateInternal();
}

/**
 * Close + reopen the DB at `opts.path` (default `:memory:`), then migrate +
 * rebind prepared statements. Intended for tests; production uses the single
 * open handle.
 * @param {{ path?: string }} [opts]
 * @returns {Database.Database}
 */
export function resetDb(opts = {}) {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
    stmts = null;
  }
  process.env.TAGTEAM_DB_PATH = opts.path ?? ':memory:';
  return getDb();
}

/** Close the DB handle (process shutdown / test teardown). */
export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
    stmts = null;
  }
}

/**
 * Run `fn` inside a better-sqlite3 transaction. The transaction commits when
 * fn returns normally and rolls back if fn throws. Use this to wrap BOTH the
 * DB write and the in-memory mutation so they cannot diverge — put the DB
 * write first; if it throws, the memory mutation (after it) never runs.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(fn) {
  const d = getDb();
  return d.transaction(fn)();
}

/** @type {Record<string, import('better-sqlite3').Statement> | null} */
export let stmts = null;
