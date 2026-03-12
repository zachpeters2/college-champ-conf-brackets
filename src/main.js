/**
 * main.js
 * Entry point. Imports conference config, wires up the sidebar,
 * and orchestrates ESPN fetching + rendering.
 *
 * No hardcoded team names, seeds, scores, or colors here —
 * all of that lives in conferences.json (metadata) and the ESPN API (bracket data).
 */

import conferences from './conferences.json';
import { fetchEvents, buildBracketData } from './espn.js';
import { render, alignBracket, alignSplitGaps, drawConnectors } from './render.js';

// ── State ─────────────────────────────────────────────────────

const cache   = new Map();   // conf.id → { events, bracketData }
let   active  = null;        // currently displayed conf
let   sortMode = 'az';       // 'az' | 'za'
let   liveMode    = null;  // null | 'live' | 'not-live'
let   todayMode   = null;  // null | 'today' | 'not-today'
let   champMode   = null;  // null | 'champion' | 'not-champion'
const confsWithGameToday = new Set();  // populated as events load

// ── Persistent champion cache (localStorage) ──────────────────
// Champions are final once crowned — no need to re-fetch them.

const CHAMP_STORE = 'conf-champions-v1';

function loadChampionStore() {
  try { return JSON.parse(localStorage.getItem(CHAMP_STORE) || '{}'); } catch { return {}; }
}

function saveChampion(confId, championName) {
  try {
    const store = loadChampionStore();
    if (store[confId] === championName) return; // already saved
    store[confId] = championName;
    localStorage.setItem(CHAMP_STORE, JSON.stringify(store));
  } catch {}
}

function getCachedChampion(confId) {
  return loadChampionStore()[confId] ?? null;
}

// ── DOM refs ──────────────────────────────────────────────────

const bracketEl  = document.getElementById('bracket');
const lastUpdEl  = document.getElementById('lastUpd');
const statusEl   = document.getElementById('statusBar');
const hdrSponsor = document.getElementById('hdrSponsor');
const hdrTitle   = document.getElementById('hdrTitle');
const hdrSub     = document.getElementById('hdrSub');
const hdrBadges  = document.getElementById('hdrBadges');
const ftDisc     = document.getElementById('ftDisc');
const ftLinks    = document.getElementById('ftLinks');
const sidebar    = document.getElementById('sidebar');
const sbToggle   = document.getElementById('sbToggle');
const sbOverlay  = document.getElementById('sbOverlay');

// ── Sidebar: built dynamically from conferences.json ──────────

function buildSidebar() {
  const list = document.getElementById('confList');
  const storedChamps = loadChampionStore();
  conferences.forEach(conf => {
    const btn = document.createElement('button');
    btn.className = 'conf-btn';
    btn.dataset.conf = conf.id;
    btn.title = conf.name;
    btn.style.setProperty('--c-accent', conf.accentHi);
    const cachedChamp = storedChamps[conf.id];
    btn.innerHTML = `
      <div class="conf-dot"></div>
      <div class="conf-btn-text">
        <div class="conf-name">${cachedChamp ? `🏆 ${conf.name}` : conf.name}</div>
        <div class="conf-dates${cachedChamp ? ' champion' : ''}">${cachedChamp ?? conf.dates}</div>
      </div>
      <span class="conf-live" hidden>LIVE</span>`;
    btn.addEventListener('click', () => switchConf(conf.id));
    list.appendChild(btn);
  });
  sortSidebar();
}

function sortSidebar() {
  const list = document.getElementById('confList');
  const btns = [...list.querySelectorAll('.conf-btn')];
  btns.sort((a, b) => {
    const aName = conferences.find(c => c.id === a.dataset.conf)?.name ?? '';
    const bName = conferences.find(c => c.id === b.dataset.conf)?.name ?? '';
    return sortMode === 'az' ? aName.localeCompare(bName) : bName.localeCompare(aName);
  });
  btns.forEach(btn => list.appendChild(btn));
}

window.cycleAlphaSort = function () {
  const btn = document.getElementById('filterAlpha');
  if (sortMode === 'az') { sortMode = 'za'; btn.textContent = 'Z–A'; }
  else                   { sortMode = 'az'; btn.textContent = 'A–Z'; }
  sortSidebar();
};

