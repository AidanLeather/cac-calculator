/* ingest.js - turn a HubSpot deals export into the normalised dataset shape
   the engine + explorer expect.

   Auto-detects the two export fidelities:
     - basic     - one row per deal, Original + Latest source columns.
                   Supports first / last / any / sole-touch. Linear and
                   position-based are marked unavailable (a 2-point path would
                   just be a 50/50 guess - you need multi-touch to earn them).
     - multitouch - either a delimited "touch path" column, OR repeated deal
                   rows with an interaction-date column (grouped + ordered).
                   Supports all six rules.

   Emits a partial dataset.json (deals + detected channels + timing + available
   methods) and a data-quality report. Spend, cost assumptions and the focus
   channel are filled in the confirmation step (see SKILL.md), not here.

   Usage:
     node ingest.js <export.csv> [--out dataset.json] [--json-report]
*/
"use strict";
var fs = require("fs");
var cmap = require("./channel-map.js");

/* ---- tiny CSV parser (handles quotes, embedded commas/newlines) ---------- */
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ""); // strip BOM
  var rows = [], row = [], field = "", i = 0, inQ = false;
  while (i < text.length) {
    var ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };
  var headers = rows[0].map(function (h) { return h.trim(); });
  var records = [];
  for (var r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue; // blank line
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = (rows[r][c] == null ? "" : rows[r][c]).trim();
    records.push(obj);
  }
  return { headers: headers, records: records };
}

/* ---- column detection ---------------------------------------------------- */
var COLUMN_PATTERNS = {
  dealId:        [/^record id$/i, /deal id/i, /^id$/i, /^deal$/i],
  account:       [/company( name)?/i, /account( name)?/i, /deal name/i],
  amount:        [/^amount$/i, /deal (amount|value|size)/i, /\bacv\b/i, /contract value/i, /value/i, /^price$/i, /revenue/i],
  closeDate:     [/close date/i, /closed date/i, /^close$/i, /won date/i, /^signed$/i, /^won$/i, /close(d)?$/i],
  createDate:    [/create date/i, /created( date)?/i, /became a deal/i, /open(ed)? date/i, /^created$/i],
  origSource:    [/original (traffic )?source( type)?$/i, /^original source$/i, /first source/i, /lead source/i, /where did.*(come|hear)/i, /^source$/i],
  origDrill:     [/original (traffic )?source drill-?down 1/i, /original.*drill.*1/i],
  latestSource:  [/latest (traffic )?source( type)?$/i, /^latest source$/i, /last source/i],
  latestDrill:   [/latest (traffic )?source drill-?down 1/i, /latest.*drill.*1/i],
  touchPath:     [/touch(point)? path/i, /attribution path/i, /^path$/i, /channel path/i, /journey/i],
  interactionDt: [/interaction date/i, /activity date/i, /event date/i, /touch date/i, /^timestamp$/i],
  interactionSrc:[/interaction source( type)?$/i, /touch source$/i, /^channel$/i],
  interactionDrill:[/interaction (source )?drill-?down 1/i, /touch source drill-?down 1/i],
  selfReport:    [/how did you hear/i, /hear about us/i, /self.?reported/i],
};

function detectColumns(headers) {
  var found = {};
  Object.keys(COLUMN_PATTERNS).forEach(function (key) {
    var pats = COLUMN_PATTERNS[key];
    for (var h = 0; h < headers.length; h++) {
      for (var p = 0; p < pats.length; p++) {
        if (pats[p].test(headers[h])) { if (!found[key]) found[key] = headers[h]; }
      }
    }
  });
  return found;
}

