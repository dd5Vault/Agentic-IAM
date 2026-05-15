// agents/planner.js — Planner Agent completo
const graph = require('../tools/mock_graph');
const sod   = require('../tools/sod_engine');
const dl    = require('../tools/dl_operations');
const rm    = require('../config/risk_matrix.json');

function enrichStep(key, params={}) {
  const r = rm.actions[key]||{risk:'MEDIUM',requires_hitl:true,rollback:false,label:key};
  return {action:key,label:r.label||key,params,risk:r.risk,requires_hitl:r.requires_hitl,requires_validation:r.requires_hitl,rollback_available:r.rollback,status:'pending'};
}

async function planTroubleshootLogin(req) {
  const upn = req.user_upn;
  if (!upn) return {error:"UPN non specificato. Di quale utente si tratta?"};
  const ud=graph.getUser(upn), sl=graph.getSignInLogs(upn), mfa=graph.getMFAMethods(upn), cap=graph.getConditionalAccessPolicies(upn);
  const rootCauses=[], steps=[enrichStep('check_account_status',{upn}),enrichStep('read_signin_logs',{upn}),enrichStep('check_mfa_methods',{upn}),enrichStep('read_cap_policies',{upn})];
  if(!ud.data.accountEnabled) rootCauses.push({cause:'account_disabled',severity:'HIGH',description:'Account '+upn+' è disabilitato'});
  const lf=sl.data.find(l=>l.status==='failure');
  if(lf?.errorCode==='53003') rootCauses.push({cause:'cap_block',severity:'MEDIUM',description:'Blocked by CAP: '+lf.errorDescription});
  if(lf?.errorCode==='50057') rootCauses.push({cause:'account_disabled_error',severity:'HIGH',description:lf.errorDescription});
  if(!mfa.data.registered) rootCauses.push({cause:'mfa_not_registered',severity:'HIGH',description:'Nessun metodo MFA registrato'});
  if(cap.data.length>0&&lf?.errorCode==='53003') steps.push(enrichStep('add_cap_exclusion',{upn,policyId:cap.data[0].id,policyName:cap.data[0].displayName,duration:'48h'}));
  if(!ud.data.accountEnabled) steps.push(enrichStep('enable_account',{upn}));
  if(ud.data.riskLevel!=='none') steps.push(enrichStep('revoke_sessions',{upn}));
  const reasoning=`Analisi per ${ud.data.displayName}: account ${ud.data.accountEnabled?'attivo':'DISABILITATO'}, MFA ${mfa.data.registered?'OK':'MANCANTE'}, ${sl.summary.failures} login falliti. ${rootCauses.length} causa/e identificata/e.`;
  return {intent:'troubleshoot_login',target_user:ud.data,context:{signInLogs:sl.summary,mfa:mfa.data,applicablePolicies:cap.data.map(p=>p.displayName),sailpoint:ud.data.sailpoint},rootCauses,steps,confidence:rootCauses.length>0?0.92:0.65,reasoning,summary:rootCauses.length?`Cause: ${rootCauses.map(r=>r.description).join('; ')}`:'Nessuna causa critica trovata. Analisi completata.'};
}

async function planCheckUserStatus(req) {
  const upn=req.user_upn; if(!upn) return {error:'UPN non specificato'};
  const ud=graph.getUser(upn), sl=graph.getSignInLogs(upn), mfa=graph.getMFAMethods(upn), sp=graph.getSailPointProfile(upn);
  const apps=dl.getUserAppAssignments(upn);
  return {intent:'check_user_status',target_user:ud.data,context:{signInLogs:sl.summary,mfa:mfa.data,sailpoint:sp.data,groups:ud.data.groups,licenses:ud.data.licenses,appAssignments:apps.assigned},rootCauses:[],steps:[enrichStep('check_account_status',{upn}),enrichStep('read_signin_logs',{upn}),enrichStep('check_mfa_methods',{upn})],confidence:0.99,reasoning:`Profilo completo per ${ud.data.displayName}: ${apps.total} app assegnate, ${ud.data.groups.length} gruppi, SailPoint ${ud.data.sailpoint?.certificationStatus||'N/A'}.`,summary:`${ud.data.displayName}: ${ud.data.accountEnabled?'ATTIVO':'DISABILITATO'}, MFA ${ud.data.mfaRegistered?'OK':'MANCANTE'}, rischio ${ud.data.riskLevel}, ${apps.total} app.`};
}