function applyFilters() {
  const anyActive = liveMode !== null || todayMode !== null || champMode !== null;
  document.querySelectorAll('.conf-btn').forEach(btn => {
    const id = btn.dataset.conf;
    if (!anyActive) { btn.style.display = ''; return; }
    const isChamp = !!(getCachedChampion(id) || getChampion(cache.get(id)?.bracketData));
    const isLive  = hasLiveGames(cache.get(id)?.bracketData);
    const isToday = confsWithGameToday.has(id);
    const visible =
      (liveMode  === null || (liveMode  === 'live'     ? isLive  : !isLive))  &&
      (todayMode === null || (todayMode === 'today'    ? isToday : !isToday)) &&
      (champMode === null || (champMode === 'champion' ? isChamp : !isChamp));
    btn.style.display = visible ? '' : 'none';
  });
}

window.cycleLiveFilter = function () {
  const btn = document.getElementById('filterLive');
  if (liveMode === null)       { liveMode = 'live';     btn.classList.add('active'); btn.classList.remove('negated'); }
  else if (liveMode === 'live') { liveMode = 'not-live'; btn.classList.add('negated'); }
  else                          { liveMode = null;       btn.classList.remove('active', 'negated'); }
  applyFilters();
};

window.cycleTodayFilter = function () {
  const btn = document.getElementById('filterToday');
  if (todayMode === null)        { todayMode = 'today';     btn.classList.add('active'); btn.classList.remove('negated'); }
  else if (todayMode === 'today') { todayMode = 'not-today'; btn.classList.add('negated'); }
  else                            { todayMode = null;        btn.classList.remove('active', 'negated'); }
  applyFilters();
};

window.cycleChampFilter = function () {
  const btn = document.getElementById('filterChamp');
  if (champMode === null)           { champMode = 'champion';     btn.classList.add('active'); btn.classList.remove('negated'); }
  else if (champMode === 'champion') { champMode = 'not-champion'; btn.classList.add('negated'); }
  else                               { champMode = null;           btn.classList.remove('active', 'negated'); }
  applyFilters();
};

// ── Champion / round detection ────────────────────────────────

/** Returns the label of the current or next upcoming round, or null if not started. */
function getCurrentRound(bracketData) {
  if (!bracketData?.rounds?.length) return null;
  const rounds = bracketData.rounds;

  // Live round takes priority
  for (const r of rounds) {
    if (r.games.some(g => !g.phantom && g.status === 'live')) return r.label;
  }

  // Walk rounds to find the first incomplete one
  let lastCompletedLabel = null;
  for (const r of rounds) {
    const real = r.games.filter(g => !g.phantom);
    if (!real.length) continue;
    const allFinal = real.every(g => g.status === 'final');
    if (allFinal) { lastCompletedLabel = r.label; continue; }
    const anyStarted = real.some(g => g.status === 'final' || g.status === 'live');
    // Next round exists but hasn't started — show as complete unless it's today
    if (lastCompletedLabel && !anyStarted) {
      const todayLocal = new Date().toLocaleDateString('en-CA');
      if (r.isoDate === todayLocal) return r.label;
      return `${lastCompletedLabel} Complete`;
    }
    if (lastCompletedLabel || anyStarted) return r.label;
    return null; // No games finished yet anywhere — tournament hasn't started
  }
  return null; // All rounds final (champion case handled separately)
}

function getChampion(bracketData) {
  if (!bracketData?.rounds?.length) return null;
  const finalRound = bracketData.rounds[bracketData.rounds.length - 1];
  if (finalRound.games.length !== 1) return null;
  const g = finalRound.games[0];
  if (g.status !== 'final' || !g.winner) return null;
  return g.winner === 'top' ? g.top.name : g.bot.name;
}

