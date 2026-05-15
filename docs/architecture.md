# Architecture — Agentic IAM v3.0

## Executive Summary

Agentic IAM è un **Copilota Operativo PoC** per la Delivery Line (DL) IAM aziendale: trasforma richieste in linguaggio naturale ("Mario Rossi non riesce ad accedere a SAP") in un **piano operativo strutturato** con valutazione del rischio, esegue le azioni reversibili in autonomia e blocca quelle irreversibili dietro una **Richiesta di Conferma** (ex HITL).

L'architettura applica il pattern **Conversational → Planner → Orchestrator** con audit append-only: ogni step ha un `risk_level` predefinito che ne determina il bisogno di approvazione operatore, ed è loggato su `logs/audit.jsonl`. Il PoC è completamente locale (`localhost:3000`), zero dipendenze esterne, con dati simulati che rappresentano un tenant Microsoft Entra ID + SailPoint.

---

## Tech Stack

| Categoria         | Tecnologia                              | Versione        | Motivazione                                                                  |
|-------------------|-----------------------------------------|-----------------|------------------------------------------------------------------------------|
| Runtime           | Node.js                                 | runtime nativo  | Zero dipendenze esterne — modulo `http` standard                             |
| HTTP Server       | `http.createServer`                     | core            | Routing manuale, niente Express. Trade-off accettato per chiarezza demo PoC  |
| LLM               | Anthropic Claude (`claude-sonnet-4-20250514`) | API REST | Conversational Agent. Fallback DEMO con pattern matching locale              |
| Storage runtime   | JSON file + JSONL append                | —               | `mock-data/users.json` riscrivibile + `logs/audit.jsonl` append-only         |
| Frontend          | HTML + CSS + JS vanilla                 | —               | 5 pagine statiche servite da `server.js`. Polling sessione lato client       |
| Auth              | Nessuna (PoC localhost)                 | —               | Pre-condizione: ambiente di sviluppo locale                                  |
| Concorrenza       | In-memory `Map` per sessioni e workflow | —               | Non sopravvive ai restart — accettato per PoC                                |
| Audit             | JSONL append-only via `fs.appendFileSync` | —             | Una riga per evento, immutabile a livello applicativo                        |
| Pacchetti         | npm (lockfile assente, deps vuote)      | —               | `package.json` dichiara `"dependencies": {}` — non c'è `node_modules`        |

