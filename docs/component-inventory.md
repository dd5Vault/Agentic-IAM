# Component Inventory — Agentic IAM v3.0

Inventario di tutti i moduli logici del progetto, suddivisi per responsabilità. Ogni voce indica il file, il ruolo, le funzioni esposte e le dipendenze interne.

## Backend — Agenti

### Conversational Agent — [agents/conversational.js](../agents/conversational.js)

- **Ruolo**: classifica un messaggio in linguaggio naturale in `{intent, user_upn, entities, confidence, blocked, summary}`.
- **Modalità**:
  - `LIVE` (con `ANTHROPIC_API_KEY`): chiama `claude-sonnet-4-20250514` via `fetch`. System prompt elenca tutti gli intent supportati.
  - `DEMO` (default locale): pattern matching deterministico in `simulateConversational`. 20 intent, mappa nomi italiani → UPN.
- **Intent supportati** (20): `troubleshoot_login`, `check_user_status`, `lifecycle_joiner`, `lifecycle_leaver`, `lifecycle_mover`, `access_review`, `nhi_audit`, `anomaly_investigate`, `sod_analysis`, `guest_lifecycle`, `privileged_abuse`, `bulk_review`, `app_enablement`, `user_creation`, `password_reset`, `profile_troubleshoot`, `pim_redirect`, `process_guidance`, `ticket_review`, `unknown`.
- **Export**: `processRequest(userMessage, apiKey)`.

### Planner Agent — [agents/planner.js](../agents/planner.js)

- **Ruolo**: trasforma `{intent, ...}` in un piano operativo `{steps[], rootCauses[], reasoning, summary, confidence, target_user, context}`.
- **Pattern**: switch su `intent` → 17 funzioni `planX(req)` dedicate. Ogni step è arricchito da `enrichStep(action, params)` che pesca da [config/risk_matrix.json](../config/risk_matrix.json) il `risk`, il `requires_hitl`, il `rollback_available` e la `label`.
- **Sotto-soglia confidence**: se `plan.confidence < risk_matrix.confidence_threshold` (0.75) il plan viene marcato `warning`.
- **Dipendenze**: `mock_graph`, `sod_engine`, `dl_operations`, `risk_matrix.json`.
- **Export**: `buildPlan(req)`.

### Orchestrator — [agents/orchestrator.js](../agents/orchestrator.js)

- **Ruolo**: esegue gli step del piano in ordine sequenziale, gestisce la richiesta-conferma e logga ogni evento.
- **Logica**:
  - Per step con `requires_validation=true`: crea richiesta in `validation_manager`, attende `waitForValidation` (timeout 120s). Esiti: `approvata` → esegue; `rifiutata` → break + log; `scaduta` → break + log.
  - Per step automatici: simula latenza random 300-700ms tramite `setTimeout`.
  - Stato finale calcolato come `completato_con_errori` / `stopped_by_operator` / `timeout` / `completato`.
- **Hook**: callback `onStepUpdate({type, step, execution})` per UI in streaming. Tipi: `step_start`, `validation_requested`, `step_approved`, `step_executing`, `step_done`, `step_rejected`.
- **Export**: `executePlan(plan, options)`.

## Backend — Tools

### Mock Graph — [tools/mock_graph.js](../tools/mock_graph.js)

Adattatore principale verso il "tenant" simulato. Carica e riscrive [mock-data/users.json](../mock-data/users.json) ad ogni invocazione.

| Funzione                              | Scopo                                                  |
|---------------------------------------|--------------------------------------------------------|
| `getUser(upn)`                        | Lookup utente con fuzzy match su displayName          |
| `getSignInLogs(upn)`                  | Log + summary (success/failures, lastError, anomalies) |
| `getMFAMethods(upn)`                  | Methods + count                                        |
| `getConditionalAccessPolicies(upn)`   | CAP applicabili in base a gruppi/ruoli                 |
| `getNHIInventory()`                   | NHI + summary (highRisk, noOwner, expiredCredentials)  |
| `getAllUsers()`                       | Tutti + summary aggregato                              |
| `getAccessReviews()`                  | Campagne di review                                     |
| `getSailPointProfile(upn)`            | Solo blocco `sailpoint`                                |
| `disableUser/enableUser(upn)`         | Mutazione `accountEnabled` + `status`                  |
| `addCAPExclusion(upn, policyId)`      | Aggiunta a `excludedUsers`                             |
| `revokeSessions(upn)`                 | Simulato (no mutazione)                                |
| `addToGroup/removeFromGroup`          | Mutazione `user.groups`                                |
| `updateRiskLevel(upn, level)`         | Reset `anomaly` se `none`                              |
| `deprovisionLeaver(upn)`              | Svuota `groups`/`licenses` + `status='deprovisioned'`  |
| `assignAppProfile(upn, profileId)`    | Sostituisce profilo per stessa app prefix              |
| `createUser(userData)`                | Provisioning con default (`SG-Office365`, `M365-E3`)   |

### SoD Engine — [tools/sod_engine.js](../tools/sod_engine.js)

- `analyzeUser(user)` — verifica le 7 regole, ritorna `{conflicts, risk_score, has_conflicts}`. Logica: tutti i `conflicting_groups` di una regola devono essere presenti in `user.groups`.
- `analyzeAll(users)` — aggregato di tenant.
- `loadRules()` — esposta per uso da Planner.
- Compliance tag presenti: SOX, NIS2, GDPR, DORA, ISO27001.

