// ══════════════════════════════════════
// PUBLIC SUPPLIER UPLOAD PAGE — logic
// Calls the supplier-submission Edge Function built in Stage 2.
// Uses the exact header pattern proven working in that stage: the
// key goes on `apikey` ONLY, never on `Authorization` — see
// backend/STAGE_2_GUIDE.md Gotcha #2 for why.
// ══════════════════════════════════════

// Both of these are the PUBLISHABLE key and project URL — safe to be
// public, this is exactly what they're for. Never put a secret/
// service_role key here.
const SUPABASE_URL = 'https://dvvadwrympflvqwoxtzh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PPV34_JovUy7VtLCnnTFjg_BA53APb3';
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/supplier-submission`;

// Supabase doesn't publish a confirmed Edge Function request-body size
// limit (checked their docs directly — genuinely not listed). This is
// a conservative best-guess ceiling, not a confirmed hard limit — it
// exists to warn early, not to block real testing. Once real usage
// tells us the actual breaking point, tighten this to match.
const MAX_FILE_SIZE_MB = 4;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Claude's document-reading API understands PDFs and images natively —
// not Word docs, spreadsheets, etc. The file picker's `accept`
// attribute only SUGGESTS these types; it doesn't block drag-and-drop
// or "All Files" selections, so this is the real enforcement.
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const ALLOWED_LABEL = 'PDF, JPG, or PNG';

const cardEl = document.getElementById('s-card');
let selectedFiles = { invoice: null, packing_list: null };
let currentToken = null;

function formatSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

// ── STATE RENDERERS ──
function renderError(icon, title, msg, showRetry) {
  const retryBtn = showRetry
    ? `<button class="s-submit-btn" style="margin-top:1.2rem" onclick="location.reload()">Try again</button>`
    : '';
  cardEl.innerHTML = `
    <div class="s-state">
      <div class="s-icon ${icon}">${icon === 'err' ? '✕' : '⚠'}</div>
      <div class="s-title">${title}</div>
      <p class="s-msg">${msg}</p>
      ${retryBtn}
    </div>`;
}

function renderSuccess() {
  cardEl.innerHTML = `
    <div class="s-state">
      <div class="s-icon ok">✓</div>
      <div class="s-title">Documents received</div>
      <p class="s-msg">Thanks — your documents have been submitted and the agent has been notified. You can close this page now.</p>
    </div>`;
}

function renderUploadForm(meta) {
  cardEl.innerHTML = `
    <div class="s-title" style="text-align:left">Upload your documents</div>
    <p class="s-msg" style="text-align:left;margin-bottom:1rem">Requested by <b>${escapeHtml(meta.agent_name)}</b> for reference <b>${escapeHtml(meta.ref)}</b>.</p>
    <div class="s-meta">
      ${meta.supplier_name ? `<div class="s-meta-row"><span>Supplier</span><span>${escapeHtml(meta.supplier_name)}</span></div>` : ''}
      ${meta.port ? `<div class="s-meta-row"><span>Port</span><span>${escapeHtml(meta.port)}</span></div>` : ''}
    </div>

    <div class="s-dropzone" id="dz-invoice" data-type="invoice">
      <div class="s-dz-label">Commercial Invoice <span class="s-dz-maxsize">(PDF/JPG/PNG, max ~${MAX_FILE_SIZE_MB}MB)</span></div>
      <div class="s-dz-text" id="dz-invoice-text">Click or drag a file here</div>
      <input type="file" id="file-invoice" accept=".pdf,.jpg,.jpeg,.png">
    </div>

    <div class="s-dropzone" id="dz-packing_list" data-type="packing_list">
      <div class="s-dz-label">Packing List <span class="s-dz-maxsize">(PDF/JPG/PNG, max ~${MAX_FILE_SIZE_MB}MB)</span></div>
      <div class="s-dz-text" id="dz-packing_list-text">Click or drag a file here</div>
      <input type="file" id="file-packing_list" accept=".pdf,.jpg,.jpeg,.png">
    </div>

    <button class="s-submit-btn" id="submit-btn" disabled>Submit documents</button>
    <div id="upload-error-box"></div>
  `;

  ['invoice', 'packing_list'].forEach(setupDropzone);
  document.getElementById('submit-btn').addEventListener('click', submitDocuments);
}

function setupDropzone(fileType) {
  const dz = document.getElementById(`dz-${fileType}`);
  const input = document.getElementById(`file-${fileType}`);

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) setFile(fileType, input.files[0]);
  });

  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(fileType, file);
  });
}

function setFile(fileType, file) {
  const dz = document.getElementById(`dz-${fileType}`);

  if (!ALLOWED_TYPES.includes(file.type)) {
    dz.classList.remove('filled');
    dz.classList.add('oversized'); // reuse the amber "warning" styling for this too
    document.getElementById(`dz-${fileType}-text`).innerHTML =
      `<span class="s-dz-filename">${escapeHtml(file.name)}</span>
       <div class="s-dz-warning">✕ This file type isn't supported — please use ${ALLOWED_LABEL} only.</div>`;
    selectedFiles[fileType] = null; // make sure a rejected file can't still be submitted
    updateSubmitBtn();
    return;
  }

  selectedFiles[fileType] = file;
  dz.classList.add('filled');
  dz.classList.remove('oversized');

  const oversized = file.size > MAX_FILE_SIZE_BYTES;
  if (oversized) {
    dz.classList.add('oversized');
    document.getElementById(`dz-${fileType}-text`).innerHTML =
      `<span class="s-dz-filename">${escapeHtml(file.name)} (${formatSize(file.size)})</span>
       <div class="s-dz-warning">⚠ Larger than the usual ~${MAX_FILE_SIZE_MB}MB guideline — it may still upload fine, but there's a higher chance of it failing. Worth trying anyway if this is your only copy.</div>`;
  } else {
    document.getElementById(`dz-${fileType}-text`).innerHTML = `<span class="s-dz-filename">✓ ${escapeHtml(file.name)} (${formatSize(file.size)})</span>`;
  }
  updateSubmitBtn();
}

