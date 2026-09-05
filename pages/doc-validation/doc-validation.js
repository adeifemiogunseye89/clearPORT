// ══════════════════════════════════════
// DOCUMENT VALIDATION — page module
// Depends on shell.js being loaded first (apiKey, callClaude, showToast, printReport).
// ══════════════════════════════════════

// ── DOC METADATA
const DOC_META = {
  'form-m':    {title:'Form M — Import Declaration',       hint:'Mandatory NCS · Initiated through Authorised Dealer Bank before shipment'},
  'paar':      {title:'PAAR — Pre-Arrival Assessment',     hint:'NCS-generated · Determines HS code, value and duties'},
  'sgd':       {title:'SGD — Single Goods Declaration',    hint:'Official entry via NICIS II · Submitted by licensed agent'},
  'bol':       {title:'Bill of Lading / Air Waybill',      hint:'Contract of carriage · Issued by shipping line or airline'},
  'invoice':   {title:'Commercial Invoice & Packing List', hint:'Details value, quantity and breakdown of goods'},
  'ccvo':      {title:'CCVO — Certificate of Value & Origin', hint:'Verifies value, quantity and country of origin'},
  'insurance': {title:'Insurance Certificate',             hint:'Marine cargo insurance · Must be Nigerian NAICOM-registered insurer'},
  'soncap':    {title:'SONCAP Certificate',                hint:'SON · Required for regulated manufactured products'},
  'nafdac':    {title:'NAFDAC Import Permit',              hint:'Required for food, drugs, chemicals and related products'},
  'release':   {title:'Customs Release Note / Exit Note',  hint:'NPA · Proof duties paid and Customs authorised release'},
  'delivery':  {title:'Delivery Order (DO)',               hint:'Shipping line · Authorises terminal to release cargo to consignee'},
  'gatepass':  {title:'Gate Pass / Tally Sheet',           hint:'NPA terminal exit document · Final step before leaving port'}
};

