// ══════════════════════════════════════════════════════════
// ClearAI Pro — Public beta AI proxy
// Function name: claude-proxy (all lowercase — see the naming note
// at the bottom of this file before you deploy it)
//
// This replaces every browser-side call to api.anthropic.com. The
// real Anthropic key now lives ONLY here, as a secret, never sent to
// any browser. Every request must carry a valid invite code, and is
// rate-limited by IP regardless of the code, so a single visitor
// can't hammer this even with a legitimate code.
//
// OBSERVABILITY (added 2026-09-27): every response — success or
// failure — is logged to proxy_events, correlated with the client's
// telemetry via the SAME visitor_id/request_id js/telemetry.js and
// shell.js already send. This was previously assumed by comments in
// both those client files but never actually implemented here —
// closing that gap is the entire point of this revision. Logging
// NEVER blocks or can fail the actual response: it's fire-and-forget,
// wrapped in EdgeRuntime.waitUntil() so it still completes after the
// response is returned (Deno can tear down the isolate immediately
// after respond() otherwise, silently dropping unawaited writes).
// PRIVACY: mirrors js/telemetry.js's own rules — never logs document
// text, system/user prompt content, AI responses, or the invite code
// value itself (only its pass/fail outcome).
//
// PROMPT VERSIONING (added 2026-09-30): every call now hashes its own
// system prompt (SHA-256, first 12 hex chars) and self-registers that
// hash — paired with the full prompt text and model — in
// prompt_versions the first time it's ever seen. Every proxy_events row
// now carries that same hash plus the model string, so any logged
// result can be traced back to the EXACT prompt text that produced it,
// not just "a version, somewhere." prompt_versions is deliberately NOT
// covered by the data-retention cleanup function — it's the audit
// trail itself (a handful of rows, one per distinct prompt that's ever
// existed), not per-call operational noise like proxy_events is. Worth
// knowing: proxy_events rows DO still age out under the existing
// retention policy, so a specific call's full trace has the same
// lifespan as any other operational log — only the prompt text itself
// is kept indefinitely by default.
// ══════════════════════════════════════════════════════════

import { createClient } from 'jsr:@supabase/supabase-js@2'
// Shared with supplier-submission AND with the Node test suite — one
// definition, imported everywhere it's needed, so a test genuinely
// proves what runs in production rather than a hand-copied mirror of
// it. See _shared/validation.js's own header for why this works
// identically in Deno (here) and Node (the tests) with no build step.
import { sha256Hex, categoryForStatus } from '../_shared/validation.js'

// Named once, used both in the actual Anthropic call and in every
// prompt_versions/proxy_events row — so the logged model can never
// silently drift out of sync with what was actually used.
const MODEL = 'claude-sonnet-4-20250514'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Supabase's Edge Runtime keeps the isolate alive until any promise
// passed to waitUntil() settles, even after the response has already
// gone out. Without this, a fire-and-forget insert can be silently
// dropped when Deno tears the isolate down right after respond() —
// which would make this whole fix look like it works in testing and
// quietly lose events in production. Never let a logging failure
// affect the real request: always caught, never awaited by callers.
function background(promise: Promise<unknown>) {
  try {
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime
    if (rt && typeof rt.waitUntil === 'function') {
      rt.waitUntil(promise.catch(() => {}))
    } else {
      promise.catch(() => {})
    }
  } catch (_e) { /* observability must never break the proxy */ }
}