async function planLifecycleLeaver(req) {
  const upn=req.user_upn; if(!upn) return {error:'UPN non specificato'};
  const ud=graph.getUser(upn), nhi=graph.getNHIInventory();
  const ownedNHI=nhi.data.filter(n=>n.owner===upn);
  const reasoning=`Processo Leaver per ${ud.data.displayName}: sequenza sicura — revoca sessioni e disabilitazione automatiche, poi deprovisioning completo con HITL.${ownedNHI.length>0?' ATTENZIONE: owner di '+ownedNHI.length+' NHI — trasferire ownership.':''}`;
  return {intent:'lifecycle_leaver',target_user:ud.data,context:{groups:ud.data.groups,licenses:ud.data.licenses,sailpoint:ud.data.sailpoint,ownedNHI},rootCauses:[{cause:'termination',severity:'INFO',description:`Processo Leaver: ${ud.data.displayName}`}],steps:[enrichStep('check_account_status',{upn}),enrichStep('revoke_sessions',{upn}),enrichStep('disable_account',{upn}),enrichStep('deprovision_leaver',{upn,groups:ud.data.groups,licenses:ud.data.licenses})],confidence:0.97,reasoning,summary:`Leaver ${ud.data.displayName}: revoca sessioni → disabilita → deprovisioning (${ud.data.groups.length} gruppi, ${ud.data.licenses.length} licenze).${ownedNHI.length>0?' [!] Owner di '+ownedNHI.length+' NHI.':''}`};
}

async function planLifecycleMover(req) {
  const upn=req.user_upn; if(!upn) return {error:'UPN non specificato'};
  const ud=graph.getUser(upn);
  const oldGroups=ud.data.groups.filter(g=>g.includes('ReadOnly')||g.includes('Junior'));
  const reasoning=`Mover per ${ud.data.displayName}: rimozione permessi vecchio ruolo (${oldGroups.join(',')||'nessuno identificato'}), assegnazione nuovi. SoD check post-transizione incluso.`;
  return {intent:'lifecycle_mover',target_user:ud.data,context:{currentGroups:ud.data.groups,currentDept:ud.data.department,sailpoint:ud.data.sailpoint},rootCauses:[{cause:'role_change',severity:'INFO',description:`Cambio ruolo da: ${ud.data.jobTitle}`}],steps:[enrichStep('check_account_status',{upn}),enrichStep('read_signin_logs',{upn}),enrichStep('modify_user_attributes',{upn,oldGroupsToRemove:oldGroups,reason:'Mover transition'})],confidence:0.85,reasoning,summary:`Mover ${ud.data.displayName}: rimozione ${oldGroups.length} permessi obsoleti, assegnazione nuovi accessi.`};
}

async function planNHIAudit() {
  const nhi=graph.getNHIInventory(), issues=nhi.data.filter(n=>n.issues.length>0);
  return {intent:'nhi_audit',target_user:null,context:{summary:nhi.summary,issues},rootCauses:issues.map(n=>({cause:n.issues.join(','),severity:n.risk,description:`${n.displayName}: ${n.issues.join(', ')}`})),steps:[enrichStep('check_nhi_inventory',{})],confidence:0.99,reasoning:`Inventory NHI: ${nhi.summary.total} identità, ${nhi.summary.highRisk} HIGH, ${nhi.summary.noOwner} senza owner, ${nhi.summary.expiredCredentials} credenziali scadute.`,summary:`NHI: ${nhi.summary.total} totali, ${nhi.summary.noOwner} senza owner, ${nhi.summary.expiredCredentials} credenziali scadute, ${nhi.summary.highRisk} HIGH risk.`};
}

async function planAnomalyInvestigate(req) {
  const upn=req.user_upn;
  if(!upn){const all=graph.getAllUsers(),risky=all.data.filter(u=>u.riskLevel!=='none'||u.anomaly);return {intent:'anomaly_investigate',target_user:null,context:{riskyUsers:risky},rootCauses:risky.map(u=>({cause:u.anomaly||'risk_elevated',severity:u.riskLevel==='high'?'HIGH':'MEDIUM',description:`${u.displayName}: ${u.anomaly||'rischio '+u.riskLevel}`})),steps:[enrichStep('check_account_status',{}),enrichStep('read_signin_logs',{})],confidence:0.88,reasoning:'Scan anomalie su tutti gli utenti.',summary:`${risky.length} utenti con anomalie o rischio elevato.`};}
  const ud=graph.getUser(upn),sl=graph.getSignInLogs(upn);
  const steps=[enrichStep('read_signin_logs',{upn}),enrichStep('check_account_status',{upn})];
  if(ud.data.riskLevel!=='none') steps.push(enrichStep('revoke_sessions',{upn}));
  return {intent:'anomaly_investigate',target_user:ud.data,context:{signInLogs:sl.data,riskLevel:ud.data.riskLevel,anomaly:ud.data.anomaly},rootCauses:[{cause:ud.data.anomaly||'risk_elevated',severity:ud.data.riskLevel==='high'?'HIGH':'MEDIUM',description:`Login sospetto: ${sl.summary.anomalies[0]?.detail||ud.data.anomaly||'rischio '+ud.data.riskLevel}`}],steps,confidence:0.88,reasoning:`Anomalia ${ud.data.displayName}: ${ud.data.anomaly||'rischio '+ud.data.riskLevel}, ${sl.summary.anomalies.length} segnali.`,summary:`Anomalia ${ud.data.displayName}: ${ud.data.anomaly||'rischio '+ud.data.riskLevel}.`};
}

