// agents/conversational.js — Conversational Agent con tutti gli intent DL
const SYSTEM_PROMPT = `Sei il Conversational Agent di un sistema IAM aziendale.
Analizza la richiesta e restituisci SOLO JSON valido.
INTENT: troubleshoot_login, check_user_status, lifecycle_joiner, lifecycle_leaver, lifecycle_mover,
access_review, nhi_audit, anomaly_investigate, sod_analysis, guest_lifecycle, privileged_abuse,
bulk_review, app_enablement, user_creation, password_reset, profile_troubleshoot, pim_redirect,
process_guidance, ticket_review, unknown
Formato: { "intent":string, "user_upn":string|null, "entities":{"app":string|null,"profile":string|null,"error_hint":string|null,"topic":string|null,"accountType":string|null,"new_role":string|null}, "confidence":number, "blocked":boolean, "block_reason":string|null, "summary":string }`;

async function processRequest(userMessage, apiKey) {
  if (!apiKey) return simulateConversational(userMessage);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:600, system:SYSTEM_PROMPT, messages:[{role:'user',content:userMessage}] })
  });
  if (!r.ok) throw new Error('Anthropic API error '+r.status);
  const d = await r.json();
  try { return JSON.parse(d.content[0].text.trim()); } catch { throw new Error('JSON non valido'); }
}

function detectApp(msg) {
  return ['ERPCORE','ORDERHUB','AUTHFORMS','NETOPS','NETMON','WORKFLOW','QUALITY','JOBORDER','WEBPORTAL'].find(a=>msg.toUpperCase().includes(a))||null;
}
function detectUpn(msg, message) {
  const upnMatch = message.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (upnMatch) return upnMatch[1];
  const nameMap = { 'mario':'mario.rossi@demo.local','rossi':'mario.rossi@demo.local','giulia':'giulia.verdi@demo.local','verdi':'giulia.verdi@demo.local','luca':'luca.ferrari@demo.local','ferrari':'luca.ferrari@demo.local','anna':'anna.ricci@demo.local','ricci':'anna.ricci@demo.local','paolo':'paolo.bruno@demo.local','bruno':'paolo.bruno@demo.local','sofia':'sofia.marino@demo.local','marino':'sofia.marino@demo.local','marco':'marco.neri@demo.local','neri':'marco.neri@demo.local','chiara':'chiara.fontana@demo.local','fontana':'chiara.fontana@demo.local','roberto':'roberto.galli@demo.local','galli':'roberto.galli@demo.local','elena':'elena.conti@demo.local','conti':'elena.conti@demo.local','thomas':'thomas.weber@external.demo','weber':'thomas.weber@external.demo' };
  for (const [k,v] of Object.entries(nameMap)) { if (msg.includes(k)) return v; }
  return null;
}
function detectProfile(msg, app) {
  const map = {'admin':'ADM','advanced':'ADV','standard':'STD','readonly':'RO','read only':'RO','sola lettura':'RO','operator':'OPE','operatore':'OPE','manager':'MGR','approvatore':'APP','user':'USER','viewer':'VIEW','compilatore':'COMP'};
  for (const [k,v] of Object.entries(map)) { if (msg.includes(k)) return app?(app+'-'+v):v; }
  return null;
}

function detectPromptInjection(msg) {
  const patterns = [
    { rx: /ignore (all |the )?previous (instructions|commands|rules|prompts)/i, reason: "Tentativo di ignorare istruzioni precedenti (prompt injection)" },
    { rx: /disable (all|every|tutti|tutto)\s*(account|user|utent)/i, reason: "Richiesta di disabilitazione massiva di account (azione distruttiva non autorizzata)" },
    { rx: /delete (all|every|tutti|tutto)/i, reason: "Richiesta di eliminazione massiva (azione irreversibile non autorizzata)" },
    { rx: /\b(jailbreak|DAN mode|developer mode|bypass (security|firewall|filter))\b/i, reason: "Tentativo di jailbreak / bypass del firewall semantico" },
    { rx: /forget (your |the )?(instructions|rules|guardrails)/i, reason: "Tentativo di alterare i guardrail dell'agente" },
    { rx: /you are (now|a) (different|new|unrestricted)/i, reason: "Tentativo di redefinizione persona/ruolo dell'agente" },
    { rx: /act as (root|admin|god|unrestricted)/i, reason: "Tentativo di privilege escalation tramite role injection" },
    { rx: /reveal (the |your )?(system prompt|instructions|api key)/i, reason: "Tentativo di estrazione del system prompt o credenziali" },
    { rx: /grant (me )?(all |full )?(admin|root|globaladmin) (access|privileges|rights)/i, reason: "Richiesta di privilegi amministrativi senza workflow autorizzativo" }
  ];
  for (const p of patterns) if (p.rx.test(msg)) return p.reason;
  return null;
}

