/* build-explorer.js - assemble the personalised explorer.

   Takes the partial dataset from ingest.js plus a small config (focus channel,
   monthly focus-channel spend, cost assumptions, currency), completes the
   dataset, validates it against the engine, and writes a self-contained,
   Artifact-ready HTML fragment. Also prints the findings summary + recommended
   default that go in the chat reply.

   Usage:
     node build-explorer.js --dataset partial.json --config config.json --out explorer.html

   config.json shape (spend is PER CHANNEL, so any paid channel can be focused):
     {
       "focusChannel": "LinkedIn Ads",
       "currency": "GBP",
       "spend": {
         "LinkedIn Ads": [ { "month": "2025-01", "focus_media": 5000 }, ... ],
         "Paid search": [ ... ]
       },
       "costAssumptions": {
         "retainerPerMonth": 2000, "retainerShare": 0.7,
         "toolingPerMonth": 450,  "toolingShare": 0.5,
         "staffPerMonth": 6250,   "staffShare": 0.4
       }
     }
   A single-channel shorthand is also accepted: "monthly": [ ... ] is treated as
   spend for the focus channel. Channels with no spend entry get no CAC (n/a) -
   correct, because CAC is a paid-channel concept.
*/
"use strict";
var fs = require("fs");
var path = require("path");
var ATTR = require("../engine.js");

