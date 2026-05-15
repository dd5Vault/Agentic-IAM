const fs = require('fs');
const path = require('path');
const RULES_PATH = path.join(__dirname, '..', 'config', 'sod_rules.json');
function loadRules() { return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')).rules; }
function analyzeUser(user) {
  const rules = loadRules(), conflicts = [];
  for (const rule of rules) {
    if (rule.conflicting_groups.every(g => user.groups?.includes(g)))
      conflicts.push({ rule_id:rule.id, rule_name:rule.name, severity:rule.severity, description:rule.description, conflicting_groups:rule.conflicting_groups, recommended_action:rule.recommended_action, compliance:rule.compliance });
  }
  return { user_upn:user.userPrincipalName, display_name:user.displayName, department:user.department, groups:user.groups||[], conflicts, risk_score:calcScore(conflicts), has_conflicts:conflicts.length>0 };
}
function analyzeAll(users) {
  const results = users.map(u => analyzeUser(u));
  const withConflicts = results.filter(r => r.has_conflicts);
  return { total_users:results.length, users_at_risk:withConflicts.length, critical_count:withConflicts.filter(r=>r.conflicts.some(c=>c.severity==='CRITICAL')).length, high_count:withConflicts.filter(r=>r.conflicts.some(c=>c.severity==='HIGH')).length, total_conflicts:withConflicts.reduce((a,r)=>a+r.conflicts.length,0), results, at_risk:withConflicts };
}
function calcScore(conflicts) {
  if (!conflicts.length) return 0;
  return Math.min(conflicts.reduce((a,c)=>a+({CRITICAL:40,HIGH:25,MEDIUM:10}[c.severity]||5),0), 100);
}
module.exports = { analyzeUser, analyzeAll, loadRules };
