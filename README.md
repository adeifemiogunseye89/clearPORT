# ClearAI Pro (clearPORT)

Pre-submission document intelligence for Nigerian port clearance —
helps shippers/agents catch document errors before they hit the
National Single Window, rather than replacing NSW itself. Deliberately
plain HTML/CSS/JS on the frontend (no build step), with a Supabase
backend fronting the Anthropic API.

**If you're picking this project up for the first time:** read this
file top to bottom before editing anything. The architecture changed
significantly partway through this project's life (see "The proxy
pivot" below), and the response contract between proxy and client
changed again more recently (see "What claude-proxy guarantees now")
— some instincts from a typical frontend-only app, or from this
project's own earlier commits, don't apply here anymore.

## What this is, in one diagram

```
Browser (you)
  │
  ├─ index.html / app.html / pages/*       — static, no build step
  │     │
  │     └─ js/shell.js's callClaude() ──────┐
  │                                         │
  └─ supplierlink.html (public, no nav) ────┤
                                             ▼
                              Supabase Edge Functions (Deno)
                              ├─ claude-proxy           — gatekeeper + AI call + response validation
                              ├─ supplier-submission     — file upload gatekeeper
                              └─ cleanup-expired-data     — scheduled retention purge
                                             │
                                             ▼
                              Supabase Postgres + Storage
                              (invite_codes, submissions, documents,
                               proxy_usage_log, client_events,
                               proxy_events, prompt_versions)
                                             │
                                             ▼
                                    api.anthropic.com
                         (real API key lives ONLY in claude-proxy)
```

## The proxy pivot — read this if anything below seems unfamiliar

Earlier in this project's life, each browser brought its own Anthropic
API key (pasted into an input, stored in `localStorage`, sent directly
to `api.anthropic.com`). **That model is gone.** The app is now in
public trial, gated by invite codes, with the real API key held
server-side only:

- The browser never talks to `api.anthropic.com` directly. Every AI
  call goes through `js/shell.js`'s `callClaude()`, which POSTs to the
  `claude-proxy` Edge Function.
- `claude-proxy` checks the invite code (real? active? under its usage
  cap? within its trial window?), checks two separate rate limits
  (per-IP and per-code, both hourly), and only then calls Anthropic
  using a key that exists only as a Supabase secret.
- What used to be an "API key" input in the UI is now an **invite
  code** input. Same spot in the UI, completely different meaning —
  don't confuse the two if you're reading older notes or commits.

If you're looking for where the key itself is configured: it isn't,
anywhere in this repo. It's a Supabase secret (`ANTHROPIC_API_KEY`),
set via the dashboard, never committed, never sent to a browser.

## What claude-proxy guarantees now — a second contract change, more recent than the first

As of the invite-code quota work, the proxy does more than gatekeep —
it also **validates Claude's own output before ever charging for it**:

- `claude-proxy` parses, fence-strips, and validates the AI's JSON
  response itself (`parseClaudeJSON()` in `_shared/validation.js`) —
  the client (`js/shell.js`) no longer does any of that. What
  `callClaude()` receives back on success is already a clean, real
  object — not Anthropic's raw Messages API envelope.
- **A malformed or truncated AI response is a typed 502
  (`upstream_error`), not a 200 the client has to untangle.**
  Specifically: if Anthropic's own `stop_reason` says `max_tokens`,
  the error message says so plainly ("too long and got cut off")
  instead of a generic parse-failure message.
- This exists specifically so a user's trial quota is never spent on
  a response they couldn't actually use — see the quota model below.
  "Success" now means *a usable result*, not just *Anthropic returned
  HTTP 200*.

If you're editing a tool page and wondering why there's no
`JSON.parse`/fence-stripping in `callClaude()` anymore: this is why —
it moved server-side on purpose, it wasn't accidentally lost.

## The trial / quota model

