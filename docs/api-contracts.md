# API Contracts — Agentic IAM v3.0

Tutti gli endpoint sono esposti dal singolo server HTTP nativo Node.js in [server.js](../server.js). Nessun framework: il routing è basato su `if (method && pathname)`. Tutte le risposte sono JSON con header `Access-Control-Allow-Origin: *`.

Base URL: `http://localhost:3000`

## Tabella riassuntiva endpoint

| Metodo | Path                                  | Scopo                                            | Sorgente dati                              |
|-------:|---------------------------------------|--------------------------------------------------|--------------------------------------------|
| POST   | `/api/chat`                           | Pipeline conversazionale → piano operativo       | Conversational Agent + Planner Agent       |
| POST   | `/api/execute/:sessionId`             | Avvia esecuzione del piano associato alla sessione | Orchestrator                              |
| GET    | `/api/session/:sessionId`             | Stato sessione corrente                          | In-memory `sessions` map                   |
| GET    | `/api/validazione`                    | Lista richieste di conferma in attesa            | `validation_manager`                       |
| POST   | `/api/validazione/:id/approva`        | Approva una richiesta di conferma                | `validation_manager` + `audit`             |
| POST   | `/api/validazione/:id/rifiuta`        | Rifiuta una richiesta di conferma                | `validation_manager` + `audit`             |
| POST   | `/api/resp-app/avvia`                   | Avvia workflow autorizzazione RA con SLA 8h                 | In-memory `raWorkflows` map + `audit`      |
| POST   | `/api/resp-app/conferma`                | Conferma RG ricevuto                             | In-memory `raWorkflows` map + `audit`      |
| GET    | `/api/resp-app`                         | Lista workflow autorizzazione RA                            | In-memory `raWorkflows` map                |
| GET    | `/api/audit?limit=N`                  | Ultimi N record di audit (default 30)            | `logs/audit.jsonl`                         |
| POST   | `/api/email`                          | Genera bozza email post-azione                   | `email_generator`                          |
| GET    | `/api/users`                          | Tutti gli utenti mock                            | `mock_graph.getAllUsers()`                 |
| GET    | `/api/nhi`                            | Inventory Non-Human Identities                   | `mock_graph.getNHIInventory()`             |
| GET    | `/api/reviews`                        | Campagne Access Review                           | `mock_graph.getAccessReviews()`            |
| GET    | `/api/tickets`                        | Ticket DL aperti                                 | `dl_operations.getOpenTickets()`           |
| GET    | `/api/apps`                           | Catalogo applicazioni                            | `config/app_catalog.json`                  |
| GET    | `/api/sla`                            | Metriche SLA aggregate (over/near/in SLA)        | `dl_operations` + `users.json`             |
| GET    | `/api/sod/:upn`                       | Analisi SoD per singolo utente                   | `sod_engine.analyzeUser()`                 |
| GET    | `/api/sod`                            | Analisi SoD su tutti gli utenti                  | `sod_engine.analyzeAll()`                  |
| GET    | `/api/dashboard`                      | Aggregato KPI per dashboard principale           | tutti i tools                              |
| GET    | `/api/status`                         | Stato del servizio (uptime, modalità, sessioni)  | runtime                                    |
| GET    | `/` e `/*.html`, `*.js`, `*.css`      | Static file serving da [public/](../public/)     | filesystem                                 |
| OPTIONS| `*`                                   | Pre-flight CORS                                  | —                                          |

## Endpoint dettagliati

### POST `/api/chat`

Entrypoint principale. Accetta un messaggio in linguaggio naturale, lo classifica via Conversational Agent (intent + entities + UPN), genera il piano operativo via Planner, registra una sessione e risponde con il piano *non ancora eseguito*.

**Request body**

```json
{ "message": "Mario Rossi non riesce ad accedere a SAP" }
```

**Response 200 (piano pronto)**

```json
{
  "stage": "pianificato",
  "sessionId": "uuid-v4",
  "structured": {
    "intent": "troubleshoot_login",
    "user_upn": "mario.rossi@demo.local",
    "entities": { "app": null, "profile": null, "error_hint": "ConditionalAccess", "topic": null, "accountType": "cloud-only", "new_role": null },
    "confidence": 0.89,
    "blocked": false,
    "block_reason": null,
    "summary": "Troubleshooting login per mario.rossi@demo.local"
  },
  "plan": {
    "intent": "troubleshoot_login",
    "target_user": { "...": "user object" },
    "context": { "...": "intent-specific context" },
    "rootCauses": [ { "cause": "cap_block", "severity": "MEDIUM", "description": "Blocked by CAP: ..." } ],
    "steps": [ { "action": "check_account_status", "label": "Verifica stato account", "params": { "upn": "..." }, "risk": "LOW", "requires_hitl": false, "rollback_available": false, "status": "pending" } ],
    "confidence": 0.92,
    "reasoning": "...",
    "summary": "Cause: ..."
  },
  "message": "Cause: ...",
  "stepAutomatici": 3,
  "stepValidazione": 2
}
```

