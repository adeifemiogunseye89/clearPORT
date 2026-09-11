// ══════════════════════════════════════
// FEATURE — SUPPLIER COMPLIANCE PORTAL
// (Zero-login shareable link. Supplier uploads Invoice/PL only —
//  NOT the Bill of Lading, which is issued by the carrier.)
// Depends on shell.js (apiKey, callClaude, showToast, navTo)
// and pages/pre-shipment-check/pre-shipment-check.js (RECON_SAMPLES,
// RECON_PROMPT, renderReconResults, onReconInput) — this "preview"
// button intentionally reuses the reconciliation feature's logic.
//
// STAGE 4: "Generate Link" now performs a real insert into the
// `submissions` table (built in Stage 1) instead of building a fake
// slug locally. It writes directly via Supabase's REST API — no
// Edge Function needed for this step, since Stage 1's RLS policy
// already permits exactly this one action ("anyone can create a
// submission") and nothing more. The token itself is generated in
// the browser with crypto.randomUUID() before the insert, so we
// never need the row echoed back — see STAGE_2_GUIDE.md's key-header
// rule (apikey only, never Authorization) for why the fetch below is
// built the way it is.
//
// SUPABASE_URL / SUPABASE_ANON_KEY live in shell.js, not here — see
// the comment there for why (a real redeclaration bug, not a style
// choice).
// ══════════════════════════════════════

function initSupplierPortal() {
  checkLinkFormReady();
  window.CurrentPage = { onKeyChange: function(){} };
    window.CurrentPage._guardId = 'supplier';
}

// Cheap, client-side only — just enables/disables the Generate Link
// button as the required fields fill in. No network call happens
// until the button is actually clicked.
function checkLinkFormReady() {
  const agent = document.getElementById('scp-agent').value.trim();
  const ref = document.getElementById('scp-ref').value.trim();
  document.getElementById('scp-generate-btn').disabled = !agent || !ref;
}
async function generateSupplierLink() {
  const agent = document.getElementById('scp-agent').value.trim();
  const agentEmail = document.getElementById('scp-agent-email').value.trim();
  const supplier = document.getElementById('scp-supplier').value.trim();
  const ref = document.getElementById('scp-ref').value.trim();
  const port = document.getElementById('scp-port').value;
  const display = document.getElementById('scp-link-display');
  const genBtn = document.getElementById('scp-generate-btn');
  const copyBtn = document.getElementById('scp-copy-btn');

  if (!agent || !ref) return; // button should already be disabled, this is just a safety net

  genBtn.disabled = true;
  genBtn.textContent = 'Generating...';
  copyBtn.disabled = true;

  const token = crypto.randomUUID();

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY, // apikey ONLY — see STAGE_2_GUIDE.md
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal', // we already have the token; no need for
                                     // PostgREST to SELECT the row back, which
                                     // would need a SELECT policy we don't have
      },
      body: JSON.stringify({
        token,
        agent_name: agent,
        agent_email: agentEmail || null,
        supplier_name: supplier || null,
        ref,
        port: port || null,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `Request failed (${res.status})`);
    }

    // Build the real link relative to wherever this page is actually being
    // served from — works unchanged whether that's Live Server locally or
    // the real domain once deployed, since supplierlink.html always sits
    // right next to app.html.
    const link = new URL(`supplierlink.html?token=${token}`, window.location.href).href;

    display.textContent = link;
    display.classList.add('active');
    copyBtn.disabled = false;
    window._supplierLink = link;
    window._supplierMeta = { agent, supplier, ref, port };
    showToast('Link generated ✓', 'Ready to share with your supplier', true);
  } catch (err) {
     if (isNavigationAbort(err)) return; 
    showToast('Could not generate link', err.message.substring(0, 120), false);
    display.textContent = 'Something went wrong — try again';
    display.classList.remove('active');
  } finally {
    genBtn.disabled = false;
    genBtn.textContent = 'Generate Link';
  }
}

function copySupplierLink() {
  if (!window._supplierLink) return;
  navigator.clipboard.writeText(window._supplierLink)
    .then(()=>showToast('Link copied ✓','Share it with your supplier',true))
    .catch(()=>showToast('Copy failed','Copy manually',false));
}

function sendWhatsApp() {
  if (!window._supplierLink) { showToast('Generate a link first','Fill in the fields above',false); return; }
  const m = window._supplierMeta;
  const text = encodeURIComponent(`Hi ${m.supplier||'there'}, please upload your Commercial Invoice and Packing List for ${m.ref} here so we can check it before shipping: ${window._supplierLink}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

function sendEmail() {
  if (!window._supplierLink) { showToast('Generate a link first','Fill in the fields above',false); return; }
  const m = window._supplierMeta;
  const subject = encodeURIComponent(`Document check for ${m.ref}`);
  const body = encodeURIComponent(`Hi ${m.supplier||'there'},\\n\\nPlease upload your Commercial Invoice and Packing List for ${m.ref} using this link so we can verify it before shipping instructions go out:\\n${window._supplierLink}\\n\\nThanks,\\n${m.agent}`);
  window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
}

async function simulateSupplierSubmission() {
  if (!apiKey) { showToast('No API key','Connect your key above to preview the AI check',false); return; }
  const formmForCheck = RECON_SAMPLES.formm;
  const invoiceForCheck = RECON_SAMPLES.invoice;
  showToast('Simulating...', 'Running the same AI check a real supplier submission would trigger', true);
  try {
    const userMsg = `<form_m>\n${formmForCheck}\n</form_m>\n\n<supplier_invoice>\n${invoiceForCheck}\n</supplier_invoice>`;
    const res = await callClaude(RECON_PROMPT, userMsg, 1800);
    // navTo is async now (it fetches the target page's fragment) — must await it
    // before touching that page's DOM elements below.
    await navTo(document.querySelector('.nav-item[onclick*="pre-check"]') || document.getElementById('btab-pre-check'), 'pre-check');
    document.getElementById('pr-formm').value = formmForCheck;
    document.getElementById('pr-invoice').value = invoiceForCheck.split('PACKING LIST')[0].trim();
    document.getElementById('pr-packing').value = 'PACKING LIST\\n' + invoiceForCheck.split('PACKING LIST')[1].trim();
    onReconInput();
    lastReconReport = res;
    renderReconResults(res);
    showToast('Preview complete ✓', 'This is what happens the moment your supplier submits', true);
  } catch(err) {
    showToast('Preview failed', err.message.substring(0,120), false);
  }
}
simulateSupplierSubmission = guardApiCall('supplier', simulateSupplierSubmission);
window.PageInit = window.PageInit || {};
window.PageInit['supplier'] = initSupplierPortal;
