/* channel-map.js - normalise HubSpot source values onto a clean channel set.

   HubSpot records a deal/contact's source as a `Source Type` enum plus a
   free-text `Drill-Down 1` (the specific platform/campaign). This is the exact
   analogue of the workbook's self-report normalisation: an ordered, explicit,
   first-match-wins table. Nothing is guessed into a channel silently - an
   unrecognised value comes back as { channel: null }, and the ingest step
   surfaces it for the user to map by hand.

   The output labels are deliberately human and CAC-friendly ("LinkedIn Ads",
   "Paid search"), because they become the channel names in the explorer.
*/
"use strict";

/* Ordered rules. `test(type, drill)` - first truthy match wins. `drill` is the
   lower-cased drill-down text (may be ""). */
var RULES = [
  // paid social, split by platform via the drill-down
  { test: function (t, d) { return t === "paid_social" && /linkedin/.test(d); }, channel: "LinkedIn Ads" },
  { test: function (t, d) { return t === "paid_social" && /(facebook|meta|instagram|\bfb\b)/.test(d); }, channel: "Meta Ads" },
  { test: function (t, d) { return t === "paid_social" && /tiktok/.test(d); }, channel: "TikTok Ads" },
  { test: function (t, d) { return t === "paid_social"; }, channel: "Paid social" },

  // paid search
  { test: function (t, d) { return t === "paid_search" || (t === "other_campaigns" && /google ads|adwords|ppc/.test(d)); }, channel: "Paid search" },

  // organic
  { test: function (t) { return t === "organic_search"; }, channel: "Organic search" },
  { test: function (t) { return t === "social_media" || t === "organic_social"; }, channel: "Organic social" },

  // owned / earned
  { test: function (t) { return t === "email_marketing"; }, channel: "Email" },
  { test: function (t) { return t === "referrals" || t === "referral"; }, channel: "Referral" },
  { test: function (t) { return t === "direct_traffic" || t === "direct"; }, channel: "Direct" },
  { test: function (t, d) { return t === "offline" && /(event|conference|webinar|trade ?show|booth)/.test(d); }, channel: "Events" },
  { test: function (t) { return t === "offline" || t === "offline_sources"; }, channel: "Offline" },
  { test: function (t) { return t === "other_campaigns"; }, channel: "Other campaigns" },
];

/* Free-text fallbacks - for the "how did you hear about us" style values or
   non-standard exports where only a label is present (no HubSpot enum). */
var TEXT_RULES = [
  { re: /linkedin\s*(ad|paid)|paid.*linkedin/i, channel: "LinkedIn Ads" },
  { re: /linkedin/i, channel: "LinkedIn Ads", ambiguous: true },
  { re: /google\s*ad|adwords|ppc|paid\s*search/i, channel: "Paid search" },
  { re: /google|bing|search/i, channel: "Organic search" },
  { re: /facebook|instagram|meta\b/i, channel: "Meta Ads" },
  { re: /email|newsletter/i, channel: "Email" },
  { re: /referr|word of mouth|colleague|recommend/i, channel: "Referral" },
  { re: /event|conference|webinar|trade ?show/i, channel: "Events" },
  { re: /outbound|sdr|cold|emailed us/i, channel: "Outbound" },
  { re: /direct/i, channel: "Direct" },
];

function normType(t) {
  return String(t == null ? "" : t).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/* Map a HubSpot (sourceType, drillDown) pair to a channel label, or null. */
function mapSource(sourceType, drillDown) {
  var t = normType(sourceType);
  var d = String(drillDown == null ? "" : drillDown).toLowerCase();
  if (!t && !d) return { channel: null, reason: "blank" };
  for (var i = 0; i < RULES.length; i++) {
    if (RULES[i].test(t, d)) return { channel: RULES[i].channel, matchedBy: "enum" };
  }
  // no enum match - try the free text of type+drill together
  var text = (sourceType || "") + " " + (drillDown || "");
  for (var j = 0; j < TEXT_RULES.length; j++) {
    if (TEXT_RULES[j].re.test(text)) return { channel: TEXT_RULES[j].channel, matchedBy: "text", ambiguous: !!TEXT_RULES[j].ambiguous };
  }
  return { channel: null, reason: "unmapped", raw: (sourceType || "") + (d ? " / " + drillDown : "") };
}

/* Map a plain label (single string, e.g. a touch-path token or self-report). */
function mapLabel(label) {
  if (label == null || String(label).trim() === "") return { channel: null, reason: "blank" };
  for (var j = 0; j < TEXT_RULES.length; j++) {
    if (TEXT_RULES[j].re.test(String(label))) return { channel: TEXT_RULES[j].channel, matchedBy: "text", ambiguous: !!TEXT_RULES[j].ambiguous };
  }
  return { channel: null, reason: "unmapped", raw: label };
}

module.exports = { mapSource: mapSource, mapLabel: mapLabel, RULES: RULES, TEXT_RULES: TEXT_RULES };