function simulateConversational(message) {
  const blockReason = detectPromptInjection(message);
  if (blockReason) {
    return { intent:'blocked_by_firewall', user_upn:null, entities:{}, confidence:0.99, blocked:true, block_reason:blockReason, summary:'Richiesta bloccata dal firewall semantico', _mode:'demo' };
  }
  const msg = message.toLowerCase();
  const upn = detectUpn(msg, message);
  const app = detectApp(message);
  const profile = detectProfile(msg, app);
  let intent = 'unknown', errorHint = null, topic = null, accountType = 'cloud-only';

  // DL-specific — higher priority
  if ((msg.includes('abilit')||msg.includes('assegn')||msg.includes('profilo')||msg.includes('abilitazione')) && app) { intent='app_enablement'; }
  else if (msg.includes('crea')&&(msg.includes('utente')||msg.includes('utenza')||msg.includes('cloud-only')||msg.includes('guest')||msg.includes('outsourcer'))) { intent='user_creation'; accountType=msg.includes('guest')?'guest':msg.includes('outsourcer')?'outsourcer':'cloud-only'; }
  else if (msg.includes('password')||msg.includes('reset')||msg.includes('sspr')||msg.includes('forgot')||msg.includes('credenziali')) { intent='password_reset'; }
  else if ((msg.includes('verifica profil')||msg.includes('non vede')||msg.includes('non trova')||(msg.includes('verifica')&&app))&&!msg.includes('sod')) { intent='profile_troubleshoot'; }
  else if (msg.includes('pim')||msg.includes('privileged identity')||(msg.includes('ruolo')&&msg.includes('temporane'))||msg.includes('global admin')||msg.includes('exchange admin')) { intent='pim_redirect'; }
  else if (msg.includes('responsabile applicativo')||msg.includes('autorizzazione ra')||msg.includes('autorizzazione del ra')||(msg.includes(' ra ')||msg.endsWith(' ra'))||msg.includes('quando serve')||msg.includes('scope')||msg.includes('cosa gestisce')||msg.includes('cosa fa il team')||msg.includes('chi gestisce')||msg.includes('processo')) { intent='process_guidance'; topic=(msg.includes('responsabile')||msg.includes('autorizzazione')||msg.includes(' ra'))?'resp_app':msg.includes('primo accesso')?'first_access':msg.includes('pim')?'pim':msg.includes('non vis')?'app_not_visible':'scope'; }
  else if (msg.includes('ticket')||msg.includes('richieste aperte')||msg.includes('coda dl')) { intent='ticket_review'; }
  // IAM generic
  else if (msg.includes('sod')||msg.includes('segregation')||msg.includes('conflitt')||msg.includes('incompatib')) { intent='sod_analysis'; }
  else if (msg.includes('nhi')||msg.includes('service principal')||msg.includes('managed identity')||msg.includes('app registration')) { intent='nhi_audit'; }
  else if (msg.includes('privileged')&&(msg.includes('fuori orario')||msg.includes('notte')||msg.includes('abuso'))) { intent='privileged_abuse'; }
  else if (msg.includes('guest')&&(msg.includes('scadenz')||msg.includes('lifecycle')||msg.includes('gestione'))) { intent='guest_lifecycle'; }
  else if (msg.includes('review')||msg.includes('campagna')||msg.includes('certificazione')||msg.includes('bulk')) { intent='bulk_review'; }
  else if (msg.includes('accede')||msg.includes('login')||msg.includes('errore')||msg.includes('bloccato')||msg.includes('non riesce')||msg.includes('non accede')) {
    intent='troubleshoot_login';
    if (msg.includes('mfa')) errorHint='MFA';
    else if (msg.includes('policy')||msg.includes('cap')||msg.includes('conditional')) errorHint='ConditionalAccess';
    else if (msg.includes('disabilit')) errorHint='AccountDisabled';
    else errorHint='ConditionalAccess';
  }
  else if (msg.includes('leav')||msg.includes('uscita')||msg.includes('lascia')||msg.includes('termina')||msg.includes('offboarding')||msg.includes('dismetti')) { intent='lifecycle_leaver'; }
  else if (msg.includes('mover')||msg.includes('cambio ruolo')||msg.includes('trasferit')||msg.includes('promos')) { intent='lifecycle_mover'; }
  else if (msg.includes('anomal')||msg.includes('sospett')||msg.includes('lagos')||msg.includes('nigeria')||msg.includes('inusuale')||msg.includes('travel')) { intent='anomaly_investigate'; }
  else if (msg.includes('stato')||msg.includes('status')||msg.includes('verifica')||msg.includes('profilo')||msg.includes('chi è')) { intent='check_user_status'; }

  const summaries = { troubleshoot_login:'Troubleshooting login'+(upn?' per '+upn:'')+(app?' su '+app:''), check_user_status:'Verifica stato'+(upn?' '+upn:''), lifecycle_leaver:'Deprovisioning Leaver'+(upn?' '+upn:''), lifecycle_mover:'Transizione Mover'+(upn?' '+upn:''), lifecycle_joiner:'Provisioning Joiner'+(upn?' '+upn:''), anomaly_investigate:'Anomalia'+(upn?' '+upn:''), nhi_audit:'Audit NHI e Service Principal', sod_analysis:'Analisi SoD'+(upn?' '+upn:''), guest_lifecycle:'Lifecycle guest'+(upn?' '+upn:''), privileged_abuse:'Abuso privilegiato'+(upn?' '+upn:''), bulk_review:'Campagna Access Review', app_enablement:'Abilitazione '+(app||'app')+(upn?' per '+upn:''), user_creation:'Creazione utenza '+accountType+(upn?' '+upn:''), password_reset:'Reset password'+(upn?' '+upn:''), profile_troubleshoot:'Verifica profilo'+(upn?' '+upn:'')+(app?' su '+app:''), pim_redirect:'Richiesta PIM'+(upn?' '+upn:'')+'— non in scope DL', process_guidance:'Guida processo — topic: '+(topic||'scope'), ticket_review:'Ticket DL in coda', unknown:'Richiesta non riconosciuta'+(upn?' '+upn:'') };

  return { intent, user_upn:upn, entities:{ app, profile, error_hint:errorHint, topic, accountType, new_role:null }, confidence:upn?0.89:0.68, blocked:false, block_reason:null, summary:summaries[intent]||'Richiesta'+( upn?' per '+upn:''), _mode:'demo' };
}

module.exports = { processRequest };
