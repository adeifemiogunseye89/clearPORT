// ══════════════════════════════════════
// APP SHELL
// Owns everything that used to be "global" in the old single-file app:
// the API key, the page router, the sidebar, toasts, and the shared
// callClaude() helper every page module calls.
//
// ARCHITECTURE NOTE — read this before editing:
// The original app kept all 9 tool pages in the DOM at once and just
// hid the inactive ones with CSS (`.page { display:none }`). That let
// one shared `updateAllBtns()` reach into every page's inputs directly,
// because they always existed.
//
// This split app instead fetches ONE page's HTML fragment at a time
// into #page-container and throws the previous one away. That's what
// makes each page's .html/.css/.js independently maintainable — but it
// means only the CURRENTLY LOADED page's elements exist in the DOM.
//
// The fix: every page module defines its own init<PageName>() function
// (registered in window.PageInit) that the router calls after injecting
// that page's fragment. Each page module also sets
// `window.CurrentPage = { onKeyChange: fn }` inside its init function,
// so that when the API key changes (saveKey below), the shell can ask
// *only the page that's actually on screen* to refresh its own button
// state — instead of guessing at every page's element IDs.
// ══════════════════════════════════════

let apiKey = '';

// pageId -> folder/file on disk + the label shown in "recently used"
const ROUTES = {
  'doc-val':      { folder: 'doc-validation',       file: 'doc-validation',       label: 'Document Check' },
  'hs-class':     { folder: 'hs-classifier',         file: 'hs-classifier',        label: 'HS Code' },
  // Supplier Portal's "preview supplier experience" button reuses the
  // Pre-Shipment Check page's reconciliation logic (RECON_SAMPLES,
  // RECON_PROMPT, onReconInput, renderReconResults) — so that page's
  // script must be loaded too, even if the visitor never opens that tab.
  'supplier':     { folder: 'supplier-portal',       file: 'supplier-portal',      label: 'Supplier Portal', deps: ['pre-check'] },
  'demurrage':    { folder: 'demurrage-calculator',  file: 'demurrage-calculator', label: 'Demurrage Calc' },
  'pre-check':    { folder: 'pre-shipment-check',    file: 'pre-shipment-check',   label: 'Form M Reconciliation' },
  'ruling':       { folder: 'advance-ruling',        file: 'advance-ruling',       label: 'Advance Ruling' },
  'coming-soon':  { folder: 'coming-soon',           file: 'coming-soon',          label: 'Coming Soon' }
};

// ── INIT
window.addEventListener('DOMContentLoaded', () => {
  const k = localStorage.getItem('clearai_key');
  if (k) { apiKey = k; document.getElementById('api-key').value = k; setKeyStatus(true); }
  document.getElementById('api-key').addEventListener('input', e => { apiKey = e.target.value.trim(); updateAllBtns(); });

  // Load the default page into the (initially empty) page container
  const defaultBtn = document.querySelector('.nav-item[onclick*="doc-val"]');
  navTo(defaultBtn, 'doc-val');
});

function setKeyStatus(ok) {
  const el = document.getElementById('api-status');
  el.className = 'api-status' + (ok ? ' ok' : '');
  el.innerHTML = ok ? '✓ Connected — all AI features active' : 'Required for all AI features · <a href="https://console.anthropic.com" target="_blank" style="color:var(--green2)">Get free key →</a>';
}

function saveKey() {
  const k = document.getElementById('api-key').value.trim();
  if (!k.startsWith('sk-ant')) { showToast('Invalid key','Must start with sk-ant...',false); return; }
  apiKey = k; localStorage.setItem('clearai_key', k);
  setKeyStatus(true); updateAllBtns();
  showToast('Connected ✓','API key saved',true);
}

// Refreshes only the currently-loaded page's own button state — see the
// architecture note at the top of this file for why it can't reach into
// every page's elements the way the original single-file version did.
function updateAllBtns() {
  if (window.CurrentPage && typeof window.CurrentPage.onKeyChange === 'function') {
    window.CurrentPage.onKeyChange();
  }
}

