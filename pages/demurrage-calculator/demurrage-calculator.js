// ══════════════════════════════════════
// FEATURE — DEMURRAGE RISK CALCULATOR
// (Fully user-driven rates. No hardcoded costs. Scenario days are
//  editable estimates, never presented as guaranteed figures.
//  Output is always shown as a range.)
// Depends on shell.js (showToast, printReport).
// This page does not require an API key — it's pure client-side math.
// ══════════════════════════════════════

function initDemurrageCalculator() {
  recalcDemurrage();
  window.CurrentPage = { onKeyChange: function(){} };
}

function addTier() {
  const container = document.getElementById('dem-tiers');
  const n = container.children.length + 1;
  const row = document.createElement('div');
  row.className = 'tier-row';
  row.dataset.tier = n;
  row.innerHTML = `<span class="tier-lbl">Tier ${n}</span>
    <input type="text" class="dem-input" placeholder="e.g. 16 – 20" oninput="recalcDemurrage()" style="font-size:12px;padding:7px 10px">
    <input type="number" class="dem-input" value="0" min="0" oninput="recalcDemurrage()" style="font-size:12px;padding:7px 10px">`;
  container.appendChild(row);
  recalcDemurrage();
}

// Parses a tier's day-range label — the text field the user fills in
// (e.g. "1 – 4", "1-4", "10+", "11 +") — into { start, end }, where `end`
// is Infinity for an open-ended top tier (e.g. "10+"). Returns null if the
// label can't be confidently parsed, so the caller can fall back safely
// AND surface that fact to the user instead of silently guessing.
function parseTierRange(label) {
  if (!label) return null;
  const cleaned = String(label).trim();
  // Open-ended tier: "10+", "11 +"
  const openMatch = cleaned.match(/^(\d+)\s*\+$/);
  if (openMatch) {
    return { start: parseInt(openMatch[1], 10), end: Infinity };
  }
  // Closed range: "1 – 4", "1—4", "1-4" (normalise en/em dash to hyphen first)
  const closedMatch = cleaned.replace(/[–—]/g, '-').match(/^(\d+)\s*-\s*(\d+)$/);
  if (closedMatch) {
    const start = parseInt(closedMatch[1], 10);
    const end = parseInt(closedMatch[2], 10);
    if (end >= start) return { start, end };
  }
  return null;
}

// Pure: computes cost for a given number of chargeable days against a
// set of { rate, range } tiers (as produced by parseTierRange above).
// Promoted out of recalcDemurrage() (where it used to live as a
// closure, capturing tiers/containers implicitly) specifically so it
// can be unit-tested directly with explicit inputs — see
// tests/demurrage-calculator.test.js. FALLBACK_TIER_WIDTH_DAYS mirrors
// the constant recalcDemurrage() uses when a tier's label couldn't be
// parsed; kept here, not passed as a parameter, since it's a fixed
// fallback width, not something callers should vary per-call.
const FALLBACK_TIER_WIDTH_DAYS = 5;
function costForDays(days, tiers, containers) {
  let cost = 0;
  let remaining = days;
  for (let i = 0; i < tiers.length && remaining > 0; i++) {
    const tier = tiers[i];
    let tierWidth;
    if (tier.range) {
      tierWidth = tier.range.end === Infinity ? Infinity : (tier.range.end - tier.range.start + 1);
    } else {
      tierWidth = FALLBACK_TIER_WIDTH_DAYS;
    }
    const daysInThisTier = tierWidth === Infinity ? remaining : Math.min(remaining, tierWidth);
    cost += daysInThisTier * tier.rate * containers;
    remaining -= daysInThisTier;
  }
  if (remaining > 0 && tiers.length > 0) {
    // Any days beyond the last defined tier's stated range fall back to
    // that tier's rate — this mirrors real demurrage tariffs, which are
    // almost always open-ended at the top tier.
    cost += remaining * tiers[tiers.length - 1].rate * containers;
  }
  return cost;
}

