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

// Shared Supabase project details — declared ONCE, here, since shell.js
// is guaranteed to load before any page's own script. Individual page
// modules (supplier-portal.js, pre-shipment-check.js) used to each
// declare their own copies of these same two constants; when both
// scripts ended up loaded on the same page together, that caused a
// real "already declared" collision that silently broke whichever
// script loaded second. Centralizing them here removes the collision
// at its root instead of just avoiding it in each new page.
const SUPABASE_URL = 'https://dvvadwrympflvqwoxtzh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PPV34_JovUy7VtLCnnTFjg_BA53APb3';
const CLAUDE_PROXY_URL = `${SUPABASE_URL}/functions/v1/claude-proxy`;

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

  // Load the default page into the (initially empty) page container.
  // This first load replaces the current history entry rather than
  // pushing a new one, matching what a user expects from a fresh
  // page load rather than treating it as a mid-app navigation step.
  const defaultBtn = document.querySelector('.nav-item[onclick*="doc-val"]');
  navTo(defaultBtn, 'doc-val').then(() => {
    history.replaceState({ pageId: 'doc-val' }, '', '#doc-val');
  });
});

function setKeyStatus(ok) {
  const el = document.getElementById('api-status');
  el.className = 'api-status' + (ok ? ' ok' : '');
  el.innerHTML = ok ? '✓ Connected — all AI features active' : 'Required for all AI features — this beta runs on a shared, rate-limited connection, no personal API key needed';
}