/* ---- value coercion (forgiving: real exports are messy) ------------------- */
function toNumber(v) {
  if (v == null || v === "") return null;
  var s = String(v).trim().toLowerCase();
  var mult = 1;
  if (/[0-9]\s*k\b/.test(s)) mult = 1e3;        // "16.5k" -> 16500
  else if (/[0-9]\s*m\b/.test(s)) mult = 1e6;   // "1.2m"  -> 1200000
  var n = parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n * mult;
}
function toDate(v) {
  if (!v) return null;
  var s = String(v).trim();
  // UK day-first D/M/Y or D-M-Y (JS Date would misread these as US month-first)
  var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    var day = +m[1], mon = +m[2], yr = +m[3]; if (yr < 100) yr += 2000;
    if (day > 12 || mon <= 12) { var d1 = new Date(yr, mon - 1, day); return isNaN(d1.getTime()) ? null : d1; }
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

/* ---- main --------------------------------------------------------------- */
function ingest(csvText) {
  var parsed = parseCSV(csvText);
  var cols = detectColumns(parsed.headers);
  var records = parsed.records;
  var report = { headers: parsed.headers, detected: cols, issues: [], notes: [] };

  if (!cols.amount) report.issues.push("No amount column detected - CAC needs deal value. Point me at the right column.");
  if (!cols.origSource && !cols.touchPath && !cols.interactionSrc)
    report.issues.push("No source/path column detected - can't map channels. Point me at the source columns.");

  // decide fidelity
  var dealIdCounts = {};
  if (cols.dealId) records.forEach(function (r) { var id = r[cols.dealId]; dealIdCounts[id] = (dealIdCounts[id] || 0) + 1; });
  var hasRepeatedIds = Object.keys(dealIdCounts).some(function (id) { return dealIdCounts[id] > 1; });
  var fidelity = "basic";
  if (cols.touchPath) fidelity = "multitouch-path";
  else if (cols.dealId && cols.interactionDt && hasRepeatedIds) fidelity = "multitouch-rows";

  var unmapped = {}; // raw -> count, for the user to resolve
  var channelsSeen = {};
  function noteChannel(ch) { if (ch) channelsSeen[ch] = (channelsSeen[ch] || 0) + 1; }
  function mapPair(type, drill) {
    var m = cmap.mapSource(type, drill);
    if (!m.channel && m.reason === "unmapped") unmapped[m.raw] = (unmapped[m.raw] || 0) + 1;
    return m.channel;
  }
  function mapTok(tok) {
    var m = cmap.mapLabel(tok);
    if (!m.channel && m.reason === "unmapped") unmapped[String(tok)] = (unmapped[String(tok)] || 0) + 1;
    return m.channel;
  }

  var deals = [];

  if (fidelity === "multitouch-rows") {
    // group rows by deal id, order by interaction date, build the sequence
    var groups = {};
    records.forEach(function (r) { var id = r[cols.dealId]; (groups[id] = groups[id] || []).push(r); });
    Object.keys(groups).forEach(function (id) {
      var g = groups[id].slice().sort(function (a, b) {
        return (toDate(a[cols.interactionDt]) || 0) - (toDate(b[cols.interactionDt]) || 0);
      });
      var head = g[0];
      var seq = [];
      g.forEach(function (r) {
        var ch = cols.interactionSrc
          ? mapPair(r[cols.interactionSrc], cols.interactionDrill ? r[cols.interactionDrill] : "")
          : mapPair(r[cols.origSource], cols.origDrill ? r[cols.origDrill] : "");
        if (ch) { noteChannel(ch); seq.push(ch); }
      });
      pushDeal(deals, head, seq, cols);
    });
  } else {
    records.forEach(function (r) {
      var seq = [];
      if (fidelity === "multitouch-path") {
        String(r[cols.touchPath]).split(/\s*(?:>|->|->|\||,|;)\s*/).forEach(function (tok) {
          if (!tok) return; var ch = mapTok(tok); if (ch) { noteChannel(ch); seq.push(ch); }
        });
      } else {
        // basic: first = original, last = latest (deduped, order preserved)
        var first = mapPair(r[cols.origSource], cols.origDrill ? r[cols.origDrill] : "");
        var last = cols.latestSource ? mapPair(r[cols.latestSource], cols.latestDrill ? r[cols.latestDrill] : "") : null;
        if (first) { noteChannel(first); seq.push(first); }
        if (last && last !== first) { noteChannel(last); seq.push(last); }
      }
      pushDeal(deals, r, seq, cols);
    });
  }

  // drop deals with no usable touch or no amount, and record why
  var kept = [], droppedNoTouch = 0, droppedNoAmount = 0;
  deals.forEach(function (d) {
    if (!d.touch_channels.length) { droppedNoTouch++; return; }
    if (d.amount == null) { droppedNoAmount++; return; }
    kept.push(d);
  });

  // channel display order: by frequency, desc
  var channels = Object.keys(channelsSeen).sort(function (a, b) { return channelsSeen[b] - channelsSeen[a]; });

  // available methods by fidelity
  var methods, unavailable = [];
  if (fidelity === "basic") {
    methods = ["first", "last", "any", "sole"];
    unavailable.push({ label: "Linear", reason: "Your data carries only first and last touch, so splitting credit evenly would just be a 50/50 guess. Add the full touch order per deal to unlock it." });
    unavailable.push({ label: "Position-based", reason: "Same reason - a U-shaped split needs the middle touches your export doesn't include." });
  } else {
    methods = ["first", "last", "linear", "position", "any", "sole"];
  }

  // timing: need create + close dates for a sales-cycle median
  var haveCycle = kept.some(function (d) { return d.sales_cycle_days != null; });
  var timing = { hasSalesCycle: haveCycle };
  if (haveCycle) {
    var xs = kept.map(function (d) { return d.sales_cycle_days; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    var med = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
    timing.medianCycleDays = med;
    timing.lagMonths = Math.round(med / 30);
    timing.timings = ["naive", "lag"];
  } else {
    timing.timings = ["naive"];
    report.notes.push("No create-date column found, so no sales-cycle length - only same-period timing is available (the lag lever needs cycle length).");
  }

  // period from close dates
  var closes = kept.map(function (d) { return d.close_date; }).filter(Boolean).sort();
  var period = closes.length ? (closes[0].slice(0, 7) + " to " + closes[closes.length - 1].slice(0, 7)) : null;

  report.fidelity = fidelity;
  report.dealsIn = records.length;
  report.dealsKept = kept.length;
  report.droppedNoTouch = droppedNoTouch;
  report.droppedNoAmount = droppedNoAmount;
  report.channels = channels.map(function (c) { return { channel: c, deals: channelsSeen[c] }; });
  report.unmapped = Object.keys(unmapped).map(function (k) { return { raw: k, count: unmapped[k] }; }).sort(function (a, b) { return b.count - a.count; });
  report.timing = timing;
  report.methods = methods;

  var dataset = {
    meta: {
      source: "your data",
      focusChannel: null,           // set in the confirm step
      currency: "GBP",              // confirm
      period: period,
      n_deals: kept.length,
      channels: channels,
    },
    config: {
      methods: methods,
      unavailableMethods: unavailable,
      timings: timing.timings,
      timing: { medianCycleDays: timing.medianCycleDays || null, lagMonths: timing.lagMonths || null },
      costAssumptions: null,        // set in the confirm step
    },
    deals: kept,
    monthly: null,                  // set in the confirm step (focus-channel spend)
  };

  return { dataset: dataset, report: report };
}

function pushDeal(deals, row, seq, cols) {
  var created = cols.createDate ? toDate(row[cols.createDate]) : null;
  var closed = cols.closeDate ? toDate(row[cols.closeDate]) : null;
  deals.push({
    deal_id: cols.dealId ? row[cols.dealId] : "row-" + (deals.length + 1),
    account: cols.account ? row[cols.account] : null,
    close_date: closed ? closed.toISOString().slice(0, 10) : null,
    amount: cols.amount ? toNumber(row[cols.amount]) : null,
    sales_cycle_days: daysBetween(created, closed),
    touch_channels: seq,
    touch_count: seq.length,
    self_reported_source: cols.selfReport ? (row[cols.selfReport] || null) : null,
  });
}

/* ---- CLI ----------------------------------------------------------------- */
if (require.main === module) {
  var args = process.argv.slice(2);
  var file = args.find(function (a) { return !a.startsWith("--"); });
  if (!file) { console.error("usage: node ingest.js <export.csv> [--out dataset.json] [--json-report]"); process.exit(2); }
  var out = (function () { var i = args.indexOf("--out"); return i >= 0 ? args[i + 1] : null; })();
  var res = ingest(fs.readFileSync(file, "utf8"));

  if (args.includes("--json-report")) { console.log(JSON.stringify(res.report, null, 2)); }
  else { printReport(res.report); }

  if (out) { fs.writeFileSync(out, JSON.stringify(res.dataset, null, 2)); console.error("\nWrote partial dataset -> " + out + "  (spend, costs, focus channel still to fill)"); }
}

function printReport(r) {
  var L = [];
  L.push("Ingest - " + r.fidelity + " export");
  L.push("  rows in: " + r.dealsIn + "   deals kept: " + r.dealsKept +
    (r.droppedNoTouch ? "   dropped (no mappable touch): " + r.droppedNoTouch : "") +
    (r.droppedNoAmount ? "   dropped (no amount): " + r.droppedNoAmount : ""));
  L.push("  detected columns:");
  Object.keys(r.detected).forEach(function (k) { L.push("    " + k + " -> \"" + r.detected[k] + "\""); });
  if (r.issues.length) { L.push("  ISSUES:"); r.issues.forEach(function (x) { L.push("    ! " + x); }); }
  L.push("  channels found: " + r.channels.map(function (c) { return c.channel + " (" + c.deals + ")"; }).join(", "));
  L.push("  methods available: " + r.methods.join(", "));
  if (r.timing.medianCycleDays != null) L.push("  median sales cycle: " + r.timing.medianCycleDays + " days -> lag drops ~" + r.timing.lagMonths + " months");
  if (r.unmapped.length) { L.push("  UNMAPPED source values (need a mapping decision):"); r.unmapped.slice(0, 15).forEach(function (u) { L.push("    ? \"" + u.raw + "\" x" + u.count); }); }
  if (r.notes.length) { L.push("  notes:"); r.notes.forEach(function (n) { L.push("    - " + n); }); }
  console.log(L.join("\n"));
}

module.exports = { ingest: ingest, parseCSV: parseCSV, detectColumns: detectColumns };
