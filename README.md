# cac-calculator

An agent skill that turns your closed-won deals into a personalised, interactive
**CAC explorer** — a page that shows how the same customers cost anywhere from
£X to £Y depending on the attribution rule, the cost boundary, and the timing you
choose, across every channel you run.

## Install

```bash
npx skills add AidanLeather/cac-calculator
```

Works in Claude Code, Cursor, Codex, OpenCode and other agents that support the
open skills ecosystem. Add `-g` to install it globally.

## What it does

Hand your agent an export of your closed-won deals (from any CRM, or a
spreadsheet). It works out the columns, asks what you spend, and builds you a
self-contained explorer you can share — drag the slider, switch channels, edit
any cost, and watch the CAC move. It never invents touches, timestamps or spend:
if the data can't support a method, it says so.

There is no single true CAC. The point is to see the whole defensible range and
pick one number you can stand behind.
