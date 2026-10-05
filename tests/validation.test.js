// Tests the REAL shared module both Edge Functions import from — not
// a hand-copied mirror of it. A passing test here is a direct
// guarantee about what claude-proxy and supplier-submission actually
// run in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryForStatus,
  sha256Hex,
  sanitizeFilename,
  detectRealType,
  formatSize,
} from '../supabase/functions/_shared/validation.js';

test('categoryForStatus — every real status code claude-proxy can emit', () => {
  assert.equal(categoryForStatus(200), 'ok');
  assert.equal(categoryForStatus(401), 'invalid_code');
  assert.equal(categoryForStatus(403), 'code_exhausted');
  assert.equal(categoryForStatus(429), 'rate_limited');
  assert.equal(categoryForStatus(502), 'upstream_error');
  // 400 and 500 are genuine server/client errors, not one of the
  // named categories — must fall through to 'generic', not be
  // miscategorized as something more specific than they are.
  assert.equal(categoryForStatus(400), 'generic');
  assert.equal(categoryForStatus(500), 'generic');
});

test('sha256Hex — identical text always hashes identically, any real change hashes differently', async () => {
  const a = 'You are a document validator. Check invoices against Form M.';
  const aAgain = 'You are a document validator. Check invoices against Form M.';
  const b = 'You are a document validator. Check invoices against Form M!'; // one char different

  const hashA = await sha256Hex(a);
  const hashAAgain = await sha256Hex(aAgain);
  const hashB = await sha256Hex(b);

  assert.equal(hashA, hashAAgain, 'identical prompt text must hash identically (self-registration depends on this)');
  assert.notEqual(hashA, hashB, 'even a one-character prompt edit must hash differently (a real version change must never be missed)');
  assert.equal(hashA.length, 12);
});

test('sanitizeFilename — neutralizes traversal, shell metacharacters, and markup', () => {
  assert.equal(sanitizeFilename('invoice.pdf'), 'invoice.pdf');
  assert.equal(sanitizeFilename('../../../etc/passwd'), '.._.._.._etc_passwd');
  assert.ok(!sanitizeFilename('invoice; rm -rf / .pdf').includes(';'));
  assert.ok(!sanitizeFilename('<script>alert(1)</script>.pdf').includes('<'));
  assert.equal(sanitizeFilename(''), 'file', 'an empty name must fall back to something, never an empty storage path segment');
  // Truncation must keep the END of the string (the extension), not the start.
  const long = sanitizeFilename('a'.repeat(300) + '.pdf');
  assert.ok(long.endsWith('.pdf'));
  assert.ok(long.length <= 100);
});

test('detectRealType — real signatures pass, disguised/adversarial content is rejected', async () => {
  const real = {
    pdf: new Blob([new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj')]),
    jpeg: new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])]),
    png: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xd])]),
  };
  assert.equal(await detectRealType(real.pdf), 'application/pdf');
  assert.equal(await detectRealType(real.jpeg), 'image/jpeg');
  assert.equal(await detectRealType(real.png), 'image/png');

  const adversarial = {
    exeDisguisedAsPdf: new Blob([Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00])]), // MZ header
    plainTextClaimingPdf: new Blob([new TextEncoder().encode('Hello, not a real document.')]),
    htmlScriptClaimingPng: new Blob([new TextEncoder().encode('<html><script>alert(1)</script></html>')]),
    empty: new Blob([]),
  };
  assert.equal(await detectRealType(adversarial.exeDisguisedAsPdf), null, 'a renamed .exe must never be accepted regardless of claimed type');
  assert.equal(await detectRealType(adversarial.plainTextClaimingPdf), null);
  assert.equal(await detectRealType(adversarial.htmlScriptClaimingPng), null);
  assert.equal(await detectRealType(adversarial.empty), null);
});

test('formatSize — human-readable MB with one decimal', () => {
  assert.equal(formatSize(4 * 1024 * 1024), '4.0MB');
  assert.equal(formatSize(1.5 * 1024 * 1024), '1.5MB');
});