### DL Operations — [tools/dl_operations.js](../tools/dl_operations.js)

Operazioni DL-specific (knowledge of process, non solo dati).

| Funzione                           | Scopo                                                       |
|------------------------------------|-------------------------------------------------------------|
| `getAppInfo(appName)`              | Lookup nel catalogo applicativo                             |
| `getUserAppAssignments(upn)`       | Risolve `appAssignments[]` in oggetti app+profilo+riskLevel |
| `checkRGRequirement(appName)`      | Verifica `respAppRequired` + ownerTeam + SLA                 |
| `checkIdentityExists(upn)`         | Esistenza/abilitazione/sync state                           |
| `checkAccountTypeForReset(upn)`    | Distingue `cloud-only` (DL può) vs `synced` (redirect)      |
| `verifyUserProfile(upn, app)`      | Determina lo scope del problema (DL_IAM / GA / OK)          |
| `handlePIMRedirect(upn, role)`     | Verifica prerequisiti + reindirizza a team PIM              |
| `getProcessGuidance(topic)`        | Lookup nei `topics`: scope, resp_app, first_access, pim, ...  |
| `getOpenTickets()`                 | Ticket aperti dal mock                                      |

### Validation Manager — [tools/validation_manager.js](../tools/validation_manager.js)

- Map in-memory `pendingValidations` con TTL 30 minuti.
- API: `createValidationRequest(step, planContext)`, `getValidation(id)`, `approve(id, operator)`, `reject(id, reason, operator)`, `getAllPending()`, `waitForValidation(id, timeoutMs)`.
- `waitForValidation` polla ogni 500ms; timeout default 120s.

### Audit — [tools/audit.js](../tools/audit.js)

- `log(entry)` — append una riga JSON a `logs/audit.jsonl` con `action_id` (uuid) e `timestamp` ISO.
- `readLogs(limit=50)` — legge l'intero file, ritorna gli ultimi `limit` record in ordine reverse.

### Email Generator — [tools/email_generator.js](../tools/email_generator.js)

- `generateEmail(action, context)` — restituisce `{to, cc, subject, body, generatedAt, action, context}`.
- 6 template: `app_enablement`, `user_creation`, `password_reset`, `leaver`, `pim_redirect`, `generic`.

### HITL Manager (legacy) — [tools/hitl.js](../tools/hitl.js)

⚠ **NON utilizzato** — duplicato di `validation_manager.js` con stessa API ma terminologia inglese (`pendingApprovals`, `approvalId`, `pending`/`approved`/`rejected`). Candidato alla rimozione per ridurre confusione.

## Backend — Configuration

| File                                            | Contenuto                                                                              |
|-------------------------------------------------|----------------------------------------------------------------------------------------|
| [config/risk_matrix.json](../config/risk_matrix.json)             | 26 azioni → risk/HITL/rollback/label + soglie                                          |
| [config/sod_rules.json](../config/sod_rules.json)                 | 7 regole SoD con compliance tag                                                        |
| [config/app_catalog.json](../config/app_catalog.json)             | 9 app Azure + processo autorizzazione RA + SLA                                                    |
| [config/process_governance.json](../config/process_governance.json) | 4 scope DL + first-access guide + password policy                                      |

## Frontend — Pagine

Tutte vanilla HTML+CSS+JS. Comune: palette CSS purple corporate; responsive flex/grid; pollig sessione lato JS inline.

| Pagina                    | Funzione                                                                            |
|---------------------------|-------------------------------------------------------------------------------------|
| [public/index.html](../public/index.html)         | Chat principale a 3 colonne: sidebar utenti, chat con timeline step, audit/NHI/conferme |
| [public/dashboard.html](../public/dashboard.html) | KPI tenant: utenti per stato/rischio, NHI summary, SoD summary, ticket, attività recente |
| [public/tickets.html](../public/tickets.html)     | Lista ticket DL aperti                                                              |
| [public/sla.html](../public/sla.html)             | Metriche SLA over/near/in + storico MTTR                                            |
| [public/apps.html](../public/apps.html)           | Catalogo applicazioni con profili e flag autorizzazione RA                                     |

Pattern interaction (vedi [public/index.html](../public/index.html)):

1. UI → `POST /api/chat` con messaggio
2. Render piano + step pending
3. UI → `POST /api/execute/:sessionId`
4. Polling `GET /api/session/:sessionId` ogni X ms per progress
5. Quando appare uno step `in_attesa_validazione`, fetch `GET /api/validazione`, render conferma
6. Operatore approva → `POST /api/validazione/:id/approva` → orchestrator riprende

## State volatile globale (process-only)

| Variabile                                 | Definita in                                              | Vita                          |
|-------------------------------------------|----------------------------------------------------------|-------------------------------|
| `sessions: Map<sessionId, sessionData>`   | [server.js:34](../server.js#L34)                         | Vita del processo             |
| `raWorkflows: Map<workflowId, workflow>`  | [server.js:36](../server.js#L36)                         | Vita del processo             |
| `pendingValidations: Map<id, request>`    | [tools/validation_manager.js:6](../tools/validation_manager.js#L6) | TTL 30 min hard               |
| `pendingApprovals: Map<id, request>`      | [tools/hitl.js:2](../tools/hitl.js#L2) — **legacy**       | Mai popolata                  |
