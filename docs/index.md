# Agentic IAM v3.0 — Documentation Index

**Generato il**: 2026-05-08
**Modalità scansione**: initial_scan / deep
**Tipo progetto**: web full-stack (Node.js HTTP nativo + frontend HTML)
**Repository**: monolith — 1 part

---

## Project Overview

- **Tipo**: monolith (Node.js full-stack)
- **Linguaggio primario**: JavaScript (CommonJS, niente TypeScript)
- **Architettura**: pipeline cognitiva 3-stadi (Conversational → Planner → Orchestrator) + audit append-only
- **Tech stack**: Node.js puro (modulo `http`), zero dipendenze npm, HTML/CSS/JS vanilla, Anthropic Claude Sonnet 4 (opzionale via env var), file JSON come storage
- **Dominio**: Identity & Access Management — Copilota Operativo per la Delivery Line IAM

## Quick Reference

- **Entry point**: [server.js](../server.js) — `npm start` su `http://localhost:3000`
- **Modalità**: DEMO (default, pattern matching locale) o LIVE (con `ANTHROPIC_API_KEY`)
- **Prerequisiti**: Node.js ≥ 18
- **Persistenza**: [mock-data/users.json](../mock-data/users.json) (mutabile a runtime), [logs/audit.jsonl](../logs/audit.jsonl) (append-only)

## Generated Documentation

- [Project Overview](./project-overview.md) — sintesi prodotto, capability, stato
- [Architecture](./architecture.md) — pattern, tech stack, principi, trade-off
- [Source Tree Analysis](./source-tree-analysis.md) — albero annotato del repository
- [API Contracts](./api-contracts.md) — tutti gli endpoint REST con request/response
- [Data Models](./data-models.md) — schema users.json, config files, audit log, state in-memory
- [Component Inventory](./component-inventory.md) — moduli backend (agents, tools, config) e pagine frontend
- [Development Guide](./development-guide.md) — setup locale, scenari demo, troubleshooting

## Existing Documentation

- [README / Project root](../) — i seguenti documenti `.docx` e `.pptx` sono presenti nella root del progetto, in italiano:
  - [Agentic_IAM_Copilota_Operativo.pptx](../Agentic_IAM_Copilota_Operativo.pptx) — slide tecnico-funzionali
  - [Agentic_IAM_Studio_Tecnico.docx](../Agentic_IAM_Studio_Tecnico.docx) — studio tecnico esteso
  - [Agentic_IAM_Guida_Completa_v2.docx](../Agentic_IAM_Guida_Completa_v2.docx) — guida completa al prodotto

> Nota: questi file *non* sono stati indicizzati (formato binario). Sono materiale di accompagnamento per stakeholder, non sostituiscono la documentazione qui sopra.

## Getting Started

```bash
# 1. Verifica prerequisiti
node --version   # >= 18

# 2. Avvia in modalità DEMO (no API key richiesta)
npm start

# 3. Apri il browser
# http://localhost:3000             — Chat
# http://localhost:3000/dashboard.html — Dashboard
# http://localhost:3000/tickets.html   — Ticket DL
# http://localhost:3000/sla.html       — Metriche SLA
# http://localhost:3000/apps.html      — Catalogo app
```

Prova in chat: *"Mario Rossi non riesce ad accedere a SAP"* — vedrai il piano generato, gli step `LOW risk` auto-eseguiti e la prima Richiesta di Conferma per gli step `MEDIUM/HIGH risk`.

Vedi [development-guide.md](./development-guide.md) per scenari completi e debug.

## Next Steps consigliati

1. **Backup** [mock-data/users.json](../mock-data/users.json) prima di demo importanti — le mutazioni sono permanenti.
2. **Allineare il versioning** tra [package.json](../package.json) (2.0.0), [agents/package.json](../agents/package.json) (1.0.0) e il banner di [server.js](../server.js) (3.0).
3. **Rimuovere [tools/hitl.js](../tools/hitl.js)** — legacy duplicato di `validation_manager.js`, non più referenziato.
4. **Test suite**: aggiungere unit test sul Planner (uno per intent) e integration test sull'Orchestrator. Nessuna suite oggi.
5. Per pianificare nuove feature: usa **`bmad-create-prd`** (Brownfield PRD) puntando a questo `index.md` come input.

## Workflow di scansione

State file: [project-scan-report.json](./project-scan-report.json) (workflow `bmad-document-project`, modalità `initial_scan` deep).
