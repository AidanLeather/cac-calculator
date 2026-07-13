# Pulling the right export from HubSpot

The skill auto-detects two fidelities. Give it whichever you can get — it will
tell you which attribution rules that unlocks.

## Option A — basic deals export (everyone has this)

Gives **first / last / any / sole-touch**. Linear and position-based stay locked
(a two-point path would just be a 50/50 guess).

1. **CRM → Deals.**
2. Filter to the ones you want to measure: **Deal stage is Closed Won**, and a
   **Close date** in the period (e.g. last 12 months).
3. **Export** (top right → Export). Choose CSV.
4. Include these properties (Edit columns if needed):
   - **Record ID**
   - **Deal name** (or Associated company)
   - **Amount**
   - **Create date**  ← needed for sales-cycle length / the lag timing lever
   - **Close date**
   - **Original Source Type** and **Original Source Drill-Down 1**
   - **Latest Source Type** and **Latest Source Drill-Down 1**
   - *(optional)* your **"How did you hear about us?"** property

Source is often a **contact** property in HubSpot, not a deal property. If the
source columns come out blank, export with the associated **primary contact's**
Original/Latest Source instead, or add those contact properties to the deal
export view.

## Option B — multi-touch attribution export (advanced, often not available)

Gives **all six rules**. Reality check first: HubSpot's multi-touch **revenue
attribution is Marketing Hub Enterprise only**, and its native export is a
*report* (attribution credit by model/channel), not a clean per-deal ordered
touch path with timestamps. So most people **can't** produce a usable multi-touch
file — and that's fine. First/last touch from Option A is a perfectly defensible
basis; don't treat this as required.

If you can produce one, two shapes both work:

- **Per-touch rows** — one row per interaction, with **Record ID** (deal),
  **Interaction Date**, and **Interaction Source Type** (+ Drill-Down 1). The
  skill groups by deal, orders by date, and rebuilds the path.
- **A touch-path column** — a single column with the ordered path in it, e.g.
  `LinkedIn Ads > Organic search > Direct` (separators `>`, `->`, `→`, `|`, `,`).

Export from **Reports → Attribution**, or from a Deals view that includes the
interaction/touch columns.

## What HubSpot source values become

`ingest.js` normalises HubSpot's source enums onto clean channel names
(`scripts/channel-map.js`). The common ones:

| HubSpot source | Drill-down | → Channel |
|---|---|---|
| `PAID_SOCIAL` | linkedin | LinkedIn Ads |
| `PAID_SOCIAL` | facebook / meta | Meta Ads |
| `PAID_SEARCH` | — | Paid search |
| `ORGANIC_SEARCH` | — | Organic search |
| `SOCIAL_MEDIA` | — | Organic social |
| `EMAIL_MARKETING` | — | Email |
| `REFERRALS` | — | Referral |
| `DIRECT_TRAFFIC` | — | Direct |
| `OFFLINE` | conference/event | Events |

Anything it can't place comes back as **unmapped** in the report — you decide
what it is, rather than the tool guessing.

## Two things HubSpot won't give you

- **Spend.** Ad spend lives in the ad platform (or a spreadsheet), not usually in
  the CRM. You'll supply monthly focus-channel spend separately.
- **The cost build-up.** Agency retainer, tooling, and the share of a person's
  time — never in HubSpot. You'll state these as assumptions (the tool grades
  them as assumptions, not facts).
