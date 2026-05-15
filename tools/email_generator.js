// tools/email_generator.js — NEW FEATURE 3: Genera bozze email dopo ogni azione

function generateEmail(action, context) {
  const ts = new Date().toLocaleString('it-IT');
  const templates = {
    app_enablement: {
      to: context.requestor || context.target,
      cc: context.rpaEmail || 'rpa-team@demo.local',
      subject: `[IAM DL] Abilitazione ${context.app} completata — ${context.target}`,
      body: `Gentile ${context.requestorName || 'utente'},\n\nCi confermiamo che l'abilitazione richiesta è stata completata con successo.\n\nDettagli operazione:\n• Utente: ${context.target}\n• Applicazione: ${context.app}\n• Profilo assegnato: ${context.profile || 'Standard'}\n• Data/ora: ${ts}\n• Ticket di riferimento: ${context.ticketId || 'N/A'}\n• Eseguito da: DL IAM Copilota (approvato da ${context.approver || 'operatore'})\n\nL'utente potrà accedere all'applicazione entro 15-30 minuti.\nIn caso di problemi, aprire un nuovo ticket su ServiceNow.\n\nCordiali saluti,\nDL IAM Team`
    },
    user_creation: {
      to: context.requestor || context.target,
      cc: context.managerEmail || '',
      subject: `[IAM DL] Utenza creata — ${context.target}`,
      body: `Gentile ${context.requestorName || 'utente'},\n\nL'utenza richiesta è stata creata su Microsoft Entra ID.\n\nDettagli:\n• UPN: ${context.target}\n• Tipo: ${context.accountType || 'cloud-only'}\n• Data creazione: ${ts}\n• Ticket: ${context.ticketId || 'N/A'}\n\nISTRUZIONI PRIMO ACCESSO:\n1. Accedere a https://portal.office.com\n2. Inserire UPN e password temporanea fornita separatamente\n3. Cambiare la password al primo accesso\n4. Registrare Microsoft Authenticator per MFA (obbligatorio)\n\nPer abilitazioni applicative successive, aprire nuovo ticket specificando l'applicazione e il profilo richiesto.\n\nCordiali saluti,\nDL IAM Team`
    },
    password_reset: {
      to: context.target,
      cc: '',
      subject: `[IAM DL] Reset password completato`,
      body: `Gentile utente,\n\nIl reset password per l'account ${context.target} è stato completato.\n\nDettagli:\n• Account: ${context.target}\n• Data/ora: ${ts}\n• Tipo operazione: Reset con password temporanea\n\nOPERAZIONI RICHIESTE:\n1. Accedere a https://portal.office.com\n2. Inserire la password temporanea comunicata separatamente\n3. Cambiarla immediatamente con una nuova password (min. 12 caratteri)\n\nNOTA: Se non riesci ad accedere entro 30 minuti, contattare nuovamente la DL IAM.\n\nCordiali saluti,\nDL IAM Team`
    },
    leaver: {
      to: context.managerEmail || context.hrEmail || 'hr@demo.local',
      cc: 'security@demo.local',
      subject: `[IAM DL] Deprovisioning completato — ${context.target}`,
      body: `Gentile HR / Manager,\n\nCi confermiamo che il processo di deprovisioning per l'utente indicato è stato completato.\n\nDettagli:\n• Utente: ${context.displayName || context.target} (${context.target})\n• Gruppi rimossi: ${context.removedGroups?.length || 0}\n• Licenze revocate: ${context.removedLicenses?.length || 0}\n• Data/ora: ${ts}\n• Approvato da: ${context.approver || 'operatore'}\n\nACCESSI REVOCATI:\n• Account Entra ID: DISABILITATO\n• Sessioni attive: REVOCATE\n• App assignments: RIMOSSI\n• SailPoint: DEPROVISIONED\n\nL'audit trail completo è disponibile su Microsoft Sentinel.\n\nCordiali saluti,\nDL IAM Team`
    },
    pim_redirect: {
      to: context.requestor || context.target,
      cc: '',
      subject: `[IAM DL] Richiesta PIM — Reindirizzamento al team corretto`,
      body: `Gentile ${context.requestorName || 'utente'},\n\nAbbiamo ricevuto la tua richiesta di accesso PIM per il ruolo "${context.roleRequested}".\n\nPERCHÉ NON SIAMO NOI: Le richieste PIM non rientrano nello scope della DL IAM. Il team corretto è il Team PIM.\n\nCOME PROCEDERE:\n1. Aprire un ticket su ServiceNow\n2. Categoria: "PIM Access Request"\n3. Specificare: ruolo richiesto, motivazione, durata necessaria\n4. Allegare l'approvazione del proprio responsabile diretto\n\nPREREQUISITI VERIFICATI:${context.prerequisiteIssues?.length > 0 ? '\n⚠ ATTENZIONE — risolvere prima di procedere:\n• ' + context.prerequisiteIssues.join('\n• ') : '\n✓ Tutti i prerequisiti sono soddisfatti'}\n\nCordiali saluti,\nDL IAM Team`
    },
    generic: {
      to: context.requestor || 'richiedente@demo.local',
      cc: '',
      subject: `[IAM DL] Operazione completata — ${context.target || 'N/A'}`,
      body: `Gentile utente,\n\nL'operazione IAM richiesta è stata completata.\n\nDettagli:\n• Target: ${context.target || 'N/A'}\n• Operazione: ${context.action || 'N/A'}\n• Data/ora: ${ts}\n• Eseguito da: DL IAM Copilota\n\nPer ulteriori informazioni, fare riferimento all'audit trail su Microsoft Sentinel (session_id: ${context.sessionId || 'N/A'}).\n\nCordiali saluti,\nDL IAM Team`
    }
  };
  const template = templates[action] || templates.generic;
  return { ...template, generatedAt: new Date().toISOString(), action, context };
}

module.exports = { generateEmail };