async function planSOD(req) {
  const upn=req.user_upn;
  if(upn){const ud=graph.getUser(upn),r=sod.analyzeUser(ud.data);return {intent:'sod_analysis',target_user:ud.data,context:{sod_result:r},rootCauses:r.conflicts.map(c=>({cause:c.rule_id,severity:c.severity,description:`${c.rule_name}: ${c.description}`})),steps:r.conflicts.length>0?[enrichStep('check_account_status',{upn}),enrichStep('modify_user_attributes',{upn,action:'remove_conflicting_groups',groups_to_remove:r.conflicts.map(c=>c.conflicting_groups[1]),reason:'SoD remediation'})]:[enrichStep('check_account_status',{upn})],confidence:0.97,reasoning:`SoD scan ${ud.data.displayName}: ${ud.data.groups.length} gruppi vs ${sod.loadRules().length} regole. ${r.conflicts.length} conflitti, risk score ${r.risk_score}/100.`,summary:r.has_conflicts?`${r.conflicts.length} conflitti SoD per ${ud.data.displayName}. Risk score: ${r.risk_score}/100.`:`Nessun conflitto SoD per ${ud.data.displayName}.`};}
  const all=graph.getAllUsers(),a=sod.analyzeAll(all.data);
  return {intent:'sod_analysis',target_user:null,context:{sod_analysis:a},rootCauses:a.at_risk.flatMap(u=>u.conflicts.map(c=>({cause:c.rule_id,severity:c.severity,description:`${u.display_name}: ${c.rule_name}`}))),steps:[enrichStep('check_account_status',{})],confidence:0.99,reasoning:`SoD scan tenant: ${a.total_users} utenti, ${a.total_conflicts} conflitti totali. ${a.critical_count} CRITICAL, ${a.high_count} HIGH.`,summary:`SoD scan: ${a.users_at_risk}/${a.total_users} utenti con conflitti. ${a.critical_count} CRITICAL, ${a.high_count} HIGH.`};
}

async function planPrivilegedAbuse(req) {
  const upn=req.user_upn;
  if(!upn){const all=graph.getAllUsers(),admins=all.data.filter(u=>u.roles?.length>0||u.groups?.some(g=>g.toLowerCase().includes('admin')||g.toLowerCase().includes('manager')));return {intent:'privileged_abuse',target_user:null,context:{adminUsers:admins},rootCauses:admins.filter(u=>u.anomaly).map(u=>({cause:u.anomaly,severity:'HIGH',description:`${u.displayName}: ${u.anomaly}`})),steps:[enrichStep('read_signin_logs',{}),enrichStep('check_account_status',{})],confidence:0.85,reasoning:'Scan abuso account privilegiati.',summary:`${admins.length} account privilegiati. ${admins.filter(u=>u.anomaly).length} con anomalie.`};}
  const ud=graph.getUser(upn),sl=graph.getSignInLogs(upn),anom=sl.data.filter(l=>l.risk);
  const steps=[enrichStep('read_signin_logs',{upn}),enrichStep('check_account_status',{upn})];
  if(ud.data.riskLevel!=='none') steps.push(enrichStep('revoke_sessions',{upn}));
  return {intent:'privileged_abuse',target_user:ud.data,context:{signInLogs:sl.data,anomalousLogins:anom,roles:ud.data.roles},rootCauses:anom.map(l=>({cause:l.risk,severity:'HIGH',description:`Login privilegiato: ${l.riskDetail||l.risk} (${l.location})`})),steps,confidence:0.9,reasoning:`Abuso privilegiato ${ud.data.displayName}: ruoli=${ud.data.roles.join(',')||'nessuno'}, ${anom.length} login anomali.`,summary:`Abuso privilegiato ${ud.data.displayName}: ${anom.length} login anomali.`};
}

