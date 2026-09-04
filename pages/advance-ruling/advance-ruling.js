// ══════════════════════════════════════
// FEATURE — ADVANCE RULING CONSISTENCY CHECKER
// (AI-assisted only — no live NCS database connection exists.
//  Always disclosed as such in the UI and in the AI's own output.)
// Depends on shell.js (apiKey, callClaude, showToast).
// ══════════════════════════════════════

function initAdvanceRuling() {
  ['ar-ruling-no','ar-hscode','ar-desc'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateArBtn);
  });
  updateArBtn();
  window.CurrentPage = { onKeyChange: updateArBtn };
  window.CurrentPage._guardId = 'ruling';
}

function fillRuling(no, code, desc) {
  document.getElementById('ar-ruling-no').value = no;
  document.getElementById('ar-hscode').value = code;
  document.getElementById('ar-desc').value = desc;
  updateArBtn();
}

function updateArBtn() {
  const btn = document.getElementById('ar-btn');
  if (!btn) return;
  const code = document.getElementById('ar-hscode').value.trim();
  const desc = document.getElementById('ar-desc').value.trim();
  btn.disabled = code.length < 4 || desc.length < 5 || !apiKey;
}

const RULING_PROMPT = `You are assisting with Nigerian Customs Service Advance Ruling verification. IMPORTANT: You do not have live access to the NCS Advance Ruling database — no public API for it exists. Your role is to check whether the declared HS code is a PLAUSIBLE and CONSISTENT classification for the product description given, based on general HS nomenclature knowledge and known patterns in published Nigerian rulings (173 issued, 137 published as of December 2025).

You must NOT claim to have verified the ruling against any live record. Be explicit that this is a plausibility check only, and that the importer must confirm against the official NCS Advance Ruling portal.

Return ONLY valid JSON, no markdown:
{"consistency":"PLAUSIBLE|QUESTIONABLE|LIKELY_MISMATCH","reason":"one sentence, honest about the limits of this check","hs_code_notes":"what this HS code chapter/heading typically covers, in plain English","recommendation":"what the importer should do next","disclaimer_ack":true}`;

async function runRulingCheck() {
  if (!apiKey) { showToast('No API key','Connect your key above',false); return; }
  const rulingNo = document.getElementById('ar-ruling-no').value.trim();
  const code = document.getElementById('ar-hscode').value.trim();
  const desc = document.getElementById('ar-desc').value.trim();

  document.getElementById('ar-loading').style.display = 'block';
  document.getElementById('ar-result').style.display = 'none';
  document.getElementById('ar-btn').disabled = true;

  try {
    const userMsg = `Advance Ruling Reference: ${rulingNo || '(not provided)'}\\nDeclared HS Code: ${code}\\nProduct Description: ${desc}`;
    const res = await callClaude(RULING_PROMPT, userMsg, 900);
    document.getElementById('ar-loading').style.display = 'none';
    const cls = res.consistency==='PLAUSIBLE'?'v-clear':res.consistency==='LIKELY_MISMATCH'?'v-error':'v-warning';
    const icon = res.consistency==='PLAUSIBLE'?'✓':res.consistency==='LIKELY_MISMATCH'?'✗':'⚠';
    document.getElementById('ar-result').innerHTML = `
      <div class="verdict-chip ${cls}" style="margin-bottom:10px"><span class="v-dot"></span>${icon} ${res.consistency.replace('_',' ')}</div>
      <p style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:10px">${res.reason}</p>
      <div class="rp-title" style="margin-bottom:6px">What this HS chapter typically covers</div>
      <p style="font-size:12.5px;color:var(--text2);line-height:1.7;margin-bottom:10px">${res.hs_code_notes}</p>
      <div class="rp-title" style="margin-bottom:6px">Recommended next step</div>
      <p style="font-size:12.5px;color:var(--text2);line-height:1.7">${res.recommendation}</p>
      <div style="margin-top:12px;padding:9px 12px;background:var(--adim);border:1px solid rgba(192,122,42,0.2);border-radius:7px;font-size:11px;color:var(--amber);font-family:var(--mono)">⚠ AI-assisted plausibility check only — always confirm on the official NCS Advance Ruling portal.</div>`;
    document.getElementById('ar-result').style.display = 'block';
    document.getElementById('ar-btn').disabled = false;
  } catch(err) {
     if (isNavigationAbort(err)) return; 
    document.getElementById('ar-loading').style.display = 'none';
    document.getElementById('ar-btn').disabled = false;
    showToast('Check failed', err.message.substring(0,120), false);
  }
}
runRulingCheck = guardApiCall('ruling', runRulingCheck);
window.PageInit = window.PageInit || {};
window.PageInit['ruling'] = initAdvanceRuling;
