/**
 * render.js
 * Handles all DOM rendering: bracket cards, round headers,
 * split-gap alignment, and SVG connector drawing.
 */

// ── Card HTML ─────────────────────────────────────────────────

function rowClass(side, g) {
  const t = side === 'top' ? g.top : g.bot;
  const isTbd = !t?.name || /(Winner|TBD|QF\d)/i.test(t.name);
  if (isTbd) return 'tbd';
  if (g.status === 'final') return g.winner === side ? 'winner' : 'loser';
  if (g.status === 'live')  return 'live';
  return 'upcoming';
}

function scoreDisplay(g, side) {
  const v = side === 'top' ? g.topScore : g.botScore;
  return v !== null && v !== undefined ? v : '—';
}

function gameInfoHTML(g) {
  if (g.status === 'final') {
    if (g.espnId) {
      return `<a class="gboxscore"
          href="https://www.espn.com/mens-college-basketball/boxscore/_/gameId/${g.espnId}"
          target="_blank" rel="noopener">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="1" y="3" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/>
            <path d="M3 3V2a2 2 0 014 0v1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="5" y1="5.5" x2="5" y2="7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          Box Score
        </a>`;
    }
    return `<span class="gfinal">Final</span>`;
  }
  const net = g.net ? `<span class="gdot">·</span><span class="gnet">${g.net}</span>` : '';
  const preview = (g.status === 'upcoming' && g.espnId)
    ? `<span class="gdot">·</span><a class="gboxscore"
        href="https://www.espn.com/mens-college-basketball/game/_/gameId/${g.espnId}/"
        target="_blank" rel="noopener">Preview</a>`
    : '';
  const liveBox = (g.status === 'live' && g.espnId)
    ? `<span class="gdot">·</span><a class="gboxscore"
        href="https://www.espn.com/mens-college-basketball/boxscore/_/gameId/${g.espnId}"
        target="_blank" rel="noopener"><svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 8L8 1M8 1H3M8 1V6" stroke="currentColor" stroke-width="1.5"/></svg> Box Score</a>`
    : '';
  const timeClass = g.status === 'live' ? 'gtime gtime--live' : 'gtime';
  return `<span class="${timeClass}">${g.time}</span>${net}${liveBox}${preview}`;
}

function cardHTML(g) {
  if (g.phantom) return `<div class="card" data-id="${g.id}" style="visibility:hidden;height:calc(2*var(--row-h) + var(--info-h))"><div class="trow"></div><div class="trow"></div><div class="ginfo"></div></div>`;

  const tc   = rowClass('top', g);
  const bc   = rowClass('bot', g);
  const tRec = g.top.rec  ? ` <span class="trec">(${g.top.rec})</span>` : '';
  const bRec = g.bot.rec  ? ` <span class="trec">(${g.bot.rec})</span>` : '';
  const tS   = g.top.seed ?? '';
  const bS   = g.bot.seed ?? '';

  return `<div class="card" data-id="${g.id}">
  <div class="trow ${tc}">
    <span class="seed">${tS}</span>
    <div class="tinfo"><div class="tname">${g.top.name}${tRec}</div></div>
    <span class="tscore">${scoreDisplay(g, 'top')}</span>
  </div>
  <div class="trow ${bc}">
    <span class="seed">${bS}</span>
    <div class="tinfo"><div class="tname">${g.bot.name}${bRec}</div></div>
    <span class="tscore">${scoreDisplay(g, 'bot')}</span>
  </div>
  <div class="ginfo">${gameInfoHTML(g)}</div>
</div>`;
}

// ── Full bracket render ───────────────────────────────────────