async function planGuestLifecycle(req) {
  const upn=req.user_upn;
  if(!upn){const all=graph.getAllUsers(),guests=all.data.filter(u=>u.guestUser),exp=guests.filter(u=>u.expiryDate&&new Date(u.expiryDate)<new Date(Date.now()+30*24*3600000));return {intent:'guest_lifecycle',target_user:null,context:{guests,expiringSoon:exp},rootCauses:exp.map(u=>({cause:'expiry_approaching',severity:'MEDIUM',description:`${u.displayName}: scade ${u.expiryDate}`})),steps:[enrichStep('check_account_status',{})],confidence:0.95,reasoning:'Scan lifecycle tutti gli utenti guest.',summary:`${guests.length} guest totali, ${exp.length} in scadenza entro 30 giorni.`};}
  const ud=graph.getUser(upn),days=ud.data.expiryDate?Math.floor((new Date(ud.data.expiryDate)-new Date())/(1000*3600*24)):null;
  return {intent:'guest_lifecycle',target_user:ud.data,context:{expiryDate:ud.data.expiryDate,daysToExpiry:days,groups:ud.data.groups},rootCauses:days!==null&&days<30?[{cause:'expiry_approaching',severity:'MEDIUM',description:`Account guest scade tra ${days} giorni`}]:[],steps:[enrichStep('check_account_status',{upn}),enrichStep('read_signin_logs',{upn}),enrichStep('modify_user_attributes',{upn,action:'extend_or_revoke_guest'})],confidence:0.93,reasoning:`Guest ${ud.data.displayName}: scade ${ud.data.expiryDate||'N/A'}${days!==null?' ('+days+' giorni)':''}.`,summary:`Guest ${ud.data.displayName}: scade ${ud.data.expiryDate||'N/A'}${days!==null?' ('+days+' giorni)':''}.`};
}

async function planBulkReview(req) {
  const reviews=graph.getAccessReviews(),all=graph.getAllUsers();
  const neverCert=all.data.filter(u=>u.sailpoint?.certificationStatus==='never_certified'),overdue=reviews.data.filter(r=>r.status==='overdue');
  return {intent:'bulk_review',target_user:null,context:{campaigns:reviews.data,neverCertified:neverCert,overdue},rootCauses:[...overdue.map(r=>({cause:'review_overdue',severity:'HIGH',description:`Campagna "${r.name}" scaduta ${r.dueDate} — ${r.pending} item pending`})),...neverCert.map(u=>({cause:'never_certified',severity:'MEDIUM',description:`${u.displayName}: accessi mai certificati`}))],steps:[enrichStep('check_account_status',{})],confidence:0.97,reasoning:`${reviews.data.length} campagne: ${overdue.length} scadute. ${neverCert.length} utenti mai certificati.`,summary:`${reviews.data.length} campagne review: ${overdue.length} scadute, ${neverCert.length} utenti mai certificati.`};
}

async function planAppEnablement(req) {
  const upn=req.user_upn, appName=req.entities?.app;
  if(!upn) return {error:"UPN non specificato. Indicare l'utente da abilitare."};
  if(!appName) return {error:"Applicazione non specificata (es. ERPCORE, QUALITY, WEBPORTAL...)."};
  const idCheck=dl.checkIdentityExists(upn), raCheck=dl.checkRGRequirement(appName);
  const steps=[], rootCauses=[];
  steps.push(enrichStep('check_account_status',{upn}));
  if(!idCheck.exists){rootCauses.push({cause:'identity_not_found',severity:'HIGH',description:`Identità ${upn} non trovata su Entra ID`});steps.push(enrichStep('provision_joiner',{upn,note:'Creare prima identità madre'}));return {intent:'app_enablement',target_user:null,context:{identityCheck:idCheck,raCheck,appName},rootCauses,steps,confidence:0.95,reasoning:`Identità ${upn} assente — impossibile procedere con abilitazione ${appName}.`,summary:`BLOCCO: ${upn} non trovato. Creare prima l'utenza, poi richiedere abilitazione ${appName}.`};}
  if(!idCheck.enabled){rootCauses.push({cause:'account_disabled',severity:'HIGH',description:`Account ${upn} disabilitato`});steps.push(enrichStep('enable_account',{upn}));}
  if(raCheck.required){rootCauses.push({cause:'resp_app_required',severity:'MEDIUM',description:`${appName} richiede autorizzazione del Responsabile Applicativo (${raCheck.ownerTeam})`});steps.push(enrichStep('assign_app_profile',{upn,appName,profileId:req.entities?.profile||appName+'-STD',raRequired:true,note:'Allegare modulo di autorizzazione RA approvato'}));}
  else steps.push(enrichStep('assign_app_profile',{upn,appName,profileId:req.entities?.profile||appName+'-USER',raRequired:false}));
  const currentApps=idCheck.exists?dl.getUserAppAssignments(upn):null;
  return {intent:'app_enablement',target_user:idCheck.user,context:{identityCheck:idCheck,raCheck,appCatalog:dl.getAppInfo(appName),currentApps:currentApps?.assigned},rootCauses,steps,confidence:0.94,reasoning:`Abilitazione ${appName} per ${upn}: identità ${idCheck.enabled?'attiva':'DISABILITATA'}, autorizzazione RA ${raCheck.required?'OBBLIGATORIA':'non richiesta'}.`,summary:`Abilitazione ${appName} per ${idCheck.user?.displayName}: ${raCheck.required?'Autorizzazione RA OBBLIGATORIA da '+raCheck.ownerTeam:'nessuna autorizzazione RA richiesta'}. ${currentApps?.total||0} app già assegnate.`};
}

