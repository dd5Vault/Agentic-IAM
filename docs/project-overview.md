# Project Overview — Agentic IAM v3.0

## Cos'è

**Agentic IAM** è un **Copilota Operativo PoC** per la **Delivery Line IAM (Team IAM)** aziendale: un agente AI che riceve richieste in linguaggio naturale dagli operatori (es. "Mario Rossi non riesce ad accedere a SAP", "Disabilita Giulia Verdi che lascia l'azienda"), produce un **piano operativo strutturato** con valutazione del rischio per ogni step, esegue automaticamente le azioni a basso rischio e blocca quelle critiche dietro una **Richiesta di Conferma** all'operatore umano.

Il sistema è progettato per **affiancare** al Team IAM, non per sostituirla: ogni mutazione significativa richiede approvazione esplicita, ogni azione viene loggata, e gli intent fuori scope (PIM, problemi applicativi, IAM on-prem) vengono **reindirizzati** ai team competenti con guida operativa.

## Versione e stato

- **Versione funzionale**: v3.0 (banner di startup, [server.js:1](../server.js#L1))
- **Versione package**: `2.0.0` ([package.json](../package.json))
- **Tipo**: Proof of Concept locale, single-process, zero dipendenze esterne
- **Linguaggio del prodotto**: italiano (UI, intent, log, email)
- **Modalità**: DEMO (default, pattern matching) o LIVE (con `ANTHROPIC_API_KEY`)

## Cosa fa — capabilities

**Intent supportati** (20 totali, vedi [agents/conversational.js:4-7](../agents/conversational.js#L4-L7)):

| Categoria               | Intent                                                                           |
|-------------------------|----------------------------------------------------------------------------------|
| Troubleshooting & status | `troubleshoot_login`, `check_user_status`, `profile_troubleshoot`               |
| Lifecycle Joiner/Mover/Leaver | `lifecycle_joiner`, `lifecycle_mover`, `lifecycle_leaver`, `user_creation`  |
| Sicurezza & rischio     | `anomaly_investigate`, `privileged_abuse`, `sod_analysis`                       |
| Governance accessi      | `bulk_review`, `access_review`, `nhi_audit`, `guest_lifecycle`                  |
| App enablement DL       | `app_enablement` (9 app: ERPCORE, ORDERHUB, AUTHFORMS, NETOPS, NETMON, WORKFLOW, QUALITY, JOBORDER, WEBPORTAL) |
| Process & redirect      | `password_reset`, `pim_redirect`, `process_guidance`, `ticket_review`           |

## Architettura in una frase

**Pipeline 3-stadi**: `Conversational Agent` (intent classification) → `Planner Agent` (piano operativo) → `Orchestrator` (esecuzione con Richiesta-Conferma per step a rischio MEDIUM/HIGH), con audit append-only su ogni evento.

Vedi [architecture.md](./architecture.md) per il dettaglio completo.

## Tech stack in una frase

**Node.js puro** (modulo `http` standard, **zero dipendenze npm**) + **HTML/CSS/JS vanilla** per il frontend + **Anthropic Claude Sonnet 4** per la modalità LIVE (con fallback DEMO senza LLM) + **JSON file** per dati simulati e **JSONL append-only** per audit.

## Dominio

Il prodotto modella precisamente il workflow della **DL IAM**:

- **Identity**: utenti Entra ID `cloud-only` / `synced-onprem` / `guest` / `outsourcer` (la sincronizzazione cambia drasticamente lo scope DL)
- **Application**: 9 app Azure censite con profili a rischio crescente (`RO` < `OPE` < `MGR/ADV` < `ADM`) e flag `respAppRequired`
- **Authorization**: workflow autorizzazione RA con SLA 8h ed escalation 24h, dipendente dall'`ownerTeam` dell'app
- **Compliance**: 7 regole SoD tag-ate per SOX, NIS2, GDPR, DORA, ISO27001
- **Out of scope esplicito**: PIM, problemi applicativi (GA), IAM on-prem — il sistema *reindirizza* con guida operativa

## Repository structure

| Cartella       | Ruolo                                                                                            |
|----------------|--------------------------------------------------------------------------------------------------|
| [agents/](../agents/)         | Pipeline cognitiva (Conversational + Planner + Orchestrator)                       |
| [tools/](../tools/)           | Adattatori dati (mock-graph, sod-engine, dl-operations) + utility (audit, email, validation) |
| [config/](../config/)         | Regole business: risk matrix, SoD rules, app catalog, governance                   |
| [mock-data/](../mock-data/)   | Tenant simulato (users.json riscrivibile)                                          |
| [public/](../public/)         | 5 pagine UI vanilla (chat, dashboard, tickets, sla, apps)                          |
| [logs/](../logs/)             | `audit.jsonl` append-only                                                          |
| [docs/](.)                    | Documentazione (questa cartella)                                                   |
| [files/](../files/)           | Riservata (vuota)                                                                  |

Documenti `.docx` / `.pptx` nella root sono materiale di accompagnamento (italiano, fuori repo logico).

## Quick start

```bash
node --version    # ≥ 18
npm start         # avvia su http://localhost:3000
```

Apri il browser su `http://localhost:3000` e scrivi in chat *"Mario Rossi non riesce ad accedere a SAP"*. Vedrai il piano generato, gli step a basso rischio già eseguiti e la prima richiesta di conferma per gli step critici.

Vedi [development-guide.md](./development-guide.md) per i dettagli, gli scenari di demo e i comandi di test.

## Documenti correlati

- [architecture.md](./architecture.md) — pattern, principi, trade-off
- [api-contracts.md](./api-contracts.md) — tutti gli endpoint REST
- [data-models.md](./data-models.md) — schema mock-data + config + audit
- [component-inventory.md](./component-inventory.md) — moduli backend e pagine frontend
- [source-tree-analysis.md](./source-tree-analysis.md) — albero annotato
- [development-guide.md](./development-guide.md) — setup, comandi, troubleshooting

## Stato e debiti tecnici visibili

1. **Versioning incoerente** — `package.json:2.0.0` vs banner `v3.0` vs `agents/package.json:1.0.0`. Allineare prima di rilasci.
2. **`tools/hitl.js` legacy** — duplicato di `validation_manager.js`, mai referenziato. Rimuovere.
3. **`mock-data/users.json` mutabile** — le demo possono "sporcare" il dataset. Backup prima delle sessioni con audience.
4. **Banner dice "25 utenti"** — `users.json` ne contiene 11. Allineare.
5. **Routing manuale lungo** in `server.js` — funziona finché gli endpoint sono ~20.
6. **Polling fixed 500ms** in `validation_manager` — accettabile per PoC, da event-emitter in produzione.
7. **Nessun test automatico** — il "test bench" è il dataset curato. Per produzione: unit Planner + integrazione Orchestrator.
