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

## Why it exists

I wrote up the thinking behind it: what the standard attribution methods do,
where they disagree, and how to report a channel CAC you can defend to a
founder or a CFO.

- **The write-up:** [My approach to calculating CAC](https://www.aidanleather.com/blog/calculating-cac/)
- **The skill page**, with what it needs from your data: [aidanleather.com/blog/calculating-cac/skill.html](https://www.aidanleather.com/blog/calculating-cac/skill.html)

## Made by

[Aidan Leather](https://www.aidanleather.com/), a marketing engineer. I write
about the tools and agents I build for marketing, and how I built them:
[aidanleather.com/blog](https://www.aidanleather.com/blog/). If it gets your
numbers wrong, or you'd like it to do something it doesn't,
[open an issue](https://github.com/AidanLeather/cac-calculator/issues) or
[message me on LinkedIn](https://www.linkedin.com/in/aidanleather).
