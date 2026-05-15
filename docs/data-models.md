# Data Models — Agentic IAM v3.0

Il PoC non ha database persistente. Tutti i dati operativi sono in:

- **[mock-data/users.json](../mock-data/users.json)** — tenant simulato (Entra ID + SailPoint)
- **[config/*.json](../config/)** — regole, catalogo applicativo, governance, matrice di rischio
- **[logs/audit.jsonl](../logs/audit.jsonl)** — append-only audit trail

Le scritture avvengono direttamente su `users.json` (`tools/mock_graph.js` → `saveDB`).

---

## 1. `mock-data/users.json` — schema

```jsonc
{
  "users":                        [ /* User[] */ ],
  "signInLogs":                   { "<upn>": [ /* SignInLog[] */ ] },
  "conditionalAccessPolicies":    [ /* CAP[] */ ],
  "nonHumanIdentities":           [ /* NHI[] */ ],
  "accessReviewCampaigns":        [ /* AccessReview[] */ ],
  "openTickets":                  [ /* Ticket[] */ ],
  "slaMetrics":                   { "historicalMTTR": [...], "slaTarget_minutes": 480, "escalation_minutes": 1440 }
}
```

### `User`

| Campo                    | Tipo            | Note                                                                 |
|--------------------------|-----------------|----------------------------------------------------------------------|
| `id`                     | string          | `usr-001`, ...                                                       |
| `displayName`            | string          | Nome visualizzato (es. "Mario Rossi")                                |
| `userPrincipalName`      | string          | UPN — chiave logica                                                  |
| `accountEnabled`         | boolean         | `false` ⇒ status `disabled` o `leaver_pending_cleanup`               |
| `department`, `jobTitle` | string          | —                                                                    |
| `manager`                | string (UPN)    | —                                                                    |
| `employeeId`             | string \| null  | `null` per guest                                                     |
| `employeeType`           | enum            | `Employee` \| `Guest`                                                |
| `accountType`            | enum            | `cloud-only` \| `synced-onprem` \| `guest` \| `outsourcer`           |
| `onPremisesSyncEnabled`  | boolean         | Presente se sincronizzato da AD on-prem                              |
| `mfaRegistered`          | boolean         | —                                                                    |
| `mfaMethods`             | string[]        | `microsoftAuthenticator`, `phone`, `hardwareToken`                   |
| `riskLevel`              | enum            | `none` \| `medium` \| `high`                                         |
| `lastSignIn`             | ISO8601         | —                                                                    |
| `groups`                 | string[]        | Security Group, prefisso `SG-`                                       |
| `licenses`               | string[]        | `Microsoft365-E1/E3/E5`, `Azure-P2`                                  |
| `roles`                  | string[]        | Ruoli direttory (`User Administrator`, `Global Reader`, ...)         |
| `status`                 | enum            | `active` \| `disabled` \| `deprovisioned` \| `leaver_pending_cleanup` |
| `location`               | string          | Città / `External`                                                   |
| `anomaly`                | string \| undef | Se presente: `admin_login_outside_hours`, `login_unusual_location`, `mfa_not_registered`, `atypical_travel` |
| `appAssignments`         | string[]        | Profile ID, formato `<APP>-<PROFILE>` (es. `ERPCORE-ADV`)            |
| `expiryDate`             | ISO8601 (date)  | Solo per guest/outsourcer                                            |
| `terminationDate`        | ISO8601 (date)  | Solo per leaver                                                      |
| `sailpoint`              | object          | Vedi sotto                                                           |

#### `User.sailpoint`

| Campo                    | Tipo                | Note                                                                                        |
|--------------------------|---------------------|---------------------------------------------------------------------------------------------|
| `accountId`              | string              | `SP-<username>`                                                                             |
| `sources`                | string[]            | Origin systems (`Active Directory`, `SAP ERP`, `Workday`, `GitHub Enterprise`, ...)         |
| `accessProfiles`         | string[]            | Profili business (`Finance-Standard`, `IT-Manager`, `Guest-IT-Limited`, ...)                |
| `lastCertification`      | ISO8601 \| null     | —                                                                                           |
| `certificationStatus`    | enum                | `completed` \| `pending_first_review` \| `revocation_pending` \| `revoked` \| `never_certified` |

### `SignInLog`

| Campo            | Tipo            | Note                                                            |
|------------------|-----------------|-----------------------------------------------------------------|
| `timestamp`      | ISO8601         | —                                                               |
| `status`         | `success` \| `failure` | —                                                       |
| `errorCode`      | string          | Codice Entra ID — `53003` CAP block, `50057` account disabled, `50076` MFA required |
| `errorDescription` | string        | Testo libero Entra ID                                           |
| `ipAddress`      | string          | —                                                               |
| `location`       | string          | `City, CountryCode`                                             |
| `app`            | string          | `SAP ERP`, `Office365`, `Salesforce CRM`, ...                   |
| `device`, `browser` | string       | —                                                               |
| `risk`           | string          | `atypical_travel`, `signin_outside_hours`                       |
| `riskDetail`     | string          | Descrizione testuale                                            |

### `ConditionalAccessPolicy`

Schema mutuato da Entra ID:

```jsonc
{
  "id": "cap-001",
  "displayName": "Require MFA for Finance Apps",
  "state": "enabled",
  "conditions": {
    "users":      { "includeGroups": [...], "includeUsers": ["All"], "includeRoles": [...] },
    "applications": { "includeApps": [...] },
    "platforms":  { "includePlatforms": ["all"] },
    "clientAppTypes": ["exchangeActiveSync", "other"]
  },
  "grantControls": { "operator": "AND" | "OR", "builtInControls": ["mfa", "block", "compliantDevice"] },
  "excludedUsers": ["upn", ...],
  "createdDateTime": "...",
  "modifiedDateTime": "..."
}
```

### `NonHumanIdentity` (NHI)

Identità non-umane (Service Principal, Managed Identity, App Registration). Campi rilevanti: `id`, `displayName`, `type`, `owner` (UPN), `risk` (`HIGH`/`MEDIUM`/`LOW`), `credentialExpiry`, `issues` (array di stringhe come `inactive_180d`, `no_owner`, `expired_credentials`).

### `OpenTicket`

`id`, `type`, `status`, `slaDeadline` (ISO8601), `note`, ... — letti da [tools/dl_operations.js:75](../tools/dl_operations.js#L75).

### `AccessReviewCampaign`

`id`, `name`, `status` (`active` \| `overdue`), `dueDate`, `pending` (count item rimasti).

---

## 2. `config/risk_matrix.json` — Matrice di rischio azioni

Mappa `action` → `{ risk: LOW|MEDIUM|HIGH, requires_hitl: boolean, rollback: boolean, label: string }`. È la fonte di verità per:

- determinare quali step richiedono richiesta di conferma (Orchestrator)
- determinare quali step sono reversibili (UI mostra badge "Rollback disponibile")
- soglia di confidence sotto cui marcare il piano `warning` (`confidence_threshold: 0.75`)
- soglia auto-disable risk score (`auto_disable_risk_score: 80`)

26 azioni totali — vedi [config/risk_matrix.json](../config/risk_matrix.json).

---

## 3. `config/sod_rules.json` — Regole Segregation of Duties

7 regole predefinite (`SOD-001` ... `SOD-007`). Schema:

```jsonc
{
  "id": "SOD-001",
  "name": "Payment Creator / Approver",
  "severity": "CRITICAL" | "HIGH" | "MEDIUM",
  "description": "...",
  "conflicting_groups": ["SG-Payment-Creator", "SG-Payment-Approver"],
  "recommended_action": "...",
  "compliance": ["SOX", "NIS2", "GDPR", "DORA", "ISO27001"]
}
```

Logica matching ([tools/sod_engine.js:8](../tools/sod_engine.js#L8)): un utente è in conflitto se possiede **tutti** i `conflicting_groups` di una regola. Score: `40·CRITICAL + 25·HIGH + 10·MEDIUM`, capped a 100.

---

## 4. `config/app_catalog.json` — Catalogo applicazioni

9 applicazioni Azure (ERPCORE, ORDERHUB, AUTHFORMS, NETOPS, NETMON, WORKFLOW, QUALITY, JOBORDER, WEBPORTAL). Per ciascuna:

- `availableProfiles` con `id` (es. `ERPCORE-ADM`), `name`, `description`, `riskLevel`
- `authorizationRequired`, `respAppRequired`, `ownerTeam`, `ssoProtocol` (`SAML` / `OIDC`), `source` (`EntraID-Connected`)

Sezione `respAppProcess`: descrive il workflow autorizzativo (5 step), `requiredFor` (5 app), `notRequiredFor` (4 app), `slaHours: 8`, `escalationAfterHours: 24`.

---

## 5. `config/process_governance.json` — Scope e guide

4 macro-scope: `DL_IAM`, `DL_IAM_REDIRECT_PIM`, `GA_APPLICATION_SUPPORT`, `ON_PREM_IAM`. Ogni scope ha `label`, `items` (cosa rientra), e per gli scope di reindirizzamento `redirectTo` e `prerequisites`.

Sezioni guida operativa: `firstAccessGuide.cloudOnly`, `firstAccessGuide.postMigration`, `firstAccessGuide.forgotPassword`, `passwordPolicy` (min 12 char, expiry 90 giorni, history 10, lockout 5 attempts).

---

## 6. `logs/audit.jsonl` — Audit trail

Append-only JSONL. Ogni riga:

```jsonc
{
  "action_id":   "uuid-v4",
  "timestamp":   "2026-04-30T09:15:00Z",
  "session_id":  "uuid-v4",
  "step_action": "disable_account",
  "step_label":  "Disabilita account utente",
  "risk_level":  "LOW",
  "params":      { "upn": "..." },
  "result":      "success" | "failure",
  "result_detail": { /* output del tool */ },
  "duration_ms": 312,
  "rollback_available": true,
  "rollback_payload": { "action": "enable_account", "upn": "..." },
  "event":       "validation_rejected" | "execution_complete" | ...
}
```

Letture via `audit.readLogs(limit)` ([tools/audit.js:10](../tools/audit.js#L10)) — leggono tutto, fanno tail in memoria. Per volumi reali serve rotation/streaming.

---

## 7. State volatile in-memory (process-only)

Definito in [server.js:34-36](../server.js#L34-L36). **Si perde a ogni restart.**

| Map               | Chiave        | Valore                                                                       |
|-------------------|---------------|------------------------------------------------------------------------------|
| `sessions`        | `sessionId`   | `{ piano, structured, status, startedAt, lastEvent, execution }`             |
| `raWorkflows`     | `workflowId`  | `{ id, ticketId, richiedente, app, profile, stato, slaScade, escalationScade, ... }` |
| `pendingValidations` (in `validation_manager`) | `validationId` | `{ status, step, planContext, createdAt, expiresAt, approvedBy, ... }` |
