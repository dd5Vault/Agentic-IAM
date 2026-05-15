# Source Tree Analysis — Agentic IAM v3.0

Albero annotato del progetto. Ogni cartella è descritta con il suo ruolo nel flusso `richiesta utente → piano → richiesta conferma → esecuzione → audit`.

```
agentic-iam/
├── server.js                  # Entry point — HTTP server nativo (zero deps), routing manuale, sessions in-memory
├── package.json               # name=agentic-iam v2.0.0; dependencies={} (PoC senza framework)
│
├── agents/                    # Agenti AI — pipeline conversazionale
│   ├── conversational.js      # Intent classification (20 intent IAM/DL); LIVE via Claude API o DEMO via pattern matching
│   ├── planner.js             # buildPlan(intent) → genera 17 piani specifici, arricchisce step con risk_matrix
│   ├── orchestrator.js        # executePlan: esecuzione sequenziale, gestione richiesta-conferma, audit logging
│   └── package.json           # Stub package.json locale (dup root) — non utilizzato per dipendenze
│
├── tools/                     # Adattatori verso "fonti dati" (mock) e moduli operativi
│   ├── mock_graph.js          # Simula Microsoft Graph + SailPoint: getUser, getSignInLogs, getMFAMethods, getCAPolicies, NHI, mutazioni (disable/enable, deprovision, addCAPExclusion, ...)
│   ├── sod_engine.js          # Analizza Segregation of Duties contro config/sod_rules.json — analyzeUser, analyzeAll, calcScore
│   ├── dl_operations.js       # Operazioni DL-specific: catalogo app, autorizzazione RA check, identità sync vs cloud-only, profile troubleshoot, PIM redirect, process guidance, ticket open
│   ├── validation_manager.js  # Richiesta-Conferma (ex HITL): create/get/approve/reject + waitForValidation con polling 500ms, timeout 120s
│   ├── audit.js               # Append-only JSONL su logs/audit.jsonl; readLogs(limit) per UI
│   ├── email_generator.js     # Bozze email post-azione: app_enablement, user_creation, password_reset, leaver, pim_redirect, generic
│   └── hitl.js                # ⚠ LEGACY: API quasi identica a validation_manager.js, non referenziato da server.js — candidato rimozione
│
├── config/                    # Regole, governance, catalogo — NON modificate a runtime
│   ├── risk_matrix.json       # 26 azioni → {risk, requires_hitl, rollback, label}; confidence_threshold=0.75; auto_disable_risk_score=80
│   ├── sod_rules.json         # 7 regole SoD (CRITICAL/HIGH) con compliance tag (SOX, NIS2, GDPR, DORA, ISO27001)
│   ├── app_catalog.json       # 9 app Azure (ERPCORE, ORDERHUB, AUTHFORMS, NETOPS, NETMON, WORKFLOW, QUALITY, JOBORDER, WEBPORTAL) + processo autorizzazione RA + SLA 8h
│   └── process_governance.json # Scope DL IAM / Redirect PIM / GA / On-Prem; first-access guide; password policy
│
├── mock-data/                 # "Tenant" simulato — letto e SCRITTO a runtime
│   └── users.json             # users[], signInLogs{}, conditionalAccessPolicies[], nonHumanIdentities[], accessReviewCampaigns[], openTickets[], slaMetrics{}
│
├── logs/                      # Output runtime (write-only durante l'esecuzione)
│   └── audit.jsonl            # Append-only audit trail — una riga JSON per evento
│
├── public/                    # Frontend HTML/CSS/JS vanilla — servito staticamente da server.js
│   ├── index.html             # Chat UI principale (sidebar utenti + chat + audit/NHI/conferme tabs)
│   ├── dashboard.html         # KPI tenant: utenti, NHI, SoD, ticket, distribuzione rischio
│   ├── tickets.html           # Vista ticket DL aperti
│   ├── sla.html               # Metriche SLA (over/near/in SLA + storico MTTR)
│   └── apps.html              # Catalogo applicazioni navigabile
│
├── docs/                      # Documentazione del progetto (questa cartella)
│   ├── index.md               # Master index — punto d'ingresso AI
│   ├── project-overview.md    # Sintesi prodotto + dominio + capabilities
│   ├── architecture.md        # Architettura tecnica, pattern, scelte
│   ├── api-contracts.md       # Tutti gli endpoint REST
│   ├── data-models.md         # Schema dati + config + audit
│   ├── component-inventory.md # Inventario moduli backend e pagine frontend
│   ├── development-guide.md   # Setup locale + comandi + DEMO/LIVE mode
│   ├── source-tree-analysis.md  # Questo file
│   └── project-scan-report.json # State file del workflow di scansione
│
├── files/                     # (vuota) Cartella riservata — probabile utilizzo per allegati/upload
│
├── Agentic_IAM_Copilota_Operativo.pptx   # Slide tecnico-funzionale (italiano) — out of band
├── Agentic_IAM_Studio_Tecnico.docx       # Studio tecnico (italiano) — out of band
└── Agentic_IAM_Guida_Completa_v2.docx    # Guida completa (italiano) — out of band
```

## Entry point e bootstrap

- **Comando**: `npm start` → `node server.js` (oppure `npm run dev` con `--watch`)
- **Bootstrap**:
  1. `server.js` carica i 3 agenti (`conv`, `plan`, `orch`) e i tools (`val`, `audit`, `email`)
  2. Stampa `LIVE MODE` se `ANTHROPIC_API_KEY` è settata, altrimenti `DEMO MODE`
  3. Crea l'`http.createServer(handler)` su `PORT=3000` (hardcoded)
  4. All'arrivo di una request: routing manuale `if (method && pathname) { ... }`
  5. Le mutazioni passano sempre da `mock_graph` o `dl_operations` → entrambi ricaricano `users.json` (`loadDB`) e riscrivono (`saveDB`) — niente caching tra richieste

## Flussi principali

| Flusso                  | Catena di chiamate                                                                               |
|-------------------------|--------------------------------------------------------------------------------------------------|
| Chat → piano            | `POST /api/chat` → `conv.processRequest` → `plan.buildPlan` → `sessions.set` → response          |
| Esegui piano            | `POST /api/execute/:id` → `orch.executePlan` (async) → `audit.log` per ogni step                 |
| Step a rischio MED/HIGH | Orchestrator → `validation_manager.createValidationRequest` → polling → approva/rifiuta da UI    |
| Dashboard               | `GET /api/dashboard` → `mock_graph.getAllUsers/NHI` + `sod_engine.analyzeAll` + `audit.readLogs` |
| Audit                   | Tutti i tool che mutano stato chiamano `audit.log` (anche `audit.js:5` e `orchestrator.js:30`)   |

## Cartelle critiche per AI agent / brownfield PRD

| Cartella     | Cosa contiene di "non derivabile"                                                                |
|--------------|--------------------------------------------------------------------------------------------------|
| `agents/`    | La pipeline cognitiva: capire questi 3 file = capire il prodotto                                 |
| `tools/`     | Tutti gli adattatori. `mock_graph` e `dl_operations` definiscono di fatto le capability del Copilota |
| `config/`    | Le regole business (SoD, autorizzazione RA, scope DL): cambiarle senza touchare il codice è una feature    |
| `mock-data/users.json` | Dati di test ricchi e curati: 11 utenti con persone, scenari (Mover, Leaver, anomalie, guest, sync). Non è "fixture" — è la "demo bench" |
