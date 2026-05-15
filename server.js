// server.js — Agentic IAM v3.0
// Novità v3: SQLite persistence, Login/RBAC, Richiesta Conferma, firewall semantico
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const conv   = require('./agents/conversational');
const plan   = require('./agents/planner');
const orch   = require('./agents/orchestrator');
const email  = require('./tools/email_generator');
const { auth, chatSessions, validations, raWorkflows, audit } = require('./tools/database');

const PORT    = 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || null;
const MIME    = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.ico':'image/x-icon' };

console.log(API_KEY ? '✅ LIVE MODE — Claude API attiva' : 'ℹ️  DEMO MODE — pattern matching locale');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => b += c.toString());
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
  res.end(JSON.stringify(data, null, 2));
}

// ── RBAC MIDDLEWARE ──────────────────────────────────────────────────────────
// Ruoli: admin (tutto), operatore (chat + approva + esegui), auditor (solo lettura)
const ROLE_PERMS = {
  admin:     { read: true, write: true, approve: true, execute: true },
  operatore: { read: true, write: true, approve: true, execute: true },
  auditor:   { read: true, write: false, approve: false, execute: false }
};

function getOperator(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return auth.validate(authHeader.slice(7));
}

function requireAuth(req, res, permission) {
  const operator = getOperator(req);
  if (!operator) { json(res, { error: 'Non autenticato. Effettua il login.' }, 401); return null; }
  const perms = ROLE_PERMS[operator.role];
  if (permission && !perms[permission]) { json(res, { error: 'Permesso negato. Ruolo ' + operator.role + ' non autorizzato.' }, 403); return null; }
  return operator;
}

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
    res.end(); return;
  }

  // ── AUTH ENDPOINTS (pubblici) ───────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const result = auth.login(body.username, body.password);
    if (!result) return json(res, { error: 'Credenziali non valide' }, 401);
    audit.log({ event: 'login', operator: result.operator.username, role: result.operator.role });
    return json(res, result);
  }

  if (method === 'GET' && url.pathname === '/api/auth/validate') {
    const operator = getOperator(req);
    if (!operator) return json(res, { valid: false }, 401);
    return json(res, { valid: true, operator });
  }

  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      auth.logout(authHeader.slice(7));
    }
    return json(res, { success: true });
  }

  // ── CHAT ────────────────────────────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/chat') {
    const operator = requireAuth(req, res, 'write');
    if (!operator) return;
    const body = await readBody(req);
    const msg  = body.message?.trim();
    if (!msg) return json(res, { error: 'Messaggio vuoto' }, 400);
    try {
      console.log(`\n[CHAT] "${msg}" (${operator.display_name})`);
      const structured = await conv.processRequest(msg, API_KEY);
      console.log(`[CONV] intent=${structured.intent}, upn=${structured.user_upn}, conf=${structured.confidence}`);
      if (structured.blocked) {
        const piano = await plan.buildPlan(structured);
        audit.log({ event: 'firewall_block', request: msg, block_reason: structured.block_reason, operator: operator.username });
        return json(res, { stage: 'bloccato', sessionId: null, structured, plan: piano, message: '🔒 ' + structured.block_reason });
      }
      const piano = await plan.buildPlan(structured);
      console.log(`[PIANO] step=${piano.steps?.length}, conf=${piano.confidence}`);
      const sessionId = randomUUID();
      chatSessions.create(sessionId, piano, structured, operator.id);
      return json(res, { stage: 'pianificato', sessionId, structured, plan: piano, message: piano.summary, stepAutomatici: piano.steps?.filter(s => !s.requires_validation).length || 0, stepValidazione: piano.steps?.filter(s => s.requires_validation).length || 0 });
    } catch (err) { console.error('[ERRORE]', err.message); return json(res, { error: err.message }, 500); }
  }

  // ── ESEGUI PIANO ────────────────────────────────────────────────────────────
  if (method === 'POST' && url.pathname.startsWith('/api/execute/')) {
    const operator = requireAuth(req, res, 'execute');
    if (!operator) return;
    const sessionId = url.pathname.split('/').pop();
    const session   = chatSessions.get(sessionId);
    if (!session) return json(res, { error: 'Sessione non trovata' }, 404);
    chatSessions.update(sessionId, { status: 'in_esecuzione' });

    // Patch orchestrator to use DB validations
    const dbValManager = {
      createValidationRequest: (step, ctx) => validations.create(step, ctx),
      getValidation: (id) => validations.get(id),
      approve: (id, op) => validations.approve(id, op),
      reject: (id, reason, op) => validations.reject(id, reason, op),
      getAllPending: () => validations.getAllPending(),
      waitForValidation: (id, timeout) => validations.waitForValidation(id, timeout)
    };

    orch.executePlan(session.piano, {
      validationManager: dbValManager,
      auditLogger: audit,
      onStepUpdate: ev => {
        chatSessions.update(sessionId, { lastEvent: ev, execution: ev.execution });
      }
    }).then(ex => {
        chatSessions.update(sessionId, { execution: ex, status: ex.status });
        console.log('[ESEC]', ex.status);
      })
      .catch(err => {
        chatSessions.update(sessionId, { status: 'errore', error: err.message });
      });
    return json(res, { sessionId, message: 'Esecuzione avviata', status: 'in_esecuzione' });
  }

  // ── STATO SESSIONE ───────────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const sessionId = url.pathname.split('/').pop();
    const s = chatSessions.get(sessionId);
    if (!s) return json(res, { error: 'Sessione non trovata' }, 404);
    return json(res, { sessionId, ...s });
  }

  // ── RICHIESTA CONFERMA DL ─────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/validazione') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    return json(res, { in_attesa: validations.getAllPending() });
  }

  if (method === 'POST' && url.pathname.match(/^\/api\/validazione\/[^/]+\/approva$/)) {
    const operator = requireAuth(req, res, 'approve');
    if (!operator) return;
    const id = url.pathname.split('/')[3];
    const result = validations.approve(id, operator.display_name);
    audit.log({ event: 'conferma_approvata', validationId: id, operatore: operator.display_name });
    return json(res, result);
  }

  if (method === 'POST' && url.pathname.match(/^\/api\/validazione\/[^/]+\/rifiuta$/)) {
    const operator = requireAuth(req, res, 'approve');
    if (!operator) return;
    const id = url.pathname.split('/')[3];
    const b  = await readBody(req);
    const result = validations.reject(id, b.motivo || 'Rifiutato', operator.display_name);
    audit.log({ event: 'conferma_rifiutata', validationId: id, motivo: b.motivo, operatore: operator.display_name });
    return json(res, result);
  }

  // ── WORKFLOW Autorizzazione RA ──────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/resp-app/avvia') {
    const operator = requireAuth(req, res, 'write');
    if (!operator) return;
    const b = await readBody(req);
    const workflow = raWorkflows.create(b);
    audit.log({ event: 'resp_app_workflow_avviato', ...workflow, operator: operator.username });
    return json(res, { success: true, workflowId: workflow.id, workflow });
  }

  if (method === 'POST' && url.pathname === '/api/resp-app/conferma') {
    const operator = requireAuth(req, res, 'write');
    if (!operator) return;
    const b = await readBody(req);
    const wf = raWorkflows.confirm(b.workflowId);
    if (!wf) return json(res, { error: 'Workflow non trovato' }, 404);
    audit.log({ event: 'resp_app_confermato', workflowId: b.workflowId, operator: operator.username });
    return json(res, { success: true, workflow: wf });
  }

  if (method === 'GET' && url.pathname === '/api/resp-app') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    return json(res, { workflows: raWorkflows.getAll() });
  }

  // ── DATI ─────────────────────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/audit') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const limit = parseInt(url.searchParams.get('limit') || '30');
    return json(res, { logs: audit.readLogs(limit) });
  }

  if (method === 'POST' && url.pathname === '/api/email') {
    const operator = requireAuth(req, res, 'write');
    if (!operator) return;
    const b = await readBody(req);
    return json(res, { success: true, email: email.generateEmail(b.action || 'generic', b.context || {}) });
  }

  if (method === 'GET' && url.pathname === '/api/users') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const g = require('./tools/mock_graph');
    return json(res, g.getAllUsers());
  }

  if (method === 'GET' && url.pathname === '/api/nhi') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const g = require('./tools/mock_graph');
    return json(res, g.getNHIInventory());
  }

  if (method === 'GET' && url.pathname === '/api/reviews') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const g = require('./tools/mock_graph');
    return json(res, g.getAccessReviews());
  }

  if (method === 'GET' && url.pathname === '/api/tickets') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const d = require('./tools/dl_operations');
    return json(res, d.getOpenTickets());
  }

  if (method === 'GET' && url.pathname === '/api/apps') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const cat = require('./config/app_catalog.json');
    return json(res, cat);
  }

  if (method === 'GET' && url.pathname === '/api/sla') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const db = require('./mock-data/users.json');
    const d  = require('./tools/dl_operations');
    const tickets = d.getOpenTickets();
    const now = new Date();
    const overSLA     = tickets.data.filter(t => t.slaDeadline && new Date(t.slaDeadline) < now);
    const nearSLA     = tickets.data.filter(t => t.slaDeadline && new Date(t.slaDeadline) > now && (new Date(t.slaDeadline) - now) < 4 * 3600000);
    const inSLA       = tickets.data.filter(t => !t.slaDeadline || new Date(t.slaDeadline) > now + 4 * 3600000);
    return json(res, {
      tickets: { total: tickets.total, overSLA: overSLA.length, nearSLA: nearSLA.length, inSLA: inSLA.length, overSLAList: overSLA, nearSLAList: nearSLA },
      historicalMTTR: db.slaMetrics?.historicalMTTR || [],
      slaTarget_minutes: db.slaMetrics?.slaTarget_minutes || 480,
      escalation_minutes: db.slaMetrics?.escalation_minutes || 1440,
      raWorkflows: raWorkflows.getAll()
    });
  }

  if (method === 'GET' && url.pathname.startsWith('/api/sod/') && url.pathname !== '/api/sod/') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const upn = decodeURIComponent(url.pathname.replace('/api/sod/', ''));
    const s = require('./tools/sod_engine'), g = require('./tools/mock_graph');
    return json(res, s.analyzeUser(g.getUser(upn).data));
  }

  if (method === 'GET' && url.pathname === '/api/sod') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const s = require('./tools/sod_engine'), g = require('./tools/mock_graph');
    return json(res, s.analyzeAll(g.getAllUsers().data));
  }

  // ── DASHBOARD AGGREGATA ──────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/dashboard') {
    const operator = requireAuth(req, res, 'read');
    if (!operator) return;
    const g = require('./tools/mock_graph');
    const s = require('./tools/sod_engine');
    const d = require('./tools/dl_operations');
    const all     = g.getAllUsers();
    const nhi     = g.getNHIInventory();
    const sodData = s.analyzeAll(all.data);
    const logs    = audit.readLogs(200);
    const tickets = d.getOpenTickets();
    const now     = new Date();
    const overSLA = tickets.data.filter(t => t.slaDeadline && new Date(t.slaDeadline) < now);
    return json(res, {
      utenti: {
        total: all.data.length, attivi: all.data.filter(u => u.accountEnabled).length,
        disabilitati: all.data.filter(u => !u.accountEnabled).length,
        altoRischio: all.data.filter(u => u.riskLevel === 'high').length,
        rischioMedio: all.data.filter(u => u.riskLevel === 'medium').length,
        senzaMFA: all.data.filter(u => !u.mfaRegistered).length,
        guest: all.data.filter(u => u.guestUser).length,
        conAnomalie: all.data.filter(u => u.anomaly).length,
        syncOnPrem: all.data.filter(u => u.accountType === 'synced-onprem').length
      },
      nhi: nhi.summary,
      sod: { utenti_a_rischio: sodData.users_at_risk, critici: sodData.critical_count, alti: sodData.high_count, conflitti_totali: sodData.total_conflicts },
      operazioni: {
        sessioniTotali: chatSessions.count(),
        completate: chatSessions.countByStatus('completato'),
        validazionePendente: validations.getAllPending().length,
        vociAudit: logs.length,
        raWorkflowAttivi: raWorkflows.count()
      },
      ticket: { total: tickets.total, oltreRgSla: overSLA.length, byTipo: tickets.data.reduce((a, t) => { a[t.type] = (a[t.type] || 0) + 1; return a; }, {}) },
      attivitaRecente: logs.slice(0, 12).map(l => ({ time: l.timestamp, azione: l.step_label || l.event || l.step_action, risultato: l.result || l.event, rischio: l.risk_level || null })),
      distribuzioneRischio: { BASSO: logs.filter(l => l.risk_level === 'LOW').length, MEDIO: logs.filter(l => l.risk_level === 'MEDIUM').length, ALTO: logs.filter(l => l.risk_level === 'HIGH').length }
    });
  }

  // ── STATUS (pubblico) ───────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/status')
    return json(res, { status: 'operativo', modalita: API_KEY ? 'live' : 'demo', sessioni: chatSessions.count(), validazionePendente: validations.getAllPending().length, uptime: process.uptime().toFixed(0) + 's', versione: '3.0' });

  // ── FILE STATICI ─────────────────────────────────────────────────────────────
  if (method === 'GET') {
    const fp   = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.join(__dirname, 'public', fp);
    if (fs.existsSync(full)) {
      const ext = path.extname(full);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(fs.readFileSync(full)); return;
    }
  }

  json(res, { error: 'Non trovato' }, 404);
});

// Pulizia sessioni auth scadute ogni 30 minuti
setInterval(() => auth.cleanup(), 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║      AGENTIC IAM v3.0 — Copilota Operativo DL IAM       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Login:          http://localhost:${PORT}/login.html            ║`);
  console.log(`║  Chat:           http://localhost:${PORT}                     ║`);
  console.log(`║  Dashboard:      http://localhost:${PORT}/dashboard.html       ║`);
  console.log(`║  Ticket DL:      http://localhost:${PORT}/tickets.html         ║`);
  console.log(`║  Metriche SLA:   http://localhost:${PORT}/sla.html             ║`);
  console.log(`║  Catalogo App:   http://localhost:${PORT}/apps.html            ║`);
  console.log(`║  Modalità: ${API_KEY ? 'LIVE (Claude API)          ' : 'DEMO (pattern matching)    '}              ║`);
  console.log('║  Auth: Login + RBAC (admin/operatore/auditor)              ║');
  console.log('║  DB: SQLite (data/iam.db)                                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});