function daysBetween(d1, d2) {
  if (!d1 || !d2) return 0;
  const a = new Date(d1), b = new Date(d2);
  if (isNaN(a) || isNaN(b)) throw new Error('Invalid date entered');
  const diff = Math.round((b - a) / (1000*60*60*24));
  return Math.max(0, diff);
}

// Typical published starting rates by tier-day-range — user must confirm against actual contract.
// These are NOT presented as fact anywhere in the UI; the dropdown label and helper text both say so.
const LINE_PRESETS = {
  maersk: [ ['1 – 4', 100000], ['5 – 9', 150000], ['10+', 200000] ],
  msc:    [ ['1 – 5', 90000],  ['6 – 10', 140000], ['11+', 190000] ],
  cma:    [ ['1 – 4', 95000],  ['5 – 9', 145000],  ['10+', 195000] ],
  hapag:  [ ['1 – 5', 105000], ['6 – 10', 155000], ['11+', 205000] ]
};

function applyLinePreset() {
  const key = document.getElementById('dem-line-preset').value;
  if (!key || !LINE_PRESETS[key]) { recalcDemurrage(); return; }
  const tiers = LINE_PRESETS[key];
  const container = document.getElementById('dem-tiers');
  container.innerHTML = '';
  tiers.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.dataset.tier = i + 1;
    row.innerHTML = `<span class="tier-lbl">Tier ${i+1}</span>
      <input type="text" class="dem-input" value="${t[0]}" oninput="recalcDemurrage()" style="font-size:12px;padding:7px 10px">
      <input type="number" class="dem-input" value="${t[1]}" min="0" oninput="recalcDemurrage()" style="font-size:12px;padding:7px 10px">`;
    container.appendChild(row);
  });
  showToast('Preset applied', 'Typical starting rates loaded — edit any value to match your contract', true);
  recalcDemurrage();
}

