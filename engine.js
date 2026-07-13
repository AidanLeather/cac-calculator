/* ===========================================================================
   engine.js - the generalised attribution/CAC engine for the skill.

   This is the workbook engine (js/attribution.js) with the LinkedIn-specific
   parts pulled out into parameters:
     - the channel set is passed in (derived from the user's data)
     - the focus channel is a parameter (whichever channel's CAC we're defending)
     - the cost build-up is passed in as explicit per-month costs + shares,
       instead of the workbook's hard-coded LinkedIn constants

   Pure functions, deterministic, no DOM. Runs in Node (the build scripts) AND
   in the browser (the generated explorer inlines this file verbatim), so it is
   written as a UMD module.

   Design rule, inherited from the workbook: if the data can't support a method
   honestly, the caller is told - never invent touches or timestamps.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ATTR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Method catalogue. `kind: "fractional"` splits one deal's credit to a total
     of 1; `kind: "counting"` deliberately does not (a deal can add credit to
     several channels). Availability is decided per-dataset, not here. */
  var METHODS = {
    first:    { key: "first",    label: "First-touch",    kind: "fractional" },
    last:     { key: "last",     label: "Last-touch",     kind: "fractional" },
    linear:   { key: "linear",   label: "Linear",         kind: "fractional" },
    position: { key: "position", label: "Position-based", kind: "fractional" },
    any:      { key: "any",      label: "Any-touch",      kind: "counting"   },
    sole:     { key: "sole",     label: "Sole-touch",     kind: "counting"   },
  };

  /* ---- credit allocation for ONE deal's ordered channel sequence ---------- */
  function creditForDeal(seq, method) {
    var c = {};
    var add = function (ch, v) { c[ch] = (c[ch] || 0) + v; };
    var n = seq.length;
    switch (method) {
      case "first": add(seq[0], 1); break;
      case "last": add(seq[n - 1], 1); break;
      case "linear": for (var i = 0; i < n; i++) add(seq[i], 1 / n); break;
      case "position":
        if (n === 1) { add(seq[0], 1); }
        else if (n === 2) { add(seq[0], 0.5); add(seq[1], 0.5); }
        else {
          add(seq[0], 0.4); add(seq[n - 1], 0.4);
          var mid = 0.2 / (n - 2);
          for (var j = 1; j < n - 1; j++) add(seq[j], mid);
        }
        break;
      case "any": {
        var seen = {};
        for (var k = 0; k < n; k++) if (!seen[seq[k]]) { seen[seq[k]] = 1; add(seq[k], 1); }
        break;
      }
      case "sole": {
        var uniq = {}; var count = 0;
        for (var m = 0; m < n; m++) if (!uniq[seq[m]]) { uniq[seq[m]] = 1; count++; }
        if (count === 1) add(seq[0], 1);
        break;
      }
      default: throw new Error("unknown attribution method: " + method);
    }
    return c;
  }

  /* Roll a method up across all deals into per-channel credited customers and
     revenue. `channels` is the display-ordered channel set for this dataset. */
  function channelTotals(deals, method, channels) {
    var customers = {}, revenue = {};
    for (var a = 0; a < channels.length; a++) { customers[channels[a]] = 0; revenue[channels[a]] = 0; }
    for (var d = 0; d < deals.length; d++) {
      var cc = creditForDeal(deals[d].touch_channels, method);
      for (var ch in cc) {
        if (customers[ch] == null) { customers[ch] = 0; revenue[ch] = 0; } // channel not in the display set - still count it
        customers[ch] += cc[ch];
        revenue[ch] += cc[ch] * deals[d].amount;
      }
    }
    var totalCustomers = 0, totalRevenue = 0;
    for (var t = 0; t < channels.length; t++) { totalCustomers += customers[channels[t]]; totalRevenue += revenue[channels[t]]; }
    return { customers: customers, revenue: revenue, totalCustomers: totalCustomers, totalRevenue: totalRevenue };
  }

  /* Median sales cycle in days (drives the lag-timing window). */
  function medianSalesCycle(deals) {
    var xs = [];
    for (var i = 0; i < deals.length; i++) if (deals[i].sales_cycle_days != null) xs.push(deals[i].sales_cycle_days);
    if (!xs.length) return null;
    xs.sort(function (p, q) { return p - q; });
    var n = xs.length;
    return n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
  }

  /* Cost boundaries for the focus channel under a timing choice.

     monthly: [{ month, focus_media }] - chronological, focus-channel spend only.
     assumptions: {
       retainerPerMonth, retainerShare,   // agency retainer GBP  / month, share on focus
       toolingPerMonth,  toolingShare,     // tools GBP  / month, share on focus
       staffPerMonth,    staffShare        // loaded headcount GBP  / month, share on focus
     }
     timing: "naive" (all months) | "lag" (drop trailing ~median-cycle months). */
  function costBoundaries(monthly, deals, timing, assumptions) {
    var A = assumptions || {};
    var monthsIncluded = monthly.length, monthsExcluded = 0;
    if (timing === "lag") {
      var med = medianSalesCycle(deals);
      if (med != null) { monthsExcluded = Math.round(med / 30); monthsIncluded = Math.max(0, monthly.length - monthsExcluded); }
    }
    var media = 0;
    for (var i = 0; i < monthsIncluded && i < monthly.length; i++) media += (monthly[i].focus_media || 0);

    var retainer = (A.retainerPerMonth || 0) * (A.retainerShare || 0) * monthsIncluded;
    var tooling  = (A.toolingPerMonth  || 0) * (A.toolingShare  || 0) * monthsIncluded;
    var staff    = (A.staffPerMonth    || 0) * (A.staffShare    || 0) * monthsIncluded;

    return {
      media_only: media,
      plus_agency_tooling: media + retainer + tooling,
      fully_loaded: media + retainer + tooling + staff,
      parts: { media: media, retainer: retainer, tooling: tooling, staff: staff },
      monthsIncluded: monthsIncluded,
      monthsExcluded: monthsExcluded,
    };
  }

  /* The headline: focus-channel CAC for one (method, boundary, timing). */
  function focusCAC(deals, monthly, opts, channels, focusChannel) {
    var b = costBoundaries(monthly, deals, opts.timing, opts.assumptions);
    var cost = b[opts.boundary];
    var totals = channelTotals(deals, opts.method, channels);
    var customers = totals.customers[focusChannel] || 0;
    // cost 0 (e.g. media-only on an unpaid channel, or lag dropping the whole
    // window) is an undefined CAC - n/a, never a misleading 0.
    return { cac: (customers > 0 && cost > 0) ? cost / customers : null, cost: cost, customers: customers, boundary: b };
  }

  /* Grid over the AVAILABLE methods x boundaries at one timing. */
  function cacGrid(deals, monthly, timing, cfg) {
    var boundaries = costBoundaries(monthly, deals, timing, cfg.assumptions);
    var rows = [], flat = [];
    var boundaryKeys = ["media_only", "plus_agency_tooling", "fully_loaded"];
    for (var i = 0; i < cfg.methods.length; i++) {
      var mKey = cfg.methods[i];
      var customers = channelTotals(deals, mKey, cfg.channels).customers[cfg.focusChannel] || 0;
      var cells = {};
      for (var b = 0; b < boundaryKeys.length; b++) {
        var cb = boundaries[boundaryKeys[b]];
        var cac = (customers > 0 && cb > 0) ? cb / customers : null; // cost 0 -> n/a, not 0
        cells[boundaryKeys[b]] = cac;
        if (cac != null) flat.push(cac);
      }
      rows.push({ method: mKey, customers: customers, cells: cells });
    }
    flat.sort(function (a, b2) { return a - b2; });
    return { rows: rows, boundaries: boundaries, min: flat[0], max: flat[flat.length - 1] };
  }

  /* Every achievable figure (method x boundary x timing), sorted by CAC. The
     explorer slider steps through exactly these - no in-between values exist. */
  function buildCombos(deals, monthly, cfg) {
    var combos = [];
    var timings = cfg.timings || ["naive", "lag"];
    var boundaryKeys = ["media_only", "plus_agency_tooling", "fully_loaded"];
    for (var t = 0; t < timings.length; t++) {
      for (var b = 0; b < boundaryKeys.length; b++) {
        for (var m = 0; m < cfg.methods.length; m++) {
          var r = focusCAC(deals, monthly,
            { method: cfg.methods[m], boundary: boundaryKeys[b], timing: timings[t], assumptions: cfg.assumptions },
            cfg.channels, cfg.focusChannel);
          if (r.cac != null) combos.push({ method: cfg.methods[m], boundary: boundaryKeys[b], timing: timings[t], cac: r.cac });
        }
      }
    }
    combos.sort(function (a, b2) { return a.cac - b2.cac; });
    return combos;
  }

  /* Overall defensible band across both timings. */
  function band(deals, monthly, cfg) {
    var combos = buildCombos(deals, monthly, cfg);
    if (!combos.length) return { min: null, max: null };
    return { min: combos[0].cac, max: combos[combos.length - 1].cac };
  }

  return {
    METHODS: METHODS,
    creditForDeal: creditForDeal,
    channelTotals: channelTotals,
    medianSalesCycle: medianSalesCycle,
    costBoundaries: costBoundaries,
    focusCAC: focusCAC,
    cacGrid: cacGrid,
    buildCombos: buildCombos,
    band: band,
  };
});