export function render(data, bracketEl, lastUpdEl) {
  if (!data?.rounds?.length) {
    bracketEl.innerHTML = `<div class="empty-state">No bracket data available yet.<br>Check back when the tournament begins.</div>`;
    return;
  }

  let html = '';
  data.rounds.forEach((r, i) => {
    const note = r.note ? `<div class="rnd-note">${r.note}</div>` : '';
    let cardsHTML = '';
    r.games.forEach((g, gi) => {
      cardsHTML += cardHTML(g);
      if (r.splitAfter !== undefined && gi === r.splitAfter) {
        cardsHTML += `<div class="cards-split-gap" data-split="${r.id}"></div>`;
      }
    });
    const splitClass = r.splitAfter !== undefined ? ' split' : '';
    html += `<div class="round" data-round="${r.id}">
  <div class="rnd-hdr">
    <div class="rnd-name">${r.label}</div>
    <div class="rnd-date">${r.date}</div>
    ${note}
  </div>
  <div class="cards-area${splitClass}">${cardsHTML}</div>
</div>`;

    if (i < data.rounds.length - 1) {
      const next = data.rounds[i + 1];
      if (next.connectors?.length) {
        html += `<div class="conn-col" data-conn="${r.id}-${next.id}"><svg></svg></div>`;
      } else {
        html += `<div style="width:var(--col-gap);flex-shrink:0"></div>`;
      }
    }
  });

  bracketEl.innerHTML = html;

  if (lastUpdEl) {
    lastUpdEl.textContent = 'Updated ' +
      new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  requestAnimationFrame(() => requestAnimationFrame(() => {
    alignBracket(data, bracketEl);
    alignSplitGaps(data, bracketEl);
    requestAnimationFrame(() => drawConnectors(data, bracketEl));
  }));
}

// ── Standard bracket vertical alignment ──────────────────────
// Centers each card in round N at the midpoint between its two
// feeder cards' divider lines in round N-1.

export function alignBracket(data, bracketEl) {
  if (!data?.rounds) return;

  const divY = el => {
    const row = el.querySelector('.trow');
    const r   = row.getBoundingClientRect();
    return r.top + r.height;            // bottom of top row = divider line
  };
  // Midpoint between the two team rows' centers (excludes ginfo bar)
  const twoRowMidY = el => {
    const rows = el.querySelectorAll('.trow');
    const r0   = rows[0].getBoundingClientRect();
    const r1   = rows[1].getBoundingClientRect();
    return (r0.top + r0.height / 2 + r1.top + r1.height / 2) / 2;
  };

  data.rounds.forEach(round => {
    if (!round.connectors?.length) return;

    // Reset margins and any spacer so we measure from a clean baseline
    round.games.forEach(g => {
      const card = bracketEl.querySelector(`[data-id="${g.id}"]`);
      if (card) card.style.marginTop = '';
    });
    const splitGap = bracketEl.querySelector(`[data-split="${round.id}"]`);
    if (splitGap) { splitGap.style.height = ''; splitGap.style.display = ''; }
    void bracketEl.offsetHeight;

    // Index connectors by destination game
    const byDest = {};
    round.connectors.forEach(c => { (byDest[c.toGame] ??= []).push(c); });

    // ── Spacer approach for 2-game rounds (semifinals) ────────────
    // Position card 0 via marginTop; size the spacer div so card 1
    // lands naturally at the right height without its own marginTop.
    if (round.splitAfter === 0 && round.games.length === 2 && splitGap) {
      const [g0, g1] = round.games;
      const card0 = bracketEl.querySelector(`[data-id="${g0.id}"]`);
      const card1 = bracketEl.querySelector(`[data-id="${g1.id}"]`);
      if (!card0 || !card1) return;

      const conns0 = byDest[g0.id];
      const conns1 = byDest[g1.id];
      if (!conns0?.length || !conns1?.length) return;

      const feederMid = conns => {
        if (conns.length !== 2) return null;
        const fa = bracketEl.querySelector(`[data-id="${conns[0].fromGame}"]`);
        const fb = bracketEl.querySelector(`[data-id="${conns[1].fromGame}"]`);
        return (fa && fb) ? (divY(fa) + divY(fb)) / 2 : null;
      };

      const pair0Mid = feederMid(conns0);
      const pair1Mid = feederMid(conns1);
      if (pair0Mid === null || pair1Mid === null) return;

      // Align card 0: its two-row midpoint at pair0Mid
      const delta0 = pair0Mid - twoRowMidY(card0);
      if (Math.abs(delta0) > 0.5) {
        card0.style.marginTop = delta0 + 'px';
        void bracketEl.offsetHeight;
      }

      // twoRowMidY(card) = card.top + rowH, so desired card1.top = pair1Mid - rowH
      const rowH    = card0.querySelector('.trow').getBoundingClientRect().height;
      const spacerH = (pair1Mid - rowH) - card0.getBoundingClientRect().bottom;
      if (spacerH > 0) {
        splitGap.style.height  = spacerH + 'px';
        splitGap.style.display = 'block';
      }
      return;
    }

    // ── Standard approach: marginTop on each card ─────────────────
    // Process top-to-bottom; force reflow after each adjustment so the next
    // card's measured position already accounts for previous margins.
    round.games.forEach(g => {
      const card  = bracketEl.querySelector(`[data-id="${g.id}"]`);
      if (!card) return;
      const conns = byDest[g.id];
      if (!conns || conns.length !== 2) return;

      const f0 = bracketEl.querySelector(`[data-id="${conns[0].fromGame}"]`);
      const f1 = bracketEl.querySelector(`[data-id="${conns[1].fromGame}"]`);
      if (!f0 || !f1) return;

      const target = (divY(f0) + divY(f1)) / 2;   // desired divider Y
      const delta  = target - twoRowMidY(card);
      if (Math.abs(delta) > 0.5) {
        card.style.marginTop = delta + 'px';
        void bracketEl.offsetHeight;
      }
    });
  });
}

// ── Split-gap alignment ───────────────────────────────────────

export function alignSplitGaps(data, bracketEl) {
  const cs    = getComputedStyle(document.documentElement);
  const rowH  = parseFloat(cs.getPropertyValue('--row-h'))  || 34;
  const infoH = parseFloat(cs.getPropertyValue('--info-h')) || 26;
  const cardH = rowH * 2 + infoH;
  const gap   = 12;
  const hdrH  = parseFloat(cs.getPropertyValue('--hdr-h'))  || 58;

  data.rounds.forEach((r, ri) => {
    if (r.splitAfter === undefined) return;
    const semiR  = data.rounds[ri + 1]; if (!semiR)  return;
    const champR = data.rounds[ri + 2]; if (!champR) return;

    const qfCards   = r.games.map(g    => bracketEl.querySelector(`[data-id="${g.id}"]`)).filter(Boolean);
    const semiCards = semiR.games.map(g => bracketEl.querySelector(`[data-id="${g.id}"]`)).filter(Boolean);
    if (qfCards.length < 4 || semiCards.length < 2) return;

    // Reset margins
    [...qfCards, ...semiCards].forEach(c => { c.style.marginTop = ''; });
    champR.games
      .map(g => bracketEl.querySelector(`[data-id="${g.id}"]`))
      .filter(Boolean)
      .forEach(c => { c.style.marginTop = ''; });
    bracketEl.style.minHeight = '';
    void bracketEl.offsetHeight;

    const divY    = card => { const r = card.querySelector('.trow').getBoundingClientRect(); return r.top + r.height; };
    const centerY = card => { const r = card.getBoundingClientRect(); return r.top + r.height / 2; };

    const B = divY(semiCards[semiCards.length - 1]) - divY(semiCards[0]);
    const requiredH = 3 * (B + cardH + gap) + hdrH + 20;
    if (bracketEl.getBoundingClientRect().height < requiredH) {
      bracketEl.style.minHeight = requiredH + 'px';
      void bracketEl.offsetHeight;
    }

    const semi1C = centerY(semiCards[0]);
    const semi2C = centerY(semiCards[semiCards.length - 1]);
    const targets = [
      semi1C - B / 2 - rowH,
      semi1C + B / 2 - rowH,
      semi2C - B / 2 - rowH,
      semi2C + B / 2 - rowH,
    ];

    let shift = 0;
    qfCards.forEach((card, i) => {
      const needed = targets[i] - card.getBoundingClientRect().top - shift;
      card.style.marginTop = needed + 'px';
      shift += needed;
    });

    void bracketEl.offsetHeight;
    const qfDivs  = qfCards.map(c => divY(c));
    const pair1Mid = (qfDivs[0] + qfDivs[1]) / 2;
    const pair2Mid = (qfDivs[2] + qfDivs[3]) / 2;
    semiCards.forEach((card, i) => {
      const pairMid = i === 0 ? pair1Mid : pair2Mid;
      card.style.marginTop = (pairMid - cardH / 2 - card.getBoundingClientRect().top) + 'px';
    });

    void bracketEl.offsetHeight;
    const champCards = champR.games
      .map(g => bracketEl.querySelector(`[data-id="${g.id}"]`))
      .filter(Boolean);
    if (champCards.length) {
      const semiBarMid = (divY(semiCards[0]) + divY(semiCards[semiCards.length - 1])) / 2;
      const champCard  = champCards[0];
      champCard.style.marginTop = (semiBarMid - cardH / 2 - champCard.getBoundingClientRect().top) + 'px';
    }
  });
}

// ── SVG connector drawing ─────────────────────────────────────

export function drawConnectors(data, bracketEl) {
  const bRect = bracketEl.getBoundingClientRect();

  const absY  = el => el.getBoundingClientRect().top - bRect.top;
  const getRX = id  => { const c = bracketEl.querySelector(`[data-id="${id}"]`); return c ? c.getBoundingClientRect().right - bRect.left : null; };
  const getLX = id  => { const c = bracketEl.querySelector(`[data-id="${id}"]`); return c ? c.getBoundingClientRect().left  - bRect.left : null; };

  function getY(gid, side) {
    const card = bracketEl.querySelector(`[data-id="${gid}"]`);
    if (!card) return null;
    const rows = card.querySelectorAll('.trow');
    if (side === 'divider') return absY(rows[0]) + rows[0].getBoundingClientRect().height;
    if (side === 'top')     { const r = rows[0].getBoundingClientRect(); return absY(rows[0]) + r.height / 2; }
    const r = rows[1].getBoundingClientRect(); return absY(rows[1]) + r.height / 2;
  }

  data.rounds.forEach((round, ri) => {
    if (!round.connectors?.length) return;
    const prev = data.rounds[ri - 1]; if (!prev) return;
    const col  = bracketEl.querySelector(`[data-conn="${prev.id}-${round.id}"]`); if (!col) return;
    const svg  = col.querySelector('svg');
    svg.innerHTML = '';
    const colLeft = col.getBoundingClientRect().left - bRect.left;

    function seg(x1, y1, x2, y2) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', x1 - colLeft); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2 - colLeft); l.setAttribute('y2', y2);
      l.setAttribute('stroke', '#a8b0c0');
      l.setAttribute('stroke-width', '1.5');
      l.setAttribute('stroke-linecap', 'round');
      svg.appendChild(l);
    }

    // Group connectors by destination game, skipping phantom sources
    const groups = {};
    round.connectors.forEach(c => {
      if (c.fromGame.startsWith('phantom_')) return;
      (groups[c.toGame] ??= []).push(c);
    });

    Object.entries(groups).forEach(([toId, conns]) => {
      const toLeft = getLX(toId); if (toLeft === null) return;

      if (conns.length === 1) {
        const { fromGame, fromSide, toSide } = conns[0];
        const fx = getRX(fromGame), fy = getY(fromGame, fromSide), ty = getY(toId, toSide);
        if ([fx, fy, ty].includes(null)) return;
        const mx = fx + (toLeft - fx) / 2;
        seg(fx, fy, mx, fy);
        if (Math.abs(fy - ty) > 1) seg(mx, fy, mx, ty);
        seg(mx, ty, toLeft, ty);

      } else if (conns.length === 2) {
        const [c0, c1] = conns;
        const fx0 = getRX(c0.fromGame), fy0 = getY(c0.fromGame, c0.fromSide);
        const fx1 = getRX(c1.fromGame), fy1 = getY(c1.fromGame, c1.fromSide);
        const ty0 = getY(toId, c0.toSide), ty1 = getY(toId, c1.toSide);
        if ([fx0, fx1, fy0, fy1, ty0, ty1, toLeft].includes(null)) return;
        const barX = Math.max(fx0, fx1) + (toLeft - Math.max(fx0, fx1)) * 0.45;
        seg(fx0, fy0, barX, fy0);
        seg(fx1, fy1, barX, fy1);
        seg(barX, fy0, barX, fy1);
        seg(barX, (fy0 + fy1) / 2, toLeft, (ty0 + ty1) / 2);
      }
    });
  });
}