// ── SHARED CLAUDE API CALL — every page module uses this
// `attachments` is optional: an array of {media_type, data} where
// `data` is base64 file content. Used by Pre-Shipment Check's real-
// document loading (Stage 6) to hand Claude actual PDFs/images
// instead of pasted text. Every other existing caller passes nothing
// here, so this is fully backward compatible — when attachments is
// empty, the request body is built exactly as it always was.
async function callClaude(system, userMsg, maxTokens=1800, attachments=[]) {
  let content = userMsg;
  if (attachments.length) {
    content = attachments.map(att => ({
      type: att.media_type === 'application/pdf' ? 'document' : 'image',
      source: { type: 'base64', media_type: att.media_type, data: att.data }
    }));
    content.push({ type: 'text', text: userMsg });
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'x-api-key': apiKey,
      'anthropic-version':'2023-06-01',
      'anthropic-dangerous-direct-browser-access':'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system, messages:[{role:'user',content}]
    })
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e?.error?.message||`API error ${r.status}`); }
  const d = await r.json();
  return JSON.parse(d.content[0].text.replace(/```json|```/g,'').trim());
}

// ── NAVIGATION / ROUTER — fetches the target page's HTML fragment,
// injects it, loads that page's <link> CSS + <script> JS if not already
// loaded, then calls that page's init function.
// Async now (the original was a synchronous show/hide toggle) — any
// caller that needs the new page's DOM to exist right after navigating
// must `await navTo(...)`, same as simulateSupplierSubmission() does.
const _loadedPageAssets = new Set(); // pageId -> full bundle (CSS+JS) loaded
const _loadedScripts = new Set();    // pageId -> JS file loaded (script-only or full)

async function navTo(btn, pageId) {
  const route = ROUTES[pageId];
  if (!route) { console.error('Unknown page:', pageId); return; }

  // Update desktop nav items
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  // Update mobile bottom tabs
  document.querySelectorAll('.btab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Mirror selection: if desktop btn clicked, activate matching mobile tab and vice versa
  const desktopMatch = document.querySelector('.nav-item[onclick*="' + pageId + '"]');
  const mobileMatch = document.getElementById('btab-' + pageId);
  if (desktopMatch) desktopMatch.classList.add('active');
  if (mobileMatch) mobileMatch.classList.add('active');

  const container = document.getElementById('page-container');
  try {
    const res = await fetch(`pages/${route.folder}/${route.file}.html`);
    if (!res.ok) throw new Error(`Could not load page (${res.status})`);
    container.innerHTML = await res.text();
  } catch (err) {
    container.innerHTML = `<div class="page-wrap"><p style="color:var(--red)">Could not load this page: ${err.message}. If you're opening this file directly (file://), you need to serve it over a local web server instead — see README.md.</p></div>`;
    return;
  }

  await ensurePageAssetsLoaded(pageId, route);

  window.scrollTo({top:0, behavior:'smooth'});

  const init = window.PageInit && window.PageInit[pageId];
  if (typeof init === 'function') init();

  if (route.label) trackRecentlyUsed(pageId, route.label);
}

// Keep backward-compat alias some inline handlers may still use
function nav(btn, pageId) { navTo(btn, pageId); }

async function ensurePageAssetsLoaded(pageId, route) {
  // Load this page's own dependency scripts first (e.g. Supplier Portal
  // needs Pre-Shipment Check's JS even if that page was never opened).
  if (route.deps) {
    for (const depId of route.deps) {
      const depRoute = ROUTES[depId];
      if (depRoute) await loadScriptOnly(depId, depRoute);
    }
  }

  if (_loadedPageAssets.has(pageId)) return;
  _loadedPageAssets.add(pageId);

  // CSS
  const cssHref = `pages/${route.folder}/${route.file}.css`;
  if (!document.querySelector(`link[href="${cssHref}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssHref;
    document.head.appendChild(link);
  }

  // JS — coming-soon has no script file, it's a static page
  if (pageId === 'coming-soon') return;
  await loadScriptOnly(pageId, route);
}

// Loads a page's <script> only (no HTML fragment, no CSS) — used both for
// the active page and for silently-loaded dependency scripts (see `deps`
// above), since a dependency's code is needed but its markup isn't shown.
async function loadScriptOnly(pageId, route) {
  if (_loadedScripts.has(pageId)) return;
  _loadedScripts.add(pageId);
  const jsSrc = `pages/${route.folder}/${route.file}.js`;
  if (document.querySelector(`script[src="${jsSrc}"]`)) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = jsSrc;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${jsSrc}`));
    document.body.appendChild(script);
  });
}