async function planUserCreation(req) {
  const upn=req.user_upn, accountType=req.entities?.accountType||'cloud-only';
  if(!upn) return {intent:'user_creation',target_user:null,context:{accountType},rootCauses:[],steps:[enrichStep('check_account_status',{})],confidence:0.6,reasoning:'UPN non specificato.',summary:'Specificare: UPN (email), nome, reparto, ruolo, manager. Tipo: '+accountType};
  const idCheck=dl.checkIdentityExists(upn);
  if(idCheck.exists) return {intent:'user_creation',target_user:idCheck.user,context:{identityCheck:idCheck},rootCauses:[{cause:'user_already_exists',severity:'INFO',description:`${upn} già presente — status: ${idCheck.user?.status}`}],steps:[enrichStep('check_account_status',{upn})],confidence:0.99,reasoning:`${upn} già esistente.`,summary:`ATTENZIONE: ${upn} già presente (${idCheck.enabled?'ATTIVO':'DISABILITATO'}). Verificare con il richiedente.`};
  return {intent:'user_creation',target_user:null,context:{identityCheck:idCheck,accountType,upn},rootCauses:[{cause:'new_user',severity:'INFO',description:`Nuova utenza ${accountType}: ${upn}`}],steps:[enrichStep('check_account_status',{upn}),enrichStep('provision_joiner',{upn,accountType})],confidence:0.92,reasoning:`Creazione ${accountType} per ${upn}: identità assente, da creare.`,summary:`Piano creazione ${accountType} per ${upn}: Entra ID → licenza → gruppi base. MFA da registrare al primo accesso.`};
}

async function planPasswordReset(req) {
  const upn = req.user_upn;
  if (!upn) return { intent:'password_reset', target_user:null, context:{}, rootCauses:[], steps:[enrichStep('check_account_status',{})], confidence:0.5, reasoning:'UPN non specificato.', summary:"Specificare l'utente per il reset password." };
  const typeCheck = dl.checkAccountTypeForReset(upn);
  if (!typeCheck.found) return { intent:'password_reset', target_user:null, context:{typeCheck}, rootCauses:[{cause:'user_not_found',severity:'HIGH',description:`${upn} non trovato su Entra ID`}], steps:[enrichStep('check_account_status',{upn})], confidence:0.97, reasoning:`${upn} non trovato.`, summary:`Utente ${upn} non trovato. Verificare UPN corretto.` };
  if (typeCheck.isSynced) return {
    intent: 'password_reset',
    target_user: typeCheck.user,
    context: { typeCheck },
    rootCauses: [{ cause:'synced_account', severity:'MEDIUM', description:`Utenza ${typeCheck.displayName} sincronizzata on-prem — fuori scope DL/Team IAM` }],
    steps: [ enrichStep('check_account_status', { upn }) ],
    confidence: 0.99,
    reasoning: `${upn} è sync on-prem: reset non eseguibile dal Team IAM cloud — reindirizzamento al team AD on-prem.`,
    summary: `🚦 REINDIRIZZA — ${typeCheck.displayName}: utenza sync on-prem.\n• Self-service: https://aka.ms/sspr\n• In alternativa: ticket ServiceNow → "AD Identity Management".`
  };
  return {
    intent: 'password_reset',
    target_user: typeCheck.user,
    context: { typeCheck },
    rootCauses: [{ cause:'cloud_only_reset', severity:'INFO', description:`Utenza cloud-only — Team IAM può procedere con reset` }],
    steps: [
      enrichStep('check_account_status', { upn }),
      enrichStep('revoke_sessions', { upn }),
      enrichStep('password_reset_cloud', { upn, note:'Genera password temporanea con obbligo cambio al primo accesso' }),
      enrichStep('force_password_change_next_login', { upn }),
      enrichStep('notify_user_password_reset', { upn })
    ],
    confidence: 0.96,
    reasoning: `${typeCheck.displayName} è cloud-only: Team IAM esegue reset password con revoca sessioni e notifica utente. Lo step di reset richiede Richiesta Conferma operatore.`,
    summary: `Reset password per ${typeCheck.displayName} (cloud-only): revoca sessioni → reset con password temporanea (richiede conferma) → forza cambio al primo accesso → notifica via email.`
  };
}

