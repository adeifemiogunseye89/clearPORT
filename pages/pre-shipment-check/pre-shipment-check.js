// ══════════════════════════════════════
// FEATURE — FORM M ↔ INVOICE/PL RECONCILIATION
// (Phased: Form M is baseline, checked against supplier's Invoice/PL.
//  B/L is NOT included here — it's issued later by the carrier, not
//  the supplier, and carries different fields — see Supplier Portal.)
// Depends on shell.js (apiKey, callClaude, showToast).
// ══════════════════════════════════════
const RECON_SAMPLES = {
  formm: `Form M Number: FM2026-LKI-051290
Applicant: Nexus Nigeria Ltd
Applicant Address: Plot 14 Apapa Wharf Road, Lagos
Authorised Dealer Bank: GTBank, Victoria Island
Description of Goods: LED Television Sets, 43-inch Smart TVs
HS Code: 8528.72.00
Quantity: 200 units
Unit Value: USD 185.00
Total CIF Value: USD 37,000
Country of Origin: China
Supplier: Guangdong Electronics Co. Ltd, Shenzhen
Port of Discharge: Lekki Deep Sea Port
Incoterms: FOB Shenzhen`,
  invoice: `COMMERCIAL INVOICE
Invoice Number: INV-2026-CN-8871
Seller: Guangdong Electronics Co. Ltd, Shenzhen, China
Buyer: Nexus Nigeria Ltd, Lagos
Description: LED Smart TV, 43-inch, Android OS
HS Code: 8528.72.00
Quantity: 220 units
Unit Price: USD 185.00
Total Value: USD 40,700
Incoterms: FOB Shenzhen
Country of Origin: China

PACKING LIST
Total Packages: 220 cartons
Net Weight: 4,620 KG
Gross Weight: 5,060 KG
Volume: 64 CBM`
};

const RECON_PROMPT = `You are a Nigerian customs reconciliation expert. Form M is filed by the importer BEFORE the order — it is the baseline of truth. The Commercial Invoice and Packing List come LATER from the foreign supplier. Your job is to check whether what the supplier actually sent is consistent with what was originally declared on Form M.

Important field semantics — do not treat these as directly comparable:
- Invoice may show only net weight or no weight; Packing List shows both net and gross weight. Compare packing list gross weight only against other gross weight fields, never against net weight.
- Minor quantity/value differences (under 5%) are common and should be WARNING not ERROR.
- Description wording may differ slightly (e.g. "LED TV" vs "LED Smart Television") — judge on substance, not exact wording match.

Return ONLY valid JSON, no markdown:
{"verdict":"CONSISTENT|MINOR_DIFFERENCES|MAJOR_MISMATCH","verdict_reason":"one sentence","comparison":[{"field":"HS Code","form_m_value":"...","supplier_value":"...","match":"MATCH|CLOSE|MISMATCH"}],"issues":[{"severity":"error|warning|ok","title":"...","detail":"...","affected_docs":["Form M","Invoice"]}],"summary":"3-4 sentence plain English summary. State clearly if the supplier's documents are safe to proceed with, or what must be corrected with the supplier before Shipping Instructions are sent to the carrier."}`;

let lastReconReport = null;

// ══════════════════════════════════════
// STAGE 6 — loading a real supplier submission
// Same Supabase project as every other page; calls the agent-review
// Edge Function (Stage 6, Part A) to get signed download URLs, then
// downloads and base64-encodes each file so callClaude() (extended
// in shell.js) can hand them to Claude directly as real documents.
// ══════════════════════════════════════
const SUPABASE_URL = 'https://dvvadwrympflvqwoxtzh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PPV34_JovUy7VtLCnnTFjg_BA53APb3';
const AGENT_REVIEW_URL = `${SUPABASE_URL}/functions/v1/agent-review`;

let loadedAttachments = null; // null = using pasted text (default); once set, takes priority over Stage 2's textareas

