---
name: calculate-cac
description: >-
  Turn a closed-won deals export from any CRM (HubSpot, Salesforce, Pipedrive) or a
  spreadsheet into a personalised, interactive channel-CAC explorer — a slider
  showing how the same
  customers cost anywhere from £X to £Y depending on the attribution rule, cost
  boundary, and timing you choose. Use when someone wants to work out their real
  customer acquisition cost from their own data, defend a CAC figure to a
  founder/CFO, understand why their CAC numbers disagree, or asks to "run my
  export through the attribution thing / CAC explorer / workbook". Produces a
  shareable Artifact.
---

# Calculate CAC explorer (from a deals export)

This skill turns a user's own closed-won deals into **their** personalised CAC
explorer — one slider, their channel, their range — published as a single
interactive Artifact. It is **fully self-contained**: nothing outside this skill
folder is depended on or referenced, and the user only ever sees your questions,
the explorer, and a short findings summary. Never mention any source repo or
internal file to them.

**Start from the deals.** What you need is an export of their closed-won deals —
the **Deals section of whatever CRM they use** (HubSpot, Salesforce, Pipedrive,
Close, a plain spreadsheet — it doesn't matter). Don't assume a tool. If they're
on HubSpot, `references/hubspot-exports.md` has the exact click-path; if they're
not, the same idea applies to any CRM's deals list. **The data can come in any
shape** — the columns rarely match exactly, so the ingest auto-detects what it can
and flags the rest, and you clean up the remainder in conversation. Work with what
they have; never insist on a specific format or tool.

The whole point is intellectual honesty: **never invent touches, timestamps, or
spend.** If the export can't support a method, the tool says so and offers the
ones it can. Mirror that tone throughout — factual, understated, no hype.

## The one idea to hold onto
There is no single true CAC. It moves with three choices — the attribution
**rule** (how credit splits across touches), the **cost boundary** (media only →
fully loaded), and the **timing** (same-period vs lag-adjusted). The tool shows
the whole range and helps the user pick one defensible number to stick with.

## Files
- `engine.js` — the computation engine. Pure, deterministic.
- `scripts/ingest.js` — parse a CSV deals export (any CRM) → normalised dataset + report.
- `scripts/channel-map.js` — CRM source values / free-text → clean channel labels.
- `scripts/build-explorer.js` — dataset (+ spend/costs) → self-contained HTML + summary.
- `template/explorer.html` — the Artifact-ready explorer (engine + data injected).
- `references/hubspot-exports.md` — the exact export path *if* they're on HubSpot.

## Workflow

**Ground rules for the whole flow:**
- **Keep the intro short and the barrier low.** You need two things to start: their
  deals export, and the monthly ad spend for the channel they care about. Everything
  else — agency, tooling, staff costs — is **optional and can be typed straight into
  the explorer afterwards** (it has live per-channel cost boxes). Say that explicitly
  so nobody feels they need a perfect cost breakdown before they begin.
- **Don't interrogate.** If cost details are fuzzy or ambiguous, don't run a long
  back-and-forth — build with what's clear (media-only if that's all you have) and
  let them refine the rest live in the explorer. Only confirm the few things that
  actually move the headline: the focus channel and its media spend.
- **Never invent numbers, and never reference anything outside this skill.** No
  source repo or internal paths — ever. If a tool can't run, work around it
  silently; the user just sees questions, the explorer, and the findings.

A good, brief opening: "I'll turn your deals into an interactive CAC explorer. Two
things to start: **(1)** an export of your closed-won deals (your CRM's Deals view,
or a spreadsheet), and **(2)** the monthly ad spend for the channel you care about.
Agency, tooling and staff costs are optional — tell me now, or just type them into
the explorer afterwards. Send the deals export and we're off."

### 1. Get the export
Ask the user to export their **closed-won deals** as CSV — from the Deals section
of whatever CRM they use. Don't prescribe a tool. If they happen to be on HubSpot,
`references/hubspot-exports.md` gives the exact click-path and column names; on any
other CRM the same two fidelities apply and the skill auto-detects which one it got:
- **Basic (lead with this)** — one row per deal with a **first/original source**
  and a **latest source** per deal (most CRMs record these, sometimes as a pair of
  "traffic source" columns, sometimes as a single "lead source" field). Gives
  first / last / any / sole-touch. This is the reliable path — expect most users
  to be here.
