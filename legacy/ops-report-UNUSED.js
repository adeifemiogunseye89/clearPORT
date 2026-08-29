// ══════════════════════════════════════
// LEGACY / UNUSED — Ops Report feature
// Zero references remain anywhere in the current HTML (verified by
// grepping for setPeriod/handleFile/handleDrop/loadMockData/generateReport/
// opsPrompt/reportPeriod/fileData across clearAi.html — none found).
// This matches what was described as a deliberate product decision: Ops
// Report served a port-management audience (weekly KPI summaries), a
// different persona from the shipper/agent using the rest of the app,
// so it was pulled from the shipper-facing build. Not wired into
// app.html or any page's init — kept here only so the code isn't lost
// if this feature is ever rebuilt as its own management-portal product.
//
// If you do bring this back: it also needs Papa Parse and SheetJS (XLSX)
// loaded (see the original clearAi.js), a #drop-zone / file input in
// some page's HTML, and legacy/ops-report-UNUSED.css.
// ══════════════════════════════════════

let reportPeriod = 'Weekly';
let fileData = null;
let lastOpsReport = null;

function opsPrompt(data, port, period) {
  return `You are a port operations intelligence analyst. Analyse this ${period} port operations data for ${port} and return ONLY valid JSON, no markdown:
{"executive_summary":"3-4 paragraph plain English executive summary for the Operations Director. Highlight performance vs targets, key achievements, and concerns.","kpis":[{"label":"KPI name","value":"formatted value","unit":"TEU/days/hrs/etc","trend":"up|down|flat","trend_pct":"percentage change or N/A","color":"green|amber|red|blue"}],"bottlenecks":[{"severity":"high|medium|low","title":"Bottleneck title","detail":"Plain English explanation and recommended action"}],"recommendations":"2-3 key recommended actions for management this week"}
Data: ${JSON.stringify(data).substring(0,3000)}`;
}

function setPeriod(btn, val) {
  document.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); reportPeriod = val;
}

function handleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'csv') {
    Papa.parse(file, { header:true, complete: r => { fileData = r.data; onDataLoaded(file.name, r.data.length); }});
  } else if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader();
    reader.onload = e => {
      const wb = XLSX.read(e.target.result, {type:'binary'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      fileData = XLSX.utils.sheet_to_json(ws);
      onDataLoaded(file.name, fileData.length);
    };
    reader.readAsBinaryString(file);
  }
}

function handleDrop(e) {
  e.preventDefault(); document.getElementById('drop-zone').classList.remove('drag');
  const f = e.dataTransfer.files[0]; if (f) handleFile(f);
}

function onDataLoaded(name, rows) {
  document.getElementById('dz-text').textContent = `✓ ${name}`;
  document.getElementById('dz-sub').textContent = `${rows} rows loaded`;
  document.getElementById('gen-btn').disabled = !apiKey;
  showToast('File loaded ✓', `${rows} rows ready`, true);
}

function loadMockData() {
  fileData = [
    {week:'W1',vessels_arrived:18,teu_processed:9200,avg_dwell_days:12.4,customs_rejections:34,demurrage_cases:12,nsw_rejections:89,truck_tat_hrs:1.4,berth_utilisation_pct:72},
    {week:'W2',vessels_arrived:21,teu_processed:11400,avg_dwell_days:10.8,customs_rejections:28,demurrage_cases:8,nsw_rejections:71,truck_tat_hrs:1.2,berth_utilisation_pct:81},
    {week:'W3',vessels_arrived:19,teu_processed:10600,avg_dwell_days:13.1,customs_rejections:41,demurrage_cases:15,nsw_rejections:103,truck_tat_hrs:1.7,berth_utilisation_pct:76},
    {week:'W4',vessels_arrived:23,teu_processed:12800,avg_dwell_days:11.2,customs_rejections:22,demurrage_cases:7,nsw_rejections:58,truck_tat_hrs:1.1,berth_utilisation_pct:88}
  ];
  onDataLoaded('sample-port-data.csv', 4);
}

async function generateReport() {
  if (!apiKey || !fileData) return;
  const port = document.getElementById('port-sel').value;
  document.getElementById('gen-btn').disabled = true;
  document.getElementById('gen-btn').textContent = 'Generating...';
  document.getElementById('ops-empty').style.display = 'none';
  try {
    const res = await callClaude(opsPrompt(fileData, port, reportPeriod), `Generate the ${reportPeriod} operations report for ${port}. Data: ${JSON.stringify(fileData)}`, 2000);
    lastOpsReport = res;
    renderOpsReport(res, port);
  } catch(err) {
    document.getElementById('ops-empty').style.display = 'flex';
    showToast('Report failed', err.message.substring(0,120), false);
  }
  document.getElementById('gen-btn').disabled = false;
  document.getElementById('gen-btn').textContent = 'Generate AI Report';
}

function renderOpsReport(r, port) {
  const now = new Date().toLocaleDateString('en-NG',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  document.getElementById('report-title').textContent = `${reportPeriod} Operations Report`;
  document.getElementById('report-sub').textContent = `${port} · ${now}`;
  document.getElementById('copy-rep-btn').style.display = 'inline-block';
  let kH=''; (r.kpis||[]).forEach(k=>{ const c=k.color==='green'?'kpi-green':k.color==='amber'?'kpi-amber':k.color==='red'?'kpi-red':'kpi-blue'; const tc=k.trend==='up'?'chg-up':k.trend==='down'?'chg-dn':'chg-fl'; const ti=k.trend==='up'?'↑':k.trend==='down'?'↓':'→'; kH+=`<div class="kpi-card"><div class="kpi-val ${c}">${k.value}<span style="font-size:0.6em;margin-left:3px">${k.unit||''}</span></div><div class="kpi-lbl">${k.label}</div>${k.trend_pct&&k.trend_pct!=='N/A'?`<div class="kpi-chg ${tc}">${ti} ${k.trend_pct}</div>`:''}</div>`; });
  document.getElementById('kpi-grid').innerHTML = kH;
  document.getElementById('ai-narrative').textContent = r.executive_summary||'';
  let bH=''; (r.bottlenecks||[]).forEach(b=>{ const c=b.severity==='high'?'bneck-h':b.severity==='medium'?'bneck-m':'bneck-l'; const i=b.severity==='high'?'🔴':b.severity==='medium'?'🟡':'🟢'; bH+=`<div class="bneck ${c}"><span class="bneck-icon">${i}</span><div class="bneck-b"><b>${b.title}</b><span>${b.detail}</span></div></div>`; });
  document.getElementById('bottleneck-list').innerHTML = bH;
  document.getElementById('ops-report-body').classList.add('on');
}

function copyOpsReport() {
  if (!lastOpsReport) return;
  const r = lastOpsReport;
  const lines = [`ClearAI Pro — Operations Report\n${document.getElementById('report-title').textContent}\n${document.getElementById('report-sub').textContent}\n\nEXECUTIVE SUMMARY\n${r.executive_summary}\n\nKPIs\n`];
  (r.kpis||[]).forEach(k=>lines.push(`${k.label}: ${k.value} ${k.unit||''} (${k.trend_pct||''})`));
  lines.push('\nBOTTLENECKS\n');
  (r.bottlenecks||[]).forEach(b=>lines.push(`[${b.severity.toUpperCase()}] ${b.title}: ${b.detail}`));
  navigator.clipboard.writeText(lines.join('\n')).then(()=>showToast('Copied ✓','Report copied',true)).catch(()=>showToast('Failed','Copy manually',false));
}