// ── SAMPLE DATA
// Each sample carries its own document type directly — this used to be
// a separate lookup table in loadSamp() that had to be kept in sync by
// hand; a new sample added here with no matching entry there would
// silently default to the wrong validator. Embedding the type removes
// that whole class of mistake.
const SAMPLES = {
  'fm-ok': { type: 'form-m', text: `Form M Application — Lekki Deep Sea Port
Form M Number: FM2025-LKI-084721
Date of Issue: 15 May 2025
Applicant: Dangote Industries Limited
Applicant Address: 2 Banana Island Road, Ikoyi, Lagos
Authorised Dealer Bank: First Bank of Nigeria PLC, Victoria Island Branch
Letter of Credit: LC/2025/0047821
Description of Goods: Industrial Conveyor Belt Systems and Spare Parts
HS Code: 8431.39.00
Quantity: 12 Units
Unit Value: USD 8,500
Total CIF Value: USD 102,000
Country of Origin: Germany
Port of Discharge: Lekki Deep Sea Port
Incoterms: CIF Lagos
Insurance Policy: NIA/2025/MB/00472 — AIICO Insurance Plc
Valid Until: 15 August 2025` },
  'fm-err': { type: 'form-m', text: `Form M Application
Form M Number: FM2025-LKI-091033
Date of Issue: 3 March 2025
Applicant: Kalos Trading Co
Applicant Address: MISSING
Bank: Zenith Bank PLC
Letter of Credit: NOT PROVIDED
Description of Goods: Electronics and Household Items
HS Code: 9999.99.99
Quantity: 500 cartons
Unit Value: USD 12
Total Value: USD 500
Country of Origin: UNKNOWN
Port of Discharge: Apapa
Insurance: Not stated
Valid Until: 1 January 2025` },
  'bol': { type: 'bol', text: `BILL OF LADING
B/L Number: CMDU2025NGA04481
Vessel: CMA CGM SCANDOLA
Voyage: 0127W
Port of Loading: Shanghai, China
Port of Discharge: Lekki Deep Sea Port, Nigeria
Shipper: Shanghai Machinery Export Corp, 18 Pudong Ave, Shanghai
Consignee: Nexus Nigeria Ltd, Plot 14 Apapa Wharf Road, Lagos
Container: CMAU8847362 / Seal: NP20039921
Description: Generator Sets (Diesel) — 3 x 40ft containers
Gross Weight: 67,500 KG / Volume: 108 CBM
Freight: PREPAID
HS Code: 8502.11.00
Originals: 3` },
  'invoice': { type: 'invoice', text: `COMMERCIAL INVOICE & PACKING LIST
Invoice: INV-2025-NG-4821 / Date: 10 April 2025
Seller: Guangdong Electronics Co. Ltd, Shenzhen, China
Buyer: Lagos Tech Distributors Ltd, 5 Commercial Road, Apapa, Lagos
Description: LED Television Sets, 43-inch Smart TVs
HS Code: 8528.72.00
Quantity: 200 units / Unit Price: USD 185.00 / Total: USD 37,000
Incoterms: FOB Shenzhen
Country of Origin: China
Packages: 200 cartons / Gross Weight: 5,200 KG / Volume: 62 CBM
Port of Discharge: Lekki Deep Sea Port` },
  'gatepass': { type: 'gatepass', text: `GATE PASS / TALLY SHEET
Gate Pass: LDSP-GP-2025-091234 / Date: 28 May 2025
Terminal: Lekki Deep Sea Port — Terminal 1
Container: CMAU8847362 / Seal: NP20039921 — INTACT
B/L Ref: CMDU2025NGA04481
Consignee: Nexus Nigeria Ltd
Delivery Order: DO-CMACGM-2025-44821
Customs Release Note: NCS/REL/2025/084721
Exit Time: 14:35
Gate Officer: O. Adeyemi / Vehicle: KJA-421-XY / Driver: Musa Ibrahim
Cargo: Generator Sets — 3 units / Weight: 67,500 KG
Tally Confirmed: YES / Port Charges Paid: YES — NPA-EPAY-2025-091234` }
};

// ── VALIDATION PROMPT
function valPrompt(type) {
  return `You are a Nigerian port customs expert with deep knowledge of NCS, NPA, and the National Single Window (NSW) launched March 2026. Return ONLY valid JSON, no markdown:
{"verdict":"CLEAR|WARNING|ERROR","verdict_reason":"one sentence","nsw_ready":"YES|NO|CONDITIONAL","fields":{"field":"value or MISSING"},"checks":{"check":{"status":"PASS|FAIL|WARN","note":"reason"}},"nsw_checklist":[{"item":"description","status":"PASS|FAIL|WARN"}],"issues":[{"severity":"error|warning|ok","title":"title","detail":"explanation"}],"summary":"3-4 sentence plain English verdict for a port operations manager. State NSW readiness and single most important action."}
Document type: ${type.toUpperCase()}. Extract all relevant fields, run all applicable Nigerian customs checks, assess NSW readiness.`;
}

let currentDocType = 'form-m';
let lastValReport = null;

// ── PAGE INIT — called by the shell router every time this page's fragment loads
function initDocValidation() {
  currentDocType = 'form-m';
  const docText = document.getElementById('doc-text');
  if (docText) {
    docText.addEventListener('input', function() {
      const l = this.value.trim().length;
      document.getElementById('cc-chars').textContent = l.toLocaleString() + ' chars';
      document.getElementById('val-btn').disabled = l < 30 || !apiKey;
    });
  }
  updateDocValBtn();
  // Register so the shell can refresh this page's button when the API key changes
  window.CurrentPage = { onKeyChange: updateDocValBtn };
}

function updateDocValBtn() {
  const el = document.getElementById('doc-text');
  const btn = document.getElementById('val-btn');
  if (!el || !btn) return;
  btn.disabled = el.value.trim().length < 30 || !apiKey;
}

