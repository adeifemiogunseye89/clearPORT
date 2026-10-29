import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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

// validateInviteCode talks to the network, so the sandbox gets a fake
// fetch whose behavior each test sets, and which records what it was
// asked to send (so the tests can check the request itself, not just
// how the response is interpreted).
let nextFetch = () => Promise.reject(new Error('no fetch behavior set for this test'));
let lastFetchCall = null;
const fakeFetch = (url, init) => { lastFetchCall = { url, init }; return nextFetch(url, init); };
const fakeResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

const scriptPath = new URL('../js/shell.js', import.meta.url);
const ctx = loadBrowserScript(scriptPath, {
  document: { createElement: (tag) => (tag === 'div' ? fakeDiv() : {}) },
  fetch: fakeFetch,
  AbortController,
  setTimeout,
  clearTimeout,
});
const { escapeHtml, classifyProxyError, validateInviteCode, createSubmission } = ctx;

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

test('validateInviteCode — sends a validate action with NO prompt or document payload', async () => {
  nextFetch = () => Promise.resolve(fakeResponse(200, { valid: true, remaining: 25, max: 25 }));
  await validateInviteCode('abc123');
  const sent = JSON.parse(lastFetchCall.init.body);
  assert.equal(sent.inviteCode, 'abc123');
  assert.equal(sent.action, 'validate');
  // The whole point of validate is that it's cheap: nothing that could
  // make the proxy think it should call Claude may ride along.
  assert.equal(sent.system, undefined);
  assert.equal(sent.userMsg, undefined);
  assert.equal(sent.attachments, undefined);
  assert.equal(lastFetchCall.init.method, 'POST');
});

test('validateInviteCode — a valid code returns the remaining quota', async () => {
  nextFetch = () => Promise.resolve(fakeResponse(200, { valid: true, remaining: 22, max: 25 }));
  const res = await validateInviteCode('good-code');
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 22);
  assert.equal(res.max, 25);
});

test('validateInviteCode — definitive rejections are labelled so callers can tell them from "no answer"', async () => {
  nextFetch = () => Promise.resolve(fakeResponse(401, { error: 'Invalid invite code' }));
  const bad = await validateInviteCode('nope');
  assert.equal(bad.ok, false);
  assert.equal(bad.category, 'invalid_code');

  nextFetch = () => Promise.resolve(fakeResponse(403, { error: 'This invite code has reached its usage limit' }));
  const spent = await validateInviteCode('spent');
  assert.equal(spent.ok, false);
  assert.equal(spent.category, 'code_exhausted');
});

test('validateInviteCode — throttled / unreachable are NOT reported as a bad code', async () => {
  nextFetch = () => Promise.resolve(fakeResponse(429, { error: 'Too many invalid code attempts — please wait a few minutes and try again.' }));
  const throttled = await validateInviteCode('x');
  assert.equal(throttled.ok, false);
  assert.equal(throttled.category, 'rate_limited');

  // Network failure must resolve (never throw) and must not look like
  // a definitive rejection — otherwise being offline would wipe a
  // perfectly good saved code.
  nextFetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const offline = await validateInviteCode('x');
  assert.equal(offline.ok, false);
  assert.equal(offline.category, 'unreachable');
  assert.notEqual(offline.category, 'invalid_code');
  assert.notEqual(offline.category, 'code_exhausted');
});

// createSubmission reads the invite code from shell.js's own top-level
// `apiKey`, which isn't reachable as a property from outside the sandbox —
// run a statement inside it, exactly as the browser's input handler would.
const setApiKey = (code) => vm.runInContext(`apiKey = ${JSON.stringify(code)}`, ctx);
const details = { agent: 'Ada Obi', agentEmail: 'ada@example.com', supplier: 'Shenzhen Co', ref: 'PO-114', port: 'Lagos' };

test('createSubmission — sends the invite code and details to the proxy, never to the table directly', async () => {
  setApiKey('my-code');
  nextFetch = () => Promise.resolve(fakeResponse(200, { token: 'server-made-token' }));
  const token = await createSubmission(details);
  assert.equal(token, 'server-made-token');
  const sent = JSON.parse(lastFetchCall.init.body);
  assert.equal(sent.action, 'create_submission');
  assert.equal(sent.inviteCode, 'my-code');
  assert.equal(sent.ref, 'PO-114');
  assert.equal(sent.agent, 'Ada Obi');
  assert.equal(sent.token, undefined, 'the client must no longer choose its own token');
  assert.equal(String(lastFetchCall.url).includes('/rest/v1/submissions'), false);
});

test('createSubmission — server verdicts arrive as typed errors the page can hand to handleClaudeError', async () => {
  setApiKey('my-code');
  const cases = [
    [401, { error: 'Invalid invite code' }, 'invalid_code'],
    [403, { error: 'This invite code has reached its usage limit' }, 'code_exhausted'],
    [429, { error: 'This invite code has reached its limit of 20 supplier links.' }, 'rate_limited'],
  ];
  for (const [status, body, category] of cases) {
    nextFetch = () => Promise.resolve(fakeResponse(status, body));
    await assert.rejects(() => createSubmission(details), (err) => {
      assert.equal(err.name, 'ClaudeProxyError');
      assert.equal(err.category, category);
      assert.equal(err.message, body.error); // the server's own wording reaches the user
      return true;
    });
  }
});

test('createSubmission — network failure and a missing token are plain errors, not code verdicts', async () => {
  setApiKey('my-code');
  nextFetch = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(() => createSubmission(details), (err) => {
    assert.notEqual(err.name, 'ClaudeProxyError'); // being offline must never clear a good saved code
    return true;
  });
  nextFetch = () => Promise.resolve(fakeResponse(200, {}));
  await assert.rejects(() => createSubmission(details), /did not return a link/);
});