- **Multi-touch (advanced)** — any file with a per-deal **touch path**: a
  touch-path column, or repeated deal rows with interaction dates. Gives all six
  rules. Be honest that most CRMs can't cleanly produce this (on HubSpot it's
  Marketing Hub Enterprise, and even then the native export is a *report* — credit
  by model/channel — not a clean per-deal path). Don't push them to it; first/last
  is a perfectly defensible basis.

If it's an `.xlsx`, convert to CSV first (use the `xlsx` skill) — `ingest.js`
reads CSV.

### 2. Ingest and read the report
```
node scripts/ingest.js <their-export.csv> --out /tmp/dataset.json
```
The report tells you: detected columns, the fidelity, channels found, methods
available, median sales cycle, and — crucially — any **unmapped source values**.
Read it out to the user in plain language. If columns were mis-detected, tell
them which column is which and re-run (the detection is fuzzy, not magic).

### 3. Resolve unmapped sources and pick the focus channel
- For each unmapped value, ask the user what channel it is, and add a rule to
  `scripts/channel-map.js` (or map it inline before building). Don't guess.
- Ask **which channel's CAC they want to defend** — usually their main paid
  channel (LinkedIn Ads, Paid search, Meta Ads…). That's the `focusChannel`.

### 4. Get the spend; the cost build-up is optional
The CRM won't carry spend or cost figures. Ask for the **one input that matters**,
and make the rest optional:
- **Monthly ad spend for the focus channel** — the number you genuinely can't
  invent, because a paid channel's CAC needs it. Spend is a **per-channel map**, so
  any paid channel can be focused:
  `"spend": { "LinkedIn Ads": [{ "month": "2025-01", "focus_media": 5000 }, …] }`
  (single-channel shorthand `"monthly": [ … ]` also works). A channel with no spend
  entry correctly shows **n/a** — CAC is a paid-channel concept.
- **Agency, tooling and staff costs are optional — now or later.** Tell the user
  plainly: they can give these now, *or just type them into the explorer* — it has
  editable **Media / Agency & tooling / People** boxes per channel that recompute
  the CAC and band live. If they defer, build **media-only** (set `costAssumptions`
  to zeros); the explorer opens on the media number and they fill in the rest. Only
  chase the build-up if they want the fully-loaded figure in the summary right now.
- **A channel can have a cost with no ad spend** — someone running email full-time
  at £5k/mo has a real email CAC (the cost is the person, not media). The explorer
  handles this through the People box on a no-media channel; mention it if relevant.

Write the inputs into a `config.json` (see `build-explorer.js` header for the shape).

### 5. Build
```
node scripts/build-explorer.js --dataset /tmp/dataset.json --config /tmp/config.json --out /tmp/explorer.html
```
This prints the **findings summary** (range, recommended default, the fixed-cost
band) and writes the explorer. The embedded data is **PII-stripped by default** —
account names, deal IDs and self-report text never ship, only amounts / cycle
lengths / channels. Leave it stripped.

### 6. Publish and hand over
- **Output the explorer and nothing else.** Publish `/tmp/explorer.html` with the
  **Artifact** tool (already Artifact-ready: `<style>` + markup + `<script>`, no
  external requests). Favicon: a chart/target emoji; keep it stable on re-publish.
  Do **not** produce or offer a dataset file, CSV, or any second download — the
  explorer is the whole deliverable.
- In chat, give a short findings summary in a factual, understated voice: the
  defensible range, the one number you'd recommend adopting (a credit-splitting
  rule, fully loaded, same-period — never a counting rule for the headline), and
  the honest caveats (which rules the data supported; brand/dark social sit outside
  all of it).

## Guardrails
- **Only ever output the explorer.** No dataset dumps, no CSVs, no "second file"
  with the working — just the one Artifact. That is the entire deliverable.
- **Stay self-contained: never reference anything outside this skill to the user.**
  No source repo, article, or internal paths. If a tool errors, work around it
  silently rather than narrating the internals.
- **PII stays stripped** in the published Artifact — the default strip is deliberate.
- **Counting rules (any/sole) are the outer edges, not a headline.** Recommend a
  credit-splitting rule for the number they actually report.
- If a rule yields zero focus-channel customers, the CAC is genuinely undefined
  (n/a) — that's correct, not a bug.
