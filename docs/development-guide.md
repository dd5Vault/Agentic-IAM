# Development Guide — Agentic IAM v3.0

## Prerequisiti

- **Node.js** ≥ 18 (richiesto per `--watch` di `npm run dev` e per `fetch` nativo usato dal Conversational Agent in modalità LIVE)
- **npm** (per `npm start`)
- **Browser moderno** per la UI
- *Opzionale*: una API key Anthropic in `ANTHROPIC_API_KEY` per attivare la modalità LIVE

Nessun database, nessun container, nessun build step.

## Setup

```bash
# Niente da installare — il package.json non dichiara dipendenze
# Verifica solo la versione di Node:
node --version   # >= 18 (ideale 20+)
```

Non c'è `npm install` significativo: `package.json` ha `dependencies: {}`.

## Avvio

```bash
# Modalità DEMO (default — pattern matching locale)
npm start

# Modalità sviluppo con auto-reload (Node ≥ 18.11)
npm run dev

# Modalità LIVE (Conversational Agent usa Claude Sonnet)
ANTHROPIC_API_KEY=sk-ant-... npm start          # bash
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start  # PowerShell
```

Una volta avviato:

```
╔══════════════════════════════════════════════════════════╗
║      AGENTIC IAM v3.0 — Copilota Operativo DL IAM       ║
╠══════════════════════════════════════════════════════════╣
║  Chat:           http://localhost:3000                  ║
║  Dashboard:      http://localhost:3000/dashboard.html   ║
║  Ticket DL:      http://localhost:3000/tickets.html     ║
║  Metriche SLA:   http://localhost:3000/sla.html         ║
║  Catalogo App:   http://localhost:3000/apps.html        ║
║  Modalità: DEMO (pattern matching)                       ║
╚══════════════════════════════════════════════════════════╝
```

