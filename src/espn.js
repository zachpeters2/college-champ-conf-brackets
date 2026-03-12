/**
 * espn.js
 * Fetches live bracket data from the ESPN public scoreboard API and
 * transforms it into the internal round/game format the renderer expects.
 *
 * ESPN API endpoint (no auth, no rate limits):
 * https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard
 *   ?groups=<groupId>&dates=<YYYYMMDD-YYYYMMDD>&limit=100
 */

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';

/** Fetch all events for a conference from ESPN */
export async function fetchEvents(conf) {
  const url = `${ESPN_BASE}?groups=${conf.espnGroupId}&dates=${conf.espnDateRange}&limit=100`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.events || [];
  } catch {
    return [];
  }
}

const ROUND_LABEL_MAP = {
  'Quarterfinal':  'Quarterfinals',
  'Semifinal':     'Semifinals',
  'Final':         'Championship Game',
};

function normalizeRoundLabel(label) {
  return ROUND_LABEL_MAP[label] ?? label;
}

/** Transform raw ESPN events into the internal { rounds } bracket structure */
export function buildBracketData(events, seedsMap, roundSlotOrder, suppressConnectors, feedMap, phantomSlots, bracketSlots) {
  if (!events.length) return null;

  // Group events by round label from ESPN
  const roundMap = new Map();
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const note = comp?.notes?.[0]?.headline ?? '';
    const key  = note || ev.date?.slice(0, 10) || 'Unknown';

    if (!roundMap.has(key)) {
      roundMap.set(key, {
        id:      `rnd_${roundMap.size}`,
        label:   note ? normalizeRoundLabel(note.split(' - ').pop()) : key,
        date:    formatDate(ev.date),
        isoDate: ev.date ? new Date(ev.date).toLocaleDateString('en-CA') : null,
        games:   [],
        venue:   comp?.venue?.fullName || '',
      });
    }
    roundMap.get(key).games.push(transformEvent(ev, seedsMap));
  }

  // Sort rounds by the date of their first game
  const rounds = [...roundMap.values()].sort((a, b) =>
    (a.games[0]?._rawDate ?? '').localeCompare(b.games[0]?._rawDate ?? '')
  );

  // If bracketSlots (preferred) or roundSlotOrder is provided, merge consecutive
  // ESPN rounds until each round's game count matches the expected slot count.
  // This handles cases where ESPN splits one logical round across multiple
  // date/label groups (e.g. campus-site QFs on two different days).
  const slotConfig = bracketSlots ?? roundSlotOrder;
  if (slotConfig && rounds.length > slotConfig.length) {
    let rso = 0;
    let i = 0;
    while (i < rounds.length && rso < slotConfig.length) {
      const expected = slotConfig[rso].length;
      while (rounds[i].games.length < expected && i + 1 < rounds.length) {
        const next = rounds[i + 1];
        // Combine date strings when the two groups span different days
        if (next.date && next.date !== rounds[i].date) {
          const stripWeekday = s => s.replace(/^\w+,\s*/, ''); // "Saturday, March 8" → "March 8"
          const firstDate  = stripWeekday(rounds[i].date);
          const secondDate = stripWeekday(next.date);
          const secondDay  = secondDate.split(' ').pop();       // "March 9" → "9"
          rounds[i].date = `${firstDate} & ${secondDay}`;
        }
        rounds[i].games = [...rounds[i].games, ...rounds[i + 1].games];
        rounds.splice(i + 1, 1);
      }
      i++;
      rso++;
    }
  }

  // Within each round, order games by bracket slot position.
  //
  // If bracketSlots[ri] is defined (preferred): use seed-set matching.
  //   Each slot is an array of ALL seeds that could appear there. A game is
  //   assigned to the slot with the most seed overlap. This is robust to upsets
  //   and partial advancement — no need to enumerate every possible upset seed.
  //
  // Otherwise fall back to roundSlotOrder (legacy): sort by indexOf(top.seed).
  rounds.forEach((r, ri) => {
    const slots = bracketSlots?.[ri] ?? null;

    if (slots) {
      // Seed-set matching: assign each game to the slot containing its seeds
      const result = new Array(slots.length).fill(null);
      const unplaced = [];

      r.games.forEach(game => {
        const seeds = [game.top.seed, game.bot.seed].filter(s => s != null);
        let bestSlot = -1, bestScore = 0;
        for (let si = 0; si < slots.length; si++) {
          if (result[si] !== null) continue;
          const score = seeds.filter(s => slots[si].includes(s)).length;
          if (score > bestScore) { bestScore = score; bestSlot = si; }
        }
        if (bestSlot !== -1) result[bestSlot] = game;
        else unplaced.push(game);
      });

      // Fill remaining gaps (TBD vs TBD games) in original order
      let ui = 0;
      for (let i = 0; i < slots.length && ui < unplaced.length; i++) {
        if (result[i] === null) result[i] = unplaced[ui++];
      }
      r.games = result.filter(Boolean);
      return;
    }

    // Legacy: sort by roundSlotOrder indexOf(top.seed)
    const slotOrder = roundSlotOrder?.[ri] ?? null;
    r.games.sort((a, b) => {
      const posA = slotOrder ? slotOrder.indexOf(a.top.seed ?? -1) : -1;
      const posB = slotOrder ? slotOrder.indexOf(b.top.seed ?? -1) : -1;
      const rankA = posA !== -1 ? posA : (a.top.seed ?? Infinity) + 1000;
      const rankB = posB !== -1 ? posB : (b.top.seed ?? Infinity) + 1000;
      return rankA - rankB;
    });
  });

  // Detect rounds whose games span multiple calendar days; annotate with date range + per-game date
  const longDate  = raw => new Date(raw).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });
  const shortDate = raw => new Date(raw).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
  rounds.forEach(r => {
    const dated = r.games.filter(g => g._rawDate);
    const localDates = [...new Set(
      dated.map(g => new Date(g._rawDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
    )].sort();
    if (localDates.length > 1) {
      r.date = `${longDate(localDates[0] + 'T12:00:00')} – ${longDate(localDates[localDates.length - 1] + 'T12:00:00')}`;
      dated.forEach(g => { g.gameDate = shortDate(g._rawDate); });
    }
  });

  // Clean up internal sort key
  rounds.forEach(r => r.games.forEach(g => delete g._rawDate));

  // Insert phantom (invisible placeholder) games at specified positions.
  // phantomSlots = [[roundIndex, insertPosition], ...]
  // Phantom games take up visual space so standard 2:1 connectors align correctly.
  if (phantomSlots) {
    for (const [ri, pos] of phantomSlots) {
      const round = rounds[ri];
      if (!round) continue;
      round.games.splice(pos, 0, { id: `phantom_${ri}_${pos}`, phantom: true });
    }
  }

  // Explicit feedMap connectors: feedMap[ri] = [[fromIdx, toIdx], ...] pairs
  // Each pair routes prev.games[fromIdx] → round.games[toIdx] (bot slot).
  // Rounds with explicit connectors are skipped by the auto-connector loops below.
  if (feedMap) {
    rounds.forEach((round, ri) => {
      const prev = rounds[ri - 1];
      const pairs = feedMap[ri];
      if (!prev || !pairs) return;
      const connectors = [];
      for (const [fromIdx, toIdx, toSide = 'bot'] of pairs) {
        const fromGame = prev.games[fromIdx];
        const toGame   = round.games[toIdx];
        if (!fromGame || !toGame) continue;
        connectors.push({ fromGame: fromGame.id, fromSide: 'divider', toGame: toGame.id, toSide });
      }
      if (connectors.length) round.connectors = connectors;
    });
  }

  // Build connectors for rounds where the previous round has exactly 2x the games
  // (standard single-elimination pairing: adjacent pairs feed into next-round games)
  rounds.forEach((round, ri) => {
    const prev = rounds[ri - 1];
    if (!prev || round.games.length * 2 !== prev.games.length) return;
    if (suppressConnectors?.includes(ri)) return;
    if (round.connectors) return;
    const connectors = [];
    for (let i = 0; i < prev.games.length; i += 2) {
      const g0 = prev.games[i];
      const g1 = prev.games[i + 1];
      const toGame = round.games[i / 2];
      if (!g0 || !g1 || !toGame) continue;
      connectors.push({ fromGame: g0.id, fromSide: 'divider', toGame: toGame.id, toSide: 'top' });
      connectors.push({ fromGame: g1.id, fromSide: 'divider', toGame: toGame.id, toSide: 'bot' });
    }
    if (connectors.length) round.connectors = connectors;
  });

  // Step-ladder: 1:1 connectors when consecutive rounds have the same game count.
  // Winner of prev.games[i] feeds the 'bot' slot of round.games[i].
  rounds.forEach((round, ri) => {
    const prev = rounds[ri - 1];
    if (!prev || round.games.length !== prev.games.length) return;
    if (suppressConnectors?.includes(ri)) return;
    if (round.connectors) return;
    const connectors = [];
    for (let i = 0; i < prev.games.length; i++) {
      const fromGame = prev.games[i];
      const toGame   = round.games[i];
      if (!fromGame || !toGame) continue;
      connectors.push({ fromGame: fromGame.id, fromSide: 'divider', toGame: toGame.id, toSide: 'bot' });
    }
    if (connectors.length) round.connectors = connectors;
  });

  // Play-in / partial feed: when prev round has fewer games, each prev game
  // feeds the bot slot of the corresponding-indexed game in the next round.
  rounds.forEach((round, ri) => {
    const prev = rounds[ri - 1];
    if (!prev || prev.games.length >= round.games.length) return;
    if (suppressConnectors?.includes(ri)) return;
    if (round.connectors) return;
    const connectors = [];
    for (let i = 0; i < prev.games.length; i++) {
      const fromGame = prev.games[i];
      const toGame   = round.games[i];
      if (!fromGame || !toGame) continue;
      connectors.push({ fromGame: fromGame.id, fromSide: 'divider', toGame: toGame.id, toSide: 'bot' });
    }
    if (connectors.length) round.connectors = connectors;
  });

  // Adjust top/bot placement to follow bracket position rather than seed number.
  // For 2:1 connector rounds: the winner of the earlier (even-indexed) feeder game
  // should occupy the top slot, matching traditional bracket visual conventions.
  const gameById = new Map();
  rounds.forEach(r => r.games.forEach(g => { if (g.id) gameById.set(g.id, g); }));

  rounds.forEach((round, ri) => {
    const prev = rounds[ri - 1];
    if (!prev || round.games.length * 2 !== prev.games.length) return;
    if (suppressConnectors?.includes(ri)) return;

    round.games.forEach(game => {
      if (!game || game.phantom) return;

      const topConn = round.connectors?.find(c => c.toGame === game.id && c.toSide === 'top');
      const botConn = round.connectors?.find(c => c.toGame === game.id && c.toSide === 'bot');
      if (!topConn || !botConn) return;

      const topFeeder = gameById.get(topConn.fromGame);
      const botFeeder = gameById.get(botConn.fromGame);
      if (!topFeeder || !botFeeder || topFeeder.phantom || botFeeder.phantom) return;

      const topFeederWinner = topFeeder.winner
        ? (topFeeder.winner === 'top' ? topFeeder.top.name : topFeeder.bot.name)
        : null;
      const botFeederWinner = botFeeder.winner
        ? (botFeeder.winner === 'top' ? botFeeder.top.name : botFeeder.bot.name)
        : null;

      const swap = () => {
        [game.top, game.bot] = [game.bot, game.top];
        [game.topScore, game.botScore] = [game.botScore, game.topScore];
        if (game.winner === 'top') game.winner = 'bot';
        else if (game.winner === 'bot') game.winner = 'top';
      };

      if (topFeederWinner && game.bot.name === topFeederWinner) {
        swap(); // top feeder's winner is in the bot slot
      } else if (!topFeederWinner && botFeederWinner && game.top.name === botFeederWinner) {
        swap(); // only bot feeder is known, but their winner is in the top slot
      }
    });
  });

  // Mark classic SF rounds (2 games, preceded by 4 games, with connectors) with a spacer split.
  // Gated on connectors existing so suppressed rounds keep their normal centered layout.
  rounds.forEach((round, ri) => {
    const prev = rounds[ri - 1];
    if (round.games.length === 2 && prev?.games.length === 4 && round.connectors?.length) {
      round.splitAfter = 0;
    }
  });

  return { rounds };
}

/** Transform a single ESPN event into the internal game shape */
function transformEvent(ev, seedsMap) {
  const comp    = ev.competitions?.[0];
  const comps   = comp?.competitors || [];
  const status  = comp?.status?.type;
  const home    = comps.find(c => c.homeAway === 'home') || comps[0];
  const away    = comps.find(c => c.homeAway === 'away') || comps[1];

  const isFinal = status?.name === 'STATUS_FINAL';
  const isLive  = status?.state === 'in';

  // Sort top/bot by seed so lower seed (better team) is on top.
  // Fall back to away-on-top if seeds are unavailable.
const awaySeed = seedOf(away, seedsMap);
const homeSeed = seedOf(home, seedsMap);
let topTeam, botTeam;

// 1. If both teams have seeds, put the better (lower number) seed on top
if (awaySeed !== null && homeSeed !== null) {
  topTeam = awaySeed <= homeSeed ? away : home;
  botTeam = awaySeed <= homeSeed ? home : away;
} 
// 2. If ONLY the Away team has a seed, put them on top
else if (awaySeed !== null) {
  topTeam = away;
  botTeam = home;
} 
// 3. If ONLY the Home team has a seed, put them on top
else if (homeSeed !== null) {
  topTeam = home;
  botTeam = away;
} 
// 4. If neither has a seed (TBD vs TBD), default to ESPN's Away-on-Top
else {
  topTeam = away;
  botTeam = home;
}

  const topScore = isFinal || isLive ? parseInt(topTeam?.score) ?? null : null;
  const botScore = isFinal || isLive ? parseInt(botTeam?.score) ?? null : null;

  let winner = null;
  if (isFinal && topScore !== null && botScore !== null) {
    winner = topScore > botScore ? 'top' : 'bot';
  }

  const broadcast = comp?.broadcasts?.[0]?.names?.[0]
    || comp?.geoBroadcasts?.[0]?.media?.shortName
    || '';

  return {
    id:       `espn_${ev.id}`,
    espnId:   ev.id,
    _rawDate: ev.date,
    top: {
      seed: seedOf(topTeam, seedsMap),
      name: shortName(topTeam),
      rec:  teamRecord(topTeam),
    },
    bot: {
      seed: seedOf(botTeam, seedsMap),
      name: shortName(botTeam),
      rec:  teamRecord(botTeam),
    },
    topScore,
    botScore,
    status: isFinal ? 'final' : isLive ? 'live' : 'upcoming',
    winner,
    time:   isLive
      ? (comp?.status?.type?.shortDetail ?? comp?.status?.type?.detail ?? formatTime(ev.date))
      : formatTime(ev.date),
    net:    broadcast,
  };
}

/**
 * Extract the tournament seed from a competitor object.
 *
 * ESPN stores seeds in several places depending on endpoint version:
 *   - competitor.seed          (most scoreboard responses)
 *   - competitor.seeding       (alternate key, older responses)
 *
 * curatedRank.current is ESPN's national AP-style ranking and reaches 99
 * for unranked teams — we explicitly ignore it here.
 */
function seedOf(competitor, seedsMap) {
  const candidates = [
    competitor?.seed,
    competitor?.seeding,
  ];
  for (const v of candidates) {
    const n = parseInt(v);
    if (!isNaN(n) && n > 0 && n < 99) return n;
  }
  if (seedsMap) {
    const name = competitor?.team?.shortDisplayName || competitor?.team?.displayName;
    if (name) return lookupSeed(name, seedsMap);
  }
  return null;
}

/**
 * Look up a team's conference tournament seed from the static seeds map.
 * Tries exact match first (case-insensitive, periods stripped), then checks
 * if a stored key contains the ESPN name (handles "Illinois State" → "Illinois St.").
 */
function lookupSeed(teamName, seedsMap) {
  const norm = s => s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const normName = norm(teamName);
  for (const [key, seed] of Object.entries(seedsMap)) {
    if (norm(key) === normName) return seed;
  }
  for (const [key, seed] of Object.entries(seedsMap)) {
    if (norm(key).includes(normName)) return seed;
  }
  return null;
}

function shortName(competitor) {
  return competitor?.team?.shortDisplayName
    || competitor?.team?.displayName
    || 'TBD';
}

function teamRecord(competitor) {
  // Prefer conference record, fall back to overall record
  const records  = competitor?.records || [];
  const confRec  = records.find(r => r.type === 'vsconf');
  const totalRec = records.find(r => r.type === 'total');
  const rec = confRec || totalRec;
  return rec ? rec.summary : null;
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });
}

function formatTime(isoDate) {
  if (!isoDate) return 'TBD';
  return new Date(isoDate).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: 'America/New_York',
  });
}
