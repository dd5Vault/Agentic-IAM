const graph = require('../tools/mock_graph');
const validazione = require('../tools/validation_manager');
const audit = require('../tools/audit');
const { randomUUID, randomInt } = require('crypto');

function generateTempPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const L = 'abcdefghjkmnpqrstuvwxyz';
  const D = '23456789';
  const S = '!@#$%&*';
  const pickFrom = s => s[randomInt(0, s.length)];
  // 14 char: 3 upper, 5 lower, 4 digits, 2 symbols → soddisfa policy (min 12, complexity OK)
  let chars = [];
  for (let i = 0; i < 3; i++) chars.push(pickFrom(U));
  for (let i = 0; i < 5; i++) chars.push(pickFrom(L));
  for (let i = 0; i < 4; i++) chars.push(pickFrom(D));
  for (let i = 0; i < 2; i++) chars.push(pickFrom(S));
  // shuffle Fisher-Yates
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function executeStep(step, sessionId) {
  const start = Date.now();
  let result;
  try {
    switch(step.action) {
      case 'check_account_status':   result = graph.getUser(step.params?.upn||''); break;
      case 'read_signin_logs':        result = graph.getSignInLogs(step.params?.upn||''); break;
      case 'check_mfa_methods':       result = graph.getMFAMethods(step.params?.upn||''); break;
      case 'read_cap_policies':       result = graph.getConditionalAccessPolicies(step.params?.upn||''); break;
      case 'check_nhi_inventory':     result = graph.getNHIInventory(); break;
      case 'revoke_sessions':         result = graph.revokeSessions(step.params?.upn||''); break;
      case 'disable_account':         result = graph.disableUser(step.params?.upn||''); break;
      case 'enable_account':          result = graph.enableUser(step.params?.upn||''); break;
      case 'add_cap_exclusion':       result = graph.addCAPExclusion(step.params?.upn, step.params?.policyId); break;
      case 'deprovision_leaver':      result = graph.deprovisionLeaver(step.params?.upn||''); break;
      case 'assign_app_profile':      result = graph.assignAppProfile(step.params?.upn, step.params?.profileId||step.params?.action); break;
      case 'add_group_member':        result = graph.addToGroup(step.params?.upn, step.params?.groupName||'SG-Default'); break;
      case 'remove_group_member':     result = graph.removeFromGroup(step.params?.upn, step.params?.groupName||''); break;
      case 'provision_joiner':        result = graph.createUser({ userPrincipalName: step.params?.upn, displayName: step.params?.displayName||step.params?.upn, department: step.params?.department||'N/A', jobTitle: step.params?.jobTitle||'N/A', manager: step.params?.manager||'', accountType: step.params?.accountType||'cloud-only' }); break;
      case 'modify_user_attributes':  result = { success:true, source:'mock-entra-id', action:'modify_user_attributes', target:step.params?.upn, params:step.params, message:'Modifica attributi simulata: '+JSON.stringify(step.params).substring(0,100) }; break;
      case 'password_reset_cloud': {
        const tempPassword = generateTempPassword();
        result = {
          success: true,
          source: 'mock-entra-id',
          action: 'password_reset_cloud',
          target: step.params?.upn,
          generated_password: tempPassword,
          password_length: tempPassword.length,
          message: 'Password temporanea generata. Comunicarla all\'utente attraverso un canale sicuro (no email in chiaro, no chat pubbliche).',
          warning: 'La password sarà visibile UNA SOLA VOLTA. Copiarla subito.',
          requires_change_at_next_login: true,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        };
        break;
      }
      case 'force_password_change_next_login': {
        result = {
          success: true,
          source: 'mock-entra-id',
          action: 'force_password_change_next_login',
          target: step.params?.upn,
          message: 'Flag "forceChangePasswordNextSignIn" attivato. L\'utente sarà costretto a impostare una nuova password al primo accesso.'
        };
        break;
      }
      case 'notify_user_password_reset': {
        result = {
          success: true,
          source: 'mock-notifier',
          action: 'notify_user_password_reset',
          target: step.params?.upn,
          channels: ['email aziendale', 'SMS manager'],
          message: 'Comunicazione automatica inviata all\'utente e al manager. La password NON è inclusa nella notifica (canale sicuro separato).'
        };
        break;
      }
      default:                        result = { success:true, source:'mock-entra-id', action:step.action, message:'Azione simulata: '+step.action };
    }
  } catch(err) { result = { success:false, error:err.message }; }
  const duration = Date.now() - start;
  audit.log({ session_id:sessionId, step_action:step.action, step_label:step.label, risk_level:step.risk, required_validazione:step.requires_validation, params:step.params, result:result.success?'success':'failure', result_detail:result, duration_ms:duration, rollback_available:step.rollback_available, rollback_payload:result.rollbackPayload||null });
  return { ...result, duration_ms: duration };
}

