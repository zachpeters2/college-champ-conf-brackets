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
  conferences.forEach(conf => {
    const btn = document.createElement('button');
    btn.className = 'conf-btn';
    btn.dataset.conf = conf.id;
    btn.title = conf.name;
    btn.style.setProperty('--c-accent', conf.accentHi);
    btn.innerHTML = `
      <div class="conf-dot"></div>
      <div class="conf-btn-text">
        <div class="conf-name">${conf.name}</div>
        <div class="conf-dates">${conf.dates}</div>
      </div>`;
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
    return aName.localeCompare(bName);
  });
  btns.forEach(btn => list.appendChild(btn));
}

// ── Champion detection ────────────────────────────────────────

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
  const btn = document.querySelector(`.conf-btn[data-conf="${confId}"]`);
  if (!btn) return;
  const conf    = conferences.find(c => c.id === confId);
  const nameEl  = btn.querySelector('.conf-name');
  const datesEl = btn.querySelector('.conf-dates');
  if (champion) {
    if (nameEl)  nameEl.textContent = `🏆 ${conf?.name ?? confId}`;
    if (datesEl) { datesEl.textContent = champion; datesEl.classList.add('champion'); }
  } else {
    if (nameEl)  nameEl.textContent = conf?.name ?? confId;
    if (datesEl) { datesEl.textContent = conf?.dates ?? ''; datesEl.classList.remove('champion'); }
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

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  const data = cache.get(active)?.bracketData;
  if (!hasLiveGames(data)) return;
  autoRefreshTimer = setTimeout(async () => {
    cache.delete(active);
    const conf = conferences.find(c => c.id === active);
    if (conf) await loadConf(conf);
  }, 60_000);
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
    // Already fetched — render immediately from cache
    const cached = cache.get(id);
    render(cached.bracketData, bracketEl, lastUpdEl);
    updateSidebarChampion(id, cached.bracketData);
    scheduleAutoRefresh();
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
    render(bracketData, bracketEl, lastUpdEl);
    updateSidebarChampion(conf.id, bracketData);
    scheduleAutoRefresh();

    // Flash live cards to dark briefly to signal the refresh completed
    bracketEl.classList.remove('refreshed');
    void bracketEl.offsetWidth; // force reflow so re-adding restarts the transition
    bracketEl.classList.add('refreshed');
    setTimeout(() => bracketEl.classList.remove('refreshed'), 5100);

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
    try {
      const events      = await fetchEvents(conf);
      const bracketData = buildBracketData(events, conf.seeds || null, conf.roundSlotOrder || null, conf.suppressConnectors || null, conf.feedMap || null, conf.phantomSlots || null);
      cache.set(conf.id, { events, bracketData });
      updateSidebarChampion(conf.id, bracketData);
    } catch {}
  }
}

// ── Boot ──────────────────────────────────────────────────────

buildSidebar();
const hashId    = window.location.hash.slice(1);
const startConf = conferences.find(c => c.id === hashId) ?? conferences[0];
switchConf(startConf.id);
preloadChampions();