function arg(name) { var i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

/* spend is per-channel: dataset.spend[channel] = [{month, focus_media}]. A
   channel with no entry has no paid media on record, so its CAC is genuinely
   undefined (shown as n/a, not a fabricated number). */
function spendFor(dataset, ch) { return (dataset.spend && dataset.spend[ch]) || []; }

function complete(dataset, config) {
  if (config.focusChannel) dataset.meta.focusChannel = config.focusChannel;
  if (config.currency) dataset.meta.currency = config.currency;
  // accept either a per-channel spend map, or a single monthly array for the focus channel
  if (config.spend) dataset.spend = config.spend;
  else if (config.monthly) { dataset.spend = dataset.spend || {}; dataset.spend[config.focusChannel || dataset.meta.focusChannel] = config.monthly; }
  if (config.costAssumptions) dataset.config.costAssumptions = config.costAssumptions;
  return dataset;
}

/* Set the analysis window: N = min(12, months the deals actually span). Cost and
   customers MUST cover the same window - you can't annualise spend to 12 months
   if there are only 3 months of customers to divide it by. So we window the deals
   to the most recent N calendar months and record N as `meta.months`; everything
   downstream multiplies the monthly cost rate by N. Best-effort: deals with no
   parseable close date are kept but don't constrain the window (e.g. messy
   exports). If nothing is dateable, fall back to a 12-month assumption. */
function monthIdx(t) { var d = new Date(t); return d.getFullYear() * 12 + d.getMonth(); }
function ymFromIdx(i) { return Math.floor(i / 12) + "-" + String((i % 12) + 1).padStart(2, "0"); }
function setWindow(dataset) {
  var parseable = function (d) { return d.close_date && !isNaN(Date.parse(d.close_date)); };
  var idxs = dataset.deals.filter(parseable).map(function (d) { return monthIdx(Date.parse(d.close_date)); });
  if (!idxs.length) { dataset.meta.months = 12; return dataset; } // undateable - assume a year
  var maxIdx = Math.max.apply(null, idxs), minIdx = Math.min.apply(null, idxs);
  var span = maxIdx - minIdx + 1;
  var N = Math.min(12, span);
  var kept = dataset.deals.filter(function (d) { return !parseable(d) || (maxIdx - monthIdx(Date.parse(d.close_date))) < N; });
  dataset._windowed = { before: dataset.deals.length, after: kept.length, months: N, capped: span > N };
  dataset.deals = kept;
  dataset.meta.n_deals = kept.length;
  dataset.meta.months = N;
  dataset.meta.period = ymFromIdx(maxIdx - N + 1) + " to " + ymFromIdx(maxIdx) + (span > N ? " (last " + N + " months)" : " (" + N + " months)");
  return dataset;
}

/* Flatten each channel's spend to N flat months of its mean monthly rate, so the
   build and the explorer (both on meta.months) agree exactly. */
function normalizeSpendToWindow(dataset) {
  if (!dataset.spend) return dataset;
  var N = dataset.meta.months || 12;
  Object.keys(dataset.spend).forEach(function (ch) {
    var arr = dataset.spend[ch] || [];
    if (!arr.length) return;
    var sum = 0; for (var i = 0; i < arr.length; i++) sum += (arr[i].focus_media || 0);
    var monthly = sum / arr.length;
    var out = []; for (var m = 0; m < N; m++) out.push({ month: null, focus_media: monthly });
    dataset.spend[ch] = out;
  });
  return dataset;
}

/* Lag-timing drops ~(median cycle) months of trailing spend. If that is >= the
   analysis window, it would zero the whole window - a meaningless lever. Drop it
   in that case, leaving same-period timing. */
function dropUselessLag(dataset) {
  var timings = dataset.config.timings || [];
  if (timings.indexOf("lag") < 0) return dataset;
  var med = ATTR.medianSalesCycle(dataset.deals);
  var excl = med != null ? Math.round(med / 30) : 0;
  if (excl >= (dataset.meta.months || 12)) {
    dataset.config.timings = timings.filter(function (t) { return t !== "lag"; });
    dataset._lagDropped = { lagMonths: excl, window: dataset.meta.months };
  }
  return dataset;
}

function validate(dataset) {
  var errs = [];
  var m = dataset.meta, c = dataset.config;
  if (!m.focusChannel) errs.push("meta.focusChannel is not set - which channel's CAC are we defending?");
  else if (m.channels.indexOf(m.focusChannel) < 0) errs.push("focusChannel \"" + m.focusChannel + "\" isn't one of the channels in the data (" + m.channels.join(", ") + ").");
  if (!spendFor(dataset, m.focusChannel).length) errs.push("no spend on record for the focus channel \"" + m.focusChannel + "\" - need its monthly media spend to compute a CAC.");
  if (!c.costAssumptions) errs.push("config.costAssumptions is not set - need the retainer/tooling/staff build-up (or explicit zeros).");
  if (!dataset.deals.length) errs.push("no deals.");
  return errs;
}

function summarise(dataset) {
  var cfg = {
    channels: dataset.meta.channels, focusChannel: dataset.meta.focusChannel,
    methods: dataset.config.methods, timings: dataset.config.timings, assumptions: dataset.config.costAssumptions,
  };
  var monthly = spendFor(dataset, cfg.focusChannel);
  var combos = ATTR.buildCombos(dataset.deals, monthly, cfg);
  var CUR = dataset.meta.currency === "USD" ? "$" : dataset.meta.currency === "EUR" ? "EUR " : "GBP ";
  var money = function (n) { return CUR + Math.round(n).toLocaleString("en-GB"); };
  var band = { min: combos[0].cac, max: combos[combos.length - 1].cac };

  // recommended default: best available "credit-splitting" rule, fully-loaded, same-period.
  // prefer linear, else position, else first (never a counting rule for the headline).
  var pref = ["linear", "position", "first", "last"].filter(function (m) { return cfg.methods.indexOf(m) >= 0; })[0];
  var timing = cfg.timings.indexOf("naive") >= 0 ? "naive" : cfg.timings[0];
  var rec = ATTR.focusCAC(dataset.deals, monthly, { method: pref, boundary: "fully_loaded", timing: timing, assumptions: cfg.assumptions }, cfg.channels, cfg.focusChannel);

  // fixed cost+timing band (only the rule moves it)
  var grid = ATTR.cacGrid(dataset.deals, monthly, timing, cfg);
  var fixed = grid.rows.map(function (r) { return r.cells.fully_loaded; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });

  return {
    focus: cfg.focusChannel, currency: CUR, deals: dataset.meta.n_deals,
    band: band, recMethod: ATTR.METHODS[pref].label, recCAC: rec.cac,
    fixedBand: { min: fixed[0], max: fixed[fixed.length - 1] },
    methods: cfg.methods, unavailable: dataset.config.unavailableMethods || [],
    money: money,
  };
}

/* Strip PII before embedding in a hosted Artifact. The explorer only needs
   what the engine computes on - amount, cycle length, touch channels. Account
   names, deal IDs, close dates and free-text self-report never render, so they
   don't ship. The explorer is the only output; no dataset file is handed over. */
function minifyForPublish(dataset) {
  return {
    meta: {
      source: dataset.meta.source, focusChannel: dataset.meta.focusChannel,
      currency: dataset.meta.currency, period: dataset.meta.period,
      months: dataset.meta.months, n_deals: dataset.meta.n_deals, channels: dataset.meta.channels,
    },
    config: dataset.config,
    spend: dataset.spend,
    deals: dataset.deals.map(function (d) {
      return { amount: d.amount, sales_cycle_days: d.sales_cycle_days, touch_channels: d.touch_channels };
    }),
  };
}

function build(dataset, templatePath, enginePath, opts) {
  opts = opts || {};
  var template = fs.readFileSync(templatePath, "utf8");
  var engine = fs.readFileSync(enginePath, "utf8");
  var embedded = opts.keepPII ? dataset : minifyForPublish(dataset);
  return template
    .replace("/*{{ENGINE}}*/", function () { return engine; })
    .replace("/*{{DATA}}*/", function () { return JSON.stringify(embedded); });
}

if (require.main === module) {
  var dsPath = arg("--dataset"), cfgPath = arg("--config"), out = arg("--out");
  if (!dsPath) { console.error("usage: node build-explorer.js --dataset partial.json [--config config.json] --out explorer.html"); process.exit(2); }
  var dataset = JSON.parse(fs.readFileSync(dsPath, "utf8"));
  if (cfgPath) dataset = complete(dataset, JSON.parse(fs.readFileSync(cfgPath, "utf8")));
  dataset = dropUselessLag(normalizeSpendToWindow(setWindow(dataset)));

  var errs = validate(dataset);
  if (errs.length) { console.error("Cannot build - dataset is incomplete:\n  - " + errs.join("\n  - ")); process.exit(1); }

  var s = summarise(dataset);
  var keepPII = process.argv.indexOf("--keep-pii") >= 0;
  var html = build(dataset, path.join(__dirname, "../template/explorer.html"), path.join(__dirname, "../engine.js"), { keepPII: keepPII });
  if (out) { fs.writeFileSync(out, html); }

  var lines = [];
  lines.push("Findings - " + s.focus + " CAC over " + s.deals + " deals");
  if (dataset._windowed)
    lines.push("  Window: " + dataset._windowed.months + " months" + (dataset._windowed.capped ? " (capped at 12, most recent closes)" : " (the full span of your data)") + " - " + dataset._windowed.after + " of " + dataset._windowed.before + " deals; costs are monthly x " + dataset._windowed.months + ".");
  if (dataset._lagDropped)
    lines.push("  Lag timing dropped: a ~" + dataset._lagDropped.lagMonths + "-month sales cycle exceeds the " + dataset._lagDropped.window + "-month window, so only same-period timing is offered.");
  lines.push("  Defensible range:   " + s.money(s.band.min) + " - " + s.money(s.band.max));
  lines.push("  Recommended default (" + s.recMethod + ", fully-loaded, same-period): " + s.money(s.recCAC));
  if (dataset.config.methods.indexOf("linear") < 0)
    lines.push("  NB: Linear (the split I'd normally recommend) needs full touch data. On a first/last export the best available is " + s.recMethod + " - export multi-touch to unlock Linear.");
  lines.push("  Fix cost + timing -> only the rule moves it: " + s.money(s.fixedBand.min) + " - " + s.money(s.fixedBand.max));
  lines.push("  Rules used: " + s.methods.join(", "));
  s.unavailable.forEach(function (u) { lines.push("  Unavailable: " + u.label + " - " + u.reason); });
  if (out) lines.push("\n  Wrote explorer -> " + out + "  (publish this as an Artifact)");
  console.log(lines.join("\n"));
}

module.exports = { complete: complete, validate: validate, summarise: summarise, build: build };