Built for public trial launch, grounded in real Claude Sonnet 4
pricing ($3/M input tokens, $15/M output — roughly $0.01–0.03 per call
for this app's actual call shape):

- **25 successful checks per invite code**, by default
  (`invite_codes.max_total_uses`, now `NOT NULL` — a code can no
  longer be created with unlimited uses by accident).
- **14-day trial window, starting from the code's first successful
  use** (`invite_codes.first_used_at`), not from when the code was
  created — a code sitting unused in someone's inbox hasn't burned any
  of its own trial window. `TRIAL_DAYS` in `claude-proxy`.
- **Quota is only spent on confirmed success** — not on an invalid
  code, not on a rate-limited request, not on an Anthropic-side
  failure, and (since the response-validation work above) not on a
  response that came back malformed or truncated either. Contrast
  with `proxy_usage_log`, which logs every *attempt* regardless of
  outcome — that's deliberate, it's the abuse/burst-protection signal,
  a different concern from quota fairness.
- **Per-code hourly rate limit is 20** (lowered from an earlier 60 —
  60 was tuned as a generic anti-abuse ceiling before this trial model
  existed; nobody legitimately evaluating the product needs to burn
  most of a 25-use trial in one hour).
- Every successful response carries `X-Quota-Remaining`/`X-Quota-Max`
  headers; `js/shell.js` reads them and updates the persistent
  "✓ Connected — N of 25 checks left" status text — a soft, always-
  visible warning rather than a surprise hard wall.

**Connect checks the code for real.** Pressing Connect calls
`claude-proxy` with `action: 'validate'` — same code checks as a real
call (exists? active? under its cap? inside its window?), but it never
calls Claude, never spends quota, and writes no `proxy_usage_log` row.
The UI only says "✓ Connected — N of 25 checks left" if the server
agrees; a stored code is also quietly re-checked on page load. Only a
*definitive* rejection (invalid / used up / expired) clears a saved
code — being offline or throttled changes nothing, so a flaky
connection never logs anyone out. This is feedback, not a security
gate: every real AI call still runs the full checks regardless.
Validate and link-creation calls show up in `proxy_events` with
`tool = 'connect'` / `'create-submission'` — filter those out when
counting real AI usage.

**Supplier links are behind the invite code too.** `claude-proxy` has a
third action, `create_submission`, which generates a supplier upload
link: same code checks and wrong-guess throttle as everything else, the
token is generated server-side, the details are length-capped and
cleaned (`cleanSubmissionInput()` in `_shared/validation.js`), and each
link records which invite code created it (`submissions.invite_code`).
One code can create at most **20 links**. Before this, the browser
inserted into `submissions` directly using only the public key, so
anyone could create links — with any `agent_email` — without a code.
That direct insert is gone from the client, **and the `anyone can
create submission` RLS policy must be dropped** (see the migrations
below), otherwise the gate can still be bypassed by calling the REST
endpoint directly.

**Wrong-code guesses are throttled.** More than 10 invalid-code
responses from one IP in 15 minutes returns a 429 (`Check 0` in
`claude-proxy`). Before this existed, a wrong guess never created a
`proxy_usage_log` row and so was never rate-limited by anything — the
validate action would otherwise have made code-guessing cheap. It is a
soft throttle (fails open on a counting error; `proxy_events` is
written fire-and-forget, so a burst of parallel requests can slip past
before earlier ones are logged). Worth watching once real users
arrive: mobile carriers often put many subscribers behind one shared
IP, and the per-IP limits (this one and the 15 AI calls/hour one) are
per-IP, not per-person.

**Before creating trial codes in bulk:** check for any existing code
with a `NULL` `max_total_uses` before running the quota migration —
it backfills nulls to 25, which may not be right for every existing
code (see that migration file's own comment).

## Security model

Several things worth knowing before assuming this is "just" a thin
proxy:

- **Invite codes are case-insensitive.** `claude-proxy` normalizes
  (`trim().toLowerCase()`) before checking, and stored codes are kept
  normalized the same way — a tester mistyping the case of an
  otherwise-valid code isn't told it's invalid.
- **File uploads are verified by content, not by label.**
  `supplier-submission` reads the first 1KB of every uploaded file and
  checks real format signatures (PDF/JPEG/PNG magic bytes) — it does
  not trust the browser-reported MIME type, which is trivially spoofed
  from outside a browser. Size is enforced server-side too (4MB/file,
  8MB aggregate per submission) — not just a client-side warning.
- **Every AI-derived value rendered into the DOM is escaped.** All
  four AI-calling pages (`doc-validation`, `hs-classifier`,
  `advance-ruling`, `pre-shipment-check`) run Claude's JSON response
  fields through `escapeHtml()` (in `js/shell.js`) before building
  `innerHTML` — closing a real unescaped-injection path that existed
  specifically because this app's CSP still allows `'unsafe-inline'`
  (true today; migrating the ~100+ inline `onclick=`/`style=`
  attributes off that is a larger, separate refactor, not yet done).
- **Storage filenames are sanitized**, not stored verbatim from the
  upload — see `sanitizeFilename()` in
  `supabase/functions/_shared/validation.js`.
- **Data isn't kept forever.** `cleanup-expired-data` runs daily
  (`pg_cron`), deleting supplier documents + their Storage objects
  after 90 days, and operational logs after 60/30 days. See that
  function's own header comment for the exact windows and the
  reasoning — these are defaults to confirm against an actual policy,
  not a legal determination.
- **A trial code can no longer cost you an unbounded amount** — see
  the trial/quota model above. This is a cost control as much as a
  security one.

None of this is a claim of formal compliance (NDPA or otherwise) —
it's the technical foundation that supports making that case, not the
case itself.

## Observability — if something goes wrong in production

Three tables, each answering a different question:

- **`client_events`** — browser-side failures (JS errors, timeouts,
  network drops), written by `js/telemetry.js`. Never contains
  document/prompt content.
- **`proxy_events`** — every `claude-proxy` call, success or failure,
  tagged with a `category` (`ok` / `invalid_code` / `code_exhausted` /
  `rate_limited` / `upstream_error` / `generic`), plus `prompt_version`
  and `model`. A malformed/truncated AI response now shows up here as
  `upstream_error`, same as any other upstream problem.
- **`prompt_versions`** — self-registering: the first time a given
  system prompt's exact text is seen, it's recorded here (hash → full
  text + model). Every `proxy_events` row's `prompt_version` joins back
  to this, so any logged result traces to the exact prompt that
  produced it. Deliberately **not** covered by the retention cleanup —
  this is the audit trail itself, not per-call noise.

```sql
-- "what prompt produced this specific result?"
select pe.created_at, pe.tool, pe.category, pv.system_prompt
from proxy_events pe join prompt_versions pv on pv.hash = pe.prompt_version
order by pe.created_at desc limit 20;
```

## Offline support

A real, working service worker (`sw.js`) precaches the app shell and
specifically the **Demurrage Calculator** — the one tool with zero
network dependency (verified: no `fetch`/`callClaude` anywhere in its
code). Every other tool needs a live connection and is deliberately
*not* precached, so it doesn't falsely appear to load while offline
and then fail the moment you click Analyze. `app.html` shows a banner
when offline; `navTo()` in `js/shell.js` gives an honest
connection-specific error if you click a live tool anyway.

## Folder layout

```
index.html                    — landing page (standalone, static)
app.html                      — app shell: nav, invite-code bar, router mount point
supplierlink.html             — standalone public upload page (no nav/shell — suppliers use this directly)
manifest.json, sw.js, icons/  — PWA / offline support

css/
  tokens.css, landing.css, shell.css, components.css

js/
  shell.js                    — router, invite-code state, callClaude(),
                                 escapeHtml(), classifyProxyError(), offline banner,
                                 quota display (reads X-Quota-* headers)
  supplierlink.js              — supplierlink.html's own logic (standalone, own SUPABASE_URL)
  telemetry.js                 — client_events reporting
  landing.js                   — index.html-only scroll effects
  supplier-portal.js           — byte-identical duplicate of pages/supplier-portal/
                                 supplier-portal.js — flagged repo clutter, not yet deleted

pages/<page-name>/
  <page-name>.html/.css/.js    — one tool's content, styles, logic + initX() the router calls

supabase/
  functions/
    claude-proxy/index.ts         — THE invite-code–gated entry point: AI calls, plus the
                                      'validate' and 'create_submission' actions. Rate limits,
                                      quota/trial enforcement, wrong-guess throttle,
                                      AI response parsing + validation, logging
    supplier-submission/index.ts  — the file-upload gatekeeper (content verification, size limits)
    _shared/validation.js          — pure logic BOTH functions import from (one source of truth) —
                                      also what tests/validation.test.js tests directly.
                                      Includes parseClaudeJSON(), the AI-response validator.
  migrations/                      — DOES NOT EXIST AS A TRACKED FOLDER YET. Every SQL change so
                                      far (observability tables, invite-code casing, prompt
                                      versioning, retention cleanup schedule, quota/trial model, failed-attempt
                                      throttle index, submission gating: add submissions.invite_code, THEN
                                      drop the anon insert policy — in that order)
                                      was run by hand via the SQL Editor — real gap, not yet
                                      closed. See "Known gaps" below.

tests/                          — node --test suite (see "Testing" below)
.github/workflows/ci.yml        — lint + test, runs on every push/PR
eslint.config.js, package.json  — CI tooling config

legacy/
  ops-report-UNUSED.css/.js     — dead code, not loaded anywhere

vitest.config.js                — STALE. Not the actual test runner (node --test is) —
                                   safe to delete, kept only because no one has yet.
preview-ruling-verdicts.html    — dev-only style preview, not part of the app flow.
```

Seven tool pages: `doc-validation`, `hs-classifier`, `coming-soon`,
`pre-shipment-check`, `supplier-portal`, `demurrage-calculator`,
`advance-ruling`.

## How to run it locally

```
python3 -m http.server 8000
```

then open `http://localhost:8000/index.html`. Any static server works
(VS Code's "Live Server", `npx serve`, etc.). `app.html` genuinely
needs this — it loads each tool page's fragment via `fetch()`, which
browsers block against `file://` paths.

The frontend talks to whatever Supabase project `SUPABASE_URL`/
`SUPABASE_ANON_KEY` in `js/shell.js` point at — there's no separate
local backend to run. To test against a real invite code, you need one
that actually exists in that project's `invite_codes` table, with
`max_total_uses` and `use_count` both set sensibly (it's `NOT NULL`
now — see the trial/quota model above).

## Testing

```
npm install
npm run lint     # ESLint — 0 errors expected; ~40 warnings are known/explained, see eslint.config.js
npm test         # node --test — 25 tests, all pure-logic (no network, no DOM except where stubbed)
```

What's actually tested, and how, matters here: `tests/validation.test.js`
imports `supabase/functions/_shared/validation.js` directly — a real
ES module import, testing the exact file both Edge Functions use,
including `parseClaudeJSON()` against real Anthropic response shapes
(clean JSON, fenced JSON, truncated, malformed, missing text block).
`tests/demurrage-calculator.test.js` and `tests/shell.test.js` test
`pages/demurrage-calculator/demurrage-calculator.js` and `js/shell.js`
themselves — plain `<script>`-style browser files, loaded into a
sandboxed Node `vm` context (see `tests/helpers/load-browser-script.mjs`)
rather than a hand-copied mirror of their logic. A passing test is a
direct guarantee about the real shipped file, not a parallel copy that
can silently drift out of sync with it.

CI (`.github/workflows/ci.yml`) runs both on every push and PR.

## Deploying a change

**Edge Functions** (`claude-proxy`, `supplier-submission`): via the
Supabase dashboard (Edge Functions → pick one → Code → replace →
Deploy) or the CLI (`supabase functions deploy <name>`). Either way,
`_shared/validation.js` must exist in the same deploy — both functions
import from it. If you're using the dashboard's multi-file editor,
**add `_shared/validation.js` first, then edit `index.ts` separately**
— replacing a function's entire code in one paste can drop the
dashboard's tracking of the separately-added shared file, causing a
"Module not found .../_shared/validation.js" bundling error on
deploy. Always check the function's **Logs** tab right after
deploying, and do one real sanity-check in the live app — a deploy
reporting "success" has still, in this project's actual history, left
a broken import behind silently.

**SQL changes:** run by hand in the SQL Editor for now (see "Known
gaps" below for why this isn't ideal).

**Frontend files:** no build step — edit, commit, push. If the GitHub
repo's Supabase integration is connected, pushes can also auto-deploy
functions/migrations; confirm current status in the dashboard before
assuming that's live.

## Known gaps — real, not hidden

- **Supplier-notification email recipient is still self-declared.**
  `agent_email` is whatever the link's creator typed, and
  `supplier-submission` emails it. Contained today — links now need an
  invite code, one code makes at most 20, the email body is escaped,
  and the Resend sandbox sender reportedly only reaches the account
  owner — but **when a sending domain is verified**, decide whether to
  send only to an address tied to the invite code rather than any typed
  one.
- **`claude-proxy` trusts caller-supplied cost parameters.**
  `maxTokens`, `system`, `userMsg` and `attachments` have no server-side
  caps (attachments: no count limit, no size limit, no media-type
  allowlist). The "≤ ~$0.50 per code" figure assumes normal calls; a
  holder of a valid code could send far larger ones. Caps are the fix;
  moving the system prompts server-side (keyed by `tool`) would remove
  the "any code is a general-purpose Claude relay" property entirely.
- **`use_count` is read-then-written, not atomic.** Concurrent requests
  on one code can overshoot `max_total_uses` slightly (bounded in
  practice by the per-code hourly limit). The exact fix is to reserve a
  slot atomically before calling Claude and refund it on failure, which
  needs a small Postgres function.
- **CORS is `*` on the Edge Functions.** Low real impact (no cookies;
  auth is the code in the body; `curl` ignores CORS) — lock it to the
  real origin once the hostname is final, mainly as hygiene.
- **Two unescaped render paths remain** (neither reachable from AI
  output): the tier-label warning in `demurrage-calculator.js` (the
  user's own typed text) and `renderError()` in `supplierlink.js`
  (every current caller passes a fixed string, but the helper itself
  doesn't escape).

- **No `supabase/migrations/` yet.** Every schema change this project
  has made exists only as whatever's currently live in the dashboard —
  not version-controlled, not reviewable in a PR. `supabase db pull`
  would capture current state as a starting point.
- **`js/supplier-portal.js` is a byte-identical duplicate** of
  `pages/supplier-portal/supplier-portal.js` — confirmed clutter, safe
  to delete once confirmed nothing references the root-level copy.
- **`supplier-portal.js`'s preview feature depends on
  `pre-shipment-check.js` having already loaded** in the same session
  (`RECON_PROMPT`, `onReconInput`, and three other names are only
  defined there) — a real latent bug if a visitor reaches Supplier
  Portal without visiting Pre-Shipment Check first. Currently papered
  over in `eslint.config.js` (declared as known globals, loudly
  commented) rather than fixed.
- **`vitest.config.js` is stale** — not the real test runner, safe to
  delete.
- **`css/landing.css` still references `images/hero-bg.jpg`**, which
  doesn't exist in `images/` (real images were added for everything
  else since this was first flagged; this one was missed).
- **CSP still allows `'unsafe-inline'`** — necessary today given ~100+
  inline event handlers and inline styles across every tool page;
  migrating those to `addEventListener`/CSS classes is real,
  multi-page work, not yet started.
- **No per-tool weighted quota.** A simple reconciliation check and a
  heavier Pre-Shipment Check with two attached documents both cost the
  same "1 use" today, despite costing meaningfully different amounts
  in real API spend. Deliberately kept simple for trial launch;
  revisit once `prompt_versions`/`proxy_events` give you real
  per-tool cost data to base weighting on.
