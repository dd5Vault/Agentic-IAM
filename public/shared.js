// shared.js — Auth guard, dark mode, toast, skeleton loader
// Incluso in tutte le pagine tranne login.html

// ── AUTH GUARD ──────────────────────────────────────────────────────────────
var IAM_TOKEN = localStorage.getItem('iam_token');
var IAM_OPERATOR = JSON.parse(localStorage.getItem('iam_operator') || 'null');

function iamLogout() {
  fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + IAM_TOKEN } }).catch(function(){});
  localStorage.removeItem('iam_token');
  localStorage.removeItem('iam_operator');
  window.location.href = '/login.html';
}

function iamHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + IAM_TOKEN };
}

// Check auth on page load
(function checkAuth() {
  if (!IAM_TOKEN) { window.location.href = '/login.html'; return; }
  fetch('/api/auth/validate', { headers: { 'Authorization': 'Bearer ' + IAM_TOKEN } })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.valid) { iamLogout(); return; }
      IAM_OPERATOR = d.operator;
      localStorage.setItem('iam_operator', JSON.stringify(d.operator));
      // Inject operator info in nav
      var navOp = document.getElementById('nav-operator');
      if (navOp) {
        navOp.innerHTML = '<span style="font-size:11px;color:rgba(255,255,255,.7);margin-right:4px">' + d.operator.display_name + '</span>' +
          '<span style="font-size:9px;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.15);color:rgba(255,255,255,.85);font-weight:600">' + d.operator.role.toUpperCase() + '</span>' +
          '<button onclick="iamLogout()" style="background:none;border:1px solid rgba(255,255,255,.25);color:rgba(255,255,255,.7);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:10px;margin-left:8px;transition:all .2s" onmouseover="this.style.background=\'rgba(255,255,255,.1)\'" onmouseout="this.style.background=\'none\'">Esci</button>';
      }
      // RBAC: hide write actions for auditor
      if (d.operator.role === 'auditor') {
        document.querySelectorAll('[data-rbac-write]').forEach(function(el) { el.style.display = 'none'; });
      }
    })
    .catch(function() { iamLogout(); });
})();

