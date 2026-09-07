/**
 * Self-contained operator control panel, served as one HTML string from GET
 * /cloud/v1/admin when admin access is configured. A single inline page, no
 * build step, no framework: an internal tool that must keep working with zero
 * deploy ceremony.
 *
 * The admin token is NEVER baked in. The operator pastes it once, or signs in
 * with Google when ALOUD_ADMIN_EMAILS is set (the on-the-go path: the device
 * then holds a 7-day session JWT, not the root token). Either way the credential
 * lives in localStorage for this origin and rides every call as a Bearer header.
 * Same-origin with the API, so no CORS in play.
 *
 * Everything the page can do maps to a gated endpoint in routes/admin.ts;
 * unauthorized, those return 401/404 and the page is an inert form.
 *
 * The Google button needs the web OAuth client id (injected by the route, ''
 * disables it) AND this server's origin listed under "Authorized JavaScript
 * origins" on that client in the Google Cloud console.
 */

import {
    TYPICAL_SESSION,
    TYPICAL_SESSION_MINUTES,
    TTS_CHAR_PROFILES,
    UTILITY_CREDITS_PER_HOUR,
    estimateModels,
    estimateStt,
    estimateVoices,
} from '../pricing/estimate.js';

export function renderAdminPanel(googleClientId?: string): string {
    return ADMIN_PANEL_TEMPLATE.replace(
        '"__GOOGLE_CLIENT_ID__"',
        JSON.stringify(googleClientId ?? '')
    )
        .replace('"__ESTIMATE_PROFILE__"', JSON.stringify(assumedPerHour()))
        .replace('"__BADGES__"', JSON.stringify(badgeRates()));
}

/**
 * The credits/hr the app ADVERTISES, keyed the way usage rows are keyed
 * (kind:provider:model), so the panel can print each measured rate beside its
 * badge. Computed by the same estimate code the picker uses, never copied.
 * Voices carry the talk band (spacious / typical / engaged) since the picker
 * shows a range; the STT and utility legs are flat.
 */
function badgeRates(): {
    llm: Record<string, number>;
    tts: Record<string, { spacious: number; typical: number; engaged: number }>;
    stt: number;
    utility: number;
} {
    const llm: Record<string, number> = {};
    for (const m of estimateModels()) llm[`${m.provider}:${m.model}`] = m.creditsPerHour;
    const tts: Record<string, { spacious: number; typical: number; engaged: number }> = {};
    for (const v of estimateVoices()) {
        if (v.costUsdPerHourTypical > 0) tts[v.voiceId] = v.creditsPerHour;
    }
    return { llm, tts, stt: estimateStt().creditsPerHour, utility: UTILITY_CREDITS_PER_HOUR };
}

/**
 * What pricing/estimate.ts ASSUMES per hour, injected so the per-hour cards can
 * print measured-vs-assumed side by side. Derived from TYPICAL_SESSION rather
 * than copied: the whole point of the panel's calibration row is to catch that
 * profile drifting, which a second hardcoded copy of it would hide.
 */
function assumedPerHour(): Record<string, number> {
    const perHour = 60 / TYPICAL_SESSION_MINUTES;
    const perTurn = 1 / TYPICAL_SESSION.llmCalls;
    return {
        turns: TYPICAL_SESSION.llmCalls * perHour,
        sttSeconds: TYPICAL_SESSION.sttSeconds * perHour,
        // The voice badges price from TTS_CHAR_PROFILES, not TYPICAL_SESSION.ttsChars
        // (a Gemma-era figure the Aug 18 reseed left as an upper bound), so
        // the card compares against what users are actually shown: the band.
        ttsCharsTypical: TTS_CHAR_PROFILES.typical * perHour,
        ttsCharsEngaged: TTS_CHAR_PROFILES.engaged * perHour,
        input: TYPICAL_SESSION.llmTokensIn * perHour,
        output: TYPICAL_SESSION.llmTokensOut * perHour,
        cacheRead: TYPICAL_SESSION.llmCacheRead * perHour,
        cacheCreation: TYPICAL_SESSION.llmCacheCreation * perHour,
        inputPerTurn: TYPICAL_SESSION.llmTokensIn * perTurn,
        outputPerTurn: TYPICAL_SESSION.llmTokensOut * perTurn,
        cacheReadPerTurn: TYPICAL_SESSION.llmCacheRead * perTurn,
        cacheCreationPerTurn: TYPICAL_SESSION.llmCacheCreation * perTurn,
    };
}