function saveKey() {
  const k = document.getElementById('api-key').value.trim();
  if (!k) { showToast('Missing code','Paste your invite code first',false); return; }
  apiKey = k; localStorage.setItem('clearai_key', k);
  setKeyStatus(true); updateAllBtns();
  showToast('Connected ✓','Invite code saved',true);
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
// PUBLIC BETA: calls our own claude-proxy Edge Function instead of
// api.anthropic.com directly. The real Anthropic key lives only
// server-side — `apiKey` here is actually the user's invite code
// (kept under the same variable/localStorage name deliberately, so
// every existing per-page `!apiKey` check keeps working unchanged;
// only what it represents has changed).
//
// Accepts an abort signal from the page-level guard below (via
// window.CurrentPage._guardId), so navigating away mid-request or a
// blocked double-click both cleanly cancel the in-flight call instead
// of leaving it to finish pointlessly in the background.
//
// In-memory cache: identical inputs return the cached result instead
// of a second paid call — worth more now than under the old bring-
// your-own-key model, since every call here draws against a shared,
// rate-limited invite code. Intentionally in-memory only (a plain
// Map, not localStorage) — cleared on reload, never written to disk.
const _responseCache = new Map();

async function _hashRequest(system, userMsg, attachments) {
  const attSig = attachments.map(a => `${a.media_type}:${a.data.length}`).join('|');
  const raw = system + '||' + userMsg + '||' + attSig;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function callClaude(system, userMsg, maxTokens=1800, attachments=[]) {
  const cacheKey = await _hashRequest(system, userMsg, attachments);
  if (_responseCache.has(cacheKey)) {
    return _responseCache.get(cacheKey);
  }

  // Abort signal comes from the currently-running page's guard entry,
  // if one exists — lets guardApiCall()/abortApiCall() below actually
  // cancel this specific in-flight request.
  const pageId = window.CurrentPage?._guardId;
  const guardSignal = pageId ? _apiGuard.get(pageId)?.abortCtrl?.signal : undefined;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 30000);
  // Combine the 30s hard timeout with the guard's cancellation signal —
  // whichever fires first aborts the request. AbortSignal.any() is a
  // newer API; fall back to the timeout alone on older browsers rather
  // than fail outright — public beta testers may be on unknown devices.
  const signal = (guardSignal && typeof AbortSignal.any === 'function')
    ? AbortSignal.any([guardSignal, timeoutController.signal])
    : timeoutController.signal;

  let r;
  try {
    r = await fetch(CLAUDE_PROXY_URL, {
      signal,
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'apikey': SUPABASE_ANON_KEY, // Supabase's own gate on the function — apikey ONLY, see STAGE_2_GUIDE.md
      },
      body: JSON.stringify({
        inviteCode: apiKey,
        system, userMsg, maxTokens, attachments
      })
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw guardSignal?.aborted && !timeoutController.signal.aborted
        ? new Error('aborted') // navigation/guard cancellation — page modules check isNavigationAbort() for this exact message
        : new Error('Request timed out after 30s');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e?.error||`Request failed (${r.status})`); }
  const d = await r.json();
  const textBlock = d.content?.find(b => b.type === 'text');
  if (!textBlock) throw new Error('AI returned no text block');
  const parsed = JSON.parse(textBlock.text.replace(/```json|```/g,'').trim());
  _responseCache.set(cacheKey, parsed);
  return parsed;
}

// ══════════════════════════════════════
// API CALL GUARD — prevents double-submission, hammering, and race
// conditions across all tool pages that fire paid API calls.
//
// Usage in any page module:
//   runValidation = guardApiCall('doc-val', runValidation);
//   runHS         = guardApiCall('hs-class', runHS);
//
// The guard:
// 1. Blocks concurrent calls with a toast ("Already running...")
// 2. Attaches an AbortController that callClaude() above honors
// 3. Guarantees the flag is cleared even if the promise throws
// ══════════════════════════════════════

const _apiGuard = new Map(); // pageId -> { running: boolean, abortCtrl: AbortController|null }

function guardApiCall(pageId, fn) {
  return async function(...args) {
    const state = _apiGuard.get(pageId);
    if (state?.running) {
      showToast('Already running', 'Please wait for the current check to complete', false);
      return;
    }
    const abortCtrl = new AbortController();
    _apiGuard.set(pageId, { running: true, abortCtrl });
    try {
      return await fn.apply(this, args);
    } finally {
      _apiGuard.set(pageId, { running: false, abortCtrl: null });
    }
  };
}

// Optional: programmatic abort (e.g. if user navigates away mid-call)
function abortApiCall(pageId) {
  const state = _apiGuard.get(pageId);
  if (state?.abortCtrl) {
    state.abortCtrl.abort();
    _apiGuard.set(pageId, { running: false, abortCtrl: null });
  }
}

// Helper: page modules use this to silently swallow errors caused by
// the user navigating away mid-request. Prevents toasts and null-DOM
// crashes on the new page.
function isNavigationAbort(err) {
  return err?.name === 'AbortError' || err?.message === 'aborted';
}

// ── NAVIGATION / ROUTER — fetches the target page's HTML fragment,
// injects it, loads that page's <link> CSS + <script> JS if not already
// loaded, then calls that page's init function.
// Async now (the original was a synchronous show/hide toggle) — any
// caller that needs the new page's DOM to exist right after navigating
// must `await navTo(...)`, same as simulateSupplierSubmission() does.
const _loadedPageAssets = new Set(); // pageId -> full bundle (CSS+JS) loaded
const _loadedScripts = new Set();    // pageId -> JS file loaded (script-only or full)

async function navTo(btn, pageId, pushHistory = true) {
  // Cancel any paid API work from the page we're leaving — prevents a
  // stale in-flight request from finishing pointlessly in the background.
  const leavingId = window.CurrentPage?._guardId;
  if (leavingId) abortApiCall(leavingId);
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

  // Move focus to the freshly-loaded page's own heading. Without this,
  // a keyboard or screen-reader user's focus is left on a nav button
  // that's now visually in a different spot, or worse, on nothing at
  // all — they'd have no indication navigation actually happened.
  const heading = container.querySelector('.page-title, h1');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }

  const init = window.PageInit && window.PageInit[pageId];
  if (typeof init === 'function') init();

  if (route.label) trackRecentlyUsed(pageId, route.label);

  // Browser back/forward support. `pushHistory` is false only when
  // THIS call is itself the result of a popstate event (see the
  // listener below) — otherwise every back/forward press would push
  // ANOTHER history entry instead of actually going back.
  if (pushHistory) {
    history.pushState({ pageId }, '', `#${pageId}`);
  }
}

// Fires when the user presses the browser's actual Back/Forward
// buttons. Re-runs navTo for whatever page was in that history entry,
// with pushHistory=false so it doesn't create a new entry on top of
// the one being navigated back to.
window.addEventListener('popstate', (e) => {
  const pageId = e.state?.pageId;
  if (pageId && ROUTES[pageId]) navTo(null, pageId, false);
});

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