function recalcDemurrage() {
  const containersEl = document.getElementById('dem-containers');
  if (!containersEl) return;
  const containers = parseInt(containersEl.value) || 0;
  const freeTerminal = parseInt(document.getElementById('dem-free-terminal').value) || 0;
  const freeLine = parseInt(document.getElementById('dem-free-line').value) || 0;
  const arrival = document.getElementById('dem-arrival').value;
  const clearance = document.getElementById('dem-clearance').value;
  const storageFree = parseInt(document.getElementById('dem-storage-free').value) || 0;
  const storageRate = parseFloat(document.getElementById('dem-storage-rate').value) || 0;

  // Show/hide scenario day inputs based on any checkbox checked
  const scenarios = ['sc-soncap','sc-hscode','sc-nafdac','sc-naqs'];
  const anyChecked = scenarios.some(id => document.getElementById(id) && document.getElementById(id).checked);
  document.getElementById('sc-days-row').style.display = anyChecked ? 'grid' : 'none';
  const scLow = anyChecked ? (parseInt(document.getElementById('sc-days-low').value) || 0) : 0;
  const scHigh = anyChecked ? (parseInt(document.getElementById('sc-days-high').value) || 0) : 0;

  if (!arrival || !clearance || containers < 1) {
    document.getElementById('dem-empty').style.display = 'flex';
    document.getElementById('dem-live').classList.remove('on');
    document.getElementById('dem-copy-btn').style.display = 'none';
    document.getElementById('dem-print-btn').style.display = 'none';
    return;
  }

  let baseDelayDays;
  try {
    baseDelayDays = daysBetween(arrival, clearance);
  } catch (err) {
    // Native <input type="date"> can only ever hold a valid date or
    // empty (caught above) in modern browsers — this only fires on
    // older/unusual browsers that silently fall back to a plain text
    // field for type="date". Fail visibly rather than showing a
    // confidently-wrong $0 estimate.
    document.getElementById('dem-empty').style.display = 'flex';
    document.getElementById('dem-live').classList.remove('on');
    document.getElementById('dem-copy-btn').style.display = 'none';
    document.getElementById('dem-print-btn').style.display = 'none';
    showToast('Invalid date', 'Check the arrival and clearance dates entered', false);
    return;
  }
  const effectiveFree = Math.min(freeTerminal, freeLine);
  const lowDelayDays = Math.max(0, baseDelayDays - effectiveFree);
  const highDelayDays = Math.max(0, (baseDelayDays + scHigh) - effectiveFree);
  const lowDelayDaysWithScenario = Math.max(0, (baseDelayDays + scLow) - effectiveFree);

  // Read tiers dynamically — fully user-defined, nothing hardcoded in logic.
  // Each tier's day-range label (e.g. "1 – 4") is parsed into a real width
  // and used to size that tier's bucket. A label that can't be parsed falls
  // back to FALLBACK_TIER_WIDTH_DAYS for that tier only, and is reported to
  // the user via the warning banner below — it never fails silently.
  const tierRows = document.querySelectorAll('#dem-tiers .tier-row');
  const tiers = [];
  const unparsedTierLabels = [];
  tierRows.forEach((row, idx) => {
    const inputs = row.querySelectorAll('input');
    const rawLabel = inputs[0] ? inputs[0].value.trim() : '';
    const rate = parseFloat(inputs[1] ? inputs[1].value : '') || 0;
    const range = parseTierRange(rawLabel);
    if (!range) {
      unparsedTierLabels.push(rawLabel ? `Tier ${idx + 1} ("${rawLabel}")` : `Tier ${idx + 1} (empty)`);
    }
    tiers.push({ rate, range });
  });

  // Surface the warning (or clear it) — never swallow a parse failure.
  const warnEl = document.getElementById('dem-tier-warning');
  if (warnEl) {
    if (unparsedTierLabels.length > 0) {
      warnEl.style.display = 'flex';
      warnEl.innerHTML = `<span class="at-icon">⚠️</span><div class="at-body"><b>Couldn't read ${unparsedTierLabels.length === 1 ? 'a tier day-range' : 'some tier day-ranges'}</b><span>${unparsedTierLabels.join(', ')} — use a format like "1 – 4" or "10+". Falling back to a ${FALLBACK_TIER_WIDTH_DAYS}-day estimate for ${unparsedTierLabels.length === 1 ? 'it' : 'them'} until fixed.</span></div>`;
    } else {
      warnEl.style.display = 'none';
      warnEl.innerHTML = '';
    }
  }

  const lowCost = costForDays(lowDelayDaysWithScenario, tiers, containers) + (Math.max(0, lowDelayDaysWithScenario - storageFree) * storageRate * containers);
  const highCost = costForDays(highDelayDays, tiers, containers) + (Math.max(0, highDelayDays - storageFree) * storageRate * containers);

  document.getElementById('dem-empty').style.display = 'none';
  document.getElementById('dem-live').classList.add('on');
  document.getElementById('dem-copy-btn').style.display = 'inline-block';
  document.getElementById('dem-print-btn').style.display = 'inline-block';
  document.getElementById('dem-results-sub').textContent = `${containers} × ${document.getElementById('dem-type').value} · ${document.getElementById('dem-port').value}`;

  // Cost hero — always a range
  const heroClass = highCost === 0 ? 'zero' : lowCost < 300000 ? 'low' : '';
  document.getElementById('dem-cost-hero').innerHTML = `
    <div class="ch-label">Estimated Exposure Range</div>
    <div class="ch-amount ${heroClass}">₦${Math.round(lowCost).toLocaleString()} – ₦${Math.round(highCost).toLocaleString()}</div>
    <div class="ch-sub">${lowDelayDaysWithScenario}–${highDelayDays} chargeable day${highDelayDays===1?'':'s'} · based on the rates you entered${anyChecked?' + selected delay scenario':''}</div>`;

  // Risk gauge — position based on high estimate relative to a rough scale
  const riskPct = Math.min(100, (highCost / 2000000) * 100);
  document.getElementById('rg-marker').style.left = riskPct + '%';

  // Breakdown table
  let bH = '<thead><tr><th>Item</th><th>Days</th><th>Basis</th><th>Est. Cost (high case)</th></tr></thead><tbody>';
  bH += `<tr><td class="field-name">Free time (binding: min of terminal/line)</td><td class="day-col">${effectiveFree}</td><td class="rate-col">₦0</td><td class="cost-col">₦0</td></tr>`;
  bH += `<tr><td class="field-name">Base delay (arrival → clearance)</td><td class="day-col">${baseDelayDays}</td><td class="rate-col">per your tiers</td><td class="cost-col">₦${Math.round(costForDays(lowDelayDays, tiers, containers)).toLocaleString()}</td></tr>`;
  if (anyChecked) {
    bH += `<tr><td class="field-name">Delay scenario (optional, editable)</td><td class="day-col">${scLow}–${scHigh}</td><td class="rate-col">per your tiers</td><td class="cost-col">₦${Math.round(costForDays(highDelayDays, tiers, containers)-costForDays(lowDelayDays, tiers, containers)).toLocaleString()}</td></tr>`;
  }
  if (storageRate > 0) {
    bH += `<tr><td class="field-name">Terminal storage</td><td class="day-col">${Math.max(0,highDelayDays-storageFree)}</td><td class="rate-col">₦${storageRate.toLocaleString()}/day</td><td class="cost-col">₦${Math.round(Math.max(0,highDelayDays-storageFree)*storageRate*containers).toLocaleString()}</td></tr>`;
  }
  bH += `<tr><td class="total-row" colspan="3">Total (high estimate)</td><td class="total-row">₦${Math.round(highCost).toLocaleString()}</td></tr>`;
  bH += '</tbody>';
  document.getElementById('dem-breakdown-table').innerHTML = bH;

  // Action tips
  let tips = '';
  if (highCost > 0) {
    tips += `<div class="action-tip at-high"><span class="at-icon">💸</span><div class="at-body"><b>Every day you shorten this delay saves real money</b><span>Reducing your clearance timeline by even 2 days on this shipment could save roughly ₦${Math.round((highCost/highDelayDays)*2).toLocaleString()} at your current rates — check documents before arrival, not after.</span></div></div>`;
  }
  if (anyChecked) {
    tips += `<div class="action-tip at-med"><span class="at-icon">📋</span><div class="at-body"><b>The selected delay scenario is avoidable</b><span>Missing permits and disputed HS codes are exactly what the Reconciliation and Regulatory tools on this platform are built to catch before they cost you these extra days.</span></div></div>`;
  }
  tips += `<div class="action-tip at-low"><span class="at-icon">✓</span><div class="at-body"><b>These figures are yours to adjust</b><span>Update the tier rates, free days, and container count any time your shipping line contract or the port's published rates change — nothing here is fixed.</span></div></div>`;
  document.getElementById('dem-action-tips').innerHTML = tips;

  window._lastDemResult = { lowCost, highCost, lowDelayDaysWithScenario, highDelayDays, containers };
}

function copyDemReport() {
  const r = window._lastDemResult;
  if (!r) return;
  const lines = [
    'ClearAI Pro — Demurrage Risk Estimate',
    new Date().toLocaleString(),
    `Containers: ${r.containers}`,
    `Estimated range: ₦${Math.round(r.lowCost).toLocaleString()} – ₦${Math.round(r.highCost).toLocaleString()}`,
    `Chargeable days: ${r.lowDelayDaysWithScenario}–${r.highDelayDays}`,
    '',
    'Based on user-entered rates — not a fixed platform figure. Confirm against your actual shipping line and terminal tariff.'
  ];
  copyToClipboard(lines.join('\n')).then(()=>showToast('Copied ✓','Estimate copied',true)).catch(()=>showToast('Failed','Copy manually',false));
}

window.PageInit = window.PageInit || {};
window.PageInit['demurrage'] = initDemurrageCalculator;

// Test-only export hook — a plain no-build-step <script> tag in the
// browser never has a `module` global, so this is a complete no-op
// there. In Node (Vitest), it lets tests/demurrage-calculator.test.js
// import these exact functions directly — the real shipped code, not
// a copy that could drift out of sync with it.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseTierRange, costForDays, daysBetween };
}