async function planProfileTroubleshoot(req) {
  const upn=req.user_upn, appName=req.entities?.app;
  if(!upn) return {intent:'profile_troubleshoot',target_user:null,context:{},rootCauses:[],steps:[],confidence:0.5,reasoning:'UPN non specificato.',summary:'Specificare utente e applicazione.'};
  const v=dl.verifyUserProfile(upn,appName);
  const scopeMsgs={'DL_IAM':'Problema in scope DL — azione richiesta','GA_APPLICATION_SUPPORT':'Problema NON in scope DL — reindirizzare al supporto applicativo','OK':'Nessun problema IAM — verifica completata'};
  return {intent:'profile_troubleshoot',target_user:v.user||null,context:{verification:v,appName},rootCauses:v.issue!=='none'?[{cause:v.issue,severity:'MEDIUM',description:v.description}]:[],steps:[enrichStep('check_account_status',{upn}),enrichStep('read_signin_logs',{upn})],confidence:0.93,reasoning:`Verifica ${upn}${appName?' su '+appName:''}: ${v.description}. Scope: ${v.scope}.`,summary:`${scopeMsgs[v.scope]||v.scope}: ${v.description}${v.action?' → '+v.action:''}`};
}

async function planPIMRedirect(req) {
  const upn=req.user_upn, role=req.entities?.new_role||'ruolo non specificato';
  const r=dl.handlePIMRedirect(upn,role);
  return {intent:'pim_redirect',target_user:upn?dl.checkIdentityExists(upn).user:null,context:{result:r},rootCauses:r.prerequisiteIssues.map(i=>({cause:'pim_prerequisite',severity:'MEDIUM',description:i})),steps:[enrichStep('check_account_status',{upn:upn||'N/A'}),enrichStep('check_mfa_methods',{upn:upn||'N/A'})],confidence:0.97,reasoning:`PIM per ${upn}: NON in scope DL. Prerequisiti: ${r.userPrerequisitesOk?'OK':'KO — '+r.prerequisiteIssues.join(', ')}.`,summary:`PIM NON in scope DL. ${r.userPrerequisitesOk?'Prerequisiti OK — reindirizzare al team PIM.':'Prerequisiti KO: '+r.prerequisiteIssues.join('; ')}`};
}