// ── PRINT / SAVE AS PDF (native browser print — no library needed)
function printReport(pageId) {
  let resultsHTML = '';
  let title = 'ClearAI Pro Report';
  if (pageId === 'doc-val') {
    resultsHTML = document.getElementById('cc-results') ? document.getElementById('cc-results').innerHTML : '';
    title = 'Document Check Report';
  } else if (pageId === 'pre-check') {
    resultsHTML = document.getElementById('pr-results') ? document.getElementById('pr-results').innerHTML : '';
    title = 'Form M Reconciliation Report';
  } else if (pageId === 'demurrage') {
    resultsHTML = document.getElementById('dem-live') ? document.getElementById('dem-live').innerHTML : '';
    title = 'Demurrage Risk Estimate';
  }
  if (!resultsHTML.trim()) { showToast('Nothing to print', 'Run a check first', false); return; }
  const now = new Date().toLocaleString();
  const win = window.open('', '_blank');
  if (!win) { showToast('Pop-up blocked', 'Allow pop-ups to print', false); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>${title}</title><meta charset="UTF-8">
    <style>
      body{font-family:Georgia,'Times New Roman',serif;padding:2rem;color:#1e1810;max-width:720px;margin:0 auto;line-height:1.5}
      h1{font-size:1.3rem;border-bottom:2px solid #3a7d5f;padding-bottom:10px;margin-bottom:4px}
      .meta{font-size:11px;color:#7a6e5f;margin-bottom:1.5rem;font-family:'Courier New',monospace}
      .disclaimer{font-size:10px;color:#9a8c7a;margin-top:2rem;padding-top:1rem;border-top:1px solid #ddd}
      table{width:100%;border-collapse:collapse;margin:0.8rem 0}
      td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;font-size:12.5px}
      button,.btn-sm,.go-btn,.res-foot,.result-foot{display:none !important}
      * {box-shadow:none !important; background-image:none !important}
      @media print { body{padding:0.5rem} }
    </style></head><body>
    <h1>${title}</h1>
    <div class="meta">ClearAI Pro · Nigerian Port Intelligence · Generated ${now}</div>
    ${resultsHTML}
    <div class="disclaimer">This is an AI-assisted check, not a legal or regulatory certification. Confirm against official NCS / NPA / NSW records before relying on it.</div>
    </body></html>`);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 350);
}

// ── SIDEBAR (honest content only — nothing "live" without a real data source)
function toggleSidebar() {
  const panel = document.getElementById('sidebar-panel');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  overlay.classList.toggle('on', !isOpen);
  if (!isOpen) renderRecentlyUsed();
}
function closeSidebarOutside(e) {
  if (e.target.id === 'sidebar-overlay') toggleSidebar();
}
function sidebarNav(pageId) {
  toggleSidebar();
  const desktopMatch = document.querySelector('.nav-item[onclick*="' + pageId + '"]');
  const mobileMatch = document.getElementById('btab-' + pageId);
  const target = desktopMatch || mobileMatch;
  if (target) navTo(target, pageId);
}
function trackRecentlyUsed(pageId, label) {
  try {
    let list = JSON.parse(localStorage.getItem('clearai_recent') || '[]');
    list = list.filter(x => x.id !== pageId);
    list.unshift({ id: pageId, label, ts: Date.now() });
    list = list.slice(0, 5);
    localStorage.setItem('clearai_recent', JSON.stringify(list));
  } catch(e) {}
}
function renderRecentlyUsed() {
  const el = document.getElementById('recent-list');
  if (!el) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem('clearai_recent') || '[]'); } catch(e) {}
  if (!list.length) { el.innerHTML = '<div class="sb-empty">Nothing checked yet on this device</div>'; return; }
  el.innerHTML = list.map(x => `<div class="sb-recent-item" onclick="sidebarNav('${x.id}')">${x.label}</div>`).join('');
}

// ── TOAST
function showToast(title, msg, ok) {
  const t = document.getElementById('toast');
  t.className = `toast on ${ok?'ok':'err'}`;
  document.getElementById('t-t').textContent = title;
  document.getElementById('t-m').textContent = msg;
  setTimeout(()=>t.classList.remove('on'), 3800);
}

// NOTE: launchApp()/backToLanding() from the original single-file app are
// gone. Landing (index.html) and the app (app.html) are now two real,
// separately-loadable pages — see index.html's "Open Platform" link and
// app.html's "← Home" link. localStorage (the API key, recently-used list)
// persists across that navigation same as it did across the old show/hide.

