// server.js — Agentic IAM v3.0
// Novità v3: Richiesta Conferma (ex HITL), 11 utenti demo, pagina SLA, catalogo app, workflow autorizzazione RA, firewall semantico
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const conv   = require('./agents/conversational');
const plan   = require('./agents/planner');
const orch   = require('./agents/orchestrator');
const val    = require('./tools/validation_manager');
const audit  = require('./tools/audit');
const email  = require('./tools/email_generator');

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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data, null, 2));
}

const sessions = new Map();
// Workflow autorizzazione Responsabile Applicativo (RA): traccia i moduli in attesa
const raWorkflows = new Map();

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // ── CHAT ────────────────────────────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/chat') {
    const body = await readBody(req);
    const msg  = body.message?.trim();
    if (!msg) return json(res, { error: 'Messaggio vuoto' }, 400);
    try {
      console.log(`\n[CHAT] "${msg}"`);
      const structured = await conv.processRequest(msg, API_KEY);
      console.log(`[CONV] intent=${structured.intent}, upn=${structured.user_upn}, conf=${structured.confidence}`);
      if (structured.blocked) {
        const piano = await plan.buildPlan(structured);
        audit.log({ event: 'firewall_block', request: msg, block_reason: structured.block_reason });
        return json(res, { stage: 'bloccato', sessionId: null, structured, plan: piano, message: '🔒 ' + structured.block_reason });
      }
      const piano = await plan.buildPlan(structured);
      console.log(`[PIANO] step=${piano.steps?.length}, conf=${piano.confidence}`);
      const sessionId = randomUUID();
      sessions.set(sessionId, { piano, structured, status: 'pianificato', startedAt: new Date().toISOString() });
      return json(res, { stage: 'pianificato', sessionId, structured, plan: piano, message: piano.summary, stepAutomatici: piano.steps?.filter(s => !s.requires_validation).length || 0, stepValidazione: piano.steps?.filter(s => s.requires_validation).length || 0 });
    } catch (err) { console.error('[ERRORE]', err.message); return json(res, { error: err.message }, 500); }
  }

  // ── ESEGUI PIANO ────────────────────────────────────────────────────────────
  if (method === 'POST' && url.pathname.startsWith('/api/execute/')) {
    const sessionId = url.pathname.split('/').pop();
    const session   = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Sessione non trovata' }, 404);
    session.status = 'in_esecuzione';
    orch.executePlan(session.piano, { onStepUpdate: ev => { session.lastEvent = ev; session.execution = ev.execution; } })
      .then(ex => { session.execution = ex; session.status = ex.status; console.log('[ESEC]', ex.status); })
      .catch(err => { session.status = 'errore'; session.error = err.message; });
    return json(res, { sessionId, message: 'Esecuzione avviata', status: 'in_esecuzione' });
  }

  // ── STATO SESSIONE ───────────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const s = sessions.get(url.pathname.split('/').pop());
    if (!s) return json(res, { error: 'Sessione non trovata' }, 404);
    return json(res, { sessionId: url.pathname.split('/').pop(), ...s });
  }

  // ── RICHIESTA CONFERMA DL (ex HITL) ────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/validazione')
    return json(res, { in_attesa: val.getAllPending() });

  if (method === 'POST' && url.pathname.match(/^\/api\/validazione\/[^/]+\/approva$/)) {
    const id = url.pathname.split('/')[3];
    const b  = await readBody(req);
    const result = val.approve(id, b.operatore || 'operatore');
    audit.log({ event: 'conferma_approvata', validationId: id, operatore: b.operatore || 'operatore' });
    return json(res, result);
  }

  if (method === 'POST' && url.pathname.match(/^\/api\/validazione\/[^/]+\/rifiuta$/)) {
    const id = url.pathname.split('/')[3];
    const b  = await readBody(req);
    const result = val.reject(id, b.motivo || 'Rifiutato', b.operatore || 'operatore');
    audit.log({ event: 'conferma_rifiutata', validationId: id, motivo: b.motivo, operatore: b.operatore || 'operatore' });
    return json(res, result);
  }

  // ── WORKFLOW Autorizzazione RA ──────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/resp-app/avvia') {
    const b = await readBody(req);
    const wfId = randomUUID();
    const workflow = {
      id: wfId, ticketId: b.ticketId, richiedente: b.richiedente, app: b.app,
      profile: b.profile, stato: 'promemoria_inviato',
      promemoriInviati: 1, avviatoAl: new Date().toISOString(),
      slaScade: new Date(Date.now() + 8 * 3600000).toISOString(),
      escalationScade: new Date(Date.now() + 24 * 3600000).toISOString()
    };
    raWorkflows.set(wfId, workflow);
    audit.log({ event: 'resp_app_workflow_avviato', ...workflow });
    return json(res, { success: true, workflowId: wfId, workflow });
  }

  if (method === 'POST' && url.pathname === '/api/resp-app/conferma') {
    const b = await readBody(req);
    const wf = raWorkflows.get(b.workflowId);
    if (!wf) return json(res, { error: 'Workflow non trovato' }, 404);
    wf.stato = 'ra_confermato'; wf.confermatoAl = new Date().toISOString();
    audit.log({ event: 'resp_app_confermato', workflowId: b.workflowId });
    return json(res, { success: true, workflow: wf });
  }

  if (method === 'GET' && url.pathname === '/api/resp-app')
    return json(res, { workflows: [...raWorkflows.values()] });

  // ── DATI ─────────────────────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/audit') {
    const limit = parseInt(url.searchParams.get('limit') || '30');
    return json(res, { logs: audit.readLogs(limit) });
  }

  if (method === 'POST' && url.pathname === '/api/email') {
    const b = await readBody(req);
    return json(res, { success: true, email: email.generateEmail(b.action || 'generic', b.context || {}) });
  }

  if (method === 'GET' && url.pathname === '/api/users') {
    const g = require('./tools/mock_graph');
    return json(res, g.getAllUsers());
  }

  if (method === 'GET' && url.pathname === '/api/nhi') {
    const g = require('./tools/mock_graph');
    return json(res, g.getNHIInventory());
  }

  if (method === 'GET' && url.pathname === '/api/reviews') {
    const g = require('./tools/mock_graph');
    return json(res, g.getAccessReviews());
  }

  if (method === 'GET' && url.pathname === '/api/tickets') {
    const d = require('./tools/dl_operations');
    return json(res, d.getOpenTickets());
  }

  if (method === 'GET' && url.pathname === '/api/apps') {
    const cat = require('./config/app_catalog.json');
    return json(res, cat);
  }

  if (method === 'GET' && url.pathname === '/api/sla') {
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
      raWorkflows: [...raWorkflows.values()]
    });
  }

  if (method === 'GET' && url.pathname.startsWith('/api/sod/') && url.pathname !== '/api/sod/') {
    const upn = decodeURIComponent(url.pathname.replace('/api/sod/', ''));
    const s = require('./tools/sod_engine'), g = require('./tools/mock_graph');
    return json(res, s.analyzeUser(g.getUser(upn).data));
  }

  if (method === 'GET' && url.pathname === '/api/sod') {
    const s = require('./tools/sod_engine'), g = require('./tools/mock_graph');
    return json(res, s.analyzeAll(g.getAllUsers().data));
  }

  // ── DASHBOARD AGGREGATA ──────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/dashboard') {
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
        sessioniTotali: sessions.size,
        completate: [...sessions.values()].filter(s => s.status === 'completato').length,
        validazionePendente: val.getAllPending().length,
        vociAudit: logs.length,
        raWorkflowAttivi: raWorkflows.size
      },
      ticket: { total: tickets.total, oltreRgSla: overSLA.length, byTipo: tickets.data.reduce((a, t) => { a[t.type] = (a[t.type] || 0) + 1; return a; }, {}) },
      attivitaRecente: logs.slice(0, 12).map(l => ({ time: l.timestamp, azione: l.step_label || l.event || l.step_action, risultato: l.result || l.event, rischio: l.risk_level || null })),
      distribuzioneRischio: { BASSO: logs.filter(l => l.risk_level === 'LOW').length, MEDIO: logs.filter(l => l.risk_level === 'MEDIUM').length, ALTO: logs.filter(l => l.risk_level === 'HIGH').length }
    });
  }

  // ── STATUS ───────────────────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/status')
    return json(res, { status: 'operativo', modalita: API_KEY ? 'live' : 'demo', sessioni: sessions.size, validazionePendente: val.getAllPending().length, uptime: process.uptime().toFixed(0) + 's', versione: '3.0' });

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

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║      AGENTIC IAM v3.0 — Copilota Operativo DL IAM       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Chat:           http://localhost:${PORT}                     ║`);
  console.log(`║  Dashboard:      http://localhost:${PORT}/dashboard.html       ║`);
  console.log(`║  Ticket DL:      http://localhost:${PORT}/tickets.html         ║`);
  console.log(`║  Metriche SLA:   http://localhost:${PORT}/sla.html             ║`);
  console.log(`║  Catalogo App:   http://localhost:${PORT}/apps.html            ║`);
  console.log(`║  Modalità: ${API_KEY ? 'LIVE (Claude API)          ' : 'DEMO (pattern matching)    '}              ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
});