async function planProcessGuidance(req) {
  const topic = req.entities?.topic || 'scope';
  const g = dl.getProcessGuidance(topic);
  const details = { topic, title: g.title, sections: [] };
  let summary = g.title;

  if (topic === 'resp_app' && g.content) {
    details.sections.push({ heading: 'Quando è richiesta', kind: 'badges', items: g.appsRequired || [] });
    details.sections.push({ heading: 'Non richiesta', kind: 'badges', items: g.appsNotRequired || [], variant: 'ok' });
    details.sections.push({ heading: 'Processo (5 step)', kind: 'steps', items: g.content.steps || [] });
    details.sections.push({ heading: 'SLA', kind: 'kv', items: [
      { k: 'Tempo di risposta', v: g.content.slaHours + ' ore lavorative' },
      { k: 'Escalation dopo', v: g.content.escalationAfterHours + ' ore' }
    ]});
    summary = `Autorizzazione RA richiesta per ${(g.appsRequired || []).length} app · SLA ${g.content.slaHours}h · escalation ${g.content.escalationAfterHours}h.`;
  } else if (topic === 'scope' && g.content) {
    details.sections.push({ heading: 'In scope DL/Team IAM', kind: 'list', items: g.content.items || [], variant: 'ok' });
    if (g.outOfScope) {
      for (const o of g.outOfScope) {
        details.sections.push({ heading: 'Fuori scope — ' + o.label, kind: 'list', items: o.items || [], variant: 'warn', meta: o.redirectTo });
      }
    }
    summary = `${g.content.items?.length || 0} attività in scope, ${(g.outOfScope || []).length} aree da reindirizzare.`;
  } else if (topic === 'first_access' && g.content) {
    if (g.content.cloudOnly) details.sections.push({ heading: g.content.cloudOnly.title, kind: 'steps', items: g.content.cloudOnly.steps || [] });
    if (g.content.postMigration) details.sections.push({ heading: g.content.postMigration.title, kind: 'steps', items: g.content.postMigration.steps || [] });
    if (g.content.forgotPassword) details.sections.push({ heading: g.content.forgotPassword.title, kind: 'steps', items: g.content.forgotPassword.steps || [], variant: 'warn' });
    summary = 'Guide primo accesso: cloud-only, post-migrazione e password dimenticata.';
  } else if (topic === 'pim' && g.content) {
    details.sections.push({ heading: 'Perché non in scope', kind: 'text', items: [g.content.label || 'Le richieste PIM sono gestite dal Team PIM.'], variant: 'warn' });
    details.sections.push({ heading: 'Come procedere', kind: 'text', items: [g.content.redirectTo || ''] });
    details.sections.push({ heading: 'Prerequisiti utente', kind: 'list', items: g.content.prerequisites || [] });
    summary = 'PIM non in scope: ' + (g.content.redirectTo || 'aprire ticket ServiceNow al Team PIM') + '.';
  } else if (topic === 'app_not_visible' && g.content) {
    details.sections.push({ heading: g.title, kind: 'steps', items: g.content.steps || [] });
    summary = 'Procedura applicazione non visibile dopo migrazione (5 step di verifica).';
  } else if (topic === 'password_reset' && g.content) {
    if (g.content.cloudOnly) details.sections.push({ heading: g.content.cloudOnly.title, kind: 'steps', items: g.content.cloudOnly.steps || [] });
    if (g.content.policy) details.sections.push({ heading: 'Password policy', kind: 'kv', items: Object.entries(g.content.policy).map(([k, v]) => ({ k, v: String(v) })) });
    summary = 'Procedura reset password + password policy aziendale.';
  } else if (g.availableTopics) {
    details.sections.push({ heading: 'Argomenti disponibili', kind: 'badges', items: g.availableTopics });
    summary = `Topic "${topic}" non trovato. ${g.availableTopics.length} argomenti disponibili.`;
  }

  return {
    intent: 'process_guidance',
    target_user: null,
    context: { topic, guidance: g },
    details,
    rootCauses: [],
    steps: [],
    confidence: 0.98,
    reasoning: 'Richiesta chiarimento processo: ' + topic + '. Restituisco guida operativa strutturata.',
    summary
  };
}

async function planTicketReview(req) {
  const t = dl.getOpenTickets();
  const now = new Date();
  const byType = {};
  const enriched = [];
  for (const tk of t.data) {
    byType[tk.type] = (byType[tk.type] || 0) + 1;
    const dl_ = tk.slaDeadline ? new Date(tk.slaDeadline) : null;
    const hoursLeft = dl_ ? Math.round((dl_ - now) / 36e5) : null;
    let slaStatus = 'in_sla';
    if (hoursLeft !== null) {
      if (hoursLeft < 0) slaStatus = 'over_sla';
      else if (hoursLeft < 4) slaStatus = 'near_sla';
    }
    enriched.push({ ...tk, slaStatus, hoursLeft });
  }
  const overSLA = enriched.filter(tk => tk.slaStatus === 'over_sla');
  const nearSLA = enriched.filter(tk => tk.slaStatus === 'near_sla');
  const wrongQueue = enriched.filter(tk => tk.status === 'wrong_queue');

  const typeLabel = { app_enablement: 'Abilitazione app', user_creation: 'Creazione utenza', password_reset: 'Reset password', pim_request: 'Richiesta PIM', app_troubleshoot: 'Troubleshooting app' };

  const details = {
    topic: 'ticket_review',
    title: `Coda DL — ${t.total} ticket aperti`,
    sections: [
      { heading: 'Distribuzione per tipo', kind: 'kv', items: Object.entries(byType).map(([k, v]) => ({ k: typeLabel[k] || k, v: v + ' ticket' })) },
      { heading: 'SLA', kind: 'kv', items: [
        { k: 'Oltre SLA', v: overSLA.length, variant: overSLA.length > 0 ? 'danger' : 'ok' },
        { k: 'In scadenza (< 4h)', v: nearSLA.length, variant: nearSLA.length > 0 ? 'warn' : 'ok' },
        { k: 'In SLA', v: t.total - overSLA.length - nearSLA.length, variant: 'ok' }
      ]},
      { heading: 'Ticket attivi', kind: 'tickets', items: enriched.map(tk => ({
        id: tk.id,
        type: typeLabel[tk.type] || tk.type,
        requestor: tk.requestor,
        target: tk.targetUser || tk.app || tk.roleRequested || '—',
        slaStatus: tk.slaStatus,
        hoursLeft: tk.hoursLeft,
        note: tk.note
      }))}
    ]
  };

  return {
    intent: 'ticket_review',
    target_user: null,
    context: { tickets: enriched, byType, overSLA, nearSLA, wrongQueue },
    details,
    rootCauses: [
      ...overSLA.map(tk => ({ cause: 'sla_breach', severity: 'HIGH', description: `${tk.id}: SLA scaduto da ${Math.abs(tk.hoursLeft)}h — ${tk.note}` })),
      ...nearSLA.map(tk => ({ cause: 'sla_warning', severity: 'MEDIUM', description: `${tk.id}: SLA in scadenza tra ${tk.hoursLeft}h — ${tk.note}` })),
      ...wrongQueue.map(tk => ({ cause: 'wrong_queue', severity: 'LOW', description: `${tk.id}: ${tk.note}` }))
    ],
    steps: [],
    confidence: 0.99,
    reasoning: `Snapshot coda DL: ${t.total} ticket aperti, ${overSLA.length} oltre SLA, ${nearSLA.length} in scadenza, ${wrongQueue.length} in coda sbagliata.`,
    summary: `${t.total} ticket aperti${overSLA.length > 0 ? ` · ${overSLA.length} oltre SLA` : ''}${nearSLA.length > 0 ? ` · ${nearSLA.length} in scadenza` : ''}${wrongQueue.length > 0 ? ` · ${wrongQueue.length} in coda sbagliata` : ''}.`
  };
}

