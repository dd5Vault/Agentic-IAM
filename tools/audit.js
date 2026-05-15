const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'audit.jsonl');
function log(entry) {
  const record = { action_id: randomUUID(), timestamp: new Date().toISOString(), ...entry };
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  return record.action_id;
}
function readLogs(limit = 50) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
}
module.exports = { log, readLogs };