// Accepts either a full supplierlink.html?token=... link, or a bare token
function extractToken(input) {
  input = input.trim();
  try {
    const url = new URL(input);
    const t = url.searchParams.get('token');
    if (t) return t;
  } catch (e) { /* not a full URL — treat the whole input as the token */ }
  return input;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]); // strip the "data:...;base64," prefix
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function loadRealSubmission() {
  const raw = document.getElementById('load-token-input').value;
  const token = extractToken(raw);
  const btn = document.getElementById('load-submission-btn');
  const status = document.getElementById('load-submission-status');

  if (!token) { status.textContent = 'Paste a link or token first'; return; }

  btn.disabled = true;
  status.textContent = 'Loading...';

  try {
    const res = await fetch(`${AGENT_REVIEW_URL}?token=${encodeURIComponent(token)}`, {
      headers: { apikey: SUPABASE_ANON_KEY } // apikey ONLY — see STAGE_2_GUIDE.md
    });
    const data = await res.json();

    if (!res.ok) { status.textContent = data.error || 'Could not load this submission'; btn.disabled = false; return; }
    if (data.status !== 'submitted') { status.textContent = 'No documents submitted yet for this link'; btn.disabled = false; return; }
    if (!data.documents || !data.documents.length) { status.textContent = 'Submission found, but no documents attached'; btn.disabled = false; return; }

    const newAttachments = {};
    for (const doc of data.documents) {
      const fileRes = await fetch(doc.signed_url);
      if (!fileRes.ok) throw new Error(`Could not download ${doc.type}`);
      const blob = await fileRes.blob();
      newAttachments[doc.type] = { media_type: blob.type, data: await blobToBase64(blob) };
    }

    loadedAttachments = newAttachments;
    status.innerHTML = `✓ Loaded ${data.documents.length} document(s) for ${data.ref} — paste your Form M below, then run reconciliation. <a href="#" onclick="clearLoadedSubmission();return false;" style="color:var(--text3);text-decoration:underline">Use pasted text instead</a>`;
    btn.disabled = false;
    onReconInput(); // refresh the Stage 2 badge now that real files count as "loaded"
  } catch (err) {
    status.textContent = 'Something went wrong loading this submission — ' + err.message;
    btn.disabled = false;
  }
}

function clearLoadedSubmission() {
  loadedAttachments = null;
  document.getElementById('load-submission-status').textContent = '';
  document.getElementById('load-token-input').value = '';
  onReconInput();
}

function initPreShipmentCheck() {
  onReconInput();
  window.CurrentPage = { onKeyChange: onReconInput };
}

function loadReconSample(which) {
  if (which === 'formm') document.getElementById('pr-formm').value = RECON_SAMPLES.formm;
  if (which === 'invoice') {
    document.getElementById('pr-invoice').value = RECON_SAMPLES.invoice.split('PACKING LIST')[0].trim();
    document.getElementById('pr-packing').value = 'PACKING LIST\n' + RECON_SAMPLES.invoice.split('PACKING LIST')[1].trim();
  }
  onReconInput();
}

function onReconInput() {
  const formmEl = document.getElementById('pr-formm');
  if (!formmEl) return;
  const formm = formmEl.value.trim();
  const invoice = document.getElementById('pr-invoice').value.trim();
  const packing = document.getElementById('pr-packing').value.trim();
  document.getElementById('stage1-badge').textContent = formm.length > 20 ? '✓ Loaded' : 'Not loaded';
  document.getElementById('stage1-badge').style.color = formm.length > 20 ? 'var(--green2)' : 'var(--text3)';
  document.getElementById('stage1-badge').style.borderColor = formm.length > 20 ? 'rgba(58,125,95,0.3)' : 'var(--border2)';
  document.getElementById('stage1-badge').style.background = formm.length > 20 ? 'var(--gdim)' : 'var(--bg3)';
  const stage2Ready = invoice.length > 20 || packing.length > 20 || !!loadedAttachments;
  document.getElementById('stage2-badge').textContent = loadedAttachments ? '✓ Loaded (real files)' : stage2Ready ? '✓ Loaded' : 'Not loaded';
  document.getElementById('stage2-badge').style.color = stage2Ready ? 'var(--green2)' : 'var(--text3)';
  document.getElementById('stage2-badge').style.borderColor = stage2Ready ? 'rgba(58,125,95,0.3)' : 'var(--border2)';
  document.getElementById('stage2-badge').style.background = stage2Ready ? 'var(--gdim)' : 'var(--bg3)';

  const ready = formm.length > 20 && stage2Ready;
  document.getElementById('pr-btn').disabled = !ready || !apiKey;
  document.getElementById('pr-status').textContent = ready
    ? 'Ready to reconcile — Form M baseline + supplier documents loaded'
    : 'Load Stage 1 and Stage 2 to run reconciliation';
}