const ADMIN_PANEL_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>aloud - admin</title>
<style>
  :root {
    --bg: #14110f; --panel: #1d1916; --line: #2e2823; --ink: #efe7dd;
    --dim: #a89a8c; --accent: #e0a96d; --good: #7fb389; --bad: #d98a7a;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 20px; max-width: 980px; margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .3px;
       display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h1 .dot { color: var(--accent); }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px;
       color: var(--dim); margin: 22px 0 10px; font-weight: 600;
       scroll-margin-top: 16px;
       display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* Control clusters that sit at the right edge of a heading and drop onto
     their own line when the viewport is too narrow to share it. */
  .controls { margin-left: auto; display: flex; gap: 8px; align-items: center;
              flex-wrap: wrap; text-transform: none; letter-spacing: normal; }
  /* Quick nav - fixed in the left gutter, only when the viewport is wide
     enough to fit it beside the centered 980px column. */
  #quickNav { display: none; }
  @media (min-width: 1360px) {
    #quickNav { display: block; position: fixed; top: 34px;
                left: calc(50vw - 490px - 176px); width: 150px; font-size: 15px; }
    #quickNav a { display: block; color: var(--dim); text-decoration: none;
                  padding: 3px 0 3px 10px; border-left: 2px solid var(--line); }
    #quickNav a:hover { color: var(--accent); border-left-color: var(--accent); }
  }
  #quickNav.hidden { display: none; }
  .sub { color: var(--dim); font-size: 14px; margin: 0 0 14px; }
  /* Explainer paragraphs are toggled as a group - hidden by default, revealed
     by the "Show explanations" button in the header. */
  body.hide-help .help-text { display: none; }
  /* Compact view (the default): the key cards and tables only. Anything
     marked .detail - the long tail of per-hour cards, itemized sits, cache
     breakdown, distributions, daily table - waits behind the header's
     "Full view" button, so each section fits about a screen. */
  body.compact .detail { display: none; }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px; }
  /* A stat grid directly before a card used to touch it. */
  .grid { margin-bottom: 10px; }
  label { display: block; font-size: 14px; color: var(--dim); margin-bottom: 5px; }
  input, textarea {
    width: 100%; padding: 9px 11px; background: #100d0b; color: var(--ink);
    border: 1px solid var(--line); border-radius: 8px; font: inherit;
  }
  textarea { resize: vertical; min-height: 60px; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .check { display: flex; align-items: center; gap: 7px; cursor: pointer; font-size: 14px; }
  .check input { width: auto; }
  button.xs { padding: 4px 10px; font-size: 13px; }
  button {
    padding: 8px 14px; background: var(--accent); color: #1a1208; border: none;
    border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1; min-width: 140px; }
  .row > button { flex: 0 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  /* Wide tables scroll inside their card instead of spilling past its edge. */
  .table-wrap { overflow-x: auto; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  /* Headers stay on one line; a wide table scrolls in its .table-wrap rather
     than stacking every header word (the 13-column sits table ran 7 rows tall). */
  th { white-space: nowrap; }
  /* Long free-text cells (incident detail) clip with the full text on hover. */
  td.clip { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Long unbreakable values (emails) give up width first; the action column
     never wraps and takes only what its button needs. */
  td.wrap { overflow-wrap: anywhere; }
  th.act, td.act { width: 1%; white-space: nowrap; text-align: right; }
  th { color: var(--dim); font-weight: 600; font-size: 13px;
       text-transform: uppercase; letter-spacing: .5px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #221d19; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          font-size: 13px; font-weight: 600; }
  /* A row of pills standing in for a stat grid (incident kinds). */
  .pills { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
  .pills .lead { font-weight: 700; margin-right: 4px; }
  .pills .lead.bad { color: var(--bad); }
  .pill.warn { background: rgba(217,138,122,.16); color: var(--bad); }
  .pill.paid { background: rgba(127,179,137,.18); color: var(--good); }
  .pill.free { background: rgba(168,154,140,.16); color: var(--dim); }
  .prov { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 13px;
          border: 1px solid var(--line); color: var(--dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .stat { background: #100d0b; border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; min-width: 0; }
  /* One line per label, clipped with the full label on hover, so a card is
     always two lines tall and the grid rows line up. */
  .stat .k { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .4px;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat .v { font-size: 17px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums;
             overflow-wrap: anywhere; }
  .stat .v.warn { color: var(--bad); }
  .msg { font-size: 14px; margin-top: 8px; min-height: 18px; }
  .msg.ok { color: var(--good); }
  .msg.err { color: var(--bad); }
  .muted { color: var(--dim); }
  /* The "/ assumed" half of a measured-vs-assumed card: same size and weight,
     a step down in color only. */
  .assumed { color: var(--dim); }
  .hidden { display: none; }
  code { background: #100d0b; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6);
              display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--panel); border: 1px solid var(--line);
           border-radius: var(--radius); padding: 20px; max-width: 560px; width: 100%;
           max-height: 80vh; overflow: auto; }
  @media (max-width: 720px) {
    body { padding: 14px; }
    .card { padding: 13px 14px; }
    /* Two stat cells per row on a phone: narrower minimum + smaller numbers. */
    .grid { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
    .stat { padding: 9px 10px; }
    .stat .k { font-size: 13px; }
    .stat .v { font-size: 17px; }
    th, td { padding: 7px 8px; }
    .modal-bg { padding: 10px; }
    .modal { padding: 16px; max-height: 90vh; }
  }
  .modal h3 { margin: 0 0 2px; font-size: 16px; }
  .x { float: right; background: none; border: none; color: var(--dim);
       font-size: 22px; cursor: pointer; padding: 0; line-height: 1; }
</style>
</head>
<body class="hide-help compact">
  <nav id="quickNav" class="hidden" aria-label="Sections">
    <a href="#sec-spend">Spend &amp; abuse</a>
    <a href="#sec-cost">Cost attribution</a>
    <a href="#sec-history">Over time</a>
    <a href="#sec-free">Free credits</a>
    <a href="#sec-pause">Pause spending</a>
    <a href="#sec-grant">Grant credits</a>
    <a href="#sec-accounts">Accounts</a>
    <a href="#sec-retreats">Retreats</a>
  </nav>
  <h1><span>aloud<span class="dot">.</span> admin</span><span class="controls"><label class="check hidden" id="liveWrap" style="font-size:13px;font-weight:400"><input type="checkbox" id="autoRefresh"> live (60s)</label><button id="signOut" class="ghost xs hidden" type="button">Sign out</button><button id="toggleCompact" class="ghost xs" type="button">Full view</button><button id="toggleHelp" class="ghost xs" type="button">Show explanations</button></span></h1>
  <p class="sub help-text">Operator console - spend, accounts, and credit grants. Token-gated; never share this URL with the token in it.</p>

  <div class="card" id="authCard">
    <label for="tok">Admin token (<code>ALOUD_ADMIN_TOKEN</code>)</label>
    <div class="row">
      <div><input id="tok" type="password" placeholder="paste token" autocomplete="off"></div>
      <button id="connect">Connect</button>
      <button class="ghost" id="forget">Forget</button>
    </div>
    <div id="gsiWrap" class="hidden" style="margin-top:14px">
      <label>…or sign in (admin accounts only)</label>
      <div id="gsiBtn"></div>
    </div>
    <div class="msg" id="authMsg"></div>
  </div>

  <div id="app" class="hidden">
    <h2 id="sec-spend">Spend &amp; abuse
      <span class="controls">
        <select id="metricsWindow" style="width:auto;padding:3px 7px;font-size:13px">
          <option value="24">last 24h</option>
          <option value="168">last 7d</option>
          <option value="720">last 30d</option>
        </select>
        <button class="ghost" id="refreshMetrics" style="padding:3px 9px;font-size:13px">refresh</button>
      </span>
    </h2>
    <div class="grid" id="stats"></div>

    <h2 id="sec-incidents">Incidents
      <span class="controls">
        <select id="incidentWindow" style="width:auto;padding:3px 7px;font-size:13px">
          <option value="24">last 24h</option>
          <option value="168" selected>last 7d</option>
          <option value="720">last 30d</option>
        </select>
        <label class="check" style="font-size:13px;white-space:nowrap;text-transform:none;letter-spacing:normal;font-weight:400"><input type="checkbox" class="omitAdmin"> omit admin</label>
        <button class="ghost" id="refreshIncidents" style="padding:3px 9px;font-size:13px">refresh</button>
      </span>
    </h2>
    <p class="sub help-text" style="margin:-4px 0 10px">What the app handled quietly on the cloud path. <b>llm_empty</b>: a completion came back with no text (finish=length with tokens_out &gt; 0 means reasoning ate the budget). <b>llm/stt/tts_error</b>: the upstream call failed. <b>insufficient_credits</b>: a metered call was refused. <b>client_*</b> rows are reported by the app itself: a blank turn it retried or replaced with a canned line, a voice that failed to synthesize or play. Rows never contain what was said.</p>
    <div class="card">
      <div class="pills" id="incidentStats"><span class="muted">Connect to load.</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Kind</th><th>Acct</th><th>Sess</th><th>Model</th><th>Detail</th></tr></thead>
          <tbody id="incidentRows"><tr><td colspan="6" class="muted">Connect to load.</td></tr></tbody>
        </table>
      </div>
      <div id="incidentPager" style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:10px"></div>
    </div>

    <h2 id="sec-cost">Cost attribution
      <span class="controls">
        <select id="usageWindow" style="width:auto;padding:3px 7px;font-size:13px">
          <option value="24">last 24h</option>
          <option value="168">last 7d</option>
          <option value="720">last 30d</option>
          <option value="8760">last year</option>
          <option value="1000000">all time</option>
        </select>
        <select id="realSit" style="width:auto;padding:3px 7px;font-size:13px" title="One bar for every session-level number in this section. Real sessions need 5+ turns and at least this many minutes; 'all' is unfiltered">
          <option value="real" selected>real sessions (5+ turns and 5+ min)</option>
          <option value="15">real sits, 15+ min</option>
          <option value="25">real sits, 25+ min</option>
          <option value="45">real sits, 45+ min</option>
          <option value="all">all sessions</option>
        </select>
        <label class="check" style="font-size:13px;white-space:nowrap;text-transform:none;letter-spacing:normal;font-weight:400"><input type="checkbox" class="omitAdmin"> omit admin</label>
        <button class="ghost" id="refreshUsage" style="padding:3px 9px;font-size:13px">refresh</button>
      </span>
    </h2>
    <p class="sub help-text" style="margin:-4px 0 12px">What real sessions actually cost - the LLM/STT/TTS split, cache-hit ratio, and per-session economics the ledger can't show. Use this to calibrate <code>USD_PER_CREDIT</code> and pack sizing.</p>
    <div class="grid" id="usageStats"></div>
    <div class="card">
      <p class="sub help-text" style="margin:0 0 10px">Observed burn rate - total spend of the sessions above divided by their total wall-clock hours. The measured counterpart to the "~N credits/hr" estimates the app advertises; if a row runs well above its estimate, the estimate profile is wrong. Duration is first-to-last metered call, so trailing silence isn't counted and these read slightly high per sat hour.</p>
      <div class="grid" id="perHourStats" style="margin-bottom:12px"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Service</th><th>Provider</th><th>Model / voice</th><th class="num">Credits/hr</th><th class="num">Badge</th><th class="num">$/hr</th><th class="num">Volume/hr</th><th class="num">Hours</th></tr></thead>
        <tbody id="perHourRows"><tr><td colspan="8" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
    </div>
    <div class="card detail">
      <p class="sub help-text" style="margin:0 0 10px">Your own sits, itemized - only sessions from accounts on <code>ALOUD_ADMIN_EMAILS</code> ever appear here; real users stay aggregate. One line per qualifying session, newest first, with the badge the app would have shown for that model + voice (typical talk band, plus the STT and utility legs when used). Tokens are per facilitation turn; utility counts the Haiku / Flash Lite calls riding alongside.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Start</th><th class="num">Min</th><th>Model</th><th class="num">Turns</th><th class="num">Util</th><th>Voice</th><th class="num">Cr/hr</th><th class="num">Badge</th><th class="num" title="LLM · STT · TTS credits per hour">L·S·T cr/hr</th><th class="num" title="Fresh input / cache read / output tokens per turn">tok/turn in·rd·out</th><th class="num">STT min</th><th class="num">STT calls</th><th class="num">TTS chars</th></tr></thead>
        <tbody id="sessionRows"><tr><td colspan="13" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
    </div>
    <div class="card detail">
      <p class="sub help-text" style="margin:0 0 10px">LLM prompt cache - the read/write/fresh token split, hit rate, and dollars caching saved vs a no-cache baseline (everything cached re-priced at full input). Broken out per provider because Anthropic (explicit breakpoints) and OpenAI/Google (automatic on a stable prefix) cache differently - the per-provider hit rate is how you tell each path is actually caching.</p>
      <div class="grid" id="cacheStats" style="margin-bottom:12px"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Provider</th><th class="num">Hit</th><th class="num">Fresh tok</th><th class="num">Read tok</th><th class="num">Write tok</th><th class="num">Cost $</th><th class="num">Saved $</th></tr></thead>
        <tbody id="cacheProviderRows"><tr><td colspan="7" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
    </div>
    <div class="card">
      <p class="sub help-text" style="margin:0 0 10px">Cost split by service - what drives the bill.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Service</th><th class="num">Provider $</th><th class="num">Share</th><th class="num">Credits</th><th class="num">Calls</th></tr></thead>
        <tbody id="usageServiceRows"><tr><td colspan="5" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
    </div>
    <div class="card detail">
      <p class="sub help-text" style="margin:0 0 10px">Per-model / per-voice cost, biggest first.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Service</th><th>Provider</th><th>Model / voice</th><th class="num">Provider $</th><th class="num">Credits</th><th class="num">Calls</th></tr></thead>
        <tbody id="usageModelRows"><tr><td colspan="6" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
    </div>
    <div class="card detail">
      <p class="sub help-text" style="margin:0 0 10px">Per-session distribution - sessions reconstructed by clustering each account's calls (gaps over 8&nbsp;min split a session).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Metric</th><th class="num">Median</th><th class="num">p90</th><th class="num">Max</th><th class="num">Mean</th></tr></thead>
        <tbody id="usageSessionRows"><tr><td colspan="5" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
    </div>

    <h2 id="sec-history">Usage over time
      <span class="controls">
        <select id="historyMetric" style="width:auto;padding:3px 7px;font-size:13px">
          <option value="cost" selected>provider $</option>
          <option value="margin">revenue vs cost</option>
          <option value="sessions">sessions</option>
          <option value="accounts">active accounts</option>
          <option value="turns">turns</option>
          <option value="credits">credits</option>
          <option value="duration">avg min / session</option>
        </select>
        <select id="historyDays" style="width:auto;padding:3px 7px;font-size:13px">
          <option value="7">last 7d</option>
          <option value="30" selected>last 30d</option>
          <option value="90">last 90d</option>
          <option value="365">last year</option>
        </select>
        <label class="check" style="font-size:13px;white-space:nowrap;text-transform:none;letter-spacing:normal;font-weight:400"><input type="checkbox" class="omitAdmin"> omit admin</label>
        <button class="ghost" id="refreshHistory" style="padding:3px 9px;font-size:13px">refresh</button>
      </span>
    </h2>
    <p class="sub help-text" style="margin:-4px 0 12px">Daily trend, one bar per UTC day (dates labeled in UTC). Each session is counted on the day it began. Hover a bar for the exact value.</p>
    <div class="card">
      <div id="historyChart"><p class="muted" style="margin:0">Connect to load.</p></div>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Day</th><th class="num">Sessions</th><th class="num">Accounts</th><th class="num">Turns</th><th class="num">Provider $</th><th class="num">Revenue $</th><th class="num">Credits</th><th class="num">Avg min</th></tr></thead>
        <tbody id="historyRows"><tr><td colspan="8" class="muted">Connect to load.</td></tr></tbody>
      </table></div>
      <div id="historyPager" style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:10px"></div>
    </div>

    <h2 id="sec-free">Free credits</h2>
    <div class="card">
      <p class="sub help-text" style="margin:0 0 14px">Tune the free tier live - no redeploy. Set either to <strong>0</strong> to stop handing out free credits while you test. Persisted across restarts.</p>
      <div class="row">
        <div>
          <label for="cSignup">Free credits per new signup</label>
          <input id="cSignup" type="number" min="0" step="1" autocomplete="off">
        </div>
        <div>
          <label for="cBudget">Global free-grant budget / hour</label>
          <input id="cBudget" type="number" min="0" step="1" autocomplete="off">
        </div>
        <button id="saveConfig">Save</button>
      </div>
      <div class="msg" id="configMsg"></div>
    </div>

    <h2 id="sec-pause">Soft launch - pause spending</h2>
    <div class="card">
      <p class="sub help-text" style="margin:0 0 14px">While paused, signed-in users keep their credits, but a conversation turn returns a polite "come back later" message instead of a real (billed) facilitator response - so nobody spends yet, and their session still saves. Tester emails below bypass the pause so you can keep testing.</p>
      <label class="check"><input type="checkbox" id="cPaused"> <span>Pause metered usage (conversations return the canned apology)</span></label>
      <div style="margin-top:14px">
        <label for="cTesters">Tester emails - exempt from the pause (one per line)</label>
        <textarea id="cTesters" rows="3" placeholder="you@example.com" autocomplete="off"></textarea>
      </div>
      <div class="row" style="margin-top:12px"><button id="savePause">Save</button></div>
      <div class="msg" id="pauseMsg"></div>
    </div>

    <h2 id="sec-grant">Grant credits</h2>
    <div class="card">
      <div class="row">
        <div><label for="gEmail">Account email</label><input id="gEmail" placeholder="someone@example.com" autocomplete="off"></div>
        <div style="flex:0 0 130px"><label for="gCredits">Credits</label><input id="gCredits" type="number" min="1" step="1" placeholder="100"></div>
        <button id="grant">Grant</button>
      </div>
      <div class="msg" id="grantMsg"></div>
    </div>

    <h2 id="sec-accounts">Accounts <span class="controls"><button class="ghost" id="refreshAccts" style="padding:3px 9px;font-size:13px">refresh</button></span></h2>
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <div><input id="search" placeholder="search id, email, or sign-in…" autocomplete="off"></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Email</th><th>Sign-in</th><th>Status</th><th class="num">Balance</th><th class="num">Granted</th><th class="num">Spent</th><th>Joined</th><th>Active</th><th class="act"></th></tr></thead>
          <tbody id="acctRows"><tr><td colspan="9" class="muted">Connect to load accounts.</td></tr></tbody>
        </table>
      </div>
    </div>

    <h2 id="sec-retreats">Retreats <span class="controls"><button class="ghost" id="refreshRetreats" style="padding:3px 9px;font-size:13px">refresh</button></span></h2>
    <div class="card">
      <p class="sub help-text" style="margin:0 0 14px">Time-boxed unlimited access for a retreat. Create a pass, then add attendees by email (they must have signed in once). Members aren't metered while the pass is active and in its date window. Leave the daily cap blank for truly unlimited, or set a per-attendee credit ceiling as a backstop.</p>
      <div class="row">
        <div><label for="rLabel">Label</label><input id="rLabel" placeholder="Retreat Name" autocomplete="off"></div>
        <div style="flex:0 0 150px"><label for="rStart">Starts</label><input id="rStart" type="date"></div>
        <div style="flex:0 0 150px"><label for="rEnd">Ends</label><input id="rEnd" type="date"></div>
        <div style="flex:0 0 150px"><label for="rCap">Daily cap / person</label><input id="rCap" type="number" min="1" step="1" placeholder="unlimited"></div>
        <button id="createRetreat">Create</button>
      </div>
      <div class="msg" id="retreatMsg"></div>
    </div>
    <div id="retreatList"></div>
  </div>

  <div id="modalRoot"></div>

<script>
(function () {
  var KEY = 'aloud-admin-token';
  // Injected by renderAdminPanel (panel.ts); '' when sign-in is not configured.
  var GOOGLE_CLIENT_ID = "__GOOGLE_CLIENT_ID__";
  // What pricing/estimate.ts assumes per hour (server-injected from
  // TYPICAL_SESSION). The per-hour cards print measured / assumed.
  var EST = "__ESTIMATE_PROFILE__";
  // Advertised credits/hr per model / voice (pricing/estimate.ts), for the
  // measured-vs-badge columns.
  var BADGES = "__BADGES__";
  var $ = function (id) { return document.getElementById(id); };
  var token = '';

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ authorization: 'Bearer ' + token }, opts.headers || {});
    return fetch('/cloud/v1/admin' + path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error && body.error.message) || ('HTTP ' + r.status));
        return body;
      }, function () {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return {};
      });
    });
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // Sticky view prefs (window selectors, chart metric, omit-admin) so the
  // panel reopens the way you left it. Stored beside the credential.
  var PREFS_KEY = 'aloud-admin-prefs';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function savePref(k, v) {
    var p = loadPrefs(); p[k] = v;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function usd(n) { return '$' + Number(n || 0).toFixed(2); }
  // Provider costs per call/session are often fractions of a cent - show enough
  // precision to be legible (4 dp under $1, 2 dp above).
  function usdp(n) { n = Number(n || 0); return '$' + n.toFixed(n < 1 ? 4 : 2); }
  function pct(n) { return (Number(n || 0) * 100).toFixed(0) + '%'; }
  function int(n) { return Number(n || 0).toLocaleString(); }
  // Credit amounts are fractional (TTS debits sub-credit), so show one decimal.
  function dec1(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  // Counts that can be fractional means (turns/session) - up to one decimal, no
  // forced trailing zero, so a clean integer median still reads as "6".
  function num1(n) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
  // Ratios where the interesting range is around 1 (STT calls per turn): one
  // decimal would round 1.4 and 1.04 to the same reading.
  function dec2(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function date(ts) { return new Date(ts * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }); }
  function dateTime(ts) { return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  // History buckets are UTC days - label them in UTC so a bar's date matches
  // its bucket (a local-time label reads a full day early west of Greenwich).
  function dateUTC(ts) { return new Date(ts * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric', timeZone: 'UTC' }); }

  // ---- metrics dashboard -------------------------------------------------
  // A stat grid. card = [label, valueHtml, valueClass?, detail?]; detail cards
  // sit behind the Full view toggle. The label rides the title too, since it
  // clips to one line.
  function statCards(cards) {
    return cards.map(function (c) {
      return '<div class="stat' + (c[3] ? ' detail' : '') + '" title="' + esc(c[0]) + '"><div class="k">' + esc(c[0]) + '</div><div class="v ' + (c[2] || '') + '">' + c[1] + '</div></div>';
    }).join('');
  }
  function loadMetrics() {
    var sel = $('metricsWindow');
    // "last 24h" → "24h" for the card labels.
    var wl = sel.options[sel.selectedIndex].text.replace('last ', '');
    return api('/metrics?sinceHours=' + sel.value).then(function (m) {
      var t = m.totals, w = m.window, a = m.abuse;
      var cards = [
        ['Accounts', int(t.accounts)],
        ['Outstanding cr', dec1(t.creditsOutstanding)],
        ['Cost all-time', usd(t.providerCostUsd)],
        ['Free burn', usd(t.freeBurnUsd), t.freeBurnUsd > 0 ? 'warn' : ''],
        ['Gross rev (est.)', usd(t.estGrossRevenueUsd)],
        ['Signups ' + wl, int(w.signups)],
        ['Cost ' + wl, usd(w.providerCostUsd)],
        ['IP clusters ' + wl, int(a.ipsOverThreshold), a.ipsOverThreshold > 0 ? 'warn' : ''],
      ];
      $('stats').innerHTML = statCards(cards);
    });
  }

  // ---- incidents ---------------------------------------------------------
  // One pill per kind stands in for a stat grid: the count is what matters,
  // the accounts/sessions behind it ride the hover. The table pages newest
  // first, like history: page size follows the view (8 compact / 20 full).
  var INCIDENTS = [];
  var incidentPage = 0;
  function incidentPageSize() { return document.body.classList.contains('compact') ? 8 : 20; }

  function renderIncidents() {
    var size = incidentPageSize();
    var pages = Math.max(1, Math.ceil(INCIDENTS.length / size));
    if (incidentPage > pages - 1) incidentPage = pages - 1;
    if (incidentPage < 0) incidentPage = 0;
    var page = INCIDENTS.slice(incidentPage * size, (incidentPage + 1) * size);
    $('incidentRows').innerHTML = page.map(function (i) {
      return '<tr><td class="muted" style="white-space:nowrap">' + dateTime(i.ts) + '</td><td>' + esc(i.kind) +
        '</td><td>' + esc(i.account) + '</td><td class="muted">' + esc(i.sessionId ? String(i.sessionId).slice(0, 8) : '') +
        '</td><td title="' + esc(i.provider) + '" style="white-space:nowrap"><code>' + esc(i.model) + '</code></td><td class="muted clip" title="' + esc(i.detail) + '">' + esc(i.detail) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">No incidents in this window.</td></tr>';
    if (pages <= 1) {
      $('incidentPager').innerHTML = '';
    } else {
      $('incidentPager').innerHTML =
        '<button class="ghost xs" id="incPrev"' + (incidentPage === 0 ? ' disabled' : '') + '>← newer</button>' +
        '<span class="muted" style="font-size:15px">page ' + (incidentPage + 1) + ' of ' + pages + '</span>' +
        '<button class="ghost xs" id="incNext"' + (incidentPage >= pages - 1 ? ' disabled' : '') + '>older →</button>';
      $('incPrev').onclick = function () { if (incidentPage > 0) { incidentPage--; renderIncidents(); } };
      $('incNext').onclick = function () { if (incidentPage < pages - 1) { incidentPage++; renderIncidents(); } };
    }
  }

  // keepPage: the auto-refresh tick passes true so it doesn't yank the
  // operator back to page 1 mid-browse (renderIncidents clamps if out of range).
  function loadIncidents(keepPage) {
    var sel = $('incidentWindow');
    return api('/incidents?sinceHours=' + sel.value + omitAdminParam()).then(function (r) {
      var lead = '<span class="lead ' + (r.total > 0 ? 'bad' : '') + '">' + int(r.total) + ' incident' + (r.total === 1 ? '' : 's') + '</span>';
      $('incidentStats').innerHTML = lead + (r.byKind || []).map(function (k) {
        return '<span class="pill ' + (k.source === 'server' ? 'warn' : 'free') + '" title="' + int(k.accounts) + ' account(s), ' + int(k.sessions) + ' session(s)">' +
          esc(k.kind) + ' ×' + int(k.count) + '</span>';
      }).join('');
      INCIDENTS = r.recent || [];
      if (!keepPage) incidentPage = 0;
      renderIncidents();
    });
  }

  // ---- cost attribution --------------------------------------------------
  var SVC = { llm: 'LLM', stt: 'STT', tts: 'TTS' };
  // "omit admin" - one logical toggle rendered in both usage headers. Checking
  // either box syncs the other and refetches both sections without usage from
  // ALOUD_ADMIN_EMAILS accounts, so operator testing doesn't pollute the
  // real-user picture.
  function omitAdminParam() {
    var cb = document.querySelector('.omitAdmin');
    return cb && cb.checked ? '&excludeAdmin=1' : '';
  }
  function loadUsage() {
    var sit = $('realSit').value;
    var sitParam = sit === 'all' ? '&all=1' : sit === 'real' ? '' : '&sitMinutes=' + encodeURIComponent(sit);
    return api('/usage?sinceHours=' + $('usageWindow').value + sitParam + omitAdminParam()).then(function (u) {
      var s = u.sessions;
      var cards = [
        ['Provider cost', usdp(u.totals.providerCostUsd)],
        ['Credits spent', dec1(u.totals.credits)],
        ['Sessions', int(s.count) + (s.excludedShort ? ' (+' + int(s.excludedShort) + ' short)' : '')],
        ['Avg $ / session', usdp(s.costUsd.mean)],
        ['LLM cache-hit', pct(u.llmCacheHitRatio)],
        ['Active accounts', int(u.accounts), '', true],
        ['Metered calls', int(u.events), '', true],
        ['Median cr / session', dec1(s.credits.p50), '', true],
        ['Turns / session', num1(s.turns.mean), '', true],
        ['Avg length', (Number(s.meanDurationMin) || 0).toFixed(1) + ' min', '', true],
      ];
      $('usageStats').innerHTML = statCards(cards);

      // ---- observed per-hour burn ----
      var ph = u.perHour || { sessions: 0, hours: 0, creditsPerHour: 0, costUsdPerHour: 0, turnsPerHour: 0, sttSecondsPerHour: 0, ttsCharsPerHour: 0, byService: [], byModel: [] };
      var phSvc = {};
      (ph.byService || []).forEach(function (l) { phSvc[l.kind] = l; });
      function svcRate(kind) { return phSvc[kind] ? dec1(phSvc[kind].creditsPerHour) : dec1(0); }
      // The volume a leg's price is driven by, in the unit the estimate profile
      // uses, so a row reads directly against pricing/estimate.ts.
      function volume(kind, units) {
        units = Number(units) || 0;
        if (kind === 'llm') return num1(units) + ' turns';
        if (kind === 'stt') return num1(units / 60) + ' min';
        return int(Math.round(units)) + ' chars';
      }
      // Weighted (across accounts) beside pooled (total/total). When they
      // diverge, a few short high-rate sits are steering the weighted figure.
      var pooled = ph.pooled || { creditsPerHour: 0, costUsdPerHour: 0, turnsPerHour: 0 };
      function vsPooled(a, b) { return a + ' <span class="assumed">· pooled ' + b + '</span>'; }
      var phCards = [
        ['Credits / hr', vsPooled(dec1(ph.creditsPerHour), dec1(pooled.creditsPerHour))],
        ['Provider $ / hr', vsPooled(usdp(ph.costUsdPerHour), usdp(pooled.costUsdPerHour))],
        ['LLM cr/hr', svcRate('llm')],
        ['STT cr/hr', svcRate('stt')],
        ['TTS cr/hr', svcRate('tts')],
        ['Turns / hr', num1(ph.turnsPerHour) + ' <span class="assumed">· pooled ' + num1(pooled.turnsPerHour) + ' / ' + num1(EST.turns) + '</span>', '', true],
        ['STT min / hr', num1((Number(ph.sttSecondsPerHour) || 0) / 60), '', true],
        ['TTS chars / hr', int(Math.round(Number(ph.ttsCharsPerHour) || 0)), '', true],
        ['Hours measured', (Number(ph.hours) || 0).toFixed(1), '', true],
        ['Real sessions', int(ph.sessions), '', true],
        // Rates below are a sqrt-of-spend weighted mean across accounts. At 1,
        // every per-hour number here is one person's habits.
        ['Accounts (rates)', int(ph.accounts), '', true],
      ];
      // Token volume per hour over the same qualifying sessions: what
      // pricing/estimate.ts assumes, measured. Each card prints actual vs
      // assumed, so a drifted profile is visible without opening the code -
      // these four drive the credits/hr badges more than turns or chars do.
      var tph = ph.tokensPerHour || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      function vsAssumed(actual, assumed) {
        return int(Math.round(Number(actual) || 0)) +
          ' <span class="assumed">/ ' + int(Math.round(assumed)) + '</span>';
      }
      // STT and TTS get a second card each, over the hours of sessions that
      // actually used that leg. Only these are comparable to the estimate
      // profile, which assumes both are in play; the totals above are diluted
      // by every local-voice and on-device-Whisper session.
      var att = ph.attributed || { sttSecondsPerHour: 0, ttsCharsPerHour: 0 };
      var sttd = ph.stt || { callsPerHour: 0, callsPerTurn: 0, medianSeconds: 0, p90Seconds: 0 };
      phCards = phCards.concat([
        ['STT min / cloud hr', num1((Number(att.sttSecondsPerHour) || 0) / 60) +
          ' <span class="assumed">/ ' + num1(EST.sttSeconds / 60) + '</span>'],
        // Against the badge's talk band (typical–engaged), which is what the
        // picker shows, rather than TYPICAL_SESSION's upper-bound figure.
        ['TTS chars / voice hr', int(Math.round(Number(att.ttsCharsPerHour) || 0)) +
          ' <span class="assumed">/ ' + int(Math.round(EST.ttsCharsTypical)) + '–' + int(Math.round(EST.ttsCharsEngaged)) + '</span>'],
        // Why the STT minutes are what they are (0uw7). Calls/turn much above 1
        // means we bill the same audio more than once (the speculative preview
        // pass re-sends the whole buffer); a big median with calls/turn near 1
        // means each payload carries the pre-buffer and the trailing silence
        // window. Both, and it's both.
        ['STT calls / turn', dec2(sttd.callsPerTurn)],
        ['STT calls / cloud hr', num1(sttd.callsPerHour)],
        ['STT sec / call (p50)', num1(sttd.medianSeconds)],
        ['STT sec / call (p90)', num1(sttd.p90Seconds)],
        ['Fresh in tok/hr', vsAssumed(tph.input, EST.input)],
        ['Output tok/hr', vsAssumed(tph.output, EST.output)],
        ['Cache read tok/hr', vsAssumed(tph.cacheRead, EST.cacheRead)],
        ['Cache write tok/hr', vsAssumed(tph.cacheCreation, EST.cacheCreation)],
      ]);
      // Per turn, pooled: the shape of a call, independent of how fast people
      // take turns. This is the row to reseed TYPICAL_SESSION's token fields
      // from; the per-hour cards above double whenever the pace does.
      var tpt = ph.tokensPerTurn || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      phCards = phCards.concat([
        ['Fresh in tok/turn', vsAssumed(tpt.input, EST.inputPerTurn)],
        ['Output tok/turn', vsAssumed(tpt.output, EST.outputPerTurn)],
        ['Cache read tok/turn', vsAssumed(tpt.cacheRead, EST.cacheReadPerTurn)],
        ['Cache write tok/turn', vsAssumed(tpt.cacheCreation, EST.cacheCreationPerTurn)],
      ]);
      // Everything past the five headline rates is detail.
      $('perHourStats').innerHTML = statCards(phCards.map(function (c, i) {
        return i < 5 ? c : [c[0], c[1], c[2], true];
      }));
      // The advertised rate for a usage row, or '' when the app has no badge
      // for it (a model since dropped from the roster, a voice off the curated
      // list). Voices print the picker's typical–engaged band.
      function badgeFor(kind, provider, model) {
        if (kind === 'llm') {
          // The utility models are never picked as the facilitator; their
          // badge is the flat utility leg, not their as-facilitator rate.
          if (/haiku|flash-lite/.test(model)) return dec1(BADGES.utility) + ' util';
          var b = BADGES.llm[provider + ':' + model];
          return b == null ? '' : dec1(b);
        }
        if (kind === 'stt') return dec1(BADGES.stt);
        var v = BADGES.tts[model];
        return v ? dec1(v.typical) + '–' + dec1(v.engaged) : '';
      }
      $('perHourRows').innerHTML = (ph.byModel || []).map(function (m) {
        return '<tr><td>' + (SVC[m.kind] || m.kind) + '</td><td><code>' + esc(m.provider) + '</code></td><td><code>' + esc(m.model) +
          '</code></td><td class="num">' + dec1(m.creditsPerHour) + '</td><td class="num assumed">' + badgeFor(m.kind, m.provider, m.model) +
          '</td><td class="num">' + usdp(m.costUsdPerHour) +
          '</td><td class="num">' + volume(m.kind, m.unitsPerHour) +
          '</td><td class="num">' + (Number(m.hours) || 0).toFixed(1) + '</td></tr>';
      }).join('') || '<tr><td colspan="8" class="muted">No real sessions in this window.</td></tr>';

      // ---- the operator's own sits, itemized ----
      // Composed badge for one session: model + voice (typical band) + the STT
      // and utility legs when the session used them - what the setup panel's
      // session pill would have summed.
      function sessionBadge(r) {
        var total = 0, known = false;
        if (r.llmModel) {
          var b = BADGES.llm[r.llmProvider + ':' + r.llmModel];
          if (b != null) { total += b; known = true; }
        }
        if (r.ttsVoice) {
          var v = BADGES.tts[r.ttsVoice];
          if (v) { total += v.typical; known = true; }
        }
        if (r.sttCalls > 0) total += BADGES.stt;
        if (r.utilityCalls > 0) total += BADGES.utility;
        return known ? dec1(total) : '';
      }
      $('sessionRows').innerHTML = (u.sessionRows || []).map(function (r) {
        var hrs = r.minutes / 60;
        var per = function (x) { return hrs > 0 ? x / hrs : 0; };
        var tok = r.tokensPerTurn || {};
        return '<tr><td class="muted">' + dateTime(r.startTs) + '</td>' +
          '<td class="num">' + num1(r.minutes) + '</td>' +
          '<td><code>' + esc(r.llmModel || '-') + '</code></td>' +
          '<td class="num">' + int(r.llmTurns) + '</td>' +
          '<td class="num">' + int(r.utilityCalls) + '</td>' +
          '<td><code>' + esc(r.ttsVoice || '-') + '</code></td>' +
          '<td class="num">' + dec1(r.creditsPerHour) + '</td>' +
          '<td class="num assumed">' + sessionBadge(r) + '</td>' +
          '<td class="num">' + dec1(per(r.byService.llm)) + ' · ' + dec1(per(r.byService.stt)) + ' · ' + dec1(per(r.byService.tts)) + '</td>' +
          '<td class="num">' + int(Math.round(tok.input || 0)) + ' / ' + int(Math.round(tok.cacheRead || 0)) + ' / ' + int(Math.round(tok.output || 0)) + '</td>' +
          '<td class="num">' + num1(r.sttSeconds / 60) + '</td>' +
          '<td class="num">' + int(r.sttCalls) + '</td>' +
          '<td class="num">' + int(r.ttsChars) + '</td></tr>';
      }).join('') || '<tr><td colspan="13" class="muted">No qualifying sessions from admin accounts in this window' + (omitAdminParam() ? ' (omit admin is on)' : '') + '.</td></tr>';

      // ---- LLM prompt cache breakdown ----
      var lc = u.llmCache || { freshInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, hitRatio: 0, costUsd: 0, costNoCacheUsd: 0, savedUsd: 0 };
      var savedPct = lc.costNoCacheUsd > 0 ? lc.savedUsd / lc.costNoCacheUsd : 0;
      var cacheCards = [
        ['Cache hit', pct(lc.hitRatio)],
        ['Fresh input tok', int(lc.freshInputTokens)],
        ['Cache reads tok', int(lc.cacheReadTokens)],
        ['Cache writes tok', int(lc.cacheCreationTokens)],
        // 1h-TTL writes (the anchor, billed 2x). Rising = holds forcing re-anchors.
        ['1h-anchor writes', int(lc.cacheCreation1hTokens || 0)],
        ['LLM cost', usdp(lc.costUsd)],
        ['Cost w/o cache', usdp(lc.costNoCacheUsd)],
        ['Saved by cache', usdp(lc.savedUsd) + ' (' + pct(savedPct) + ')'],
      ];
      $('cacheStats').innerHTML = statCards(cacheCards);
      $('cacheProviderRows').innerHTML = (u.llmCacheByProvider || []).map(function (p) {
        return '<tr><td><code>' + esc(p.provider) + '</code></td><td class="num">' + pct(p.hitRatio) +
          '</td><td class="num">' + int(p.freshInputTokens) + '</td><td class="num">' + int(p.cacheReadTokens) +
          '</td><td class="num">' + int(p.cacheCreationTokens) + '</td><td class="num">' + usdp(p.costUsd) +
          '</td><td class="num">' + usdp(p.savedUsd) + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="muted">No LLM usage in this window.</td></tr>';

      var svc = u.byService.slice().sort(function (a, b) { return b.providerCostUsd - a.providerCostUsd; });
      $('usageServiceRows').innerHTML = svc.map(function (v) {
        return '<tr><td>' + (SVC[v.kind] || v.kind) + '</td><td class="num">' + usdp(v.providerCostUsd) +
          '</td><td class="num">' + pct(v.costShare) + '</td><td class="num">' + dec1(v.credits) +
          '</td><td class="num">' + int(v.events) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">No usage in this window.</td></tr>';

      $('usageModelRows').innerHTML = u.byModel.map(function (m) {
        return '<tr><td>' + (SVC[m.kind] || m.kind) + '</td><td><code>' + esc(m.provider) + '</code></td><td><code>' + esc(m.model) + '</code></td><td class="num">' +
          usdp(m.providerCostUsd) + '</td><td class="num">' + dec1(m.credits) + '</td><td class="num">' + int(m.events) + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="muted">No usage in this window.</td></tr>';

      function distRow(label, d, fmt) {
        return '<tr><td>' + label + '</td><td class="num">' + fmt(d.p50) + '</td><td class="num">' + fmt(d.p90) +
          '</td><td class="num">' + fmt(d.max) + '</td><td class="num">' + fmt(d.mean) + '</td></tr>';
      }
      $('usageSessionRows').innerHTML = s.count
        ? distRow('Provider $ / session', s.costUsd, usdp) +
          distRow('Credits / session', s.credits, dec1) +
          distRow('Turns / session', s.turns, num1)
        : '<tr><td colspan="5" class="muted">No sessions in this window.</td></tr>';
    });
  }

  // ---- usage over time (daily trend) -------------------------------------
  // Each metric: a label, a per-day value getter, and a value formatter.
  var HISTORY = [];
  var METRICS = {
    sessions: { label: 'Sessions', val: function (b) { return b.sessions; }, fmt: int },
    accounts: { label: 'Active accounts', val: function (b) { return b.accounts; }, fmt: int },
    turns: { label: 'Turns', val: function (b) { return b.turns; }, fmt: int },
    cost: { label: 'Provider $', val: function (b) { return b.providerCostUsd; }, fmt: usdp },
    // Dual series: cost bars + a revenue line on the same $ scale - the daily
    // gross-margin picture (revenue is spiky, so it reads best as an overlay).
    margin: {
      label: 'Provider $ (bars) vs revenue (line)',
      val: function (b) { return b.providerCostUsd; },
      val2: function (b) { return b.revenueUsd || 0; },
      label2: 'revenue',
      fmt: usdp,
    },
    credits: { label: 'Credits', val: function (b) { return b.credits; }, fmt: dec1 },
    duration: {
      label: 'Avg min / session',
      val: function (b) { return b.sessions ? b.durationMin / b.sessions : 0; },
      fmt: function (n) { return (Number(n || 0)).toFixed(1); },
    },
  };

  // Inline-SVG bar chart - no deps, scales to the window. One bar per day, a
  // dashed max gridline, and first/mid/last date ticks so it stays legible at
  // 90 bars. Each bar carries a <title> for hover-to-read the exact value.
  function barChart(buckets, metricKey) {
    var m = METRICS[metricKey] || METRICS.sessions;
    var vals = buckets.map(m.val);
    // A second series (m.val2) shares the scale - both are USD - and overlays
    // as a line, so the max covers both.
    var vals2 = m.val2 ? buckets.map(m.val2) : [];
    var max = Math.max.apply(null, vals.concat(vals2).concat([0]));
    // Every day zero-fills, so buckets is never empty; the real "nothing to show"
    // case is an all-zero window. Say so instead of drawing a flat, empty axis.
    if (max <= 0) return '<p class="muted" style="margin:0">No metered usage in this window yet.</p>';
    var W = 760, H = 180, padX = 8, padTop = 16, padBot = 22;
    var n = buckets.length, bw = (W - padX * 2) / n, plotH = H - padTop - padBot;
    var bars = buckets.map(function (b, i) {
      var v = m.val(b);
      var h = max > 0 ? plotH * (v / max) : 0;
      var x = padX + i * bw, y = padTop + (plotH - h);
      return '<rect x="' + (x + 0.7).toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + Math.max(0.5, bw - 1.4).toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="1.5" fill="var(--accent)"><title>' + esc(dateUTC(b.dayStartTs) + ': ' + m.fmt(v)) + '</title></rect>';
    }).join('');
    var overlay = '';
    if (m.val2) {
      var pts = buckets.map(function (b, i) {
        var v = m.val2(b);
        return {
          x: padX + i * bw + bw / 2,
          y: padTop + (plotH - plotH * (v / max)),
          v: v, ts: b.dayStartTs,
        };
      });
      overlay = '<polyline fill="none" stroke="var(--good)" stroke-width="1.5" points="' +
        pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + '"/>' +
        pts.filter(function (p) { return p.v > 0; }).map(function (p) {
          return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) +
            '" r="2.5" fill="var(--good)"><title>' +
            esc(dateUTC(p.ts) + ': ' + m.fmt(p.v) + ' ' + m.label2) + '</title></circle>';
        }).join('') +
        '<text x="' + padX + '" y="' + (padTop - 4) + '" font-size="13" fill="var(--good)">' +
          esc(m.label2) + '</text>';
    }
    var baseY = padTop + plotH;
    var axis = '<line x1="' + padX + '" y1="' + baseY + '" x2="' + (W - padX) + '" y2="' + baseY +
      '" stroke="var(--line)" stroke-width="1"/>';
    // Dashed gridline + label at the max.
    var grid = max > 0
      ? '<line x1="' + padX + '" y1="' + padTop + '" x2="' + (W - padX) + '" y2="' + padTop +
        '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text x="' + (W - padX) + '" y="' + (padTop - 4) + '" text-anchor="end" font-size="13" fill="var(--dim)">' +
          esc(m.fmt(max)) + '</text>'
      : '';
    // Date ticks: first, middle, last.
    var ticks = [0, Math.floor(n / 2), n - 1].filter(function (v, i, a) { return a.indexOf(v) === i; });
    var labels = ticks.map(function (i) {
      var x = padX + i * bw + bw / 2;
      var anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor +
        '" font-size="13" fill="var(--dim)">' + esc(dateUTC(buckets[i].dayStartTs)) + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(m.label) + ' per day">' +
      grid + bars + overlay + axis + labels + '</svg>';
  }

  // The table paginates (newest day first) so a 90-day window stays scannable;
  // the chart above always shows the whole window.
  // Page size follows the view: compact pages five days at a time, full ten,
  // so the pager always matches what is on screen.
  function historyPageSize() { return document.body.classList.contains('compact') ? 5 : 10; }
  var historyPage = 0;

  function renderHistory() {
    $('historyChart').innerHTML = barChart(HISTORY, $('historyMetric').value);

    var days = HISTORY.slice().reverse(); // newest first
    var size = historyPageSize();
    var pages = Math.max(1, Math.ceil(days.length / size));
    if (historyPage > pages - 1) historyPage = pages - 1;
    if (historyPage < 0) historyPage = 0;
    var page = days.slice(historyPage * size, (historyPage + 1) * size);

    $('historyRows').innerHTML = page.map(function (b) {
      var avgMin = b.sessions ? b.durationMin / b.sessions : 0;
      return '<tr><td class="muted">' + dateUTC(b.dayStartTs) + '</td>' +
        '<td class="num">' + int(b.sessions) + '</td>' +
        '<td class="num">' + int(b.accounts) + '</td>' +
        '<td class="num">' + int(b.turns) + '</td>' +
        '<td class="num">' + usdp(b.providerCostUsd) + '</td>' +
        '<td class="num">' + usdp(b.revenueUsd || 0) + '</td>' +
        '<td class="num">' + dec1(b.credits) + '</td>' +
        '<td class="num">' + avgMin.toFixed(1) + '</td></tr>';
    }).join('') || '<tr><td colspan="8" class="muted">No usage yet.</td></tr>';

    // Pager: only when there's more than one page.
    if (pages <= 1) {
      $('historyPager').innerHTML = '';
    } else {
      $('historyPager').innerHTML =
        '<button class="ghost xs" id="histPrev"' + (historyPage === 0 ? ' disabled' : '') + '>← newer</button>' +
        '<span class="muted" style="font-size:15px">page ' + (historyPage + 1) + ' of ' + pages + '</span>' +
        '<button class="ghost xs" id="histNext"' + (historyPage >= pages - 1 ? ' disabled' : '') + '>older →</button>';
      $('histPrev').onclick = function () { if (historyPage > 0) { historyPage--; renderHistory(); } };
      $('histNext').onclick = function () { if (historyPage < pages - 1) { historyPage++; renderHistory(); } };
    }
  }

  // keepPage: auto-refresh passes true so a background tick doesn't yank the
  // operator back to page 1 mid-browse (renderHistory clamps if out of range).
  function loadUsageHistory(keepPage) {
    return api('/usage/history?days=' + $('historyDays').value + omitAdminParam()).then(function (h) {
      HISTORY = h.buckets || [];
      if (!keepPage) historyPage = 0; // fresh data / new window → first page
      renderHistory();
    });
  }

  // ---- free-credit knobs -------------------------------------------------
  function loadConfig() {
    return api('/config').then(function (cfg) {
      $('cSignup').value = cfg.freeSignupCredits;
      $('cBudget').value = cfg.freeGrantBudgetPerHour;
      $('cPaused').checked = !!cfg.meteredPaused;
      $('cTesters').value = (cfg.testerEmails || []).join('\n');
    });
  }
  function savePause() {
    var testers = $('cTesters').value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    $('savePause').disabled = true;
    api('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meteredPaused: $('cPaused').checked, testerEmails: testers }),
    }).then(function (cfg) {
      $('cTesters').value = (cfg.testerEmails || []).join('\n');
      setMsg($('pauseMsg'), cfg.meteredPaused
        ? 'Saved - spending PAUSED for everyone except ' + (cfg.testerEmails.length || 0) + ' tester(s).'
        : 'Saved - spending is live.', 'ok');
    }).catch(function (e) {
      setMsg($('pauseMsg'), e.message, 'err');
    }).then(function () { $('savePause').disabled = false; });
  }
  function saveConfig() {
    var signup = parseInt($('cSignup').value, 10);
    var budget = parseInt($('cBudget').value, 10);
    if (!(signup >= 0) || !(budget >= 0)) { setMsg($('configMsg'), 'Both values must be 0 or more.', 'err'); return; }
    $('saveConfig').disabled = true;
    api('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ freeSignupCredits: signup, freeGrantBudgetPerHour: budget }),
    }).then(function (cfg) {
      $('cSignup').value = cfg.freeSignupCredits;
      $('cBudget').value = cfg.freeGrantBudgetPerHour;
      var off = cfg.freeSignupCredits === 0 || cfg.freeGrantBudgetPerHour === 0;
      setMsg($('configMsg'), 'Saved.' + (off ? ' Free credits are OFF.' : ''), 'ok');
    }).catch(function (e) {
      setMsg($('configMsg'), e.message, 'err');
    }).then(function () { $('saveConfig').disabled = false; });
  }

  // ---- accounts table ----------------------------------------------------
  var allAccounts = [];
  // Everything on an account row we can match a search against: the UUID (how
  // you find an account from a log line), the email, and the sign-in providers.
  // The email is skipped for deleted accounts - there it's an anonymized
  // 'deleted+<id>@deleted.invalid' placeholder, not a real address, so matching
  // it would surface scrubbed rows on a stray substring. The id stays
  // searchable, so a deleted account is still reachable by its id.
  function acctSearchText(a) {
    var parts = [a.id];
    if (!a.deleted && a.email) parts.push(a.email);
    if (a.providers) parts = parts.concat(a.providers);
    return parts.join(' ').toLowerCase();
  }
  function renderAccounts() {
    var q = $('search').value.trim().toLowerCase();
    var rows = allAccounts.filter(function (a) { return !q || acctSearchText(a).indexOf(q) >= 0; });
    if (!rows.length) {
      $('acctRows').innerHTML = '<tr><td colspan="9" class="muted">No accounts' + (q ? ' match.' : ' yet.') + '</td></tr>';
      return;
    }
    $('acctRows').innerHTML = rows.map(function (a) {
      var pill = a.deleted ? '<span class="pill free">deleted</span>'
        : a.purchased ? '<span class="pill paid">paid</span>' : '<span class="pill free">free</span>';
      return '<tr data-id="' + a.id + '"' + (a.deleted ? ' class="muted"' : '') + '>' +
        '<td class="wrap">' + esc(a.email) + '</td>' +
        '<td>' + providerBadges(a.providers) + '</td>' +
        '<td>' + pill + '</td>' +
        '<td class="num">' + dec1(a.balance) + '</td>' +
        '<td class="num">' + dec1(a.granted) + '</td>' +
        '<td class="num">' + dec1(a.debited) + '</td>' +
        '<td class="muted">' + date(a.createdAt) + '</td>' +
        '<td class="muted">' + (a.lastActiveTs ? date(a.lastActiveTs) : 'never') + '</td>' +
        '<td class="act">' + (a.deleted ? '' : '<button class="ghost xs" data-grant="' + esc(a.email) + '">grant</button>') + '</td>' +
        '</tr>';
    }).join('');
    Array.prototype.forEach.call($('acctRows').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { openLedger(tr.getAttribute('data-id')); });
    });
    // Per-row grant: prefill the Grant form with this email (don't open ledger).
    Array.prototype.forEach.call($('acctRows').querySelectorAll('[data-grant]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        $('gEmail').value = btn.getAttribute('data-grant');
        $('gCredits').focus();
        $('gCredits').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }
  function loadAccounts() {
    return api('/accounts').then(function (list) { allAccounts = list; renderAccounts(); });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Sign-in methods as small labelled pills (Google / Apple / Email).
  var PROVIDER_LABEL = { google: 'Google', apple: 'Apple', email: 'Email' };
  function providerBadges(providers) {
    if (!providers || !providers.length) return '<span class="muted">none</span>';
    return providers.map(function (p) {
      return '<span class="prov">' + esc(PROVIDER_LABEL[p] || p) + '</span>';
    }).join(' ');
  }

  // ---- per-account ledger modal -----------------------------------------
  function openLedger(id) {
    api('/accounts/' + encodeURIComponent(id)).then(function (d) {
      var entries = d.entries.slice().reverse(); // newest first
      var rows = entries.map(function (e) {
        var amt = e.amount > 0 ? '+' + dec1(e.amount) : dec1(e.amount);
        var cls = e.amount > 0 ? 'good' : 'bad';
        return '<tr><td class="muted">' + date(e.createdAt) + '</td><td>' + esc(e.kind) +
          '</td><td>' + esc(e.reason) + '</td><td class="num" style="color:var(--' + cls + ')">' + amt + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="muted">No ledger entries.</td></tr>';
      var deleted = d.account.deletedAt != null;
      var sign = providerBadges(d.account.providers);
      var footer = deleted
        ? '<p class="sub" style="margin:14px 0 0;color:var(--bad)">This account is deleted (anonymized, identities freed, balance zeroed).</p>'
        : '<div id="delZone" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;gap:12px">' +
            '<span class="muted" style="font-size:15px">Soft-delete: anonymizes the email, frees the sign-ins, zeroes the balance. Used to clear a duplicate.</span>' +
            '<button class="ghost xs" id="delAcct" style="color:var(--bad);border-color:var(--bad);flex:0 0 auto">Delete account</button></div>';
      $('modalRoot').innerHTML =
        '<div class="modal-bg" id="mbg"><div class="modal">' +
        '<button class="x" id="mx">&times;</button>' +
        '<h3>' + esc(d.account.email) + '</h3>' +
        '<p class="sub" style="margin:0 0 14px">Balance <strong>' + dec1(d.balance) + '</strong> credits · ' +
        'sign-in ' + sign + ' · id <code>' + esc(d.account.id) + '</code></p>' +
        '<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Reason</th><th class="num">Δ</th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' + footer + '</div></div>';
      $('mx').onclick = $('mbg').onclick = function (e) {
        if (e.target === $('mbg') || e.target === $('mx')) $('modalRoot').innerHTML = '';
      };
      if (!deleted && $('delAcct')) $('delAcct').onclick = function () { armDelete(d.account); };
    }).catch(function (e) { alert(e.message); });
  }

  // Deleting is two deliberate steps: the button only arms the confirm, and the
  // confirm only unlocks once the operator has typed the account's email back.
  // A single stray click can't destroy an account.
  function armDelete(account) {
    $('delZone').innerHTML =
      '<div style="width:100%">' +
        '<p class="sub" style="margin:0 0 8px;color:var(--bad)">This anonymizes the account, frees its sign-in methods, and zeroes its balance. It cannot sign in afterward, and this cannot be undone.</p>' +
        '<label for="delEmail">Type <code>' + esc(account.email) + '</code> to confirm</label>' +
        '<div class="row">' +
          '<div><input id="delEmail" placeholder="' + esc(account.email) + '" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
          '<button class="ghost xs" id="delCancel">Cancel</button>' +
          '<button class="ghost xs" id="delGo" disabled style="color:var(--bad);border-color:var(--bad)">Delete permanently</button>' +
        '</div>' +
        '<div class="msg" id="delMsg"></div>' +
      '</div>';
    var input = $('delEmail'), go = $('delGo');
    function matches() {
      return input.value.trim().toLowerCase() === String(account.email).trim().toLowerCase();
    }
    input.addEventListener('input', function () { go.disabled = !matches(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && matches()) doDeleteAccount(account); });
    $('delCancel').onclick = function () { openLedger(account.id); };
    go.onclick = function () { if (matches()) doDeleteAccount(account); };
    input.focus();
  }

  // Soft-delete an account (clearing a duplicate), then refresh the table +
  // spend stats. Only reachable through armDelete's typed confirmation.
  function doDeleteAccount(account) {
    var btn = $('delGo');
    if (btn) btn.disabled = true;
    api('/accounts/' + encodeURIComponent(account.id) + '/delete', { method: 'POST' })
      .then(function () {
        $('modalRoot').innerHTML = '';
        return Promise.all([loadAccounts(), loadMetrics()]);
      })
      .catch(function (e) {
        setMsg($('delMsg'), e.message, 'err');
        if (btn) btn.disabled = false;
      });
  }

  // ---- grant -------------------------------------------------------------
  function doGrant() {
    var email = $('gEmail').value.trim();
    var credits = parseInt($('gCredits').value, 10);
    if (!email || !(credits > 0)) { setMsg($('grantMsg'), 'Enter an email and a positive credit amount.', 'err'); return; }
    $('grant').disabled = true;
    api('/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, credits: credits }),
    }).then(function (r) {
      setMsg($('grantMsg'), 'Granted ' + int(credits) + ' to ' + email + ' - new balance ' + dec1(r.balance) + '.', 'ok');
      $('gCredits').value = '';
      return Promise.all([loadAccounts(), loadMetrics()]);
    }).catch(function (e) {
      setMsg($('grantMsg'), e.message, 'err');
    }).then(function () { $('grant').disabled = false; });
  }

  // ---- retreats ----------------------------------------------------------
  function loadRetreats() {
    return api('/retreats').then(renderRetreats);
  }
  function renderRetreats(list) {
    if (!list.length) {
      $('retreatList').innerHTML = '<p class="muted" style="padding:0 2px 8px">No retreat passes yet.</p>';
      return;
    }
    var now = Date.now() / 1000;
    $('retreatList').innerHTML = list.map(function (p) {
      var active = p.status === 'active' && p.startsAt <= now && p.endsAt >= now;
      var state = p.status === 'revoked' ? '<span class="pill free">revoked</span>'
        : active ? '<span class="pill paid">active</span>'
        : p.startsAt > now ? '<span class="pill free">scheduled</span>'
        : '<span class="pill free">ended</span>';
      var cap = p.perAttendeeDailyCap == null ? 'unlimited' : dec1(p.perAttendeeDailyCap) + ' credits/day';
      var revoke = p.status === 'revoked' ? ''
        : '<button class="ghost xs" data-revoke="' + p.id + '">revoke</button>';
      // Once a pass is inert (revoked or past its window) it can be cleared out
      // for good - spent retreats, durability-probe test markers. Matches the
      // server guard that refuses to delete a still-live pass.
      var del = (p.status === 'revoked' || p.endsAt < now)
        ? '<button class="ghost xs" data-delete="' + p.id + '">delete</button>'
        : '';
      // Per-attendee rows: email, their provider cost, and suggested bill.
      var memberRows = p.members.length
        ? p.members.map(function (m) {
            return '<tr><td>' + esc(m.email) + '</td><td class="num">' + usdp(m.spend.providerCostUsd) +
              '</td><td class="num">' + usdp(m.billableUsd) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="3" class="muted">No attendees signed in yet.</td></tr>';
      // Pending invites (added by email, not yet claimed by a sign-in).
      var pending = (p.invites && p.invites.length)
        ? '<p class="sub" style="margin:8px 0 0">Pending (will join on first sign-in): ' +
            p.invites.map(esc).join(', ') + '</p>'
        : '';
      return '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<strong>' + esc(p.label) + '</strong> ' + state +
          '<span style="flex:1"></span>' + revoke + del +
        '</div>' +
        '<p class="sub" style="margin:8px 0">' + date(p.startsAt) + ' → ' + date(p.endsAt) +
          ' · cap ' + cap + '</p>' +
        '<div class="grid" style="margin:0 0 10px">' +
          '<div class="stat"><div class="k">Provider cost</div><div class="v">' + usdp(p.spend.providerCostUsd) + '</div></div>' +
          '<div class="stat"><div class="k">Suggested bill</div><div class="v">' + usdp(p.billableUsd) + '</div></div>' +
          '<div class="stat"><div class="k">Calls</div><div class="v">' + int(p.spend.events) + '</div></div>' +
          '<div class="stat"><div class="k">Attendees</div><div class="v">' + int(p.members.length) + '</div></div>' +
        '</div>' +
        '<div class="table-wrap"><table><thead><tr><th>Attendee</th><th class="num">Provider $</th><th class="num">Bill</th></tr></thead>' +
          '<tbody>' + memberRows + '</tbody></table></div>' +
        pending +
        '<div class="row" style="margin-top:12px"><div><input data-email="' + p.id + '" placeholder="attendee@example.com" autocomplete="off"></div>' +
          '<button class="ghost xs" data-add="' + p.id + '">Add attendee</button></div>' +
        '<div class="msg" data-msg="' + p.id + '"></div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call($('retreatList').querySelectorAll('[data-revoke]'), function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Revoke this pass? Coverage stops immediately for every attendee.')) return;
        api('/retreats/' + btn.getAttribute('data-revoke') + '/revoke', { method: 'POST' })
          .then(loadRetreats)
          .catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call($('retreatList').querySelectorAll('[data-delete]'), function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Permanently delete this pass and its attendee records? This cannot be undone.')) return;
        api('/retreats/' + btn.getAttribute('data-delete'), { method: 'DELETE' })
          .then(loadRetreats)
          .catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call($('retreatList').querySelectorAll('[data-add]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-add');
        var input = $('retreatList').querySelector('[data-email="' + id + '"]');
        var msg = $('retreatList').querySelector('[data-msg="' + id + '"]');
        var email = input.value.trim();
        if (!email) { setMsg(msg, 'Enter an email.', 'err'); return; }
        btn.disabled = true;
        api('/retreats/' + id + '/members', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email }),
        }).then(function () { input.value = ''; return loadRetreats(); })
          .catch(function (e) { setMsg(msg, e.message, 'err'); btn.disabled = false; });
      });
    });
  }
  function createRetreat() {
    var label = $('rLabel').value.trim();
    var start = $('rStart').value, end = $('rEnd').value;
    var capRaw = $('rCap').value.trim();
    if (!label || !start || !end) { setMsg($('retreatMsg'), 'Label, start, and end dates are required.', 'err'); return; }
    // Cover the whole end day (local time); send epoch seconds.
    var startsAt = new Date(start + 'T00:00:00').getTime() / 1000;
    var endsAt = new Date(end + 'T23:59:59').getTime() / 1000;
    if (!(endsAt > startsAt)) { setMsg($('retreatMsg'), 'End must be after start.', 'err'); return; }
    var cap = capRaw === '' ? null : Number(capRaw);
    $('createRetreat').disabled = true;
    api('/retreats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: label, startsAt: startsAt, endsAt: endsAt, perAttendeeDailyCap: cap }),
    }).then(function () {
      setMsg($('retreatMsg'), 'Created "' + label + '".', 'ok');
      $('rLabel').value = ''; $('rCap').value = '';
      return loadRetreats();
    }).catch(function (e) {
      setMsg($('retreatMsg'), e.message, 'err');
    }).then(function () { $('createRetreat').disabled = false; });
  }

  // ---- connect / boot ----------------------------------------------------
  // "token" is whatever credential we hold - the static admin token or a
  // session JWT from the Google sign-in below; the server accepts either.
  // loadMetrics() doubles as the auth check before anything is persisted.
  // Once a credential works the auth card collapses out of the way - the panel
  // is for reading, not re-authenticating. "Sign out" in the header brings it
  // back (and forgets the stored credential).
  function setConnected(on) {
    $('authCard').classList.toggle('hidden', on);
    $('signOut').classList.toggle('hidden', !on);
    $('quickNav').classList.toggle('hidden', !on);
    $('liveWrap').classList.toggle('hidden', !on);
  }

  // ---- auto-refresh ("live") ----------------------------------------------
  // One 60s tick reloads the read-only dashboards. Skipped while the tab is
  // hidden (the next visible tick catches up) and while disconnected. Errors
  // are swallowed - a blipped background refresh shouldn't paint the auth box
  // red; the next tick retries anyway.
  var AUTO_MS = 60000;
  var autoTimer = null;
  function autoTick() {
    if (document.hidden || $('app').classList.contains('hidden')) return;
    Promise.all([loadMetrics(), loadUsage(), loadUsageHistory(true), loadAccounts(), loadIncidents(true)])
      .catch(function () {});
  }
  function setAuto(on) {
    clearInterval(autoTimer);
    autoTimer = on ? setInterval(autoTick, AUTO_MS) : null;
  }
  $('autoRefresh').addEventListener('change', function () {
    savePref('autoRefresh', $('autoRefresh').checked);
    setAuto($('autoRefresh').checked);
  });

  function boot() {
    setMsg($('authMsg'), 'Connecting…');
    return loadMetrics().then(function () {
      localStorage.setItem(KEY, token);
      setMsg($('authMsg'), 'Connected.', 'ok');
      setConnected(true);
      $('app').classList.remove('hidden');
      return Promise.all([loadAccounts(), loadConfig(), loadUsage(), loadUsageHistory(), loadRetreats(), loadIncidents()]);
    }).catch(function (e) {
      setMsg($('authMsg'), 'Failed: ' + e.message, 'err');
      setConnected(false);
      $('app').classList.add('hidden');
    });
  }

  function connect() {
    token = $('tok').value.trim();
    if (!token) { setMsg($('authMsg'), 'Paste the admin token first.', 'err'); return; }
    boot();
  }

  // ---- Google sign-in (ALOUD_ADMIN_EMAILS) -------------------------------
  // Mints a normal session via /cloud/v1/auth/google; the admin gate then
  // checks the account email server-side. Anyone can sign in here - only
  // allowlisted accounts get past loadMetrics().
  (function () {
    if (!GOOGLE_CLIENT_ID) return;
    $('gsiWrap').classList.remove('hidden');
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = function () {
      if (!(window.google && window.google.accounts && window.google.accounts.id)) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: function (resp) {
          if (!resp.credential) { setMsg($('authMsg'), 'Google sign-in returned no credential.', 'err'); return; }
          setMsg($('authMsg'), 'Signing in…');
          fetch('/cloud/v1/auth/google', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idToken: resp.credential }),
          }).then(function (r) { return r.json(); }).then(function (body) {
            if (!body || !body.token) {
              throw new Error((body && body.error && body.error.message) || 'sign-in failed');
            }
            token = body.token;
            return boot();
          }).catch(function (e) {
            setMsg($('authMsg'), 'Failed: ' + e.message, 'err');
          });
        },
      });
      window.google.accounts.id.renderButton($('gsiBtn'), {
        theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 240,
      });
    };
    document.head.appendChild(s);
  })();

  $('connect').onclick = connect;
  function forgetCredential() {
    localStorage.removeItem(KEY); token = ''; $('tok').value = '';
    $('app').classList.add('hidden'); setConnected(false);
    setMsg($('authMsg'), 'Credential forgotten.');
  }
  $('forget').onclick = forgetCredential;
  $('signOut').onclick = forgetCredential;
  $('grant').onclick = doGrant;
  $('saveConfig').onclick = saveConfig;
  $('savePause').onclick = savePause;
  $('refreshMetrics').onclick = function () { loadMetrics().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('metricsWindow').addEventListener('change', function () { loadMetrics().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  $('refreshUsage').onclick = function () { loadUsage().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('usageWindow').addEventListener('change', function () { loadUsage().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  $('realSit').addEventListener('change', function () { loadUsage().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  $('refreshHistory').onclick = function () { loadUsageHistory().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('refreshIncidents').onclick = function () { loadIncidents().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('incidentWindow').addEventListener('change', function () { loadIncidents().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  Array.prototype.forEach.call(document.querySelectorAll('.omitAdmin'), function (cb) {
    cb.addEventListener('change', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.omitAdmin'), function (o) { o.checked = cb.checked; });
      savePref('omitAdmin', cb.checked);
      Promise.all([loadUsage(), loadUsageHistory(), loadIncidents()]).catch(function (e) { setMsg($('authMsg'), e.message, 'err'); });
    });
  });
  $('historyDays').addEventListener('change', function () { loadUsageHistory().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  // Metric switch is a pure client-side re-render - no refetch needed.
  $('historyMetric').addEventListener('change', renderHistory);
  $('refreshAccts').onclick = function () { loadAccounts().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('refreshRetreats').onclick = function () { loadRetreats().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('createRetreat').onclick = createRetreat;
  $('search').addEventListener('input', renderAccounts);
  $('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
  $('gCredits').addEventListener('keydown', function (e) { if (e.key === 'Enter') doGrant(); });

  // Explanations toggle - show/hide the help paragraphs as a group. Hidden by
  // default (body.hide-help) so the panel stays dense; click to reveal.
  (function () {
    var btn = $('toggleHelp');
    if (!btn) return;
    var sync = function () {
      btn.textContent = document.body.classList.contains('hide-help')
        ? 'Show explanations'
        : 'Hide explanations';
    };
    btn.addEventListener('click', function () {
      document.body.classList.toggle('hide-help');
      sync();
    });
    sync();
  })();

  // Compact (default) vs full view: .detail elements hide in compact. Sticky.
  (function () {
    var btn = $('toggleCompact');
    var sync = function () {
      btn.textContent = document.body.classList.contains('compact') ? 'Full view' : 'Compact view';
    };
    btn.addEventListener('click', function () {
      document.body.classList.toggle('compact');
      savePref('compact', document.body.classList.contains('compact'));
      sync();
      // The history table pages by view size.
      if (typeof HISTORY !== 'undefined' && HISTORY.length) { historyPage = 0; renderHistory(); }
      if (INCIDENTS.length) { incidentPage = 0; renderIncidents(); }
    });
    if (loadPrefs().compact === false) document.body.classList.remove('compact');
    sync();
  })();

  // Restore sticky prefs and persist future changes. Runs before the
  // auto-connect below so the restored selections drive the initial loads.
  (function () {
    var prefs = loadPrefs();
    ['metricsWindow', 'usageWindow', 'realSit', 'historyMetric', 'historyDays'].forEach(function (id) {
      var el = $(id);
      if (prefs[id] != null) {
        var prev = el.value;
        el.value = String(prefs[id]);
        if (el.selectedIndex < 0) el.value = prev; // stored option no longer exists
      }
      el.addEventListener('change', function () { savePref(id, el.value); });
    });
    if (prefs.omitAdmin) {
      Array.prototype.forEach.call(document.querySelectorAll('.omitAdmin'), function (o) { o.checked = true; });
    }
    if (prefs.autoRefresh) {
      $('autoRefresh').checked = true;
      setAuto(true);
    }
  })();

  var saved = localStorage.getItem(KEY);
  if (saved) { $('tok').value = saved; connect(); }
})();
</script>
</body>
</html>`;