async function buildPlan(req) {
  const {intent}=req;
  if (req.blocked) {
    return {
      intent: 'blocked_by_firewall',
      blocked: true,
      block_reason: req.block_reason,
      target_user: null,
      context: { firewall: true },
      rootCauses: [{ cause: 'prompt_injection', severity: 'CRITICAL', description: req.block_reason || 'Pattern di prompt injection rilevato' }],
      steps: [],
      confidence: 0.99,
      reasoning: 'Firewall semantico ha bloccato la richiesta prima di raggiungere il Planner. Nessuna azione eseguita, evento loggato per audit.',
      summary: '🔒 Richiesta bloccata dal firewall di sicurezza. Tutti i tentativi di prompt injection sono loggati su audit.jsonl.'
    };
  }
  let plan;
  switch(intent){
    case 'troubleshoot_login':    plan=await planTroubleshootLogin(req); break;
    case 'check_user_status':     plan=await planCheckUserStatus(req); break;
    case 'lifecycle_leaver':      plan=await planLifecycleLeaver(req); break;
    case 'lifecycle_mover':       plan=await planLifecycleMover(req); break;
    case 'nhi_audit':             plan=await planNHIAudit(); break;
    case 'anomaly_investigate':   plan=await planAnomalyInvestigate(req); break;
    case 'sod_analysis':          plan=await planSOD(req); break;
    case 'privileged_abuse':      plan=await planPrivilegedAbuse(req); break;
    case 'guest_lifecycle':       plan=await planGuestLifecycle(req); break;
    case 'bulk_review':           plan=await planBulkReview(req); break;
    case 'app_enablement':        plan=await planAppEnablement(req); break;
    case 'user_creation':         plan=await planUserCreation(req); break;
    case 'password_reset':        plan=await planPasswordReset(req); break;
    case 'profile_troubleshoot':  plan=await planProfileTroubleshoot(req); break;
    case 'pim_redirect':          plan=await planPIMRedirect(req); break;
    case 'process_guidance':      plan=await planProcessGuidance(req); break;
    case 'ticket_review':         plan=await planTicketReview(req); break;
    case 'lifecycle_joiner':      plan={intent:'lifecycle_joiner',steps:[],confidence:0.9,reasoning:'Joiner: fornisci nome, reparto, ruolo e manager.',summary:"Specificare i dati del nuovo dipendente per il provisioning.",rootCauses:[],context:{},target_user:null}; break;
    default:                      plan={
      intent:'unknown', steps:[], confidence:0.3, rootCauses:[], context:{}, target_user:null,
      reasoning:'Intent non riconosciuto dal Conversational Agent. Suggerisco frasi tipiche.',
      summary:"Non ho capito la richiesta. Prova qualcosa come:\n• Login: \"Mario Rossi non riesce ad accedere\"\n• Abilitazione app: \"Abilita Roberto Galli su ERPCORE Standard\"\n• Lifecycle: \"Luca Ferrari lascia l'azienda\"\n• Reset: \"Reset password Paolo Bruno\"\n• Compliance: \"Analisi SoD su tutti gli utenti\"\n• Guida: \"Quando serve l'autorizzazione del Responsabile Applicativo?\""
    };
  }
  if(plan.confidence<rm.confidence_threshold) plan.warning=`Confidence ${(plan.confidence*100).toFixed(0)}% sotto soglia. Verifica manuale raccomandata.`;
  return plan;
}

module.exports = { buildPlan };
