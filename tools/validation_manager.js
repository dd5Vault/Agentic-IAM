// tools/validation_manager.js
// Gestione Richiesta Conferma — ex HITL Manager
// Flusso: il Copilota propone un'azione rischiosa → si sospende → l'operatore approva o rifiuta
const { randomUUID } = require('crypto');

const pendingValidations = new Map();

function createValidationRequest(step, planContext) {
  const validationId = randomUUID();
  const request = {
    validationId,
    status: 'in_attesa',
    step,
    planContext,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    label: step.label || step.action
  };
  pendingValidations.set(validationId, request);
  return validationId;
}

function getValidation(validationId) {
  return pendingValidations.get(validationId) || null;
}

function approve(validationId, operator = 'operatore') {
  const req = pendingValidations.get(validationId);
  if (!req) return { success: false, error: 'Richiesta non trovata' };
  if (req.status !== 'in_attesa') return { success: false, error: 'Stato attuale: ' + req.status };
  req.status = 'approvata';
  req.approvedBy = operator;
  req.approvedAt = new Date().toISOString();
  return { success: true, request: req };
}

function reject(validationId, reason = 'Rifiutato dall\'operatore', operator = 'operatore') {
  const req = pendingValidations.get(validationId);
  if (!req) return { success: false, error: 'Richiesta non trovata' };
  req.status = 'rifiutata';
  req.approvedBy = operator;
  req.approvedAt = new Date().toISOString();
  req.rejectionReason = reason;
  return { success: true, request: req };
}

function getAllPending() {
  const result = [];
  for (const [id, req] of pendingValidations.entries()) {
    if (req.status === 'in_attesa') {
      if (new Date() > new Date(req.expiresAt)) {
        req.status = 'scaduta';
      } else {
        result.push(req);
      }
    }
  }
  return result;
}

function waitForValidation(validationId, timeoutMs = 120000) {
  return new Promise(resolve => {
    const start = Date.now();
    const iv = setInterval(() => {
      const req = pendingValidations.get(validationId);
      if (!req) { clearInterval(iv); resolve({ status: 'not_found' }); return; }
      if (req.status !== 'in_attesa') { clearInterval(iv); resolve(req); return; }
      if (Date.now() - start > timeoutMs) {
        req.status = 'scaduta';
        clearInterval(iv);
        resolve(req);
      }
    }, 500);
  });
}

module.exports = {
  createValidationRequest,
  getValidation,
  approve,
  reject,
  getAllPending,
  waitForValidation
};