La porta è **hardcoded a 3000** in [server.js:15](../server.js#L15). Per cambiarla, modifica la costante (non c'è ENV var dedicata).

## Endpoint principali per testing manuale

```bash
# Status
curl http://localhost:3000/api/status

# Tutti gli utenti del tenant simulato
curl http://localhost:3000/api/users

# Pipeline conversazionale completa
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Mario Rossi non riesce ad accedere a SAP"}'

# Esegui il piano restituito (sostituisci <sessionId>)
curl -X POST http://localhost:3000/api/execute/<sessionId>

# Polla lo stato
curl http://localhost:3000/api/session/<sessionId>

# Conferme in attesa
curl http://localhost:3000/api/validazione
```

## Scenari di demo già pronti

Il dataset di [mock-data/users.json](../mock-data/users.json) è curato per esercitare ogni intent. Provare in chat:

| Frase                                                         | Intent attivato            |
|---------------------------------------------------------------|----------------------------|
| "Mario Rossi non riesce ad accedere a SAP"                    | `troubleshoot_login`       |
| "Verifica stato di Anna Ricci"                                | `check_user_status`        |
| "Giulia Verdi termina il rapporto, deprovisiona"              | `lifecycle_leaver`         |
| "Fai un audit delle NHI e dei service principal"              | `nhi_audit`                |
| "Anomalia su Paolo Bruno"                                     | `anomaly_investigate`      |
| "Analisi SoD su Mario Rossi"                                  | `sod_analysis`             |
| "Abilita Roberto Galli su ERPCORE con profilo Standard"       | `app_enablement`           |
| "Crea utenza cloud-only per nuovo.utente@demo.local"          | `user_creation`            |
| "Reset password per chiara.fontana"                           | `password_reset`           |
| "Voglio attivare il ruolo Global Admin"                       | `pim_redirect` (out scope) |
| "Quando serve autorizzazione RA?"                                        | `process_guidance`         |
| "Mostra i ticket aperti DL"                                   | `ticket_review`            |

In modalità DEMO il riconoscimento è **deterministico** sui keyword (vedi [agents/conversational.js:37-73](../agents/conversational.js#L37-L73)).

## Modalità DEMO vs LIVE — quando usare cosa

- **DEMO** (no API key): zero latenza, comportamento riproducibile. Ideale per sviluppo iterativo, test di regressione, demo offline. Limitato ai keyword conosciuti.
- **LIVE** (con API key): il Conversational Agent usa Claude per interpretare frasi più libere. Il system prompt impone JSON strict; comportamento dipendente dal modello.

> Il Planner e l'Orchestrator sono **identici** nei due modi: l'LLM è coinvolto solo nel primo stadio.

## Comandi utili

```bash
# Avvia con watch (auto-restart al cambio file)
npm run dev

# Vedi l'audit trail in tempo reale (Linux/Mac)
tail -f logs/audit.jsonl | jq

# PowerShell equivalente
Get-Content logs/audit.jsonl -Wait -Tail 0

# Resetta lo stato runtime: spegni il processo
# (le mutazioni su mock-data/users.json invece persistono!)
```

⚠ **Le scritture su [mock-data/users.json](../mock-data/users.json) sono permanenti**. Per ripristinare il dataset originale si raccomanda un backup prima della demo:

```bash
cp mock-data/users.json mock-data/users.backup.json
# ... esegui la demo ...
cp mock-data/users.backup.json mock-data/users.json
```

## Struttura sessione runtime

Dato il `sessionId` ritornato da `/api/chat`:

```jsonc
{
  "piano":     { /* output di Planner.buildPlan */ },
  "structured": { /* output di Conversational.processRequest */ },
  "status":    "pianificato" | "in_esecuzione" | "completato" | "errore" | "stopped_by_operator" | "timeout",
  "startedAt": "2026-04-30T09:15:00Z",
  "lastEvent": { "type": "step_executing", "step": { ... }, "execution": { ... } },
  "execution": { "sessionId", "startedAt", "plan", "steps", "pendingApprovals", "status", "completedAt" }
}
```

## Logging

Due streams:

1. **stdout** — log diagnostici (`[CHAT]`, `[CONV]`, `[PIANO]`, `[ESEC]`, `[ERRORE]`).
2. **`logs/audit.jsonl`** — append-only audit trail per ogni step eseguito o evento di validazione. Una riga JSON per evento.

## Convenzioni di codice

- Indent: 2 spazi.
- Quote: single (`'`) preferenziali per stringhe semplici, double (`"`) per JSON strings.
- Commenti TOP-of-file con summary in italiano (es. `// agents/orchestrator.js — esecutore con HITL`).
- Niente TypeScript: tutto `.js` con CommonJS (`require`/`module.exports`).
- Niente test framework configurato — non aggiungere uno senza coordinamento.

## Estendere il sistema

| Vuoi aggiungere...                             | Tocca questi file                                                   |
|------------------------------------------------|--------------------------------------------------------------------|
| Un nuovo **intent**                            | `agents/conversational.js` (system prompt + `simulateConversational`), `agents/planner.js` (nuova `planX` + switch in `buildPlan`) |
| Una nuova **azione** eseguibile                | `config/risk_matrix.json` (nuova entry), `agents/orchestrator.js` (case nello switch), `tools/mock_graph.js` o `tools/dl_operations.js` (impl reale) |
| Una nuova **regola SoD**                       | `config/sod_rules.json` (entry con `conflicting_groups`)            |
| Un'**applicazione** al catalogo                | `config/app_catalog.json` (entry con `availableProfiles` + `respAppRequired`) |
| Un nuovo **template email**                    | `tools/email_generator.js` (entry in `templates`)                   |
| Un'**API endpoint** REST                       | `server.js` (nuovo `if`)                                            |
| Una nuova **pagina UI**                        | `public/<nome>.html` (zero-build) — il static serving la espone automaticamente |

## Testing

Non esiste suite automatica. Smoke test manuale consigliato post-modifica:

```bash
# 1. Sanity
curl -s http://localhost:3000/api/status | jq

# 2. Pipeline base
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Anomalia su Paolo Bruno"}' | jq '.plan.steps[].action'

# 3. Esecuzione con conferma
SESSION=$(curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Disabilita Mario Rossi"}' | jq -r '.sessionId')
curl -s -X POST http://localhost:3000/api/execute/$SESSION
sleep 1
curl -s http://localhost:3000/api/validazione | jq '.in_attesa[] | {validationId, label: .step.label}'
```

In assenza di test, raccomandato verificare manualmente almeno: `troubleshoot_login`, `lifecycle_leaver`, `app_enablement` con e senza autorizzazione RA, `pim_redirect`, `password_reset` su utente synced vs cloud.

## Troubleshooting

| Sintomo                                            | Causa probabile                                                         |
|----------------------------------------------------|------------------------------------------------------------------------|
| `Anthropic API error 401`                          | API key non valida / scaduta. Rimuovi la env var per cadere in DEMO    |
| `JSON non valido` dalla pipeline LIVE              | Il modello non ha rispettato il formato. Riprova o switcha a DEMO      |
| `Utente '...' non trovato`                         | UPN non presente in `users.json`. Verifica `mock-data/users.json`     |
| Timeout su `/api/execute/...`                      | L'orchestrator aspetta una conferma — controlla `/api/validazione`     |
| Step in `scaduto`                                  | Conferma non arrivata entro 120s — flusso interrotto                   |
| Mutazioni che "spariscono"                         | Hai sovrascritto `mock-data/users.json` con il backup                  |