async function runReconciliation() {
  if (!apiKey) { showToast('No API key','Connect your key above',false); return; }
  const formm = document.getElementById('pr-formm').value.trim();
  const invoice = document.getElementById('pr-invoice').value.trim();
  const packing = document.getElementById('pr-packing').value.trim();

  document.getElementById('pr-loading').classList.add('on');
  document.getElementById('pr-results').classList.remove('on');
  document.getElementById('pr-btn').disabled = true;
  const steps = ['prls1','prls2','prls3','prls4','prls5'];
  steps.forEach((s,i)=>setTimeout(()=>{ document.getElementById(s).classList.add('on'); if(i>0) document.getElementById(steps[i-1]).classList.remove('on'); }, i*650));

  try {
    let userMsg, attachments = [];
    if (loadedAttachments) {
      userMsg = `FORM M (baseline, filed by importer before order):\n${formm}\n\nThe Commercial Invoice and Packing List are attached below as the real documents uploaded by the supplier — read them directly.`;
      if (loadedAttachments.invoice) attachments.push(loadedAttachments.invoice);
      if (loadedAttachments.packing_list) attachments.push(loadedAttachments.packing_list);
    } else {
      userMsg = `FORM M (baseline, filed by importer before order):\n${formm}\n\nCOMMERCIAL INVOICE (from supplier):\n${invoice || '(not provided)'}\n\nPACKING LIST (from supplier):\n${packing || '(not provided)'}`;
    }
    const res = await callClaude(RECON_PROMPT, userMsg, 1800, attachments);
    lastReconReport = res;
    document.getElementById('pr-loading').classList.remove('on');
    steps.forEach(s=>document.getElementById(s).classList.remove('on'));
    renderReconResults(res);
  } catch(err) {
    document.getElementById('pr-loading').classList.remove('on');
    document.getElementById('pr-btn').disabled = false;
    steps.forEach(s=>document.getElementById(s).classList.remove('on'));
    showToast('Reconciliation failed', err.message.substring(0,120), false);
  }
}

function renderReconResults(r) {
  const vc = r.verdict==='CONSISTENT'?'cv-clean':r.verdict==='MAJOR_MISMATCH'?'cv-issues':'cv-warnings';
  const vi = r.verdict==='CONSISTENT'?'✓':r.verdict==='MAJOR_MISMATCH'?'✗':'⚠';
  document.getElementById('pr-verdict-box').innerHTML = `<div class="cross-verdict ${vc}"><span class="cross-verdict-icon">${vi}</span><div class="cross-verdict-body"><h3>${r.verdict.replace('_',' ')}</h3><p>${r.verdict_reason||''}</p></div></div>`;

  let mH = '';
  (r.issues||[]).forEach(i=>{
    const cls = i.severity==='error'?'mc-error':i.severity==='warning'?'mc-warning':'mc-ok';
    const sevCls = i.severity==='error'?'mc-sev-e':i.severity==='warning'?'mc-sev-w':'mc-sev-o';
    let docsHtml = '';
    (i.affected_docs||[]).forEach(d=>docsHtml+=`<span class="mc-doc-tag">${d}</span>`);
    mH += `<div class="mismatch-card ${cls}"><div class="mc-header"><span class="mc-sev ${sevCls}">${i.severity.toUpperCase()}</span></div><div class="mc-title">${i.title}</div><div class="mc-detail">${i.detail}</div><div class="mc-docs">${docsHtml}</div></div>`;
  });
  document.getElementById('pr-mismatches').innerHTML = mH || '<div style="color:var(--text3);font-size:12px;padding:1rem">No issues to flag.</div>';

  let tH = '<thead><tr><th>Field</th><th>Form M (baseline)</th><th>Supplier documents</th><th>Result</th></tr></thead><tbody>';
  (r.comparison||[]).forEach(c=>{
    const mCls = c.match==='MATCH'?'match':c.match==='MISMATCH'?'mismatch':'';
    tH += `<tr><td class="field-name">${c.field}</td><td>${c.form_m_value||'—'}</td><td>${c.supplier_value||'—'}</td><td class="${mCls}">${c.match}</td></tr>`;
  });
  tH += '</tbody>';
  document.getElementById('pr-compare-table').innerHTML = tH;

  document.getElementById('pr-summary').textContent = r.summary||'';
  document.getElementById('pr-results').classList.add('on');
  document.getElementById('pr-btn').disabled = false;
  setTimeout(()=>document.getElementById('pr-results').scrollIntoView({behavior:'smooth',block:'start'}),100);
}

function copyReconReport() {
  if (!lastReconReport) return;
  const r = lastReconReport;
  const lines = [`ClearAI Pro — Form M Reconciliation Report`,`${new Date().toLocaleString()}`,`Verdict: ${r.verdict}`,``,r.verdict_reason,``,'FIELD COMPARISON:'];
  (r.comparison||[]).forEach(c=>lines.push(`  ${c.field}: Form M="${c.form_m_value}" vs Supplier="${c.supplier_value}" [${c.match}]`));
  lines.push('','ISSUES:');
  (r.issues||[]).forEach(i=>lines.push(`  [${i.severity.toUpperCase()}] ${i.title}: ${i.detail}`));
  lines.push('','SUMMARY:', r.summary);
  navigator.clipboard.writeText(lines.join('\n')).then(()=>showToast('Copied ✓','Report copied',true)).catch(()=>showToast('Failed','Copy manually',false));
}

window.PageInit = window.PageInit || {};
window.PageInit['pre-check'] = initPreShipmentCheck;