// import.meta.main is true only when this file is run as the actual
// entry point (i.e. in production, when Supabase deploys and invokes
// it) — false when another file `import`s it. sha256Hex/categoryForStatus
// now live in ../_shared/validation.js and are tested directly from
// there, but this guard stays regardless: it's what would let this
// file itself be imported later (e.g. to test `handler` directly)
// without that import having the side effect of starting a server.
if (import.meta.main) {
  Deno.serve(handler)
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Real client IP — Supabase's gateway populates this correctly,
  // confirmed directly against their own docs before building this.
  // Computed up front (doesn't depend on the body) so even the
  // earliest failure branches below can still be logged with it.
  const forwardedFor = req.headers.get('x-forwarded-for') || ''
  const ip = forwardedFor.split(',')[0].trim() || 'unknown'
  const t0 = Date.now()

  // requestId/tool/visitorId are filled in once the body is parsed
  // (may stay null for the earliest failures, e.g. a non-POST method
  // or a body that isn't valid JSON at all — nothing to correlate yet).
  let requestId: string | null = null
  let tool: string | null = null
  let visitorId: string | null = null
  // Filled in once `system` is parsed (see below) — stays null for the
  // earliest failures (bad method, unparseable body) where no prompt
  // was ever read, same pattern as requestId/tool/visitorId above.
  let promptVersion: string | null = null

  // Wraps json(): builds the response AND fires the proxy_events log
  // for this exact status/message, using whatever correlation fields
  // are known at the point this is called. Never awaited by the
  // caller — logging latency never adds to response latency.
  function respond(body: Record<string, unknown>, status = 200) {
    const category = categoryForStatus(status)
    const message = typeof body?.error === 'string' ? body.error.slice(0, 300) : null
    background(supabase.from('proxy_events').insert({
      visitor_id: visitorId,
      request_id: requestId,
      tool,
      ip_address: ip,
      status_code: status,
      category,
      message, // only ever the short, pre-scrubbed error string above — never document/prompt/response content
      latency_ms: Date.now() - t0,
      prompt_version: promptVersion,
      model: MODEL,
    }))
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

  // Tune these three numbers freely — this is the whole "how generous is
  // this beta" dial. Start conservative; it's easy to raise later.
  const MAX_REQUESTS_PER_IP_PER_HOUR = 15
  // Caps the COMBINED usage of one invite code across every IP using it —
  // the one thing per-IP limiting alone can't stop: if a single code
  // spreads further than intended (shared beyond who you gave it to),
  // this bounds the total damage from that one code, independent of how
  // many different people end up holding it.
  const MAX_REQUESTS_PER_CODE_PER_HOUR = 60
  const RATE_LIMIT_WINDOW_MINUTES = 60

  const body = await req.json().catch(() => null)
  if (!body) return respond({ error: 'Invalid request body' }, 400)

  const { inviteCode: rawInviteCode, system, userMsg, maxTokens, attachments } = body
  if (!rawInviteCode) return respond({ error: 'Missing invite code' }, 400)
  // Case/whitespace were never meant to be part of what makes a code
  // valid — a tester who mistypes "ClearPORT LAUNCH2026" as "clearport
  // launch2026" should not be told their code is invalid over that.
  // Normalize here, and everything downstream (lookup, usage logging,
  // rate-limit counting) uses this one canonical form consistently.
  // Stored codes are normalized the same way — see the companion
  // migration that lowercases existing invite_codes.code values and
  // adds a case-insensitive unique index so this can't drift back out
  // of sync as new codes get added.
  const inviteCode = String(rawInviteCode).trim().toLowerCase()
  if (!inviteCode) return respond({ error: 'Missing invite code' }, 400) // whitespace-only input
  // Correlation fields the client already sends (see shell.js) — now actually used.

  requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 100) : null
  tool = typeof body.tool === 'string' ? body.tool.slice(0, 100) : null
  visitorId = typeof body.visitorId === 'string' ? body.visitorId.slice(0, 100) : null

  if (!system || !userMsg) return respond({ error: 'Missing system or userMsg' }, 400)

  // Hash this exact prompt text and self-register it if it's new.
  // ON CONFLICT DO NOTHING (ignoreDuplicates) makes every call after
  // the first for a given prompt a cheap no-op — only an actual prompt
  // edit ever produces a new row here. Fire-and-forget like the
  // proxy_events logging above: a registration failure must never
  // block or fail the real request.
  promptVersion = await sha256Hex(system)
  background(supabase.from('prompt_versions').upsert(
    { hash: promptVersion, system_prompt: system, model: MODEL, first_seen_tool: tool },
    { onConflict: 'hash', ignoreDuplicates: true }
  ))

  // ── Check 1: is this invite code real, active, and under its cap? ──
  const { data: invite, error: inviteError } = await supabase
    .from('invite_codes')
    .select('code, active, max_total_uses, use_count')
    .eq('code', inviteCode)
    .single()

  if (inviteError || !invite) return respond({ error: 'Invalid invite code' }, 401)
  if (!invite.active) return respond({ error: 'This invite code is no longer active' }, 401)
  if (invite.max_total_uses !== null && invite.use_count >= invite.max_total_uses) {
    return respond({ error: 'This invite code has reached its usage limit' }, 403)
  }

  // ── Check 2: has this individual IP made too many requests recently? ──
  // (Applies regardless of invite code — protects against one visitor
  // hammering the proxy even with a legitimate code.)
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString()
  const { count, error: countError } = await supabase
    .from('proxy_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .gte('created_at', windowStart)

  if (countError) return respond({ error: 'Could not check rate limit' }, 500)
  if ((count ?? 0) >= MAX_REQUESTS_PER_IP_PER_HOUR) {
    return respond({ error: `Rate limit reached — max ${MAX_REQUESTS_PER_IP_PER_HOUR} requests per hour. Try again later.` }, 429)
  }

  // ── Check 3: has THIS CODE, combined across every IP using it, been
  // used too much recently? This is the one that actually matters if a
  // code leaks beyond its intended audience — Check 2 alone wouldn't
  // catch that, since each individual IP could still look fine.
  const { count: codeCount, error: codeCountError } = await supabase
    .from('proxy_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('invite_code', inviteCode)
    .gte('created_at', windowStart)

  if (codeCountError) return respond({ error: 'Could not check rate limit' }, 500)
  if ((codeCount ?? 0) >= MAX_REQUESTS_PER_CODE_PER_HOUR) {
    return respond({ error: 'This invite code is being used heavily right now — try again shortly.' }, 429)
  }

  // ── All checks passed — record usage, then actually call Claude ──
  await supabase.from('proxy_usage_log').insert({ ip_address: ip, invite_code: inviteCode })
  await supabase.from('invite_codes').update({ use_count: invite.use_count + 1 }).eq('code', inviteCode)

  let content: unknown = userMsg
  if (attachments && attachments.length) {
    content = attachments.map((att: { media_type: string; data: string }) => ({
      type: att.media_type === 'application/pdf' ? 'document' : 'image',
      source: { type: 'base64', media_type: att.media_type, data: att.data },
    }))
    ;(content as unknown[]).push({ type: 'text', text: userMsg })
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens || 1800,
        system,
        messages: [{ role: 'user', content }],
      }),
    })

    if (!anthropicRes.ok) {
      const e = await anthropicRes.json().catch(() => ({}))
      return respond({ error: e?.error?.message || `Claude API error ${anthropicRes.status}` }, 502)
    }

    const data = await anthropicRes.json()
    return respond(data, 200)
  } catch (err) {
    return respond({ error: `Proxy request failed: ${(err as Error).message}` }, 500)
  }
}

// ── NAMING NOTE — read before deploying ──
// When you create this function in the dashboard, the name field must
// read exactly: claude-proxy
// Copy-paste it rather than typing it — a single wrong capital letter
// here (exactly what happened with agent-Review earlier) will cause
// the same confusing CORS-looking failure, with zero entries in this
// function's own Logs tab, because the request never reaches this
// code at all if the name doesn't match exactly.