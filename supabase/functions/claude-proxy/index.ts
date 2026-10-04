// ══════════════════════════════════════════════════════════
// ClearAI Pro — Supplier Portal backend
// STAGE 2: The gatekeeper function
//
// Deploy this via: Supabase Dashboard → Edge Functions →
// "Deploy a new function" → "Via Editor" → name it
// "supplier-submission" → paste this in → Deploy.
//
// It does the ONE job Stage 1 deliberately left undone: checking
// whether a token is real, unexpired, and not already used — before
// anything is allowed to read a submission or write a file. Every
// other piece of the app (the public upload page in Stage 3, the
// "Generate Link" button in Stage 4) talks to Supabase THROUGH this
// function, never directly — so all the validation logic lives in
// one place you can read top to bottom, not scattered across policy
// expressions.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY below are injected
// automatically by Supabase for every deployed Edge Function — you
// do not need to paste your service_role key anywhere yourself. That
// key bypasses Row Level Security entirely, which is exactly why it
// only ever lives here, server-side, and never in the browser.
//
// Two things this function does, based on the HTTP method used:
//   GET  ?token=xxx        → "is this link valid? if so, what's it for?"
//                             (used by Stage 3's page when it first loads)
//   POST (token + files)   → "here are the documents" — validates
//                             again, uploads to Storage, records the
//                             documents rows, marks the submission
//                             'submitted'
//
// FILE UPLOAD HARDENING (added 2026-09-29): the original version here
// only checked the client-DECLARED file.type — a string any non-browser
// caller (curl, a tampered page) can set to whatever it wants regardless
// of the file's real content. That check is now backed by real content
// inspection (magic-byte signature checking), a genuinely enforced size
// cap (the old supplierlink.js one only warned, never blocked — see
// PROJECT_STATUS_CLEARPORT.md), and a few adjacent tightenings found
// while touching this file: sanitized storage filenames and generic
// client-facing errors (full detail still goes to console.error, for
// the Edge Function's own Logs tab — just not to the public caller).
// This is NOT virus/malware signature scanning (ClamAV-style) — that
// was deliberately deferred as a separate decision, since it means
// sending suppliers' commercial documents to a third-party scanning
// service, which is a real trade-off worth making knowingly rather
// than inheriting from a checklist.
// ══════════════════════════════════════════════════════════

import { createClient } from 'jsr:@supabase/supabase-js@2'
// Shared with claude-proxy AND with the Node test suite — one
// definition of this logic, imported everywhere, not a hand-copied
// mirror of it. See _shared/validation.js's own header for why this
// works identically in Deno (here) and Node (the tests).
import { detectRealType, sanitizeFilename, formatSize } from '../_shared/validation.js'

// Loosened for now so you can test this before Stage 3's page exists.
// Once app.html/index.html are live on your real domain, narrow this
// to that exact domain instead of '*'.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ── Upload limits ──
// Mirrors the number shown to suppliers in supplierlink.js — keep the
// two in sync if you ever change one. Unlike that one, THIS is real
// enforcement: the old client-side "check" only showed a warning and
// still let an oversized file submit.
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024 // 4MB per file
// Invoice + packing list combined, per submission. Nothing enforced
// this before at all — a single submission's total storage footprint
// was previously unbounded.
const MAX_AGGREGATE_SIZE_BYTES = 8 * 1024 * 1024

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
type AllowedType = typeof ALLOWED_TYPES[number]

// import.meta.main is true only when this file is run as the actual
// entry point (production, when Supabase invokes it) — false if
// another file imports it instead. detectRealType/sanitizeFilename/
// formatSize now live in ../_shared/validation.js and are tested
// directly from there, but this guard stays regardless: it's what
// would let this file itself be imported later without that import
// having the side effect of starting a server.
if (import.meta.main) {
  Deno.serve(handler)
}