// ── DOC SELECTOR
function selDoc(el, type) {
  document.querySelectorAll('.doc-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  currentDocType = type;
  const m = DOC_META[type];
  document.getElementById('cc-title').textContent = m.title;
  document.getElementById('cc-sub').textContent = m.hint;
  resetVal(true);
}

function loadSamp(key) {
  const sample = SAMPLES[key];
  if (!sample) return;
  document.querySelectorAll('.doc-card').forEach(c => {
    if (c.dataset.type === sample.type) { c.classList.add('active'); selDoc(c, sample.type); }
    else c.classList.remove('active');
  });
  document.getElementById('doc-text').value = sample.text;
  document.getElementById('doc-text').dispatchEvent(new Event('input'));
  document.getElementById('doc-text').scrollIntoView({behavior:'smooth',block:'center'});
}

// ── VALIDATION
async function runValidation() {
  if (!apiKey) { showToast('No API key','Connect your key above',false); return; }
  const text = document.getElementById('doc-text').value.trim();
  document.getElementById('cc-loading').classList.add('on');
  document.getElementById('cc-results').classList.remove('on');
  document.getElementById('val-btn').disabled = true;
  const steps = ['ls1','ls2','ls3','ls4','ls5','ls6'];
  steps.forEach((s,i) => setTimeout(()=>{ document.getElementById(s).classList.add('on'); if(i>0) document.getElementById(steps[i-1]).classList.remove('on'); }, i*700));
  try {
    const res = await callClaude(valPrompt(currentDocType), `Validate this ${DOC_META[currentDocType]?.title}:\n\n${text}`);
    validateReport(res);
    lastValReport = res;
    document.getElementById('cc-loading').classList.remove('on');
    steps.forEach(s=>document.getElementById(s).classList.remove('on'));
    renderValResults(res);
  } catch(err) {
    document.getElementById('cc-loading').classList.remove('on');
    document.getElementById('val-btn').disabled = false;
    steps.forEach(s=>document.getElementById(s).classList.remove('on'));
    showToast('Analysis failed', err.message.substring(0,120), false);
  }
}

// The render function below already has fallbacks (`||{}`, `||'UNKNOWN'`)
// that stop literal "undefined" text from appearing — but a response
// missing verdict/summary entirely would still render as a mostly-blank
// report the user could mistake for "the check passed cleanly". This
// catches that case explicitly, as a clear error, before it ever
// reaches the render step.
function validateReport(r) {
  const required = ['verdict', 'nsw_ready', 'summary'];
  const missing = required.filter(k => !r[k]);
  if (missing.length) throw new Error(`AI response missing fields: ${missing.join(', ')}`);
}

function renderValResults(r) {
  const vc = r.verdict==='CLEAR'?'vc-clear':r.verdict==='WARNING'?'vc-warn':'vc-err';
  const vi = r.verdict==='CLEAR'?'✓':r.verdict==='WARNING'?'⚠':'✗';
  const nc = r.nsw_ready==='YES'?'nr-yes':r.nsw_ready==='NO'?'nr-no':'nr-cond';
  const nt = r.nsw_ready==='YES'?'✓ NSW Ready':r.nsw_ready==='NO'?'✗ Not NSW Ready':'⚡ Fix First';
  document.getElementById('verd-bar').innerHTML = `<div class="vchip ${vc}"><span class="vdot"></span>${vi} ${r.verdict || 'UNKNOWN'}</div><div class="vreason">${r.verdict_reason||''}</div><div class="nsw-ready ${nc}">${nt}</div>`;
  let fH=''; Object.entries(r.fields||{}).forEach(([k,v])=>{ const m=!v||v==='MISSING'; fH+=`<div class="frow"><span class="fk">${k}</span><span class="fv ${m?'fv-miss':'fv-ok'}">${m?'Missing':v}</span></div>`; });
  document.getElementById('fields-out').innerHTML = fH||'<div style="color:var(--text3);font-size:12px">No fields extracted</div>';
  let cH=''; Object.entries(r.checks||{}).forEach(([k,v])=>{ const s=typeof v==='object'?v.status:(v.toLowerCase().startsWith('pass')?'PASS':v.toLowerCase().startsWith('warn')?'WARN':'FAIL'); const n=typeof v==='object'?v.note:''; const c=s==='PASS'?'cv-p':s==='WARN'?'cv-w':'cv-f'; const i=s==='PASS'?'✓':s==='WARN'?'⚠':'✗'; cH+=`<div class="crow"><span class="ck">${k}</span><span class="cv ${c}" title="${n}">${i} ${s}</span></div>`; });
  document.getElementById('checks-out').innerHTML = cH||'<div style="color:var(--text3);font-size:12px">No checks</div>';
  let iH=`<div class="rp-title">Issues &amp; Recommendations</div>`;
  const iss=r.issues||[];
  if(!iss.length) iH+=`<div class="iitem io"><span class="ii-icon">✓</span><div class="ii-b"><b>No issues found</b><span>Document appears complete and consistent.</span></div></div>`;
  else iss.forEach(i=>{ const c=i.severity==='error'?'ie':i.severity==='warning'?'iw':'io'; const ic=i.severity==='error'?'✗':i.severity==='warning'?'⚠':'✓'; iH+=`<div class="iitem ${c}"><span class="ii-icon">${ic}</span><div class="ii-b"><b>${i.title}</b><span>${i.detail}</span></div></div>`; });
  document.getElementById('issues-out').innerHTML = iH;
  let nH=`<div class="rp-title">NSW Submission Checklist</div><div class="nsw-list">`;
  (r.nsw_checklist||[]).forEach(item=>{ const c=item.status==='PASS'?'np':item.status==='WARN'?'nw':'nf'; const i=item.status==='PASS'?'✓':item.status==='WARN'?'⚠':'✗'; nH+=`<div class="ni"><span class="${c}">${i}</span>${item.item}</div>`; });
  nH+='</div>';
  document.getElementById('nsw-out').innerHTML = nH;
  document.getElementById('summ-out').textContent = r.summary||'';
  document.getElementById('cc-results').classList.add('on');
  setTimeout(()=>document.getElementById('cc-results').scrollIntoView({behavior:'smooth',block:'start'}),100);
}

function resetVal(keepText) {
  document.getElementById('cc-results').classList.remove('on');
  document.getElementById('cc-loading').classList.remove('on');
  ['ls1','ls2','ls3','ls4','ls5','ls6'].forEach(s=>document.getElementById(s).classList.remove('on'));
  if(!keepText){ document.getElementById('doc-text').value=''; document.getElementById('cc-chars').textContent='0 chars'; document.getElementById('val-btn').disabled=true; }
}

function copyValReport() {
  if (!lastValReport) return;
  const r = lastValReport;
  const lines = [`ClearAI Pro — Document Validation Report\n${new Date().toLocaleString()}\nDocument: ${DOC_META[currentDocType]?.title}\nVerdict: ${r.verdict} | NSW: ${r.nsw_ready}\n\n${r.verdict_reason}\n`];
  lines.push('FIELDS:'); Object.entries(r.fields||{}).forEach(([k,v])=>lines.push(`  ${k}: ${v}`));
  lines.push('\nISSUES:'); (r.issues||[]).forEach(i=>lines.push(`  [${i.severity.toUpperCase()}] ${i.title}: ${i.detail}`));
  lines.push('\nSUMMARY:', r.summary);
  copyToClipboard(lines.join('\n')).then(()=>showToast('Copied ✓','Report copied',true)).catch(()=>showToast('Failed','Copy manually',false));
}

// Register this page with the shell router
window.PageInit = window.PageInit || {};
window.PageInit['doc-val'] = initDocValidation;