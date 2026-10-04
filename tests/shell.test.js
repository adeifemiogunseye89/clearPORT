import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserScript } from './helpers/load-browser-script.mjs';

// escapeHtml calls document.createElement('div') internally and reads
// its .innerHTML — the loader's default document stub returns a plain
// {}, which doesn't behave like a real element, so this file provides
// a working fake div that mirrors real browser textContent->innerHTML
// escaping for the five characters that matter.
function fakeDiv() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get innerHTML() {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
  };
}

const scriptPath = new URL('../js/shell.js', import.meta.url);
const { escapeHtml, classifyProxyError } = loadBrowserScript(scriptPath, {
  document: { createElement: (tag) => (tag === 'div' ? fakeDiv() : {}) },
});

test('escapeHtml — neutralizes real injection payloads, leaves ordinary text untouched', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('<script>alert(document.cookie)</script>'), '&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  assert.equal(escapeHtml('"><svg onload=alert(1)>'), '&quot;&gt;&lt;svg onload=alert(1)&gt;');
  assert.equal(
    escapeHtml('Normal finding: invoice total does not match Form M value.'),
    'Normal finding: invoice total does not match Form M value.'
  );
});

test('escapeHtml — handles null/undefined without throwing', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('classifyProxyError — every real status/message pair claude-proxy can emit', () => {
  assert.equal(classifyProxyError(401, { error: 'Invalid invite code' }).category, 'invalid_code');
  assert.equal(classifyProxyError(401, { error: 'This invite code is no longer active' }).category, 'invalid_code');
  assert.equal(classifyProxyError(403, { error: 'This invite code has reached its usage limit' }).category, 'code_exhausted');
  assert.equal(classifyProxyError(429, { error: 'Rate limit reached — max 15 requests per hour. Try again later.' }).category, 'rate_limited');
  assert.equal(classifyProxyError(502, { error: 'Claude API error 529' }).category, 'upstream_error');
  assert.equal(classifyProxyError(400, { error: 'Missing invite code' }).category, 'generic');
  assert.equal(classifyProxyError(500, { error: 'Proxy request failed: fetch failed' }).category, 'generic');
});