function updateSidebarChampion(confId, bracketData) {
  const champion = getChampion(bracketData);
  if (champion) saveChampion(confId, champion);
  const btn = document.querySelector(`.conf-btn[data-conf="${confId}"]`);
  if (!btn) return;
  const conf    = conferences.find(c => c.id === confId);
  const nameEl  = btn.querySelector('.conf-name');
  const datesEl = btn.querySelector('.conf-dates');
  const liveEl  = btn.querySelector('.conf-live');
  if (liveEl) liveEl.hidden = !hasLiveGames(bracketData);
  if (champion) {
    if (nameEl)  nameEl.textContent = `🏆 ${conf?.name ?? confId}`;
    if (datesEl) { datesEl.textContent = champion; datesEl.className = 'conf-dates champion'; }
  } else {
    const currentRound = getCurrentRound(bracketData);
    if (nameEl) nameEl.textContent = conf?.name ?? confId;
    if (datesEl) {
      if (currentRound) {
        const isComplete = currentRound.endsWith(' Complete');
        datesEl.innerHTML = `<strong>${currentRound}</strong>`;
        datesEl.className = isComplete ? 'conf-dates round-complete' : 'conf-dates in-progress';
      } else {
        datesEl.textContent = conf?.dates ?? '';
        datesEl.className = 'conf-dates';
      }
    }
  }
  sortSidebar();
}

// ── Status bar ────────────────────────────────────────────────

let statusDismissTimer = null;

function setStatus(type, msg) {
  clearTimeout(statusDismissTimer);
  statusEl.className = 'status-bar ' + type;
  statusEl.innerHTML = msg;
  if (type === 'ok') {
    statusDismissTimer = setTimeout(() => { statusEl.className = 'status-bar'; }, 3000);
  }
}

// ── Auto-refresh ──────────────────────────────────────────────

let autoRefreshTimer = null;

function hasLiveGames(bracketData) {
  return bracketData?.rounds?.some(r => r.games.some(g => g.status === 'live'));
}

function hasGameToday(events) {
  const today = new Date().toDateString();
  return events.some(e => e.date && new Date(e.date).toDateString() === today);
}

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  const data = cache.get(active)?.bracketData;
  const isLive = hasLiveGames(data);
  const hasTodayUnfinished = confsWithGameToday.has(active) && !getChampion(data);

  if (!isLive && !hasTodayUnfinished) return;
  const delay = isLive ? 60_000 : 5 * 60_000;
  autoRefreshTimer = setTimeout(async () => {
    cache.delete(active);
    const conf = conferences.find(c => c.id === active);
    if (conf) await loadConf(conf);
  }, delay);
}

// ── Conference switching ──────────────────────────────────────

async function switchConf(id) {
  if (active === id) return;
  clearTimeout(autoRefreshTimer);
  active = id;
  history.replaceState(null, '', '#' + id);
  const confName = conferences.find(c => c.id === id)?.name ?? 'Conference';
  document.title = `${confName} Tournament Bracket — 2026`;

  document.getElementById('main').scrollTop = 0;
  document.querySelector('.bracket-outer').scrollLeft = 0;

  const conf = conferences.find(c => c.id === id);
  if (!conf) return;

  // Update CSS accent variables
  const root = document.documentElement;
  root.style.setProperty('--accent',     conf.accent);
  root.style.setProperty('--accent-hi',  conf.accentHi);
  root.style.setProperty('--accent-dim', conf.accentDim);

  // Update header
  hdrSponsor.textContent = conf.sponsor;
  hdrTitle.innerHTML     = conf.titleHTML;
  hdrSub.textContent     = conf.sub;
  hdrBadges.innerHTML    = (conf.badges || []).map(b => `<span class="badge">${b}</span>`).join('');
  ftDisc.textContent     = conf.footerDisc;
  ftLinks.innerHTML      = conf.footerLinks;

  // Mark active sidebar button
  document.querySelectorAll('.conf-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.conf === id)
  );

  if (isMobile() && sidebar.classList.contains('mobile-open')) {
    sidebar.classList.remove('mobile-open');
    sbOverlay.classList.remove('visible');
  }

  statusEl.className = 'status-bar';

  if (cache.has(id)) {
    // Render immediately from cache, then silently re-fetch in background
    const cached = cache.get(id);
    render(cached.bracketData, bracketEl, lastUpdEl);
    updateSidebarChampion(id, cached.bracketData);
    scheduleAutoRefresh();

    (async () => {
      try {
        const events      = await fetchEvents(conf);
        if (active !== id) return; // user switched away before fetch completed
        const bracketData = buildBracketData(events, conf.seeds || null, conf.roundSlotOrder || null, conf.suppressConnectors || null, conf.feedMap || null, conf.phantomSlots || null);
        cache.set(conf.id, { events, bracketData });
        if (hasGameToday(events)) confsWithGameToday.add(conf.id);
        render(bracketData, bracketEl, lastUpdEl);
        updateSidebarChampion(conf.id, bracketData);
        scheduleAutoRefresh();
      } catch { /* silent — stale cache stays rendered */ }
    })();
  } else {
    await loadConf(conf);
  }
}