**Nota versioning**: il `package.json` root dichiara `version 2.0.0`, [agents/package.json](../agents/package.json) dichiara `1.0.0`, mentre [server.js:1](../server.js#L1) e i log di startup espongono "v3.0". La versione *funzionale* è la **v3.0** (Richiesta Conferma, 25 utenti — anche se attualmente in `users.json` ne sono presenti 11 — pagina SLA, catalogo app, workflow autorizzazione RA).

---

## Architecture Pattern

**Pipeline cognitiva a 3 stadi + audit cross-cutting.**

```
                               ┌────────────────┐
   utente (chat / browser) ──► │  Conversational │  → JSON {intent, upn, entities, confidence, blocked}
                               │     Agent       │
                               └────────┬───────┘
                                        ▼
                               ┌────────────────┐
                               │     Planner     │  → Plan {steps[], rootCauses[], reasoning, summary}
                               │     Agent       │     ogni step arricchito con risk_matrix
                               └────────┬───────┘
                                        ▼
                               ┌────────────────┐         step.requires_validation?
                               │   Orchestrator  │ ◄─── sì ──► validation_manager (Richiesta Conferma)
                               │                 │           ▲ approva/rifiuta da UI ─┐
                               └────────┬────────┘ ────── no ┘                       │
                                        ▼                                            │
                              tool execution (mock_graph, dl_operations, ...) ◄──────┘
                                        ▼
                                   audit.log → logs/audit.jsonl (append-only, una riga JSON per evento)
```

**Principi guida** (visibili nel codice):

1. **Risk-first execution**: lo step ha sempre un `risk` calcolato da `config/risk_matrix.json`. Le azioni di lettura sono `LOW` e auto-eseguite; mutazioni significative sono `MEDIUM`/`HIGH` e richiedono operatore.
2. **Reversibilità esplicita**: la matrice di rischio dichiara `rollback: true|false`. Disabilitazione, esclusione CAP, assegnazione profilo applicativo sono *reversibili* — eliminazione utenti e reset credenziali admin no.
3. **Confidence threshold**: il piano sotto `0.75` ([config/risk_matrix.json:30](../config/risk_matrix.json#L30)) viene marcato con `warning` perché richiede revisione manuale.
4. **Scope governance**: ogni intent può ricadere in uno dei 4 scope di [process_governance.json](../config/process_governance.json) — `DL_IAM`, `DL_IAM_REDIRECT_PIM`, `GA_APPLICATION_SUPPORT`, `ON_PREM_IAM`. I "redirect" non eseguono azioni: rispondono con guida operativa.
5. **DEMO mode è first-class**: il sistema funziona senza `ANTHROPIC_API_KEY`. Il pattern matching in [agents/conversational.js:37-73](../agents/conversational.js#L37-L73) copre 20 intent ed estrae UPN/app/profile da nomi italiani.

---

## Domain Architecture — il dominio IAM

Il prodotto modella esattamente il workflow della DL IAM:

- **Identity layer**: utenti Entra ID con distinzione `cloud-only` / `synced-onprem` / `guest` / `outsourcer`. La sincronizzazione on-prem cambia drasticamente lo scope ("DL non può resettare password sync").
- **Application layer**: 9 applicazioni Azure (ERPCORE, ORDERHUB, AUTHFORMS, NETOPS, NETMON, WORKFLOW, QUALITY, JOBORDER, WEBPORTAL), ciascuna con profili a rischio crescente (`RO` < `OPE` < `MGR/ADV` < `ADM`) e flag `respAppRequired` che attiva il workflow autorizzativo.
- **Authorization layer**: workflow autorizzazione RA con SLA 8h, escalation 24h. Dipende dall'`ownerTeam` dell'app.
- **Audit & Compliance**: SoD engine con 7 regole tag-ate per compliance (SOX/NIS2/GDPR/DORA/ISO27001). PIM esplicitamente **fuori scope** DL.
- **NHI layer**: inventory Service Principal e Managed Identity con flag `noOwner`, `expiredCredentials`, `inactive`.

---

## Data Architecture

Architettura "file-as-database" — pensata per la riproducibilità della demo:

| Sorgente                          | Read | Write | Note                                                              |
|-----------------------------------|------|-------|-------------------------------------------------------------------|
| `mock-data/users.json`            | ✅   | ✅    | Mutazioni inline tramite `mock_graph.saveDB`                      |
| `config/*.json`                   | ✅   | ❌    | Sono "configuration as code"                                      |
| `logs/audit.jsonl`                | ✅   | ✅ (append) | `appendFileSync` — niente rotation                                |
| In-memory `sessions`              | ✅   | ✅    | Persiste solo nella vita del processo                             |
| In-memory `raWorkflows`           | ✅   | ✅    | Persiste solo nella vita del processo                             |
| In-memory `pendingValidations`    | ✅   | ✅    | Vita 30 min (TTL hard) o 120 s (timeout dell'orchestrator)        |

Vedi [data-models.md](./data-models.md) per gli schemi.

---

## API Design

REST stateless lato server (sessione tracciata via `sessionId` dato al client). Tutti gli endpoint risiedono in [server.js](../server.js) — vedi [api-contracts.md](./api-contracts.md).

Pattern UI: il client (es. [public/index.html](../public/index.html)) chiama `POST /api/chat`, riceve `sessionId`, mostra il piano, all'azione "Esegui" chiama `POST /api/execute/:id` e poi **polla** `GET /api/session/:id` per aggiornare la timeline. Le richieste di conferma compaiono come tab a parte e vengono approvate/rifiutate via `POST /api/validazione/:id/approva|rifiuta`.

---

## Frontend Architecture

Cinque pagine HTML stand-alone, condividono solo la palette CSS (purple corporate `#3D0070`/`#7B00D4`):

- **[index.html](../public/index.html)** — Chat UI a 3 colonne (utenti / chat / audit-NHI-conferme)
- **[dashboard.html](../public/dashboard.html)** — KPI grid con utenti per stato, NHI, SoD, ticket, distribuzione rischio
- **[tickets.html](../public/tickets.html)** — Lista ticket DL con stato SLA
- **[sla.html](../public/sla.html)** — Metriche SLA (over/near/in SLA + storico MTTR)
- **[apps.html](../public/apps.html)** — Catalogo applicativo navigabile

Ogni pagina è zero-build: niente bundler, niente framework, niente compilazione. JS inline o `<script>` con `fetch()` sui propri endpoint.

---

## Security Architecture (PoC posture)

| Aspetto                      | Stato attuale (PoC)                                                  | Production posture (TODO)                          |
|------------------------------|----------------------------------------------------------------------|----------------------------------------------------|
| AuthN/AuthZ inbound          | Nessuna — bind localhost                                             | OAuth2/OIDC + RBAC operatori                       |
| Secret management            | `ANTHROPIC_API_KEY` da env                                           | Key Vault / managed identity                       |
| TLS                          | Nessuna (HTTP only)                                                  | TLS 1.2+ termination su reverse proxy              |
| Audit immutability           | JSONL append-only — non firmato                                      | Stream verso SIEM (Sentinel) + WORM storage        |
| Mutazione dati               | Riscrittura diretta `users.json`                                     | Microsoft Graph API reali + transaction log        |
| Rate limiting                | Assente                                                              | Per-operator + per-API + circuit breaker su LLM    |
| Input validation             | Try/catch su body parsing; messaggio empty check                     | Schema validation (Zod / JSON Schema) + sanitization |
| Firewall semantico           | Reagisce su `structured.blocked` ([server.js:56](../server.js#L56))  | Aggiungere classifier dedicato + allow-list intent |

---

## Deployment Architecture

PoC **single-process locale**. Avvio: `npm start` (porta 3000 hardcoded). Niente container, niente CI/CD — è un eseguibile da demo. Sezione *production* in [deployment-guide.md](./deployment-guide.md) (se presente) o nel pptx allegato.

---

## Testing Strategy

Nessun test automatizzato presente nel repository (`tests/`, `*.test.js`, `*.spec.js` assenti). Il "test bench" è il dataset curato di [users.json](../mock-data/users.json), che include scenari controllati: utente attivo CAP-blocked (Mario Rossi), leaver pending (Giulia Verdi), deprovisioned (Luca Ferrari), admin con anomalia notturna (Anna Ricci), impossible-travel (Paolo Bruno), guest in scadenza (Thomas Weber).

**Gap**: per uso produzione servono almeno test di unità sul Planner (per ciascuno dei 17 intent) e test di integrazione end-to-end sull'Orchestrator con stub `validation_manager` (l'auto-approve test).

---

## Architectural Trade-offs e debiti tecnici visibili

1. **`tools/hitl.js` legacy duplicato di `validation_manager.js`** — non referenziato da `server.js`, da rimuovere.
2. **Versioning incoerente** tra `package.json` (2.0.0), `agents/package.json` (1.0.0) e startup banner (3.0). Allineare al primo rilascio production.
3. **Polling fixed 500ms** in `validation_manager.waitForValidation` — accettabile in demo, sostituibile con event emitter in produzione.
4. **Mutazioni tenant inline su `users.json`** — comode in demo, fragili sotto carico (race condition multi-request). In produzione: vere chiamate Graph + idempotency key.
5. **Routing manuale lungo** in `server.js` (~250 righe di if/else): leggibile finché gli endpoint sono ~20, da sostituire con router (Hono / Express) per scalare.
6. **Dataset utenti** — il banner dice "25 utenti" ma `users.json` ne contiene 11. Allineare prima di demo importanti.