async function handler(req: Request): Promise<Response> {
  // Browsers send a pre-flight OPTIONS request before the real one —
  // this just says "yes, you're allowed to ask."
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // ── GET: "is this link valid, and what's it asking for?" ──
  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token')
    if (!token) return json({ error: 'Missing token' }, 400)

    const { data: submission, error } = await supabase
      .from('submissions')
      .select('agent_name, supplier_name, ref, port, status, expires_at')
      .eq('token', token)
      .single()

    if (error || !submission) return json({ error: 'Link not found' }, 404)
    if (new Date(submission.expires_at) < new Date()) {
      return json({ error: 'This link has expired' }, 410)
    }
    if (submission.status !== 'pending') {
      return json({ error: 'Documents were already submitted for this link' }, 409)
    }

    // Only the fields the public page actually needs to display —
    // deliberately not the whole row.
    return json({
      agent_name: submission.agent_name,
      supplier_name: submission.supplier_name,
      ref: submission.ref,
      port: submission.port,
    })
  }

  // ── POST: "here are the documents" ──
  if (req.method === 'POST') {
    const formData = await req.formData()
    const token = formData.get('token') as string | null
    if (!token) return json({ error: 'Missing token' }, 400)

    // Re-validate — never trust that the GET check earlier still
    // holds true; the link could have expired or been used in between.
    // Also pulling agent_email/ref/agent_name now — needed below to
    // send the "a supplier just submitted" notification.
    const { data: submission, error: subError } = await supabase
      .from('submissions')
      .select('id, status, expires_at, agent_email, agent_name, ref')
      .eq('token', token)
      .single()

    if (subError || !submission) return json({ error: 'Link not found' }, 404)
    if (new Date(submission.expires_at) < new Date()) return json({ error: 'Link expired' }, 410)
    if (submission.status !== 'pending') return json({ error: 'Already submitted' }, 409)

    const invoiceFile = formData.get('invoice') as File | null
    const packingFile = formData.get('packing_list') as File | null
    if (!invoiceFile && !packingFile) return json({ error: 'No files were attached' }, 400)

    const presentFiles = [invoiceFile, packingFile].filter((f): f is File => !!f)

    // ── Size: per-file, then aggregate. Real rejection, not a warning. ──
    for (const file of presentFiles) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        return json({ error: `"${file.name}" is ${formatSize(file.size)}, which is over the ${formatSize(MAX_FILE_SIZE_BYTES)} limit per file. Please compress it or split it up.` }, 413)
      }
    }
    const totalSize = presentFiles.reduce((sum, f) => sum + f.size, 0)
    if (totalSize > MAX_AGGREGATE_SIZE_BYTES) {
      return json({ error: `Your files total ${formatSize(totalSize)}, which is over the ${formatSize(MAX_AGGREGATE_SIZE_BYTES)} combined limit. Please compress them or submit separately.` }, 413)
    }

    // ── Content: verify actual file bytes, not the caller's claimed
    // type. This is real content inspection, replacing the old check
    // that only compared file.type (a client-controlled label) against
    // ALLOWED_TYPES — a direct API call could set that label to
    // anything regardless of what the file actually contained.
    const detectedTypes = new Map<File, AllowedType>()
    for (const file of presentFiles) {
      const realType = await detectRealType(file)
      if (!realType) {
        return json({ error: `"${file.name}" doesn't look like a valid PDF, JPG, or PNG — please check the file and try again.` }, 400)
      }
      detectedTypes.set(file, realType)
    }

    const uploaded: { type: string; path: string }[] = []

    for (const [fileType, file] of [
      ['invoice', invoiceFile],
      ['packing_list', packingFile],
    ] as const) {
      if (!file) continue
      // Use the VERIFIED type from content inspection for both the
      // storage path's extension hint and the stored contentType
      // metadata — never the caller's claimed file.type. Serving a
      // file later with an attacker-chosen Content-Type is its own
      // risk (e.g. a payload mislabeled to render as HTML); this way
      // storage only ever records what the bytes actually are.
      const realType = detectedTypes.get(file)!
      const path = `${submission.id}/${fileType}-${Date.now()}-${sanitizeFilename(file.name)}`
      const { error: uploadError } = await supabase.storage
        .from('supplier-documents')
        .upload(path, file, { contentType: realType })
      if (uploadError) {
        // Full detail server-side only (Edge Function Logs tab) — the
        // public caller gets a safe, generic message. The previous
        // version returned uploadError.message directly, which could
        // hand an anonymous caller internal bucket/path/policy detail
        // for no benefit to a legitimate supplier.
        console.error('Storage upload failed:', uploadError)
        return json({ error: 'Upload failed — please try again.' }, 500)
      }
      uploaded.push({ type: fileType, path })
    }

    const rows = uploaded.map((u) => ({
      submission_id: submission.id,
      file_path: u.path,
      file_type: u.type,
    }))
    const { error: docError } = await supabase.from('documents').insert(rows)
    if (docError) {
      console.error('Could not record documents row:', docError)
      return json({ error: 'Upload failed — please try again.' }, 500)
    }

    await supabase.from('submissions').update({ status: 'submitted' }).eq('id', submission.id)

    // Notify the agent, if we have an email to notify. Deliberately
    // wrapped so a failed/misconfigured email never fails the upload
    // itself — the supplier's files are already safely stored by this
    // point, and that success shouldn't hinge on notification delivery.
    if (submission.agent_email) {
      try {
        const resendKey = Deno.env.get('RESEND_API_KEY')
        if (resendKey) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              // Sandbox sender — only reaches the email address you
              // signed up to Resend with. Swap to your own verified
              // domain (e.g. notify@clearai.pro) once you have one,
              // so this can actually notify other agents in production.
              from: 'ClearAI Pro <onboarding@resend.dev>',
              to: [submission.agent_email],
              subject: `Documents submitted for ${submission.ref}`,
              html: `<p>Your supplier just submitted documents for <b>${submission.ref}</b>${submission.agent_name ? ` (${submission.agent_name})` : ''}.</p><p>Open ClearAI Pro's Pre-Shipment Check to review them.</p>`,
            }),
          })
        } else {
          console.error('RESEND_API_KEY secret not set — skipping notification email')
        }
      } catch (emailErr) {
        console.error('Notification email failed:', emailErr)
      }
    }

    return json({ success: true, uploaded: uploaded.length })
  }

  return json({ error: 'Method not allowed' }, 405)
}