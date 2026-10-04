// Tests parseTierRange and costForDays directly from the REAL shipped
// pages/demurrage-calculator/demurrage-calculator.js — not a mirrored
// copy — via the VM loader (see tests/helpers/load-browser-script.mjs
// for why that's needed for a classic, non-module browser script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserScript } from './helpers/load-browser-script.mjs';

const scriptPath = new URL('../pages/demurrage-calculator/demurrage-calculator.js', import.meta.url);
const { parseTierRange, costForDays } = loadBrowserScript(scriptPath);

// Checks fields directly rather than whole-object deep-equal: the
// function runs inside a VM sandbox (see load-browser-script.mjs), so
// its returned objects belong to that sandbox's own realm — a strict
// deep-equal against a plain object literal here would fail on
// prototype identity alone, which has nothing to do with whether the
// actual values are correct.
function assertRange(result, start, end) {
  assert.equal(result.start, start);
  assert.equal(result.end, end);
}

test('parseTierRange — closed ranges, open-ended tiers, and dash variants', () => {
  assertRange(parseTierRange('1 – 4'), 1, 4); // en dash, spaces
  assertRange(parseTierRange('6-10'), 6, 10); // hyphen, no spaces
  assertRange(parseTierRange('11+'), 11, Infinity);
  assertRange(parseTierRange('11 +'), 11, Infinity); // space before +
});

test('parseTierRange — unparseable input returns null, never throws or guesses', () => {
  assert.equal(parseTierRange(''), null);
  assert.equal(parseTierRange('weird label'), null);
  assert.equal(parseTierRange(null), null);
  assert.equal(parseTierRange(undefined), null);
});

test('costForDays — matches the exact worked example from the original bug report', () => {
  // 1–4 days → ₦100,000 | 5–9 days → ₦150,000 | 10+ → ₦200,000, 1 container.
  // This is the precise example that proved the old hardcoded
  // daysPerTierGuess=5 logic was under-billing real money.
  const tiers = [
    { rate: 100000, range: parseTierRange('1 – 4') },
    { rate: 150000, range: parseTierRange('5 – 9') },
    { rate: 200000, range: parseTierRange('10+') },
  ];
  assert.equal(costForDays(4, tiers, 1), 400000);
  assert.equal(costForDays(9, tiers, 1), 1150000, '9 days must be 1,150,000 — the old buggy uniform-5-day-bucket logic gave 1,100,000, underbilling by ₦50,000');
  assert.equal(costForDays(15, tiers, 1), 2350000);
});

test('costForDays — a tier with an unparseable label falls back safely, never throws', () => {
  const tiers = [
    { rate: 100000, range: null }, // label failed to parse
    { rate: 200000, range: parseTierRange('10+') },
  ];
  // Must not throw, and must still produce a sane (non-negative, finite) number.
  const cost = costForDays(12, tiers, 1);
  assert.ok(Number.isFinite(cost) && cost > 0);
});

test('costForDays — scales linearly with container count', () => {
  const tiers = [{ rate: 100000, range: parseTierRange('1+') }];
  assert.equal(costForDays(5, tiers, 3), costForDays(5, tiers, 1) * 3);
});