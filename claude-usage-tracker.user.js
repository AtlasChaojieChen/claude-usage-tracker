// ==UserScript==
// @name         Claude Usage Tracker
// @namespace    https://github.com/AtlasChaojieChen/claude-usage-tracker
// @version      2.3.0
// @description  Floating editorial dashboard for Claude.ai usage. Dual ring with hover-swap, weekly bars, smooth 7-day area chart, manual refresh.
// @author       AtlasChaojieChen
// @icon         https://claude.ai/favicon.ico
// @homepageURL  https://github.com/AtlasChaojieChen/claude-usage-tracker
// @supportURL   https://github.com/AtlasChaojieChen/claude-usage-tracker/issues
// @updateURL    https://raw.githubusercontent.com/AtlasChaojieChen/claude-usage-tracker/main/claude-usage-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/AtlasChaojieChen/claude-usage-tracker/main/claude-usage-tracker.user.js
// @match        https://claude.ai/*
// @connect      claude.ai
// @run-at       document-end
// @run-in       normal-tabs
// @noframes
// @sandbox      DOM
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(async () => {
  "use strict";

  // =====================================================================
  // CONFIG
  // =====================================================================

  const REFRESH_MS = 5_000;
  const UI_TICK_MS = 1_000;
  const HISTORY_DAYS = 14;
  const DRAG_THRESHOLD_PX = 5;

  const STORAGE_KEY = "cut2_state";
  const POSITION_KEY = "cut2_pos";
  const COLLAPSED_KEY = "cut2_collapsed";

  // Routines daily caps by plan, per Anthropic's announcement.
  const ROUTINE_LIMITS = {
    free: 0,
    pro: 5,
    "max 5x": 15,
    "max 20x": 15,
    team: 25,
    enterprise: 25,
    claude: 5,
  };

  // Always show these even at 0% — known plan features.
  const ALWAYS_SHOW_FIELDS = new Set([
    "seven_day", // All models
    "seven_day_omelette", // Claude Design
    "seven_day_cowork", // Cowork
  ]);

  // Never show these — internal/promotional/noise.
  const HIDE_FIELDS = new Set([
    "seven_day_oauth_apps",
    "seven_day_iguana_necktie",
    "iguana_necktie",
    "tangelo",
    "omelette_promotional",
  ]);

  const FIELD_LABELS = {
    five_hour: "5-hour session",
    seven_day: "All models",
    seven_day_opus: "Opus",
    seven_day_sonnet: "Sonnet",
    seven_day_haiku: "Haiku",
    seven_day_omelette: "Claude Design",
    seven_day_claude_design: "Claude Design",
    seven_day_design: "Claude Design",
    seven_day_cowork: "Cowork",
  };

  const WEEKLY_FIELD_ORDER = [
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_haiku",
    "seven_day_omelette",
    "seven_day_cowork",
  ];

  // =====================================================================
  // STORAGE — promise-based wrappers around GM.* (per SKILL guidance)
  // =====================================================================

  async function storeGet(key, fallback) {
    try {
      return await GM.getValue(key, fallback);
    } catch {
      return fallback;
    }
  }

  async function storeSet(key, value) {
    try {
      await GM.setValue(key, value);
    } catch {
      /* ignore */
    }
  }

  // =====================================================================
  // FETCH — same-origin to claude.ai, uses native fetch with credentials
  // =====================================================================

  async function fetchRetry(url, opts = {}, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { credentials: "include", ...opts });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 400 * (i + 1)));
      }
    }
    throw lastErr;
  }

  let _loggedOrgOnce = false;
  let _loggedUsageOnce = false;
  let _loggedRoutinesOnce = false;

  async function fetchUsage() {
    const orgsRes = await fetchRetry("/api/organizations");
    const orgs = await orgsRes.json();
    const org = orgs?.[0];
    if (!org?.uuid) throw new Error("Not logged in");

    if (!_loggedOrgOnce) {
      console.log("[CUT] organization payload:", org);
      _loggedOrgOnce = true;
    }

    const usageRes = await fetchRetry(`/api/organizations/${org.uuid}/usage`);
    const usage = await usageRes.json();

    if (!_loggedUsageOnce) {
      console.log("[CUT] usage payload:", usage);
      _loggedUsageOnce = true;
    }

    // Routines budget — best-effort fetch, swallow failures.
    // Endpoint and headers reverse-engineered from ClaudeKarma's source.
    let routines = null;
    try {
      const rRes = await fetch("/v1/code/routines/run-budget", {
        credentials: "include",
        headers: {
          Accept: "*/*",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "ccr-triggers-2026-01-30",
          "anthropic-client-platform": "web_claude_ai",
          "x-organization-uuid": org.uuid,
        },
      });
      if (rRes.ok) {
        const data = await rRes.json();
        routines = {
          used: parseInt(data.used, 10) || 0,
          limit: parseInt(data.limit, 10) || 0,
        };
        if (!_loggedRoutinesOnce) {
          console.log("[CUT] routines budget:", routines);
          _loggedRoutinesOnce = true;
        }
      }
    } catch (_) {
      /* ignore */
    }

    return { usage, routines, plan: detectPlan(org) };
  }

  function detectPlan(org) {
    if (!org) return "Claude";
    const caps = (org.capabilities || [])
      .map((c) => String(c).toLowerCase())
      .join(" ");
    if (caps.includes("max_20") || caps.includes("max20")) return "Max 20x";
    if (caps.includes("max_5") || caps.includes("max5")) return "Max 5x";
    if (caps.includes("enterprise")) return "Enterprise";
    if (caps.includes("team")) return "Team";
    if (caps.includes("pro") || caps.includes("claude_pro")) return "Pro";
    if (caps.includes("free") || caps.includes("raven")) return "Free";

    const fallback = [
      org?.settings?.subscription_tier,
      org?.subscription_tier,
      org?.subscription?.tier,
      org?.subscription?.plan,
      org?.plan,
      org?.tier,
      org?.organization_type,
      org?.billable_units_active_subscription_plan,
    ]
      .filter((v) => typeof v === "string")
      .map((v) => v.toLowerCase());

    for (const v of fallback) {
      if (v.includes("max_20") || v.includes("max20")) return "Max 20x";
      if (v.includes("max_5") || v.includes("max5")) return "Max 5x";
      if (v.includes("enterprise")) return "Enterprise";
      if (v.includes("team")) return "Team";
      if (v.includes("pro")) return "Pro";
      if (v.includes("free")) return "Free";
    }
    return "Claude";
  }

  // =====================================================================
  // ROUTINES
  // =====================================================================

  function countRoutinesToday(routines) {
    if (!routines) return null;
    if (typeof routines.used !== "number") return null;
    return { used: routines.used, limit: routines.limit ?? null };
  }

  function routineLimitForPlan(plan) {
    return ROUTINE_LIMITS[(plan || "").toLowerCase()] ?? null;
  }

  // =====================================================================
  // COLOR
  // =====================================================================

  const PALETTE = {
    low: { stroke: "#7cb87c", glow: false },
    midlow: { stroke: "#c9bd5a", glow: false },
    mid: { stroke: "#d4a857", glow: false },
    high: { stroke: "#e2614e", glow: false },
    crit: { stroke: "#ed4d3a", glow: true },
  };

  function tierFor(pct) {
    const p = Number(pct) || 0;
    if (p < 30) return "low";
    if (p < 50) return "midlow";
    if (p < 70) return "mid";
    if (p < 85) return "high";
    return "crit";
  }

  // =====================================================================
  // HISTORY
  // =====================================================================

  function todayKey() {
    const d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  async function recordSnapshot(usage) {
    const sevenDay = usage?.seven_day?.utilization;
    if (typeof sevenDay !== "number") return;

    const state = (await storeGet(STORAGE_KEY, {})) || {};
    if (!state.history) state.history = {};

    const key = todayKey();
    const day = state.history[key] || {
      startSevenDay: sevenDay,
      endSevenDay: sevenDay,
    };

    if (sevenDay < day.startSevenDay) day.startSevenDay = 0;
    day.endSevenDay = sevenDay;
    state.history[key] = day;

    const keys = Object.keys(state.history).sort();
    while (keys.length > HISTORY_DAYS) delete state.history[keys.shift()];

    await storeSet(STORAGE_KEY, state);
  }

  /**
   * Reads from a CACHED in-memory copy of history; the cache is refreshed
   * on every successful tick(). This keeps render() synchronous so we
   * don't have to thread async through every UI helper.
   */
  let _historyCache = {};
  async function refreshHistoryCache() {
    const state = (await storeGet(STORAGE_KEY, {})) || {};
    _historyCache = state.history || {};
  }

  function getHistoryDays(n = 7) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k =
        d.getFullYear() +
        "-" +
        String(d.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getDate()).padStart(2, "0");
      const day = _historyCache[k];
      const usage = day
        ? Math.max(0, day.endSevenDay - day.startSevenDay)
        : null;
      out.push({
        date: k,
        label: d
          .toLocaleDateString("en-US", { weekday: "short" })
          .charAt(0)
          .toUpperCase(),
        usage,
        isToday: i === 0,
      });
    }
    return out;
  }

  // =====================================================================
  // FIELDS
  // =====================================================================

  function fieldLabel(key) {
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    return key
      .replace(/^seven_day_/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function pickWeeklyBars(usage) {
    if (!usage) return [];
    const seen = new Set();
    const out = [];

    const consider = (key) => {
      if (HIDE_FIELDS.has(key)) return;
      if (seen.has(key)) return;
      const v = usage[key];
      if (!v || typeof v.utilization !== "number") return;
      if (v.utilization === 0 && !ALWAYS_SHOW_FIELDS.has(key)) return;
      seen.add(key);
      out.push({ key, label: fieldLabel(key), pct: v.utilization });
    };

    for (const key of WEEKLY_FIELD_ORDER) consider(key);
    for (const key of Object.keys(usage)) {
      if (key === "seven_day") continue;
      if (key.startsWith("seven_day_")) consider(key);
    }

    const ex = usage.extra_usage;
    if (ex) {
      const enabled = ex.is_enabled === true;
      if (enabled) {
        // Heuristic: if used_credits is 0, treat as not funded → max red bar.
        // The bar self-corrects the moment any spending registers.
        const usedC = typeof ex.used_credits === "number" ? ex.used_credits : 0;
        const limitC =
          typeof ex.monthly_limit === "number" ? ex.monthly_limit : 0;
        const cur = ex.currency === "USD" ? "$" : "";

        if (usedC === 0) {
          out.push({
            key: "extra_usage",
            label: "Extra",
            pct: 100,
            forceCrit: true,
            sub: `${cur}0/${cur}0`,
          });
        } else {
          let pct = ex.utilization;
          if (typeof pct !== "number") {
            pct = limitC > 0 ? (usedC / limitC) * 100 : 0;
          }
          const sub = `${cur}${usedC.toFixed(2)}/${cur}${limitC.toFixed(0)}`;
          out.push({ key: "extra_usage", label: "Extra", pct, sub });
        }
      } else {
        out.push({
          key: "extra_usage",
          label: "Extra",
          pct: null,
          disabled: true,
        });
      }
    }

    return out;
  }

  // =====================================================================
  // FORMAT
  // =====================================================================

  function fmtCountdown(ms) {
    if (ms == null || ms < 0) return "—";
    const m = Math.floor(ms / 60_000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  // =====================================================================
  // RING SVG
  // =====================================================================

  function ringSVG(weekPct, hourPct) {
    const w = Math.round(weekPct ?? 0);
    const h = Math.round(hourPct ?? 0);
    const tierW = tierFor(w),
      tierH = tierFor(h);
    const colW = PALETTE[tierW].stroke;
    const colH = PALETTE[tierH].stroke;

    const cx = 74,
      cy = 74;
    const rOuter = 58,
      swOuter = 8;
    const rInner = 40,
      swInner = 7;
    const circOuter = 2 * Math.PI * rOuter;
    const circInner = 2 * Math.PI * rInner;
    const offOuter = circOuter * (1 - clamp(w, 0, 100) / 100);
    const offInner = circInner * (1 - clamp(h, 0, 100) / 100);

    const glowW = PALETTE[tierW].glow
      ? `filter="drop-shadow(0 0 3.5px ${colW}aa)"`
      : "";
    const glowH = PALETTE[tierH].glow
      ? `filter="drop-shadow(0 0 3.5px ${colH}aa)"`
      : "";

    return `
          <svg width="148" height="148" viewBox="0 0 148 148">
            <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="rgba(72,65,58,0.45)" stroke-width="${swOuter}"/>
            <circle class="fill outer" cx="${cx}" cy="${cy}" r="${rOuter}" fill="none"
                    stroke="${colW}" stroke-width="${swOuter}" stroke-linecap="round"
                    stroke-dasharray="${circOuter.toFixed(2)}" stroke-dashoffset="${offOuter.toFixed(2)}"
                    transform="rotate(-90 ${cx} ${cy})" ${glowW}/>
            <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="rgba(72,65,58,0.45)" stroke-width="${swInner}"/>
            <circle class="fill inner" cx="${cx}" cy="${cy}" r="${rInner}" fill="none"
                    stroke="${colH}" stroke-width="${swInner}" stroke-linecap="round"
                    stroke-dasharray="${circInner.toFixed(2)}" stroke-dashoffset="${offInner.toFixed(2)}"
                    transform="rotate(-90 ${cx} ${cy})" ${glowH}/>
          </svg>
          <div class="ed-num is-hour ${h >= 100 ? "is-wide" : ""}">${h}<span class="pct">%</span></div>
          <div class="ed-num is-week ${w >= 100 ? "is-wide" : ""}">${w}<span class="pct">%</span></div>
        `;
  }

  const HOVER_GEOM = {
    SIZE: 148,
    R_INNER: 40,
    SW_INNER: 7,
    R_OUTER: 58,
    SW_OUTER: 8,
    PAD: 4,
  };

  // =====================================================================
  // AREA CHART
  // =====================================================================

  function smoothPath(points, tension = 6) {
    if (points.length < 2) return "";
    const ext = [points[0], ...points, points[points.length - 1]];
    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      const p0 = ext[i - 1],
        p1 = ext[i],
        p2 = ext[i + 1],
        p3 = ext[i + 2];
      const cp1x = p1.x + (p2.x - p0.x) / tension;
      const cp1y = p1.y + (p2.y - p0.y) / tension;
      const cp2x = p2.x - (p3.x - p1.x) / tension;
      const cp2y = p2.y - (p3.y - p1.y) / tension;
      d +=
        ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ` +
        `${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ` +
        `${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  }

  function areaChartHTML(history) {
    const W = 360,
      H = 90;
    const padX = 14;
    const labelBand = 18;
    const padBottom = 4;
    const innerW = W - padX * 2;
    const innerH = H - labelBand - padBottom;

    const max = Math.max(1, ...history.map((d) => d.usage ?? 0));

    const points = history.map((d, i) => ({
      x: padX + (i / (history.length - 1)) * innerW,
      y: labelBand + (innerH - ((d.usage ?? 0) / max) * innerH),
      d,
      i,
      isNull: d.usage == null,
    }));

    const linePath = smoothPath(points);
    const areaPath =
      linePath +
      ` L ${points[points.length - 1].x.toFixed(2)} ${H} ` +
      `L ${points[0].x.toFixed(2)} ${H} Z`;

    const dots = points
      .map((p) => {
        const cls = p.d.isToday
          ? "b-dot today"
          : p.isNull
            ? "b-dot null"
            : "b-dot";
        const r = p.d.isToday ? 4.5 : 3;
        return `<circle class="${cls}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r}"/>`;
      })
      .join("");

    const labels = points
      .map((p) => {
        if (p.isNull) return "";
        const v = Math.round(p.d.usage);
        const leftPct = ((p.x / W) * 100).toFixed(2);
        const topPct = ((p.y / H) * 100).toFixed(2);
        const cls = p.d.isToday ? "b-lbl today" : "b-lbl";
        return `<div class="${cls}" style="left:${leftPct}%;top:${topPct}%">${v}<span class="pct">%</span></div>`;
      })
      .join("");

    return `
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <defs>
              <linearGradient id="cut2-area-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#cc785c" stop-opacity="0.32"/>
                <stop offset="100%" stop-color="#cc785c" stop-opacity="0.02"/>
              </linearGradient>
            </defs>
            <path d="${areaPath}" fill="url(#cut2-area-grad)"/>
            <path d="${linePath}" fill="none" stroke="#cc785c" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
            ${dots}
          </svg>
          ${labels}
        `;
  }

  // =====================================================================
  // STYLES
  // =====================================================================

  const FONT_LINK_HREF =
    "https://fonts.googleapis.com/css2?" +
    "family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..400&" +
    "family=Instrument+Sans:wght@400;500;600&" +
    "family=Geist+Mono:wght@400;500;600&" +
    "display=swap";

  const STYLES = `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      .root {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
        font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #f5f4ee;
        -webkit-font-smoothing: antialiased;
        user-select: none;
      }

      .card {
        background: linear-gradient(155deg, #2a2521 0%, #221f1c 60%, #1f1d1a 100%);
        border: 1px solid #3a352f;
        border-radius: 16px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.5);
        position: relative;
        overflow: hidden;
        transition: width 200ms ease;
      }
      .card::before {
        content: ''; position: absolute; inset: 0; pointer-events: none;
        background: radial-gradient(circle at 100% 0%, rgba(204,120,92,0.10), transparent 55%);
      }
      .card::after {
        content: ''; position: absolute; inset: 0; pointer-events: none;
        background-image: radial-gradient(rgba(255,255,255,0.012) 1px, transparent 1px);
        background-size: 3px 3px;
        opacity: 0.5;
      }
      .card > * { position: relative; z-index: 1; }

      .ed-top {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 4px; margin-bottom: 8px;
      }
      .ed-top.draggable { cursor: move; }
      .ed-top .left { display: flex; align-items: center; gap: 7px; }
      .ed-top .dot {
        width: 5px; height: 5px; border-radius: 99px;
        background: #cc785c;
        box-shadow: 0 0 6px rgba(204,120,92,0.55);
        transition: background 200ms, box-shadow 200ms;
      }
      .ed-top .dot.error  { background: #ed4d3a; box-shadow: 0 0 6px rgba(237,77,58,0.7); }
      .ed-top .dot.loading{ animation: cut-pulse 1.4s infinite; }
      @keyframes cut-pulse {
        0%, 100% { opacity: 0.5; }
        50%      { opacity: 1; }
      }
      .ed-top .plan {
        font-family: 'Geist Mono', ui-monospace, 'SF Mono', monospace;
        font-size: 9.5px; font-weight: 500;
        letter-spacing: 0.18em; text-transform: uppercase;
        color: #d6cfc4;
      }
      .ed-top .x {
        width: 18px; height: 18px; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        color: #8b8275; cursor: pointer; font-size: 13px; line-height: 1;
        transition: background 150ms, color 150ms;
        background: transparent; border: none; font-family: inherit;
      }
      .ed-top .x:hover { background: rgba(255,255,255,0.05); color: #d6cfc4; }

      .ed-top .refresh {
        width: 18px; height: 18px; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        color: #8b8275; cursor: pointer; line-height: 1;
        transition: background 150ms, color 150ms;
        background: transparent; border: none; font-family: inherit;
        padding: 0;
      }
      .ed-top .refresh:hover { background: rgba(255,255,255,0.05); color: #d6cfc4; }
      .ed-top .refresh:active { transform: scale(0.92); }
      .ed-top .refresh svg {
        width: 12px; height: 12px;
        transition: transform 200ms ease;
      }
      .ed-top .refresh:hover svg { transform: rotate(45deg); }
      .ed-top .refresh.spinning svg {
        animation: cut-spin 0.8s linear infinite;
      }
      @keyframes cut-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      .ed-top .actions { display: flex; align-items: center; gap: 2px; }

      .expanded { width: 360px; padding: 14px; }
      .ed-row { display: flex; gap: 10px; margin-bottom: 8px; align-items: stretch; }

      .ed-ring {
        flex: none; width: 148px; height: 148px;
        display: flex; align-items: center; justify-content: center;
        position: relative; cursor: crosshair;
      }
      .ed-ring svg { display: block; overflow: visible; }
      .ed-ring circle.fill {
        transition: stroke 280ms, stroke-dashoffset 600ms ease, stroke-width 200ms;
      }
      .ed-ring.hov-inner circle.fill.inner { stroke-width: 8; }
      .ed-ring.hov-outer circle.fill.outer { stroke-width: 9; }
      .ed-num {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        font-family: 'Fraunces', 'Iowan Old Style', Georgia, serif;
        font-weight: 300; font-size: 40px;
        letter-spacing: -0.04em; line-height: 1;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
        color: #f5f4ee;
        transition: opacity 220ms, transform 220ms, font-size 200ms;
        pointer-events: none;
      }
      .ed-num.is-wide { font-size: 30px; }
      .ed-num.is-wide .pct { font-size: 0.42em; }
      .ed-num .pct {
        font-size: 0.4em;
        font-weight: 400;
        font-style: italic;
        margin-left: 2px;
        opacity: 0.55;
      }
      .ed-num.is-hour { opacity: 1; transform: scale(1); }
      .ed-num.is-week { opacity: 0; transform: scale(0.96); }
      .ed-ring.hov-outer .ed-num.is-hour { opacity: 0; transform: scale(0.96); }
      .ed-ring.hov-outer .ed-num.is-week { opacity: 1; transform: scale(1); }

      .ed-week {
        flex: 1;
        background: rgba(255,255,255,0.018);
        border: 1px solid #3a352f;
        border-radius: 12px;
        padding: 10px 12px;
        display: flex; flex-direction: column;
        min-width: 0;
      }
      .ed-week-head {
        display: flex; align-items: baseline; gap: 7px;
        margin-bottom: 6px;
      }
      .ed-week-head .label {
        font-size: 9px; letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #8b8275; font-weight: 500;
      }
      .ed-week-head .big {
        font-family: 'Fraunces', serif;
        font-weight: 300; font-size: 21px;
        letter-spacing: -0.04em; line-height: 1;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
      }
      .ed-week-head .big .pct {
        font-size: 12px; font-style: italic; font-weight: 400;
      }
      .ed-week-head .resets {
        margin-left: auto;
        font-family: 'Fraunces', serif;
        font-style: italic; font-size: 10.5px;
        color: #8b8275;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
      }
      .ed-week-head .resets b {
        color: #d6cfc4; font-style: normal; font-weight: 500;
        font-family: 'Instrument Sans', sans-serif;
      }
      .ed-divider {
        height: 1px; margin: 0 -2px 7px;
        background: linear-gradient(90deg, transparent, #48413a 30%, #48413a 70%, transparent);
      }
      .ed-bars {
        display: flex; flex-direction: column;
        gap: 6px; flex: 1;
        justify-content: space-around;
      }
      .ed-bar {
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
        min-width: 0;
      }
      .ed-bar .top-row {
        display: flex; justify-content: space-between;
        align-items: baseline; margin-bottom: 3px;
        gap: 6px; min-width: 0;
      }
      .ed-bar .name {
        font-size: 11px; color: #d6cfc4; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        min-width: 0;
      }
      .ed-bar .name small {
        color: #8b8275; font-weight: 400; margin-left: 3px;
        font-size: 9.5px;
        font-family: 'Geist Mono', ui-monospace, monospace;
      }
      .ed-bar .val {
        font-family: 'Geist Mono', ui-monospace, monospace;
        font-size: 10.5px; color: #d6cfc4; font-weight: 500;
        flex: none;
      }
      .ed-bar .track {
        height: 4px; background: rgba(72,65,58,0.4);
        border-radius: 99px; overflow: hidden;
      }
      .ed-bar .fill {
        height: 100%; border-radius: 99px;
        transition: width 500ms ease, background 280ms, box-shadow 280ms;
      }
      .ed-bar .fill.crit { box-shadow: 0 0 5px rgba(237,77,58,0.45); }
      .ed-week-head .big.tier-crit { text-shadow: 0 0 8px rgba(237,77,58,0.4); }

      .clr-low    { color: #7cb87c; }
      .clr-midlow { color: #c9bd5a; }
      .clr-mid    { color: #d4a857; }
      .clr-high   { color: #e2614e; }
      .clr-crit   { color: #ed4d3a; }
      .bg-low    { background: linear-gradient(90deg, #6a9970, #7cb87c); }
      .bg-midlow { background: linear-gradient(90deg, #a8a04e, #c9bd5a); }
      .bg-mid    { background: linear-gradient(90deg, #c89a4f, #d4a857); }
      .bg-high   { background: linear-gradient(90deg, #d65947, #e2614e); }
      .bg-crit   { background: linear-gradient(90deg, #d83a28, #ed4d3a); }
      .bg-disabled { background: transparent; }

      .ed-bar.disabled .name { color: #8b8275; font-style: italic; }
      .ed-bar.disabled .val {
        color: #6a625a;
        font-style: italic;
        font-family: 'Fraunces', serif;
        font-size: 11px;
        font-weight: 400;
      }
      .ed-bar.disabled .track {
        background: rgba(72,65,58,0.25);
      }

      .ed-reset {
        text-align: center;
        font-family: 'Fraunces', serif;
        font-style: italic; font-size: 11.5px;
        color: #8b8275; margin: 6px 0 10px;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
      }
      .ed-reset b {
        color: #d6cfc4; font-style: normal; font-weight: 500;
        font-family: 'Instrument Sans', sans-serif;
      }

      .ed-daily {
        background: rgba(255,255,255,0.018);
        border: 1px solid #3a352f;
        border-radius: 12px;
        padding: 10px 12px 8px;
      }
      .ed-daily .head-row {
        display: flex; justify-content: space-between;
        align-items: baseline; margin-bottom: 6px;
      }
      .ed-daily .label {
        font-size: 9px; letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #8b8275; font-weight: 500;
      }
      .ed-daily .meta {
        font-family: 'Fraunces', serif;
        font-style: italic; font-size: 11px;
        color: #8b8275;
      }
      .b-chart-wrap { position: relative; height: 90px; }
      .b-chart-wrap svg { display: block; width: 100%; height: 100%; overflow: visible; }
      .b-dot {
        fill: #a89e91;
        stroke: #221f1c; stroke-width: 2;
        transition: r 200ms, fill 200ms;
      }
      .b-dot.null { fill: #5e564e; opacity: 0.5; }
      .b-dot.today {
        fill: #cc785c;
        filter: drop-shadow(0 0 5px rgba(204,120,92,0.7));
      }

      .b-lbl {
        position: absolute;
        transform: translate(-50%, -100%);
        margin-top: -4px;
        font-family: 'Fraunces', serif;
        font-style: italic; font-size: 10px;
        color: #a89e91;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
        pointer-events: none;
        white-space: nowrap;
        z-index: 2;
      }
      .b-lbl .pct { font-size: 7.5px; opacity: 0.7; margin-left: 0.5px; }
      .b-lbl.today {
        color: #cc785c;
        font-weight: 500;
        font-size: 11px;
      }

      .ed-daily .lbls {
        display: grid; grid-template-columns: repeat(7, 1fr);
        margin-top: 4px;
        font-family: 'Geist Mono', ui-monospace, monospace;
        font-size: 9px; font-weight: 500;
        color: #5e564e; letter-spacing: 0.04em;
        text-align: center;
      }
      .ed-daily .lbls span { text-transform: uppercase; }
      .ed-daily .lbls span.today { color: #cc785c; font-weight: 600; }

      .collapsed {
        display: inline-flex; align-items: center; gap: 10px;
        padding: 7px 13px; border-radius: 999px;
        cursor: pointer;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
        transition: transform 150ms;
      }
      .collapsed:hover { transform: translateY(-1px); }

      .pill-mini {
        width: 22px; height: 22px; border-radius: 99px;
        flex: none; position: relative;
      }
      .pill-mini .arc-outer,
      .pill-mini .arc-inner,
      .pill-mini .core {
        position: absolute; inset: 0; border-radius: 99px;
      }
      .pill-mini .arc-inner { inset: 3px; }
      .pill-mini .core      { inset: 7px; background: #221f1c; z-index: 1; }

      .collapsed .num {
        font-family: 'Fraunces', serif;
        font-style: italic; font-size: 15px;
        font-weight: 400; letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums lining-nums;
        font-feature-settings: 'lnum' 1, 'tnum' 1;
      }
      .collapsed .num .pct {
        font-size: 9.5px; letter-spacing: 0;
        margin-left: 1px; opacity: 0.8;
      }
      .collapsed .sep {
        color: #5e564e; font-style: normal;
        font-family: 'Instrument Sans', sans-serif;
        font-weight: 400; font-size: 13px;
      }

      .err {
        padding: 16px 14px;
        font-family: 'Fraunces', serif;
        font-size: 13px; color: #f5f4ee; text-align: center;
        line-height: 1.5;
      }
      .err .msg { color: #ed4d3a; font-style: italic; }
      .err .detail {
        font-size: 10.5px; color: #8b8275; margin-top: 6px;
        font-family: 'Geist Mono', monospace; font-style: normal;
      }
      .err .retry {
        display: inline-block; margin-top: 12px;
        padding: 5px 12px; border-radius: 6px;
        background: rgba(255,255,255,0.05);
        border: 1px solid #48413a;
        color: #d6cfc4; cursor: pointer;
        font-family: 'Instrument Sans', sans-serif;
        font-size: 11px; font-style: normal;
        transition: background 150ms;
      }
      .err .retry:hover { background: rgba(255,255,255,0.08); }
    `;

  // =====================================================================
  // RENDER
  // =====================================================================

  function render() {
    const host = ensureHost();
    if (!host) return;
    const shadow = host.shadowRoot;
    const root = shadow.getElementById("cut2-root");
    if (!root) return;

    if (state.error && !state.data) {
      renderError(root);
    } else if (state.collapsed) {
      renderCollapsed(root);
    } else {
      renderExpanded(root);
    }
    applySavedPosition(root);
    updateLiveTimes();
  }

  function renderCollapsed(root) {
    const { usage } = state.data || {};
    const w = Math.round(usage?.seven_day?.utilization ?? 0);
    const h = Math.round(usage?.five_hour?.utilization ?? 0);
    const tierW = tierFor(w),
      tierH = tierFor(h);
    const colW = PALETTE[tierW].stroke;
    const colH = PALETTE[tierH].stroke;

    root.innerHTML = `
          <div class="card collapsed" id="cut2-card">
            <span class="pill-mini">
              <span class="arc-outer" style="background: conic-gradient(${colW} 0% ${w}%, rgba(72,65,58,0.45) ${w}% 100%)"></span>
              <span class="arc-inner" style="background: conic-gradient(${colH} 0% ${h}%, #221f1c ${h}% 100%)"></span>
              <span class="core"></span>
            </span>
            <span class="num clr-${tierH}">${h}<span class="pct">%</span></span>
            <span class="sep">/</span>
            <span class="num clr-${tierW}">${w}<span class="pct">%</span></span>
          </div>
        `;

    const card = root.querySelector("#cut2-card");
    if (card) attachDrag(card, root, () => setCollapsed(false));
  }

  function renderExpanded(root) {
    const { usage, plan, routines } = state.data || {};
    const w = usage?.seven_day?.utilization ?? 0;
    const h = usage?.five_hour?.utilization ?? 0;
    const fiveReset = usage?.five_hour?.resets_at;
    const sevenReset = usage?.seven_day?.resets_at;
    const tierW = tierFor(w);
    const bars = pickWeeklyBars(usage);

    const routineCount = countRoutinesToday(routines);
    const routineLimit = routineCount?.limit ?? routineLimitForPlan(plan);
    const showRoutines =
      routineCount != null && routineLimit && routineLimit > 0;

    const history = getHistoryDays(7);
    const todayUsage = history[history.length - 1]?.usage;
    const dotCls = state.error
      ? "dot error"
      : state.loading
        ? "dot loading"
        : "dot";

    root.innerHTML = `
          <div class="card expanded" id="cut2-card">
            <div class="ed-top draggable" id="cut2-handle">
              <div class="left">
                <span class="${dotCls}"></span>
                <span class="plan">${escapeHtml(plan || "Claude")}</span>
              </div>
              <div class="actions">
                <button class="refresh" id="cut2-refresh" title="Refresh now" aria-label="Refresh">
                  <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M2 8a6 6 0 0 1 10.5-3.97M14 8a6 6 0 0 1-10.5 3.97"
                          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <path d="M12.5 1.5v3.2h-3.2M3.5 14.5v-3.2h3.2"
                          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
                <button class="x" id="cut2-close" title="Collapse">×</button>
              </div>
            </div>

            <div class="ed-row">
              <div class="ed-ring" id="cut2-ring">
                ${ringSVG(w, h)}
              </div>

              <div class="ed-week">
                <div class="ed-week-head">
                  <span class="label">Weekly</span>
                  <span class="big clr-${tierW} ${tierW === "crit" ? "tier-crit" : ""}">${Math.round(w)}<span class="pct">%</span></span>
                  <span class="resets" data-reset-at="${sevenReset || ""}">
                    ${sevenReset ? "in <b>" + fmtCountdown(new Date(sevenReset).getTime() - Date.now()) + "</b>" : ""}
                  </span>
                </div>
                <div class="ed-divider"></div>
                <div class="ed-bars">
                  ${bars.map((b) => weeklyBarRow(b)).join("")}
                  ${showRoutines ? routinesRow(routineCount.used, routineLimit) : ""}
                </div>
              </div>
            </div>

            <div class="ed-reset" data-reset-at="${fiveReset || ""}">
              ${
                fiveReset
                  ? "5-hour resets in <b>" +
                    fmtCountdown(new Date(fiveReset).getTime() - Date.now()) +
                    "</b>"
                  : "5-hour limit fresh"
              }
            </div>

            <div class="ed-daily">
              <div class="head-row">
                <span class="label">Last 7 Days</span>
                <span class="meta">${todayUsage == null ? "building history…" : ""}</span>
              </div>
              <div class="b-chart-wrap" id="cut2-area">
                ${areaChartHTML(history)}
              </div>
              <div class="lbls">
                ${history
                  .map(
                    (d) =>
                      `<span class="${d.isToday ? "today" : ""}">${escapeHtml(d.label)}</span>`,
                  )
                  .join("")}
              </div>
            </div>
          </div>
        `;

    const handle = root.querySelector("#cut2-handle");
    const closeBtn = root.querySelector("#cut2-close");
    const refreshBtn = root.querySelector("#cut2-refresh");
    const ring = root.querySelector("#cut2-ring");

    closeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      setCollapsed(true);
    });

    refreshBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      refreshBtn.classList.add("spinning");
      tick(true);
    });

    if (state.loading && refreshBtn) refreshBtn.classList.add("spinning");

    if (handle) attachDrag(handle, root, null);
    if (ring) attachRingHover(ring);
  }

  function weeklyBarRow(bar) {
    if (bar.disabled) {
      return `
              <div class="ed-bar disabled">
                <div class="top-row">
                  <span class="name">${escapeHtml(bar.label)}</span>
                  <span class="val">N/A</span>
                </div>
                <div class="track"><div class="fill bg-disabled" style="width:0%"></div></div>
              </div>
            `;
    }

    const tier = bar.forceCrit ? "crit" : tierFor(bar.pct);
    const pctRound = bar.pct < 10 ? bar.pct.toFixed(1) : Math.round(bar.pct);
    const sub = bar.sub ? ` <small>${escapeHtml(bar.sub)}</small>` : "";
    const critCls = tier === "crit" ? " crit" : "";
    return `
          <div class="ed-bar">
            <div class="top-row">
              <span class="name">${escapeHtml(bar.label)}${sub}</span>
              <span class="val clr-${tier}">${pctRound}%</span>
            </div>
            <div class="track">
              <div class="fill bg-${tier}${critCls}" style="width:${clamp(bar.pct, 0, 100)}%"></div>
            </div>
          </div>
        `;
  }

  function routinesRow(used, limit) {
    const pct = clamp((used / limit) * 100, 0, 100);
    const tier = tierFor(pct);
    const critCls = tier === "crit" ? " crit" : "";
    return `
          <div class="ed-bar">
            <div class="top-row">
              <span class="name">Routines <small>${used}/${limit}</small></span>
              <span class="val clr-${tier}">${Math.round(pct)}%</span>
            </div>
            <div class="track">
              <div class="fill bg-${tier}${critCls}" style="width:${pct}%"></div>
            </div>
          </div>
        `;
  }

  function renderError(root) {
    const msg = state.error?.message || "unknown error";
    root.innerHTML = `
          <div class="card expanded" style="padding:0;">
            <div class="ed-top draggable" id="cut2-handle" style="padding:14px 18px 12px;">
              <div class="left">
                <span class="dot error"></span>
                <span class="plan">Error</span>
              </div>
              <button class="x" id="cut2-close" title="Collapse">×</button>
            </div>
            <div class="err">
              <div class="msg">Couldn't fetch usage</div>
              <div class="detail">${escapeHtml(msg)}</div>
              <button class="retry" id="cut2-retry">Try again</button>
            </div>
          </div>
        `;
    root
      .querySelector("#cut2-retry")
      ?.addEventListener("click", () => tick(true));
    root.querySelector("#cut2-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setCollapsed(true);
    });
    const handle = root.querySelector("#cut2-handle");
    if (handle) attachDrag(handle, root, null);
  }

  // =====================================================================
  // LIVE TIMES
  // =====================================================================

  function updateLiveTimes() {
    const host = ensureHost();
    const shadow = host?.shadowRoot;
    if (!shadow) return;

    const fiveEl = shadow.querySelector(".ed-reset[data-reset-at]");
    if (fiveEl?.dataset.resetAt) {
      const ms = new Date(fiveEl.dataset.resetAt).getTime() - Date.now();
      fiveEl.innerHTML =
        ms > 0
          ? "5-hour resets in <b>" + fmtCountdown(ms) + "</b>"
          : "5-hour resetting…";
    }

    const weekEl = shadow.querySelector(".ed-week-head .resets[data-reset-at]");
    if (weekEl?.dataset.resetAt) {
      const ms = new Date(weekEl.dataset.resetAt).getTime() - Date.now();
      weekEl.innerHTML =
        ms > 0 ? "in <b>" + fmtCountdown(ms) + "</b>" : "resetting…";
    }
  }

  // =====================================================================
  // HOVER
  // =====================================================================

  function attachRingHover(ring) {
    if (!ring) return;
    const G = HOVER_GEOM;
    const innerMin = G.R_INNER - G.SW_INNER / 2 - G.PAD;
    const innerMax = G.R_INNER + G.SW_INNER / 2 + G.PAD;
    const outerMin = G.R_OUTER - G.SW_OUTER / 2 - G.PAD;
    const outerMax = G.R_OUTER + G.SW_OUTER / 2 + G.PAD;
    let stickyMode = null;

    function radius(x, y) {
      const r = ring.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = x - cx,
        dy = y - cy;
      return Math.sqrt(dx * dx + dy * dy) * (G.SIZE / r.width);
    }
    function whichBand(r) {
      if (r >= innerMin && r <= innerMax) return "hour";
      if (r >= outerMin && r <= outerMax) return "week";
      return null;
    }
    function setMode(m) {
      ring.classList.toggle("hov-inner", m === "hour");
      ring.classList.toggle("hov-outer", m === "week");
    }

    ring.addEventListener("mousemove", (e) => {
      if (stickyMode) return;
      setMode(whichBand(radius(e.clientX, e.clientY)));
    });
    ring.addEventListener("mouseleave", () => {
      if (!stickyMode) setMode(null);
    });
    ring.addEventListener("click", (e) => {
      const r = radius(e.clientX, e.clientY);
      let pick;
      if (r <= G.R_INNER + 2) pick = "hour";
      else if (r <= G.R_OUTER + G.SW_OUTER / 2 + G.PAD) pick = "week";
      else pick = null;
      if (stickyMode === pick) {
        stickyMode = null;
        setMode(null);
      } else {
        stickyMode = pick;
        setMode(pick);
      }
    });
  }

  // =====================================================================
  // DRAG
  // =====================================================================

  function attachDrag(handle, root, onClick) {
    if (!handle || !root) return;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".x, .retry, .refresh")) return;

      const startX = e.clientX,
        startY = e.clientY;
      const rect = root.getBoundingClientRect();
      const startRight = window.innerWidth - rect.right;
      const startBottom = window.innerHeight - rect.bottom;
      let moved = false;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          moved = true;
          document.body.style.cursor = "grabbing";
        }
        if (moved) {
          const r = root.getBoundingClientRect();
          const newRight = clamp(
            startRight - dx,
            8,
            window.innerWidth - r.width - 8,
          );
          const newBottom = clamp(
            startBottom - dy,
            8,
            window.innerHeight - r.height - 8,
          );
          root.style.right = newRight + "px";
          root.style.bottom = newBottom + "px";
        }
      };

      const onUp = (ev) => {
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) {
          storeSet(POSITION_KEY, {
            right: parseInt(root.style.right, 10) || 20,
            bottom: parseInt(root.style.bottom, 10) || 20,
          });
        } else if (onClick) {
          onClick(ev);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  let _savedPosition = null;
  function applySavedPosition(root) {
    const pos = _savedPosition;
    if (!pos || !Number.isFinite(pos.right) || !Number.isFinite(pos.bottom))
      return;
    const r = root.getBoundingClientRect();
    const w = r.width || 360;
    const h = r.height || 280;
    root.style.right = clamp(pos.right, 8, window.innerWidth - w - 8) + "px";
    root.style.bottom = clamp(pos.bottom, 8, window.innerHeight - h - 8) + "px";
  }

  function reclampOnResize() {
    const host = ensureHost();
    const root = host?.shadowRoot?.getElementById("cut2-root");
    if (!root) return;
    const r = root.getBoundingClientRect();
    const right = clamp(
      window.innerWidth - r.right,
      8,
      window.innerWidth - r.width - 8,
    );
    const bottom = clamp(
      window.innerHeight - r.bottom,
      8,
      window.innerHeight - r.height - 8,
    );
    root.style.right = right + "px";
    root.style.bottom = bottom + "px";
    storeSet(POSITION_KEY, { right, bottom });
  }

  // =====================================================================
  // HOST
  // =====================================================================

  const HOST_ID = "cut2-host";
  let _host = null;

  function ensureHost() {
    if (_host && document.body && document.body.contains(_host)) return _host;
    if (!document.body) return null;

    _host = document.createElement("div");
    _host.id = HOST_ID;
    document.body.appendChild(_host);
    const shadow = _host.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONT_LINK_HREF;
    shadow.appendChild(link);

    const styleEl = document.createElement("style");
    styleEl.textContent = STYLES;
    shadow.appendChild(styleEl);

    const root = document.createElement("div");
    root.id = "cut2-root";
    root.className = "root";
    shadow.appendChild(root);

    return _host;
  }

  // =====================================================================
  // STATE
  // =====================================================================

  const state = {
    data: null,
    error: null,
    loading: false,
    collapsed: true, // populated from storage during init()
  };

  async function setCollapsed(v) {
    state.collapsed = v;
    await storeSet(COLLAPSED_KEY, v);
    render();
  }

  function updateStatusDot() {
    const host = ensureHost();
    const shadow = host?.shadowRoot;
    const dot = shadow?.querySelector(".ed-top .dot");
    if (!dot) return;
    dot.classList.remove("error", "loading");
    if (state.error) dot.classList.add("error");
    else if (state.loading) dot.classList.add("loading");
  }

  async function tick(force = false) {
    if (!force && document.hidden) return;
    state.loading = true;
    updateStatusDot();
    try {
      const result = await fetchUsage();
      state.data = result;
      state.error = null;
      await recordSnapshot(result.usage);
      await refreshHistoryCache();
    } catch (e) {
      state.error = e;
      console.warn("[CUT] fetch failed:", e);
    } finally {
      state.loading = false;
    }
    render();
  }

  // =====================================================================
  // BOOT
  // =====================================================================

  async function init() {
    if (!document.body) {
      setTimeout(init, 50);
      return;
    }

    // Hydrate state from storage before first render.
    state.collapsed = await storeGet(COLLAPSED_KEY, true);
    _savedPosition = await storeGet(POSITION_KEY, null);
    await refreshHistoryCache();

    ensureHost();
    render();
    await tick(true);

    setInterval(tick, REFRESH_MS);
    setInterval(updateLiveTimes, UI_TICK_MS);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick(true);
    });
    window.addEventListener("resize", reclampOnResize);

    console.log(
      "[CUT] v2.3.0 ready — API every",
      REFRESH_MS / 1000,
      "s, UI every",
      UI_TICK_MS / 1000,
      "s.",
    );
  }

  await init();
})();
