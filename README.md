# ClearAI Pro — file architecture (rebuilt)

This replaces the original 3-file codebase (`clearAi.html` 1,367 lines,
`clearAi.css` 1,806 lines, `clearAi.js` 1,010 lines) with one file per
concern, per page. Read this before editing anything — it explains why
the pieces are shaped the way they are.

## How to run it

Open `index.html` directly in a browser (`file://...`) and the landing
page works fine — it's static. **`app.html` will not work over `file://`**
because it loads each tool page's HTML/CSS/JS with `fetch()`, and
browsers block `fetch()` against local files for security reasons.

Serve the folder over a local web server instead. From this folder:

```
python3 -m http.server 8000
```

then open `http://localhost:8000/index.html` in a browser. Any static
server works (VS Code's "Live Server" extension, `npx serve`, etc.) —
it doesn't need to be Python specifically.

## Folder layout

```
index.html                    — landing / marketing page (standalone)
app.html                      — app shell: nav, sidebar, API key bar,
                                 shared footer, and an empty
                                 <main id="page-container"> that the
                                 router fills in
css/
  tokens.css                  — colors, fonts, spacing, shadows (:root vars)
  landing.css                 — landing-page-only styles
  shell.css                   — nav, mobile tabs, sidebar, API bar, toast
  components.css               — shared building blocks used by 2+ tool
                                 pages: page-header, checker-card, buttons,
                                 form inputs, loading spinner, cross-links
js/
  landing.js                  — scroll effects for index.html only
  shell.js                    — the router, API key state, callClaude()
                                 (the shared Anthropic API call), sidebar,
                                 toast, print-to-PDF
pages/<page-name>/
  <page-name>.html            — that page's content only (page-header +
                                 body) — no nav/sidebar/footer duplicated
  <page-name>.css              — styles unique to that page
  <page-name>.js                — that page's logic + an init<Name>()
                                 function the router calls after loading it
legacy/
  ops-report-UNUSED.css/.js   — dead code, see "What I removed" below
images/
  README.txt                  — the landing page's images were never
                                 uploaded; drop them in here
```

Seven tool pages: `doc-validation`, `hs-classifier`, `coming-soon`,
`pre-shipment-check`, `supplier-portal`, `demurrage-calculator`,
`advance-ruling`.

## The one thing that's genuinely different from a plain multi-page site

The original app kept all 9 pages in the DOM at once and just hid the
inactive ones with CSS (`display:none`). That's what let one API key,
one nav bar, and instant tab-switching work for free.

Splitting into separate files breaks that unless something holds it
together. `app.html` is that something: it's a single shell page whose
router (`js/shell.js`) fetches ONE tool page's HTML fragment at a time
into `#page-container`, swaps it in, then calls that page's own
`init<Name>()` function to wire up its inputs. Only the page currently
on screen exists in the DOM — which is exactly what makes each page's
files small and independently editable, but it's also why every page
module guards its DOM lookups (`if (!el) return;`) instead of assuming
its elements exist, the way the original code safely could.

The landing page (`index.html`) and the app (`app.html`) are two real,
separate pages now — clicking "Open Platform" is a normal link, not a
show/hide toggle. Your API key and recently-used list live in
`localStorage`, so they survive that navigation exactly as before.

## Editing a single tool page

To change the Demurrage Calculator, you only ever need
`pages/demurrage-calculator/demurrage-calculator.html/.css/.js`. You
won't find its logic scattered elsewhere — except:

**Supplier Portal is a declared exception.** Its "preview supplier
experience" button reuses Pre-Shipment Check's reconciliation logic
(`RECON_SAMPLES`, `RECON_PROMPT`, `renderReconResults`). This was true
in the original file too — I didn't introduce the coupling, I made it
explicit. `js/shell.js`'s `ROUTES` table declares
`'supplier': { ..., deps: ['pre-check'] }` so Pre-Shipment Check's
script always loads alongside Supplier Portal's, even if a visitor
never opens that tab directly.

## What I removed vs. what I flagged instead

**Removed from the live app, preserved in `legacy/`:** the Ops Report
feature (CSV/XLSX upload, KPI dashboard, AI-generated weekly report) —
~150 lines of CSS and JS with zero remaining references anywhere in
the HTML. This matches what you told me earlier: Ops Report was
deliberately taken out of the shipper-facing app because it served a
port-management audience, not shippers. If you want it back, the code
is intact in `legacy/ops-report-UNUSED.css` and `.js`.

**Found, not removed — flagged instead, since fixing it means guessing
at intent:**
- Advance Ruling's result box uses `.verdict-chip`/`.v-clear`/
  `.v-warning`/`.v-error` classes that were never defined in the
  original stylesheet either — the box currently renders unstyled.
  Noted in `pages/advance-ruling/advance-ruling.css`.
- Toast notifications (`showToast()`) targeted `#toast`/`#t-t`/`#t-m`
  elements that didn't exist anywhere in the original HTML — every
  toast call would have silently failed. I *did* fix this one (added
  the missing markup to `app.html`) since it's pure plumbing, not a
  design decision.
- `.alert`, `.alert-amber`, `.alert-ink`, `.ctx-left`,
  `.lagos-trust-strip`, `.problem-photo-row` are classes used in the
  HTML with no matching CSS rule anywhere — all fully inline-styled
  in the original, so functionally harmless, but worth knowing about
  if you ever want to move that styling out of `style="..."` attributes.

## Audit trail (ran the actual app in a real browser before delivery)

Static file checks (syntax, tag balance, id/class cross-references) catch
a lot, but they can't catch a broken image path or a runtime dependency
error — those only show up when the pages actually load. So before this
was packaged, every page was driven in a real headless Chromium browser
(Playwright) over an actual HTTP server, watching the browser's own
console, network log, and uncaught-exception stream — not just re-reading
the source.

**One real bug this caught and fixed:** `css/landing.css` sets its hero
and CTA background images with `url('images/hero-bg.jpg')`. That path
was correct in the original codebase, where `clearAi.css` lived at the
project root next to `index.html`. Moving it into `css/landing.css` as
part of this split silently broke it — a CSS `url()` resolves relative
to the *stylesheet's own location*, so the browser was requesting
`css/images/hero-bg.jpg` (404) instead of `images/hero-bg.jpg`. Fixed to
`url('../images/hero-bg.jpg')`. This was a bug introduced by the
restructure, unlike the other gaps documented above — worth knowing
about if you ever move a page's CSS file to a different folder depth,
since any `url()` inside it needs its relative path re-checked.

**Also specifically verified working, live, not just by reading the code:**
- Every one of the 7 tool pages loads its fragment via `fetch()` with zero console errors or failed requests
- `doc-validation` and Supplier Portal's "preview" button both correctly trigger a real call to `api.anthropic.com` and — with a deliberately invalid key — receive a real `401`, catch it, and show an error toast instead of crashing or leaving the loading spinner stuck. This also confirms the Supplier Portal → Pre-Shipment Check script dependency (see `deps: ['pre-check']` in `js/shell.js`) actually resolves at runtime, not just in a search across the code
- The `pre-check` and `ruling` pages (which have no entry in the main desktop nav — verified that matches the original app's design, not a regression) are reachable exactly the way the original intended: via the "Compare Form M to Supplier Docs →" and "Check Against a Ruling I Have →" cross-links, both tested end-to-end
- Sidebar open/close, the recently-used list, the API key save flow, and the Demurrage Calculator's live client-side math (no API call needed) all produced correct results with zero JS errors
- Landing page ↔ app navigation (`index.html` → `app.html` → `index.html`) works both ways
- Mobile viewport (390×844) tab bar navigation works

The only console messages that showed up anywhere and were **not** fixed:
a `403` on the Google Fonts CDN request, which is this sandbox's own
network allowlist blocking it during testing — not a bug in the site,
and it will load normally on any real hosting environment — and the
already-documented 404s for the 12 landing images that were never part
of your upload (see "Images" below).


The landing page references 12 images (`trust-lagos-1.jpg`,
`carousel-1.jpg` through `carousel-4.jpg`, `hero-bg.jpg`, etc.) that
were never part of your upload — this was already true in the original
file. See `images/README.txt`.
