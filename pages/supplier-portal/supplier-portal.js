// ══════════════════════════════════════
// FEATURE — SUPPLIER COMPLIANCE PORTAL
// (Zero-login shareable link. Supplier uploads Invoice/PL only —
//  NOT the Bill of Lading, which is issued by the carrier.)
// Depends on shell.js (apiKey, callClaude, showToast, navTo)
// and pages/pre-shipment-check/pre-shipment-check.js (RECON_SAMPLES,
// RECON_PROMPT, renderReconResults, onReconInput) — this "preview"
// button intentionally reuses the reconciliation feature's logic.
// ══════════════════════════════════════

function initSupplierPortal() {
  updateSupplierLink();
  window.CurrentPage = { onKeyChange: function(){} };
}

function updateSupplierLink() {
  const agent = document.getElementById('scp-agent').value.trim();
  const supplier = document.getElementById('scp-supplier').value.trim();
  const ref = document.getElementById('scp-ref').value.trim();
  const port = document.getElementById('scp-port').value;
  const display = document.getElementById('scp-link-display');
  const btn = document.getElementById('scp-copy-btn');

  if (!agent || !ref) {
    display.textContent = 'Fill in your company name and reference number above';
    display.classList.remove('active');
    btn.disabled = true;
    return;
  }
  const slug = (agent + '-' + ref).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  const link = `https://clearai.pro/check/${slug}`;
  display.textContent = link;
  display.classList.add('active');
  btn.disabled = false;
  window._supplierLink = link;
  window._supplierMeta = { agent, supplier, ref, port };
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

function reviewSubmission() {
  showToast('Preview mode', 'Full inbox needs backend deployment — click "Preview supplier experience" below instead', false);
}

async function simulateSupplierSubmission() {
  if (!apiKey) { showToast('No API key','Connect your key above to preview the AI check',false); return; }
  const formmForCheck = RECON_SAMPLES.formm;
  const invoiceForCheck = RECON_SAMPLES.invoice;
  showToast('Simulating...', 'Running the same AI check a real supplier submission would trigger', true);
  try {
    const userMsg = `FORM M (baseline, filed by importer before order):\\n${formmForCheck}\\n\\nCOMMERCIAL INVOICE + PACKING LIST (just submitted by supplier via portal link):\\n${invoiceForCheck}`;
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

window.PageInit = window.PageInit || {};
window.PageInit['supplier'] = initSupplierPortal;
