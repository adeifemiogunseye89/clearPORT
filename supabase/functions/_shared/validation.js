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