// Override fetch to include auth header
var _originalFetch = window.fetch;
window.fetch = function(url, opts) {
  if (typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/auth/')) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (!opts.headers['Authorization'] && IAM_TOKEN) {
      opts.headers['Authorization'] = 'Bearer ' + IAM_TOKEN;
    }
    if (!opts.headers['Content-Type'] && opts.body) {
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  return _originalFetch.call(this, url, opts).then(function(r) {
    if (r.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/auth/')) {
      iamLogout();
    }
    return r;
  });
};

// ── DARK MODE ───────────────────────────────────────────────────────────────
var darkMode = localStorage.getItem('iam_dark') === 'true';

function applyTheme() {
  if (darkMode) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = darkMode ? '☀️' : '🌙';
}

function toggleTheme() {
  darkMode = !darkMode;
  localStorage.setItem('iam_dark', darkMode);
  applyTheme();
}

applyTheme();

// ── TOAST ───────────────────────────────────────────────────────────────────
function iamToast(msg, type, ms) {
  type = type || 'info';
  ms = ms || 3500;
  var container = document.getElementById('iam-toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'iam-toasts';
    container.style.cssText = 'position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:7px;z-index:9999';
    document.body.appendChild(container);
  }
  var t = document.createElement('div');
  var colors = { success: 'var(--g)', warning: 'var(--o)', error: 'var(--r)', info: 'var(--pm)' };
  var icons = { success: '✓', warning: '⚠', error: '✗', info: 'ℹ' };
  t.style.cssText = 'background:' + (colors[type] || colors.info) + ';color:white;padding:12px 18px;border-radius:12px;font-size:13px;display:flex;align-items:center;gap:10px;min-width:260px;box-shadow:0 8px 24px rgba(0,0,0,0.15);animation:iamToastIn .25s ease;font-family:inherit';
  t.innerHTML = '<span style="font-size:16px">' + (icons[type] || icons.info) + '</span> ' + msg;
  container.appendChild(t);
  setTimeout(function() {
    t.style.animation = 'iamToastIn .2s ease reverse';
    setTimeout(function() { t.remove(); }, 200);
  }, ms);
}

// ── SKELETON LOADER ─────────────────────────────────────────────────────────
function iamSkeleton(count, height) {
  count = count || 3;
  height = height || '14px';
  var html = '';
  for (var i = 0; i < count; i++) {
    var w = (70 + Math.random() * 30) + '%';
    html += '<div class="iam-skeleton" style="height:' + height + ';width:' + w + ';margin-bottom:8px"></div>';
  }
  return html;
}

// Inject shared CSS (dark mode + skeleton + toast animation + responsive)
(function injectSharedCSS() {
  var style = document.createElement('style');
  style.textContent = `
    /* DARK MODE */
    [data-theme="dark"] {
      --text: #E2E8F0;
      --muted: #94A3B8;
      --border: #334155;
      --gray: #1E293B;
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.5);
    }
    [data-theme="dark"] body { background: #0F172A; color: var(--text); }
    [data-theme="dark"] .card,
    [data-theme="dark"] .kpi,
    [data-theme="dark"] .stat,
    [data-theme="dark"] .ticket,
    [data-theme="dark"] .app-card,
    [data-theme="dark"] .sod-item,
    [data-theme="dark"] .tk-mini,
    [data-theme="dark"] .val-item { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .utbl tr:hover td { background: #334155; }
    [data-theme="dark"] .msg-sys .msg-bubble { background: #1E293B; border-color: #334155; color: var(--text); }
    [data-theme="dark"] .welcome { background: linear-gradient(135deg, #2D2640 0%, #1E293B 60%, #1A2332 100%); border-color: #4C1D95; }
    [data-theme="dark"] .welcome-feature { background: rgba(30,41,59,0.8); border-color: #334155; }
    [data-theme="dark"] .stage-card { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .details-card { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .ctx-item { background: #0F172A; border-color: #334155; }
    [data-theme="dark"] .chat-msgs { background: linear-gradient(180deg, #0F172A 0%, #1E293B 100%); }
    [data-theme="dark"] .chat-input { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .chat-input textarea { background: #0F172A; border-color: #334155; color: var(--text); }
    [data-theme="dark"] .chat-input textarea:focus { background: #1E293B; border-color: var(--pm); }
    [data-theme="dark"] .sidebar-right { background: #0F172A; }
    [data-theme="dark"] .tab-btn { color: var(--muted); }
    [data-theme="dark"] .tab-btn.active { background: #1E293B; }
    [data-theme="dark"] .tab-btn:hover:not(.active) { background: #1E293B; }
    [data-theme="dark"] .panel-tab { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .audit-entry:hover { background: #1E293B; }
    [data-theme="dark"] .nhi-card { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .nhi-item { background: #1E293B; border-color: #334155; }
    [data-theme="dark"] .profile-row { background: #0F172A; }
    [data-theme="dark"] .profile-row:hover { background: #334155; }
    [data-theme="dark"] .tk-note { background: #0F172A; color: var(--text); }
    [data-theme="dark"] .filter-btn,
    [data-theme="dark"] .fb { background: #1E293B; border-color: #334155; color: var(--text); }
    [data-theme="dark"] .filter-btn:hover,
    [data-theme="dark"] .fb:hover { background: #2D2640; border-color: var(--pm); }
    [data-theme="dark"] .abtn { border-color: #334155; }
    [data-theme="dark"] .abtn:hover { background: #2D2640; }
    [data-theme="dark"] .reasoning-box { background: #2D2640; }
    [data-theme="dark"] .email-draft { background: linear-gradient(135deg, #1A2332, #1E293B); border-color: #334155; }
    [data-theme="dark"] .email-body { background: #0F172A; border-color: #334155; color: var(--text); }
    [data-theme="dark"] .password-card { background: linear-gradient(135deg, #422006 0%, #1E293B 40%, #1E293B 100%); border-color: var(--o); }
    [data-theme="dark"] .password-warning { background: #1E293B; color: var(--o); }
    [data-theme="dark"] .firewall-block { background: linear-gradient(135deg, #450a0a 0%, #1E293B 40%, #1E293B 100%); }
    [data-theme="dark"] .firewall-reason { background: #0F172A; border-color: #7f1d1d; color: #fca5a5; }
    [data-theme="dark"] .mttr-bar-bg { background: #334155; }
    [data-theme="dark"] .countdown-bar { background: #334155; }
    [data-theme="dark"] .rbar-bg { background: #334155; }
    [data-theme="dark"] .rg-item { border-color: #334155; }
    [data-theme="dark"] .sod-conflict { opacity: 0.9; }
    [data-theme="dark"] .notifica-popup { background: #1E293B; border-color: var(--o); }
    [data-theme="dark"] .conf-list-item { background: #2D2640; border-color: var(--o); }
    [data-theme="dark"] .app-head { border-color: #334155; }
    [data-theme="dark"] .app-footer { border-color: #334155; }

    /* SKELETON */
    .iam-skeleton {
      background: linear-gradient(90deg, var(--gray) 25%, #e2e8f0 50%, var(--gray) 75%);
      background-size: 200% 100%;
      animation: iamShimmer 1.5s infinite;
      border-radius: 6px;
    }
    [data-theme="dark"] .iam-skeleton {
      background: linear-gradient(90deg, #1E293B 25%, #334155 50%, #1E293B 75%);
      background-size: 200% 100%;
    }
    @keyframes iamShimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    /* TOAST ANIMATION */
    @keyframes iamToastIn {
      from { transform: translateX(110%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    /* THEME TOGGLE BUTTON */
    .theme-toggle {
      background: none;
      border: 1px solid rgba(255,255,255,.25);
      color: white;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all .2s;
      flex-shrink: 0;
    }
    .theme-toggle:hover { background: rgba(255,255,255,.1); }

    /* RESPONSIVE */
    @media (max-width: 1024px) {
      .app { grid-template-columns: 1fr !important; grid-template-rows: 60px auto 1fr !important; }
      .sidebar-left { display: none; }
      .sidebar-right { display: none; }
      .grid2 { grid-template-columns: 1fr !important; }
      .grid3 { grid-template-columns: 1fr !important; }
      .stats { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important; }
      .kpis { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important; }
      .apps-grid { grid-template-columns: 1fr !important; }
      .nhi-grid { grid-template-columns: 1fr !important; }
      .tk-body { grid-template-columns: 1fr !important; }
      .welcome-grid { grid-template-columns: 1fr !important; }
      .ctx-grid { grid-template-columns: 1fr !important; }
      .utbl { font-size: 11px; }
      .utbl th, .utbl td { padding: 8px 6px; }
      .page { padding: 14px; }
    }
    @media (max-width: 768px) {
      nav { padding: 0 12px; gap: 8px; height: 54px; flex-wrap: wrap; }
      nav h1 { font-size: 13px; }
      .nl { gap: 2px; }
      .nl a, .nav-link { font-size: 10px; padding: 5px 8px; }
      .nav-links { gap: 2px; }
      .nav-links .nav-link { font-size: 10px; padding: 5px 8px; }
      header { height: 54px; padding: 0 12px; }
      header h1 { font-size: 13px; }
      .page { padding: 10px; }
      .kpi-val, .stat-val { font-size: 24px; }
      .hdr h2, .page-hdr h2 { font-size: 16px; }
      .ticket { padding: 14px; }
      .tk-actions { flex-wrap: wrap; }
      .tk-btn { font-size: 11px; padding: 6px 12px; }
      .filters, .fb { flex-wrap: wrap; }
      .filter-btn, .fb { font-size: 11px; padding: 5px 12px; }
      .card { padding: 14px; }
    }
    @media (max-width: 480px) {
      .nl, .nav-links { display: none; }
      .stats { grid-template-columns: 1fr 1fr !important; }
      .kpis { grid-template-columns: 1fr 1fr !important; }
    }
  `;
  document.head.appendChild(style);
})();