async function executePlan(plan, options = {}) {
  const sessionId = randomUUID();
  const { onStepUpdate } = options;
  // Usa validationManager e auditLogger da options se forniti (DB), altrimenti fallback a in-memory
  const val = options.validationManager || validazione;
  const auditLog = options.auditLogger || audit;
  const execution = { sessionId, startedAt:new Date().toISOString(), plan, steps:[], pendingApprovals:[], status:'running', completedAt:null };
  for (let i = 0; i < plan.steps.length; i++) {
    const step = { ...plan.steps[i], stepIndex:i+1, stepTotal:plan.steps.length };
    if (onStepUpdate) onStepUpdate({ type:'step_start', step, execution });
    if (step.requires_validation) {
      const validationId = val.createValidationRequest(step, { sessionId, intent:plan.intent, targetUser:plan.target_user?.userPrincipalName, stepIndex:i+1 });
      step.status = 'in_attesa_validazione'; step.validationId = validationId;
      execution.steps.push(step); execution.pendingApprovals.push(validationId);
      if (onStepUpdate) onStepUpdate({ type:'validation_requested', step, validationId, execution });
      const approvalResult = await val.waitForValidation(validationId, 120000);
      if (approvalResult.status === 'approvata') {
        step.status = 'in_esecuzione';
        if (onStepUpdate) onStepUpdate({ type:'step_approved', step, execution });
        const result = await executeStep(step, sessionId);
        step.status = result.success ? 'completato' : 'errore'; step.result = result;
      } else if (approvalResult.status === 'rifiutata') {
        step.status = 'rifiutato'; step.rejectionReason = approvalResult.rejectionReason;
        auditLog.log({ session_id:sessionId, event:'validation_rejected', step:step.action, reason:approvalResult.rejectionReason });
        if (onStepUpdate) onStepUpdate({ type:'step_rejected', step, execution });
        break;
      } else {
        step.status = 'scaduto';
        auditLog.log({ session_id:sessionId, event:'validation_timeout', step:step.action });
        break;
      }
    } else {
      step.status = 'in_esecuzione';
      if (onStepUpdate) onStepUpdate({ type:'step_executing', step, execution });
      const result = await executeStep(step, sessionId);
      step.status = result.success ? 'completato' : 'errore'; step.result = result;
      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    }
    execution.steps[i] = step;
    if (onStepUpdate) onStepUpdate({ type:'step_done', step, execution });
    if (step.status === 'errore') execution.status = 'partial_failure';
  }
  execution.status = execution.steps.some(s=>s.status==='errore') ? 'completato_con_errori'
    : execution.steps.some(s=>s.status==='rifiutato') ? 'stopped_by_operator'
    : execution.steps.some(s=>s.status==='scaduto') ? 'timeout' : 'completato';
  execution.completedAt = new Date().toISOString();
  auditLog.log({ session_id:sessionId, event:'execution_complete', status:execution.status, steps_total:plan.steps.length, steps_completed:execution.steps.filter(s=>s.status==='completato').length, steps_failed:execution.steps.filter(s=>s.status==='errore').length });
  return execution;
}

module.exports = { executePlan };