**Response 200 (richiesta bloccata da firewall semantico)**

```json
{
  "stage": "bloccato",
  "message": "🔒 Firewall di Sicurezza: ...",
  "structured": { "intent": "...", "blocked": true, "block_reason": "..." }
}
```

**Errori**: `400` su messaggio vuoto, `500` su errore Planner/Conversational.

**Modalità**: se la variabile `ANTHROPIC_API_KEY` è valorizzata l'agent conversazionale chiama `https://api.anthropic.com/v1/messages` (modello `claude-sonnet-4-20250514`); altrimenti opera in **DEMO MODE** con pattern matching locale (vedi [agents/conversational.js](../agents/conversational.js#L37-L73)).

### POST `/api/execute/:sessionId`

Avvia l'esecuzione del piano in modalità asincrona (fire-and-forget): la response torna subito, l'esecuzione prosegue in background e popola `session.execution`.

**Response 200**

```json
{ "sessionId": "...", "message": "Esecuzione avviata", "status": "in_esecuzione" }
```

L'orchestrator esegue ogni step in ordine: per gli step con `requires_validation=true` crea una richiesta in `validation_manager` e attende fino a 120s la decisione dell'operatore. Stati possibili a fine esecuzione: `completato`, `completato_con_errori`, `stopped_by_operator`, `timeout`, `partial_failure`.

**Errori**: `404` se la sessione non esiste.

### GET `/api/session/:sessionId`

Restituisce lo snapshot della sessione (piano, stato, ultimo evento, esecuzione corrente). Pollare questo endpoint per realizzare progress UI lato client.

### Richiesta Conferma (ex HITL)

Tutti gli step a rischio MEDIUM/HIGH richiedono approvazione operatore. Il flusso è: Orchestrator → `validation_manager.createValidationRequest` → `GET /api/validazione` (UI mostra) → `POST /api/validazione/:id/approva|rifiuta` → Orchestrator riprende.

**`POST /api/validazione/:id/approva`** body:

```json
{ "operatore": "nome.operatore@demo.local" }
```

**`POST /api/validazione/:id/rifiuta`** body:

```json
{ "operatore": "...", "motivo": "Manca approvazione RA" }
```

Le richieste in stato `in_attesa` scadono dopo 30 minuti (timeout interno) o dopo 120 secondi se l'orchestrator non riceve risposta (vedi `waitForValidation` in [tools/validation_manager.js:64-78](../tools/validation_manager.js#L64-L78)).

### Workflow autorizzazione RA

Tracciamento dei moduli autorizzativi richiesti per le app sensibili (ERPCORE, ORDERHUB, NETOPS, WORKFLOW, JOBORDER). Ogni workflow nasce con `slaScade = +8h` ed `escalationScade = +24h`.

**`POST /api/resp-app/avvia`** body:

```json
{ "ticketId": "INC0012345", "richiedente": "manager@demo.local", "app": "ERPCORE", "profile": "ERPCORE-ADV" }
```

**`POST /api/resp-app/conferma`** body:

```json
{ "workflowId": "uuid-v4" }
```

### GET `/api/dashboard`

Aggregato sincronico di tutti i KPI mostrati in [public/dashboard.html](../public/dashboard.html). Combina `users`, `nhi`, `sod`, `sessions`, `validation_manager`, `audit`, `tickets` in un unico oggetto: utenti per stato/rischio, NHI summary, SoD summary, conteggio operazioni, ticket per tipo, attività recente, distribuzione rischio.

### GET `/api/sod` e `/api/sod/:upn`

`analyzeAll` itera tutti gli utenti e applica le 7 regole di [config/sod_rules.json](../config/sod_rules.json). Ritorna utenti a rischio, conteggi per severity, conflitti totali e matrice dettagliata. Lo score per utente è `min(40·CRITICAL + 25·HIGH + 10·MEDIUM, 100)`.

### GET `/api/audit?limit=N`

Legge in append-only `logs/audit.jsonl` (una riga JSON per evento). Restituisce gli ultimi N record in ordine cronologico inverso. Limit default 30, validato come integer.

### Static file serving

Qualsiasi `GET` non instradato ai path `/api/...` cade nel fallback static: `/` viene riscritto in `/index.html`, gli altri path sono cercati relativamente a [public/](../public/) e serviti con MIME inferito dall'estensione (`.html`, `.js`, `.css`, `.json`, `.ico`). Gli altri tipi rispondono `text/plain`.

## CORS

Tutte le response includono `Access-Control-Allow-Origin: *`. La pre-flight `OPTIONS` risponde 204 e abilita i metodi `GET, POST, OPTIONS` con header `Content-Type`.

## Note di sicurezza (PoC)

- Nessuna autenticazione lato server: il binding è su `localhost:3000` ed è pensato per esecuzione locale.
- L'API key Anthropic è letta solo dall'env `ANTHROPIC_API_KEY`. Non è loggata.
- `audit.jsonl` è append-only ma non firmato: per uso reale serve integrare con SIEM (es. Microsoft Sentinel).
