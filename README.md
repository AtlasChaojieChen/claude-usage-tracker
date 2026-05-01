# Claude Usage Tracker

A floating dashboard for [claude.ai](https://claude.ai) that shows your usage at a glance. Built as a Tampermonkey userscript with an editorial design — Fraunces serif, warm dark palette, single dual-ring hero.

## Features

- **Dual ring** — outer ring is your weekly limit, inner is the 5-hour rolling window. Hover to see either value.
- **Per-model bars** — Opus, Sonnet, Claude Design, Cowork, and Extra usage when applicable.
- **Routines budget** — daily Claude Code routines used vs. limit.
- **7-day history** — smooth area chart showing daily usage with always-visible labels.
- **Color tiers** — bars and rings shift from green to red as you approach limits.
- **Draggable + collapsible** — click ✕ to collapse to a small pill; drag anywhere on screen.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Greasemonkey/Violentmonkey)
2. Open `claude-usage-tracker.user.js` and click **Raw**
3. Tampermonkey will offer to install it
4. Reload claude.ai

## Privacy

Everything runs locally in your browser. The script reads Claude.ai's own usage API (the same one your Settings page uses) and stores history in Tampermonkey's local storage. Nothing is sent anywhere else.

## License

MIT
