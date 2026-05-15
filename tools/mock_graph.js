const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'mock-data', 'users.json');
function loadDB() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function findUser(upn) {
  const db = loadDB(), key = upn.toLowerCase();
  return db.users.find(u => u.userPrincipalName.toLowerCase() === key ||
    u.displayName.toLowerCase().replace(/\s/g,'.').includes(key.split('@')[0]));
}
function getUser(upn) {
  const user = findUser(upn);
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  return { success:true, source:'mock-entra-id', data:user };
}
function getSignInLogs(upn) {
  const db = loadDB(), user = findUser(upn);
  const logs = db.signInLogs[upn.toLowerCase()] || (user ? db.signInLogs[user.userPrincipalName] : null) || [];
  return { success:true, source:'mock-entra-id', data:logs, summary:{ total:logs.length, failures:logs.filter(l=>l.status==='failure').length, lastSuccess:logs.find(l=>l.status==='success')?.timestamp||null, lastFailure:logs.find(l=>l.status==='failure')?.timestamp||null, lastError:logs.find(l=>l.status==='failure')?.errorDescription||null, anomalies:logs.filter(l=>l.risk).map(l=>({risk:l.risk,detail:l.riskDetail,timestamp:l.timestamp})) }};
}
function getMFAMethods(upn) {
  const user = findUser(upn); if (!user) throw new Error("Utente '" + upn + "' non trovato");
  return { success:true, source:'mock-entra-id', data:{ registered:user.mfaRegistered, methods:user.mfaMethods, count:user.mfaMethods.length }};
}
function getConditionalAccessPolicies(upn) {
  const db = loadDB(), user = findUser(upn);
  const relevant = db.conditionalAccessPolicies.filter(cap =>
    cap.conditions?.users?.includeGroups?.some(g=>user?.groups?.includes(g)) ||
    cap.conditions?.users?.includeUsers?.includes('All'));
  return { success:true, source:'mock-entra-id', data:relevant, applicablePolicies:relevant.length };
}
function getNHIInventory() {
  const db = loadDB(), nhis = db.nonHumanIdentities;
  return { success:true, source:'mock-entra-id', data:nhis, summary:{ total:nhis.length, noOwner:nhis.filter(n=>!n.owner).length, expiredCredentials:nhis.filter(n=>n.credentialExpiry&&new Date(n.credentialExpiry)<new Date()).length, highRisk:nhis.filter(n=>n.risk==='HIGH').length, mediumRisk:nhis.filter(n=>n.risk==='MEDIUM').length, inactive:nhis.filter(n=>n.issues?.some(i=>i.startsWith('inactive'))).length }};
}
function getAllUsers() {
  const db = loadDB();
  return { success:true, source:'mock-entra-id', data:db.users, summary:{ total:db.users.length, active:db.users.filter(u=>u.accountEnabled).length, disabled:db.users.filter(u=>!u.accountEnabled).length, highRisk:db.users.filter(u=>u.riskLevel==='high').length, mediumRisk:db.users.filter(u=>u.riskLevel==='medium').length, noMFA:db.users.filter(u=>!u.mfaRegistered).length, guests:db.users.filter(u=>u.guestUser).length, withAnomalies:db.users.filter(u=>u.anomaly).length }};
}
function getAccessReviews() { const db = loadDB(); return { success:true, source:'mock-sailpoint', data:db.accessReviewCampaigns||[] }; }
function getSailPointProfile(upn) {
  const user = findUser(upn); if (!user) throw new Error("Utente '" + upn + "' non trovato");
  return { success:true, source:'mock-sailpoint', data:user.sailpoint||null };
}
function disableUser(upn) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  user.accountEnabled=false; user.status='disabled'; saveDB(db);
  return { success:true, source:'mock-entra-id', action:'disable_account', target:upn, newState:{accountEnabled:false}, rollbackPayload:{action:'enable_account',upn} };
}
function enableUser(upn) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  user.accountEnabled=true; user.status='active'; saveDB(db);
  return { success:true, source:'mock-entra-id', action:'enable_account', target:upn, newState:{accountEnabled:true} };
}
function addCAPExclusion(upn, policyId) {
  const db = loadDB(), cap = db.conditionalAccessPolicies.find(p=>p.id===policyId);
  if (!cap) throw new Error("Policy '" + policyId + "' non trovata");
  if (!cap.excludedUsers.includes(upn)) cap.excludedUsers.push(upn);
  saveDB(db);
  return { success:true, source:'mock-entra-id', action:'add_cap_exclusion', target:upn, policy:cap.displayName, rollbackPayload:{action:'remove_cap_exclusion',upn,policyId} };
}
function revokeSessions(upn) { return { success:true, source:'mock-entra-id', action:'revoke_sessions', target:upn, message:'Sessioni revocate per '+upn }; }
function removeFromGroup(upn, groupName) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  user.groups = user.groups.filter(g=>g!==groupName); saveDB(db);
  return { success:true, source:'mock-entra-id', action:'remove_group_member', target:upn, group:groupName };
}
function addToGroup(upn, groupName) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  if (!user.groups.includes(groupName)) user.groups.push(groupName);
  saveDB(db);
  return { success:true, source:'mock-entra-id', action:'add_group_member', target:upn, group:groupName };
}
function updateRiskLevel(upn, riskLevel) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  user.riskLevel=riskLevel; if(riskLevel==='none') delete user.anomaly; saveDB(db);
  return { success:true, source:'mock-entra-id', action:'update_risk_level', target:upn, newRisk:riskLevel };
}
function deprovisionLeaver(upn) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  const removedGroups=[...user.groups], removedLicenses=[...user.licenses];
  user.groups=[]; user.licenses=[]; user.status='deprovisioned';
  if(user.sailpoint) user.sailpoint.certificationStatus='revoked';
  saveDB(db);
  return { success:true, source:'mock-entra-id+sailpoint', action:'deprovision_leaver', target:upn, removedGroups, removedLicenses };
}
function assignAppProfile(upn, profileId) {
  const db = loadDB(), user = db.users.find(u=>u.userPrincipalName.toLowerCase()===upn.toLowerCase());
  if (!user) throw new Error("Utente '" + upn + "' non trovato");
  if (!user.appAssignments) user.appAssignments=[];
  const prefix = profileId.split('-')[0];
  user.appAssignments = user.appAssignments.filter(a=>!a.startsWith(prefix));
  user.appAssignments.push(profileId); saveDB(db);
  return { success:true, source:'mock-entra-id', action:'assign_app_profile', target:upn, profileId, rollbackPayload:{action:'remove_app_profile',upn,profileId} };
}
function createUser(userData) {
  const db = loadDB();
  if(db.users.find(u=>u.userPrincipalName.toLowerCase()===userData.userPrincipalName.toLowerCase()))
    throw new Error("Utente già esistente");
  db.users.push({id:'usr-'+Date.now(), accountEnabled:true, mfaRegistered:false, mfaMethods:[], riskLevel:'none', status:'active', groups:['SG-Office365'], licenses:['Microsoft365-E3'], appAssignments:[], sailpoint:{accountId:'SP-'+userData.userPrincipalName.split('@')[0],sources:['Active Directory'],accessProfiles:[],certificationStatus:'pending_first_review'}, ...userData});
  saveDB(db);
  return { success:true, source:'mock-entra-id', action:'create_user', message:'Utenza creata: '+userData.userPrincipalName };
}
module.exports = { getUser, getSignInLogs, getMFAMethods, getConditionalAccessPolicies, getNHIInventory, getAllUsers, getAccessReviews, getSailPointProfile, disableUser, enableUser, addCAPExclusion, revokeSessions, removeFromGroup, addToGroup, updateRiskLevel, deprovisionLeaver, assignAppProfile, createUser };
