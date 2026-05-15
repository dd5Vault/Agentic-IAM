const { randomUUID } = require('crypto');
const pendingApprovals = new Map();
function createApprovalRequest(step, planContext) {
  const approvalId = randomUUID();
  const request = { approvalId, status: 'pending', step, planContext, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), approvedBy: null, approvedAt: null, rejectionReason: null };
  pendingApprovals.set(approvalId, request);
  return approvalId;
}
function getApproval(approvalId) { return pendingApprovals.get(approvalId) || null; }
function approve(approvalId, approver = 'operatore') {
  const req = pendingApprovals.get(approvalId);
  if (!req) return { success: false, error: 'Non trovata' };
  if (req.status !== 'pending') return { success: false, error: 'Stato: ' + req.status };
  req.status = 'approved'; req.approvedBy = approver; req.approvedAt = new Date().toISOString();
  return { success: true, request: req };
}
function reject(approvalId, reason = "Rifiutato dall'operatore", approver = 'operatore') {
  const req = pendingApprovals.get(approvalId);
  if (!req) return { success: false, error: 'Non trovata' };
  req.status = 'rejected'; req.approvedBy = approver; req.approvedAt = new Date().toISOString(); req.rejectionReason = reason;
  return { success: true, request: req };
}
function getAllPending() {
  const result = [];
  for (const [id, req] of pendingApprovals.entries()) {
    if (req.status === 'pending') {
      if (new Date() > new Date(req.expiresAt)) req.status = 'timeout';
      else result.push(req);
    }
  }
  return result;
}
function waitForApproval(approvalId, timeoutMs = 120000) {
  return new Promise(resolve => {
    const start = Date.now();
    const iv = setInterval(() => {
      const req = pendingApprovals.get(approvalId);
      if (!req) { clearInterval(iv); resolve({ status: 'not_found' }); return; }
      if (req.status !== 'pending') { clearInterval(iv); resolve(req); return; }
      if (Date.now() - start > timeoutMs) { req.status = 'timeout'; clearInterval(iv); resolve(req); }
    }, 500);
  });
}
module.exports = { createApprovalRequest, getApproval, approve, reject, getAllPending, waitForApproval };
