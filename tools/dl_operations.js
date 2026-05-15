const fs = require('fs');
const path = require('path');
const DB_PATH      = path.join(__dirname,'..','mock-data','users.json');
const CATALOG_PATH = path.join(__dirname,'..','config','app_catalog.json');
const GOV_PATH     = path.join(__dirname,'..','config','process_governance.json');
function loadDB()      { return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); }
function saveDB(db)    { fs.writeFileSync(DB_PATH,JSON.stringify(db,null,2)); }
function loadCatalog() { return JSON.parse(fs.readFileSync(CATALOG_PATH,'utf8')); }
function loadGov()     { return JSON.parse(fs.readFileSync(GOV_PATH,'utf8')); }
function getAppInfo(appName) {
  const cat = loadCatalog();
  return cat.applications.find(a=>a.name.toLowerCase()===appName.toLowerCase()||a.displayName.toLowerCase().includes(appName.toLowerCase()))||null;
}
function getUserAppAssignments(upn) {
  const db=loadDB(), cat=loadCatalog();
  const user=db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente non trovato");
  const assigned=(user.appAssignments||[]).map(profileId=>{
    for(const app of cat.applications){
      const p=app.availableProfiles.find(p=>p.id===profileId);
      if(p) return {app:app.name,appDisplayName:app.displayName,profileId,profileName:p.name,description:p.description,riskLevel:p.riskLevel};
    }
    return {profileId,app:'Unknown'};
  });
  return {success:true,source:'mock-entra-id+sailpoint',user:user.displayName,upn,assigned,total:assigned.length};
}
function checkRGRequirement(appName) {
  const app=getAppInfo(appName), cat=loadCatalog();
  if(!app) return {required:true,reason:'Applicazione non trovata nel catalogo'};
  return {required:app.respAppRequired,appName:app.name,respAppProcess:app.respAppRequired?cat.respAppProcess:null,slaHours:cat.respAppProcess.slaHours,ownerTeam:app.ownerTeam,reason:app.respAppRequired?app.name+' richiede autorizzazione del Responsabile Applicativo ('+app.ownerTeam+')':app.name+' non richiede autorizzazione RA'};
}
function checkIdentityExists(upn) {
  const db=loadDB(), user=db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  return {exists:!!user,enabled:user?.accountEnabled||false,accountType:user?.accountType||null,synced:user?.onPremisesSyncEnabled||false,status:user?.status||null,user:user||null};
}
function checkAccountTypeForReset(upn) {
  const db=loadDB(), user=db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if(!user) return {found:false,upn};
  const isSync=user.onPremisesSyncEnabled||user.accountType==='synced-onprem';
  return {found:true,upn,displayName:user.displayName,accountType:user.accountType||'cloud-only',isSynced:isSync,canResetDL:!isSync,resetProcedure:isSync?'REINDIRIZZA: utenza sincronizzata on-prem. Reset tramite team IAM AD o SSPR: https://aka.ms/sspr':'DL PUO PROCEDERE: utenza cloud-only.',ssprEnabled:true};
}
function verifyUserProfile(upn, appName) {
  const check=checkIdentityExists(upn);
  if(!check.exists) return {issue:'identity_not_found',description:'Utente '+upn+' non trovato su Entra ID',scope:'DL_IAM',action:"Creare l'utenza",user:null};
  if(!check.enabled) return {issue:'account_disabled',description:'Account '+upn+' presente ma disabilitato',scope:'DL_IAM',action:"Riabilitare l'account",user:check.user};
  if(appName){
    const cat=loadCatalog(), db=loadDB();
    const user=db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
    const app=cat.applications.find(a=>a.name.toLowerCase()===appName.toLowerCase());
    const assigned=(user.appAssignments||[]).find(a=>app?.availableProfiles.some(p=>p.id===a));
    if(!assigned) return {issue:'app_not_assigned',description:upn+' non ha profilo su '+appName,scope:'DL_IAM',action:'Assegnare profilo con autorizzazione RA se richiesta',user:check.user};
    return {issue:'profile_assigned_check_app',description:upn+' ha profilo su '+appName+' correttamente. Se non accede, problema NON è IAM.',scope:'GA_APPLICATION_SUPPORT',action:'Reindirizzare al supporto applicativo '+appName,user:check.user};
  }
  return {issue:'none',description:'Identità '+upn+' presente e abilitata.',scope:'OK',user:check.user};
}
function handlePIMRedirect(upn, roleRequested) {
  const gov=loadGov(), check=checkIdentityExists(upn);
  const prereqs=gov.scopes.DL_IAM_REDIRECT_PIM.prerequisites, issues=[];
  if(!check.exists) issues.push('Identità non trovata — creare prima');
  else { if(!check.enabled) issues.push('Account disabilitato'); if(!check.user?.mfaRegistered) issues.push('MFA non registrato'); }
  return {success:true,source:'mock-process-governance',action:'pim_redirect',inScopeDL:false,message:'Richieste PIM non in scope DL IAM — reindirizzare al team PIM.',redirectTo:gov.scopes.DL_IAM_REDIRECT_PIM.redirectTo,roleRequested,userPrerequisitesOk:issues.length===0,prerequisiteIssues:issues,prerequisites:prereqs,howToRequest:"Aprire ticket ServiceNow → 'PIM Access Request' → allegare approvazione responsabile"};
}
function getProcessGuidance(topic) {
  const gov=loadGov(), cat=loadCatalog();
  const topics={
    'scope':{title:'Cosa gestisce la DL IAM',content:gov.scopes.DL_IAM,outOfScope:[gov.scopes.DL_IAM_REDIRECT_PIM,gov.scopes.GA_APPLICATION_SUPPORT,gov.scopes.ON_PREM_IAM]},
    'resp_app':{title:'Quando serve l\'autorizzazione del Responsabile Applicativo (RA)',content:cat.respAppProcess,appsRequired:cat.respAppProcess.requiredFor,appsNotRequired:cat.respAppProcess.notRequiredFor},
    'first_access':{title:'Guida primo accesso',content:gov.firstAccessGuide},
    'password_reset':{title:'Procedura reset password',content:{cloudOnly:gov.firstAccessGuide.forgotPassword,policy:gov.passwordPolicy}},
    'pim':{title:'Processo PIM — non in scope DL',content:gov.scopes.DL_IAM_REDIRECT_PIM},
    'app_not_visible':{title:'Applicazione non visibile dopo migrazione',content:{steps:['1. Verificare account abilitato su Entra ID','2. Verificare profilo assegnato dal Team IAM','3. Se profilo assegnato ma app non visibile → supporto applicativo (GA)','4. Se profilo non assegnato → ticket Team IAM con autorizzazione RA se richiesta','5. Attendere fino a 2h per propagazione permessi']}}
  };
  return topics[topic]||{title:'Argomento non trovato',availableTopics:Object.keys(topics)};
}
function getOpenTickets() { const db=loadDB(); return {success:true,source:'mock-servicenow',data:db.openTickets||[],total:(db.openTickets||[]).length}; }
module.exports = { getAppInfo, getUserAppAssignments, checkRGRequirement, checkIdentityExists, checkAccountTypeForReset, verifyUserProfile, handlePIMRedirect, getProcessGuidance, getOpenTickets };
