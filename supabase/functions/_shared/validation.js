// ══════════════════════════════════════════════════════════
// ClearAI Pro — shared pure-logic helpers
//
// Plain JavaScript, zero dependencies, zero Deno-specific or
// Node-specific globals — deliberately so this ONE file can be
// imported both by the Edge Functions (Deno, via relative import) and
// by the test suite (Node, via the same relative import) with no
// build step, no transpilation, no TypeScript tooling required in
// either runtime. This is the single source of truth for this logic —
// claude-proxy and supplier-submission import FROM here rather than
// each defining their own copy, which is what let a real mismatch
// (the 403 regex that didn't match its own target text) go unnoticed
// earlier in this project's life. One copy, tested directly, used
// everywhere it's needed.
// ══════════════════════════════════════════════════════════

// ── Used by claude-proxy ──

// Verified status/message contract — see claude-proxy's own header
// comment for the full reasoning on why 403 means exactly one thing,
// why no error_code field exists, etc.
export function categoryForStatus(status) {
  switch (status) {
    case 200: return 'ok'
    case 401: return 'invalid_code'
    case 403: return 'code_exhausted'
    case 429: return 'rate_limited'
    case 502: return 'upstream_error'
    default: return 'generic'
  }
}

// SHA-256 of the given text, truncated to 12 hex chars. Used to
// fingerprint a system prompt for the prompt_versions audit trail.
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

// ── Used by supplier-submission ──

// Storage paths previously embedded the caller-controlled file.name
// verbatim. Strips anything that isn't alphanumeric/dot/dash/underscore,
// and caps length (keeping the END of the string, so the extension
// survives truncation).
export function sanitizeFilename(name) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
  return cleaned || 'file'
}

// Real content inspection — reads only the first 1024 bytes and checks
// actual format signatures, ignoring whatever Content-Type the caller
// claims. Accepts any object with a Blob-like .slice().arrayBuffer()
// (a real browser/Deno File, or a plain Blob in tests).
export async function detectRealType(file) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer())

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length >= 8 && PNG_SIG.every((b, i) => head[i] === b)) return 'image/png'

  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'

  const PDF_MARKER = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
  for (let i = 0; i <= head.length - PDF_MARKER.length; i++) {
    if (PDF_MARKER.every((b, j) => head[i + j] === b)) return 'application/pdf'
  }

  return null
}

export function formatSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

// Extracts the text block from an Anthropic Messages API response and
// parses it as JSON, after stripping markdown code fences (models
// sometimes wrap structured output in them despite instructions not
// to). Moved here from the CLIENT deliberately — this is what lets
// claude-proxy confirm a response is actually usable BEFORE charging
// the caller's quota for it, rather than charging for any 200 from
// Anthropic regardless of whether the content inside it was usable.
// Returns { error: false, parsed } on success, or
// { error: true, reason } on failure — reason is one of
// 'no_text_block' | 'truncated' | 'invalid_json', so the caller can
// give a specific, honest explanation instead of one generic message
// for every different cause. 'truncated' specifically means Anthropic
// itself reported stop_reason === 'max_tokens' — the response was cut
// off before finishing, not just malformed.
export function parseClaudeJSON(anthropicResponse) {
  const textBlock = anthropicResponse?.content?.find((b) => b && b.type === 'text')
  if (!textBlock || typeof textBlock.text !== 'string') {
    return { error: true, reason: 'no_text_block' }
  }
  const cleaned = textBlock.text.replace(/```json|```/g, '').trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch (_e) {
    if (anthropicResponse?.stop_reason === 'max_tokens') return { error: true, reason: 'truncated' }
    return { error: true, reason: 'invalid_json' }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { error: true, reason: 'invalid_json' }
  }
  return { error: false, parsed }
}

// ── Used by claude-proxy (create_submission) and supplier-submission ──

// Server-side HTML escaping for text that goes into an email body.
// The browser has the DOM for this (escapeHtml in js/shell.js); Deno
// doesn't, so this is the string-level equivalent. Needed because the
// notification email interpolates submission.ref / agent_name — values
// originally typed by whoever generated the link.
export function escapeHtmlString(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Cleans and bounds the fields for a new supplier link. Until now there
// was no server-side validation at all — the browser inserted straight
// into the table, so lengths and content were whatever the caller sent.
// Control characters (newlines etc.) are replaced with spaces: these
// values end up in an email subject line, where a newline is a
// header-injection risk. Returns { value } or { error }.
export function cleanSubmissionInput(input) {
  // Matching control characters is the whole point of this regex, so the
  // no-control-regex rule (which exists to catch them by ACCIDENT) is off here.
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g
  const field = (v, max) =>
    typeof v === 'string' ? v.replace(CONTROL_CHARS, ' ').trim().slice(0, max) : ''

  const agent_name = field(input?.agent, 120)
  const agent_email = field(input?.agentEmail, 254)
  const supplier_name = field(input?.supplier, 120)
  const ref = field(input?.ref, 80)
  const port = field(input?.port, 80)

  if (!agent_name) return { error: 'Your name is required.' }
  if (!ref) return { error: 'A shipment reference is required.' }
  if (agent_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(agent_email)) {
    return { error: "That email address doesn't look valid." }
  }
  return {
    value: {
      agent_name,
      agent_email: agent_email || null,
      supplier_name: supplier_name || null,
      ref,
      port: port || null,
    },
  }
}
