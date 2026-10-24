import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { logger } from './logger.js';
import { config } from '../config.js';

const DB_PATH = path.resolve(process.cwd(), config.paths.sessionDb);
const fs = await import('node:fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', context TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
    content TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE TABLE IF NOT EXISTS pending_triage (
    session_id TEXT PRIMARY KEY, questions TEXT NOT NULL, advisory_message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`);

const stmt = {
  createSession: db.prepare(`INSERT INTO sessions (id, created_at, updated_at, context) VALUES (?, ?, ?, ?)`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  updateSessionContext: db.prepare(`UPDATE sessions SET context = ?, updated_at = ? WHERE id = ?`),
  touchSession: db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`),
  closeSession: db.prepare(`UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?`),
  insertMessage: db.prepare(`INSERT INTO messages (id, session_id, role, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
  getMessages: db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`),
  setPendingTriage: db.prepare(`INSERT OR REPLACE INTO pending_triage (session_id, questions, advisory_message_id, created_at) VALUES (?, ?, ?, ?)`),
  getPendingTriage: db.prepare(`SELECT * FROM pending_triage WHERE session_id = ?`),
  clearPendingTriage: db.prepare(`DELETE FROM pending_triage WHERE session_id = ?`),
};

export function createSession(initialContext = {}) {
  const id = nanoid(16);
  const now = Date.now();
  stmt.createSession.run(id, now, now, JSON.stringify(initialContext));
  logger.info('session.created', { sessionId: id });
  return getSession(id);
}

export function getSession(sessionId) {
  const row = stmt.getSession.get(sessionId);
  if (!row) return null;
  const messages = stmt.getMessages.all(sessionId).map(m => ({
    id: m.id, role: m.role, kind: m.kind, content: safeJson(m.content), createdAt: m.created_at,
  }));
  const pending = stmt.getPendingTriage.get(sessionId);
  return {
    id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, status: row.status,
    context: safeJson(row.context) || {}, messages,
    pendingTriage: pending ? { questions: safeJson(pending.questions), advisoryMessageId: pending.advisory_message_id } : null,
  };
}

export function appendMessage(sessionId, role, kind, content) {
  const id = nanoid(16);
  const now = Date.now();
  stmt.insertMessage.run(id, sessionId, role, kind, JSON.stringify(content), now);
  stmt.touchSession.run(now, sessionId);
  return { id, role, kind, content, createdAt: now };
}

export function updateSessionContext(sessionId, context) {
  stmt.updateSessionContext.run(JSON.stringify(context), Date.now(), sessionId);
}
export function closeSession(sessionId) { stmt.closeSession.run(Date.now(), sessionId); stmt.clearPendingTriage.run(sessionId); }
export function setPendingTriage(sessionId, questions, advisoryMessageId) {
  stmt.setPendingTriage.run(sessionId, JSON.stringify(questions), advisoryMessageId, Date.now());
}
export function getPendingTriage(sessionId) {
  const row = stmt.getPendingTriage.get(sessionId);
  if (!row) return null;
  return { questions: safeJson(row.questions) || [], advisoryMessageId: row.advisory_message_id };
}
export function clearPendingTriage(sessionId) { stmt.clearPendingTriage.run(sessionId); }

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
export function _db() { return db; }