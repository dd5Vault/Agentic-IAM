// tools/database.js — SQLite persistence layer
// Sostituisce Map in-memory e JSON files per sessioni, validazioni, workflow RA, audit
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'iam.db');

// Crea directory data/ se non esiste
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS operators (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operatore',
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions_auth (
    token TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    piano TEXT NOT NULL,
    structured TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pianificato',
    execution TEXT,
    last_event TEXT,
    error TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    operator_id TEXT
  );

  CREATE TABLE IF NOT EXISTS validations (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'in_attesa',
    step TEXT NOT NULL,
    plan_context TEXT NOT NULL,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    rejection_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS ra_workflows (
    id TEXT PRIMARY KEY,
    ticket_id TEXT,
    richiedente TEXT,
    app TEXT,
    profile TEXT,
    stato TEXT NOT NULL DEFAULT 'promemoria_inviato',
    promemori_inviati INTEGER DEFAULT 1,
    avviato_al TEXT DEFAULT (datetime('now')),
    sla_scade TEXT,
    escalation_scade TEXT,
    confermato_al TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT UNIQUE NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    event TEXT,
    data TEXT NOT NULL
  );
`);

// ── SEED OPERATORI DEFAULT ──────────────────────────────────────────────────
const crypto = require('crypto');
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

const seedOperators = [
  { id: 'op-001', username: 'admin', password: 'admin123', display_name: 'Admin IAM', role: 'admin' },
  { id: 'op-002', username: 'operatore', password: 'operatore123', display_name: 'Marco Operatore', role: 'operatore' },
  { id: 'op-003', username: 'auditor', password: 'auditor123', display_name: 'Laura Auditor', role: 'auditor' }
];

const insertOp = db.prepare('INSERT OR IGNORE INTO operators (id, username, password_hash, display_name, role) VALUES (?,?,?,?,?)');
for (const op of seedOperators) {
  insertOp.run(op.id, op.username, hashPassword(op.password), op.display_name, op.role);
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
const auth = {
  login(username, password) {
    const op = db.prepare('SELECT * FROM operators WHERE username = ?').get(username);
    if (!op || op.password_hash !== hashPassword(password)) return null;
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 8 * 3600000).toISOString(); // 8h
    db.prepare('INSERT INTO sessions_auth (token, operator_id, expires_at) VALUES (?,?,?)').run(token, op.id, expiresAt);
    db.prepare(`UPDATE operators SET last_login = datetime('now') WHERE id = ?`).run(op.id);
    return { token, operator: { id: op.id, username: op.username, display_name: op.display_name, role: op.role }, expiresAt };
  },

  validate(token) {
    if (!token) return null;
    const row = db.prepare(`
      SELECT s.*, o.id as op_id, o.username, o.display_name, o.role
      FROM sessions_auth s JOIN operators o ON s.operator_id = o.id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `).get(token);
    if (!row) return null;
    return { id: row.op_id, username: row.username, display_name: row.display_name, role: row.role };
  },

  logout(token) {
    db.prepare('DELETE FROM sessions_auth WHERE token = ?').run(token);
  },

  // Pulizia sessioni scadute
  cleanup() {
    db.prepare("DELETE FROM sessions_auth WHERE expires_at < datetime('now')").run();
  }
};

// ── CHAT SESSIONS ───────────────────────────────────────────────────────────
const chatSessions = {
  create(id, piano, structured, operatorId) {
    db.prepare('INSERT INTO chat_sessions (id, piano, structured, operator_id) VALUES (?,?,?,?)')
      .run(id, JSON.stringify(piano), JSON.stringify(structured), operatorId || null);
  },

  get(id) {
    const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
    if (!row) return null;
    return {
      piano: JSON.parse(row.piano),
      structured: JSON.parse(row.structured),
      status: row.status,
      execution: row.execution ? JSON.parse(row.execution) : null,
      lastEvent: row.last_event ? JSON.parse(row.last_event) : null,
      error: row.error,
      startedAt: row.started_at,
      operatorId: row.operator_id
    };
  },

  update(id, updates) {
    const fields = [];
    const values = [];
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.execution !== undefined) { fields.push('execution = ?'); values.push(JSON.stringify(updates.execution)); }
    if (updates.lastEvent !== undefined) { fields.push('last_event = ?'); values.push(JSON.stringify(updates.lastEvent)); }
    if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
    if (!fields.length) return;
    values.push(id);
    db.prepare(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  count() {
    return db.prepare('SELECT COUNT(*) as c FROM chat_sessions').get().c;
  },

  countByStatus(status) {
    return db.prepare('SELECT COUNT(*) as c FROM chat_sessions WHERE status = ?').get(status).c;
  }
};

// ── VALIDATIONS ─────────────────────────────────────────────────────────────
const validations = {
  create(step, planContext) {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO validations (id, step, plan_context, label, expires_at) VALUES (?,?,?,?,?)')
      .run(id, JSON.stringify(step), JSON.stringify(planContext), step.label || step.action, expiresAt);
    return id;
  },

  get(id) {
    const row = db.prepare('SELECT * FROM validations WHERE id = ?').get(id);
    if (!row) return null;
    return {
      validationId: row.id,
      status: row.status,
      step: JSON.parse(row.step),
      planContext: JSON.parse(row.plan_context),
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      rejectionReason: row.rejection_reason
    };
  },

  approve(id, operator) {
    const row = db.prepare('SELECT * FROM validations WHERE id = ?').get(id);
    if (!row) return { success: false, error: 'Richiesta non trovata' };
    if (row.status !== 'in_attesa') return { success: false, error: 'Stato attuale: ' + row.status };
    db.prepare(`UPDATE validations SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?`)
      .run('approvata', operator, id);
    return { success: true, request: this.get(id) };
  },

  reject(id, reason, operator) {
    const row = db.prepare('SELECT * FROM validations WHERE id = ?').get(id);
    if (!row) return { success: false, error: 'Richiesta non trovata' };
    db.prepare(`UPDATE validations SET status = ?, approved_by = ?, approved_at = datetime('now'), rejection_reason = ? WHERE id = ?`)
      .run('rifiutata', operator, reason, id);
    return { success: true, request: this.get(id) };
  },

  getAllPending() {
    // Marca scadute
    db.prepare("UPDATE validations SET status = 'scaduta' WHERE status = 'in_attesa' AND expires_at < datetime('now')").run();
    const rows = db.prepare("SELECT * FROM validations WHERE status = 'in_attesa' ORDER BY created_at").all();
    return rows.map(r => ({
      validationId: r.id,
      status: r.status,
      step: JSON.parse(r.step),
      planContext: JSON.parse(r.plan_context),
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      rejectionReason: r.rejection_reason
    }));
  },

  waitForValidation(id, timeoutMs = 120000) {
    return new Promise(resolve => {
      const start = Date.now();
      const iv = setInterval(() => {
        const row = db.prepare('SELECT status FROM validations WHERE id = ?').get(id);
        if (!row) { clearInterval(iv); resolve({ status: 'not_found' }); return; }
        if (row.status !== 'in_attesa') { clearInterval(iv); resolve(this.get(id)); return; }
        if (Date.now() - start > timeoutMs) {
          db.prepare("UPDATE validations SET status = 'scaduta' WHERE id = ?").run(id);
          clearInterval(iv);
          resolve(this.get(id));
        }
      }, 500);
    });
  }
};

// ── RA WORKFLOWS ────────────────────────────────────────────────────────────
const raWorkflowsDb = {
  create(data) {
    const id = randomUUID();
    const slaScade = new Date(Date.now() + 8 * 3600000).toISOString();
    const escalationScade = new Date(Date.now() + 24 * 3600000).toISOString();
    db.prepare('INSERT INTO ra_workflows (id, ticket_id, richiedente, app, profile, sla_scade, escalation_scade) VALUES (?,?,?,?,?,?,?)')
      .run(id, data.ticketId, data.richiedente, data.app, data.profile, slaScade, escalationScade);
    return { id, ...data, stato: 'promemoria_inviato', promemoriInviati: 1, avviatoAl: new Date().toISOString(), slaScade, escalationScade };
  },

  confirm(id) {
    const row = db.prepare('SELECT * FROM ra_workflows WHERE id = ?').get(id);
    if (!row) return null;
    db.prepare("UPDATE ra_workflows SET stato = 'ra_confermato', confermato_al = datetime('now') WHERE id = ?").run(id);
    return this.get(id);
  },

  get(id) {
    const row = db.prepare('SELECT * FROM ra_workflows WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id, ticketId: row.ticket_id, richiedente: row.richiedente,
      app: row.app, profile: row.profile, stato: row.stato,
      promemoriInviati: row.promemori_inviati, avviatoAl: row.avviato_al,
      slaScade: row.sla_scade, escalationScade: row.escalation_scade,
      confermatoAl: row.confermato_al
    };
  },

  getAll() {
    return db.prepare('SELECT * FROM ra_workflows ORDER BY avviato_al DESC').all().map(r => ({
      id: r.id, ticketId: r.ticket_id, richiedente: r.richiedente,
      app: r.app, profile: r.profile, stato: r.stato,
      promemoriInviati: r.promemori_inviati, avviatoAl: r.avviato_al,
      slaScade: r.sla_scade, escalationScade: r.escalation_scade,
      confermatoAl: r.confermato_al
    }));
  },

  count() {
    return db.prepare('SELECT COUNT(*) as c FROM ra_workflows').get().c;
  }
};

// ── AUDIT ───────────────────────────────────────────────────────────────────
const auditDb = {
  log(entry) {
    const actionId = randomUUID();
    const timestamp = new Date().toISOString();
    const record = { action_id: actionId, timestamp, ...entry };
    db.prepare('INSERT INTO audit_log (action_id, timestamp, event, data) VALUES (?,?,?,?)')
      .run(actionId, timestamp, entry.event || entry.step_action || null, JSON.stringify(record));
    // Mantieni anche il file JSONL per compatibilità
    const logFile = path.join(__dirname, '..', 'logs', 'audit.jsonl');
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
    return actionId;
  },

  readLogs(limit = 50) {
    const rows = db.prepare('SELECT data FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => JSON.parse(r.data));
  }
};

module.exports = { db, auth, chatSessions, validations, raWorkflows: raWorkflowsDb, audit: auditDb, hashPassword };