async function loadConf(conf) {
  const refreshBtn = document.querySelector('.refresh-btn');
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.innerHTML = '<span class="spinner"></span> Loading…'; }
  statusEl.className = 'status-bar'; // hide any previous banner while loading

  try {
    const events      = await fetchEvents(conf);
    const bracketData = buildBracketData(events, conf.seeds || null, conf.roundSlotOrder || null, conf.suppressConnectors || null, conf.feedMap || null, conf.phantomSlots || null);

    cache.set(conf.id, { events, bracketData });
    if (hasGameToday(events)) confsWithGameToday.add(conf.id);
    render(bracketData, bracketEl, lastUpdEl);
    updateSidebarChampion(conf.id, bracketData);
    scheduleAutoRefresh();

    // Flash live cards to dark briefly to signal the refresh completed
    bracketEl.classList.remove('refreshed');
    void bracketEl.offsetWidth; // force reflow so re-adding restarts the transition
    bracketEl.classList.add('refreshed');
    setTimeout(() => bracketEl.classList.remove('refreshed'), 2100);

    if (!events.length) {
      setStatus('info', 'ℹ No ESPN data found — tournament may not have started yet.');
    }
  } catch (e) {
    setStatus('error', '⚠ ' + e.message);
  } finally {
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = '↻ Refresh'; }
  }
}

// ── Manual refresh ────────────────────────────────────────────

window.refreshScores = async function () {
  if (!active) return;
  cache.delete(active);
  const conf = conferences.find(c => c.id === active);
  if (conf) await loadConf(conf);
};

// ── Sidebar toggle ────────────────────────────────────────────

function isMobile() {
  return window.matchMedia('(max-width: 640px)').matches;
}

window.toggleSidebar = function () {
  if (isMobile()) {
    const isOpen = sidebar.classList.toggle('mobile-open');
    sbOverlay.classList.toggle('visible', isOpen);
  } else {
    const collapsed = sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    sbToggle.textContent = collapsed ? '›' : '‹';
  }
  setTimeout(() => requestAnimationFrame(() => drawConnectors(
    cache.get(active)?.bracketData, bracketEl
  )), 230);
};

sbOverlay.addEventListener('click', () => toggleSidebar());

// ── Resize handler ────────────────────────────────────────────

window.addEventListener('resize', () => {
  const data = cache.get(active)?.bracketData;
  if (!data) return;
  requestAnimationFrame(() => {
    alignBracket(data, bracketEl);
    alignSplitGaps(data, bracketEl);
    requestAnimationFrame(() => drawConnectors(data, bracketEl));
  });
});

// ── Background champion preload ───────────────────────────────
// Fetches all conferences silently after boot so sidebar champions
// appear without requiring the user to click each conference.

async function preloadChampions() {
  for (const conf of conferences) {
    if (cache.has(conf.id)) continue;
    if (getCachedChampion(conf.id)) continue; // already final — skip API call
    try {
      const events      = await fetchEvents(conf);
      const bracketData = buildBracketData(events, conf.seeds || null, conf.roundSlotOrder || null, conf.suppressConnectors || null, conf.feedMap || null, conf.phantomSlots || null);
      cache.set(conf.id, { events, bracketData });
      if (hasGameToday(events)) confsWithGameToday.add(conf.id);
      updateSidebarChampion(conf.id, bracketData);
      applyFilters();
    } catch {}
  }
}

// ── Boot ──────────────────────────────────────────────────────

buildSidebar();
document.getElementById('filterAlpha')?.classList.add('active');
const hashId    = window.location.hash.slice(1);
const startConf = conferences.find(c => c.id === hashId) ?? conferences[0];
switchConf(startConf.id);
preloadChampions();
