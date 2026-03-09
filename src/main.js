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

// ── Sidebar: built dynamically from conferences.json ──────────

function buildSidebar() {
  const list = document.getElementById('confList');
  conferences.forEach(conf => {
    const btn = document.createElement('button');
    btn.className = 'conf-btn';
    btn.dataset.conf = conf.id;
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

function setStatus(type, msg) {
  statusEl.className = 'status-bar ' + type;
  statusEl.innerHTML = msg;
}

// ── Conference switching ──────────────────────────────────────

async function switchConf(id) {
  if (active === id) return;
  active = id;

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

  statusEl.className = 'status-bar';

  if (cache.has(id)) {
    // Already fetched — render immediately from cache
    const cached = cache.get(id);
    render(cached.bracketData, bracketEl, lastUpdEl);
    updateSidebarChampion(id, cached.bracketData);
    setStatus('ok', '✓ Already fetched this session.');
  } else {
    await loadConf(conf);
  }
}

async function loadConf(conf) {
  const refreshBtn = document.querySelector('.refresh-btn');
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.innerHTML = '<span class="spinner"></span> Loading…'; }
  setStatus('info', '<span class="spinner"></span>&nbsp;Fetching bracket data from ESPN…');

  try {
    const events      = await fetchEvents(conf);
    const bracketData = buildBracketData(events, conf.seeds || null, conf.roundSlotOrder || null, conf.suppressConnectors || null, conf.feedMap || null, conf.phantomSlots || null);

    cache.set(conf.id, { events, bracketData });
    render(bracketData, bracketEl, lastUpdEl);
    updateSidebarChampion(conf.id, bracketData);

    if (!events.length) {
      setStatus('info', 'ℹ No ESPN data found — tournament may not have started yet.');
    } else {
      setStatus('ok', `✓ Loaded ${events.length} game(s) from ESPN.`);
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

window.toggleSidebar = function () {
  sidebar.classList.toggle('collapsed');
  sbToggle.textContent = sidebar.classList.contains('collapsed') ? '›' : '‹';
  setTimeout(() => requestAnimationFrame(() => drawConnectors(
    cache.get(active)?.bracketData, bracketEl
  )), 220);
};

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
switchConf(conferences[0].id);
preloadChampions();