function updateSubmitBtn() {
  const btn = document.getElementById('submit-btn');
  if (!btn) return;
  btn.disabled = !selectedFiles.invoice && !selectedFiles.packing_list;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ── SUBMIT ──
async function submitDocuments() {
  const btn = document.getElementById('submit-btn');
  const errBox = document.getElementById('upload-error-box');
  errBox.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Uploading...';

  const fd = new FormData();
  fd.append('token', currentToken);
  if (selectedFiles.invoice) fd.append('invoice', selectedFiles.invoice);
  if (selectedFiles.packing_list) fd.append('packing_list', selectedFiles.packing_list);

  try {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY }, // apikey ONLY — not Authorization, see STAGE_2_GUIDE.md
      body: fd,
    });
    const data = await res.json();

    if (res.ok && data.success) {
      renderSuccess();
      return;
    }

    // Upload rejected (expired / already submitted / server error) —
    // show the reason, but don't discard the page so they could retry
    // with a fresh link if that's what's needed.
    errBox.innerHTML = `<div class="s-upload-error">${escapeHtml(data.error || 'Upload failed — please try again.')}</div>`;
    btn.disabled = false;
    btn.textContent = 'Submit documents';
  } catch (err) {
    errBox.innerHTML = `<div class="s-upload-error">Network error — check your connection and try again. (${escapeHtml(err.message)})</div>`;
    btn.disabled = false;
    btn.textContent = 'Submit documents';
  }
}

// ── ENTRY POINT — check the token the moment the page loads ──
async function init() {
  const params = new URLSearchParams(window.location.search);
  currentToken = params.get('token');

  if (!currentToken) {
    renderError('err', 'Link not recognized', 'This page needs a valid upload link. Check the link you were sent and try again.');
    return;
  }

  try {
    const res = await fetch(`${FUNCTION_URL}?token=${encodeURIComponent(currentToken)}`, {
      headers: { 'apikey': SUPABASE_ANON_KEY },
    });
    const data = await res.json();

    if (res.status === 404) {
      renderError('err', 'Link not found', 'This link doesn\'t match any request on file. Double-check the link you were sent.');
    } else if (res.status === 410) {
      renderError('warn', 'Link expired', 'This upload link is no longer active. Contact the agent who sent it for a new one.');
    } else if (res.status === 409) {
      renderError('ok', 'Already submitted', 'Documents have already been submitted for this request — no further action needed.');
    } else if (res.ok) {
      renderUploadForm(data);
    } else {
      renderError('err', 'Something went wrong', data.error || 'Please try again in a moment.', true);
    }
  } catch (err) {
    renderError('err', 'Connection problem', 'Could not check your link — check your connection and reload the page.', true);
  }
}

init();