/**
 * GOAL LIGHT SERVER v5.0
 * =============================================================
 * Principe de la synchro TV:
 *
 *  - Poll API NHL toutes les 2s → chaque événement stocké avec
 *    timeInPeriod + realAt (Date.now() au moment de la réception)
 *  - Le chrono NHL DESCEND: 20:00 → 0:00
 *  - Quand l'utilisateur fait SYNCHRO:
 *      clickMs = Date.now() sur son téléphone
 *      tvTime  = chrono vu à la télé ("14:23")
 *      period  = période
 *  - On cherche l'entrée du buffer dont timeInPeriod est la plus
 *    proche de tvTime
 *  - delayTV = clickMs - realAt_de_cette_entrée
 * =============================================================
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT    = process.env.PORT || 3000;
const NHL_API = 'https://api-web.nhle.com/v1';

let TEAM_ID = parseInt(process.env.TEAM_ID || '8');

// ─── ÉTAT ────────────────────────────────────────────────────
const state = {
  gameId:          null,
  period:          0,
  homeScore:       0,
  awayScore:       0,
  clockRunning:    false,
  lastEventId:     null,
  lastGoalEventId: null,
  goals:           [],
  buffer:          [], // { period, timeInPeriod, realAt, clockRunning }
};

// ─── HELPERS ─────────────────────────────────────────────────
function toSecs(t) {
  if (!t) return -1;
  const [m, s] = t.split(':').map(Number);
  return m * 60 + (s || 0);
}

function pushBuffer(entry) {
  state.buffer.push(entry);
  if (state.buffer.length > 300) state.buffer.shift();
}

function clockFor(type, prev) {
  if (type === 'faceoff') return true;
  if (['stoppage','goal','penalty','period-end','period-start','game-end'].includes(type)) return false;
  return prev;
}

async function nhlGet(path) {
  const { data } = await axios.get(`${NHL_API}${path}`, { timeout: 8000 });
  return data;
}

// ─── TROUVER LA PARTIE ───────────────────────────────────────
async function findGame() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const yest  = new Date(now - 86400000).toISOString().slice(0, 10);
  let games   = [];
  for (const d of [today, yest]) {
    try {
      const data = await nhlGet(`/schedule/${d}`);
      games = games.concat((data.gameWeek || []).flatMap(w => w.games || []));
    } catch(e) {}
  }
  return games.find(g =>
    (g.homeTeam?.id === TEAM_ID || g.awayTeam?.id === TEAM_ID) &&
    !['OFF','FINAL','FUT','PRE'].includes(g.gameState)
  ) || null;
}

// ─── RESET ───────────────────────────────────────────────────
function resetState() {
  Object.assign(state, {
    gameId: null, period: 0, homeScore: 0, awayScore: 0,
    clockRunning: false, lastEventId: null, lastGoalEventId: null,
    goals: [], buffer: [],
  });
}

// ─── POLLING ─────────────────────────────────────────────────
async function poll() {
  try {
    if (!state.gameId) {
      const game = await findGame();
      if (!game) return;
      state.gameId    = game.id;
      state.homeScore = game.homeTeam?.score || 0;
      state.awayScore = game.awayTeam?.score || 0;
      console.log(`[NHL] Partie: ${state.gameId} (équipe ${TEAM_ID})`);
      // Mémoriser le dernier eventId pour ne traiter que les nouveaux events
      const pbp   = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
      const plays = pbp.plays || [];
      state.period    = pbp.periodDescriptor?.number || 0;
      state.homeScore = pbp.homeTeam?.score ?? state.homeScore;
      state.awayScore = pbp.awayTeam?.score ?? state.awayScore;
      if (plays.length) {
        state.lastEventId  = plays[plays.length - 1].eventId;
        state.clockRunning = clockFor(plays[plays.length - 1].typeDescKey || '', false);
      }
      console.log(`[NHL] Reprise depuis P${state.period} | lastEventId=${state.lastEventId}`);
      return;
    }

    const pbp   = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
    const plays = pbp.plays || [];
    const now   = Date.now();

    state.period    = pbp.periodDescriptor?.number ?? state.period;
    state.homeScore = pbp.homeTeam?.score           ?? state.homeScore;
    state.awayScore = pbp.awayTeam?.score           ?? state.awayScore;

    // Extraire seulement les nouveaux plays depuis le dernier poll
    const lastIdx  = state.lastEventId
      ? plays.findIndex(p => p.eventId === state.lastEventId)
      : -1;
    const newPlays = lastIdx >= 0 ? plays.slice(lastIdx + 1) : [];

    for (const play of newPlays) {
      const type   = play.typeDescKey || '';
      const period = play.periodDescriptor?.number || state.period;
      const time   = play.timeInPeriod || '00:00';

      state.clockRunning = clockFor(type, state.clockRunning);

      // Ajouter au buffer avec timestamp réel
      pushBuffer({ period, timeInPeriod: time, realAt: now, clockRunning: state.clockRunning });

      // Détecter but
      if (type === 'goal' && play.eventId !== state.lastGoalEventId) {
        const scoringTeamId = parseInt(play.details?.eventOwnerTeamId);
        const isOurTeam     = scoringTeamId === parseInt(TEAM_ID);
        state.lastGoalEventId = play.eventId;
        state.goals.push({
          eventId: play.eventId, scoringTeamId, isOurTeam,
          period, timeInPeriod: time, detectedAt: now,
          homeScore: state.homeScore, awayScore: state.awayScore,
        });
        console.log(`[GOAL] Équipe ${scoringTeamId} isOurTeam=${isOurTeam} | ${time} P${period}`);
      }

      state.lastEventId = play.eventId;
    }

    // Interpolation si jeu en cours et pas de nouveaux events
    if (state.clockRunning && newPlays.length === 0 && state.buffer.length > 0) {
      const last = state.buffer[state.buffer.length - 1];
      if (last.clockRunning && last.period === state.period) {
        const elapsed = Math.floor((now - last.realAt) / 1000);
        if (elapsed > 0) {
          const newSecs = Math.max(0, toSecs(last.timeInPeriod) - elapsed);
          const m = Math.floor(newSecs / 60);
          const s = newSecs % 60;
          pushBuffer({
            period: last.period,
            timeInPeriod: `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`,
            realAt: now,
            clockRunning: true,
          });
        }
      }
    }

    // Fin de partie
    if (['FINAL','OFF'].includes(pbp.gameState)) {
      console.log('[NHL] Partie terminée — reset dans 60s');
      setTimeout(resetState, 60000);
    }

  } catch(e) { /* erreurs réseau silencieuses */ }
}

// ─── CALCUL DÉLAI TV ─────────────────────────────────────────
// Algorithme simple: trouver l'entrée du buffer la plus proche
// de tvTime pour la bonne période, puis calculer la différence
// avec clickMs.
function calcDelay(period, tvTime, clickMs) {
  const tvSecs  = toSecs(tvTime);
  const entries = state.buffer.filter(e => e.period === period);

  console.log(`[Sync] Calcul: P${period} tvTime=${tvTime}(${tvSecs}s) clickMs=${clickMs}`);
  console.log(`[Sync] Buffer: ${state.buffer.length} total, ${entries.length} pour P${period}`);

  if (entries.length === 0) return { ok: false, error: `Pas de données P${period}` };

  const first = entries[0];
  const last  = entries[entries.length - 1];
  console.log(`[Sync] Plage buffer P${period}: ${first.timeInPeriod} → ${last.timeInPeriod}`);

  // Trouver l'entrée la plus proche de tvSecs
  let best     = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(toSecs(e.timeInPeriod) - tvSecs);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }

  console.log(`[Sync] Meilleure entrée: ${best.timeInPeriod} realAt=${best.realAt} diff=${bestDiff}s`);

  // Si trop loin → pas dans le buffer
  if (bestDiff > 90) {
    return { ok: false, error: `${tvTime} hors du buffer (entrée la plus proche: ${best.timeInPeriod})` };
  }

  const delaySec = Math.round((clickMs - best.realAt) / 1000);
  console.log(`[Sync] delaySec=${delaySec}`);

  if (delaySec < 0 || delaySec > 120) {
    return { ok: false, error: `Délai hors limites: ${delaySec}s` };
  }

  return {
    ok:         true,
    tvDelaySec: delaySec,
    confidence: bestDiff <= 10 ? 'high' : bestDiff <= 30 ? 'medium' : 'low',
    note:       `nearest (diff ${bestDiff}s)`,
  };
}

// ─── ROUTES ──────────────────────────────────────────────────

app.get('/poll', (req, res) => {
  const lastGoal = state.goals.length > 0 ? state.goals[state.goals.length - 1] : null;
  res.json({
    gameState:    state.gameId ? 'LIVE' : 'IDLE',
    period:       state.period,
    homeScore:    state.homeScore,
    awayScore:    state.awayScore,
    clockRunning: state.clockRunning,
    goal:         lastGoal,
    serverTime:   Date.now(),
  });
});

app.get('/sync/calc', (req, res) => {
  const period  = parseInt(req.query.period) || 1;
  const tvTime  = req.query.tvTime || '';
  let   clickMs = Number(req.query.clickMs);

  // Sécurité: clickMs en secondes → convertir en ms
  if (clickMs > 0 && clickMs < 9999999999) clickMs *= 1000;

  if (!tvTime.match(/^\d{1,2}:\d{2}$/))
    return res.status(400).json({ ok: false, error: 'tvTime invalide (format MM:SS)' });

  if (!state.gameId)
    return res.json({ ok: false, error: 'Aucune partie en cours', tvDelaySec: 45 });

  if (state.buffer.length < 10)
    return res.json({ ok: false, error: 'Patientez 20s et réessayez', tvDelaySec: 45 });

  const result = calcDelay(period, tvTime, clickMs);

  if (!result.ok)
    return res.json({ ok: false, error: result.error, tvDelaySec: 45 });

  res.json(result);
});

app.get('/status', (req, res) => {
  const last = state.buffer[state.buffer.length - 1];
  res.json({
    ok: true, gameId: state.gameId,
    gameState: state.gameId ? 'LIVE' : 'IDLE',
    period: state.period, homeScore: state.homeScore, awayScore: state.awayScore,
    clockRunning: state.clockRunning, bufferSize: state.buffer.length,
    lastTimer: last?.timeInPeriod || null, teamId: TEAM_ID,
    uptime: Math.floor(process.uptime()),
  });
});

app.post('/config/team', (req, res) => {
  const id = parseInt(req.body.teamId);
  if (!id || isNaN(id)) return res.status(400).json({ ok: false });
  if (id !== TEAM_ID) {
    TEAM_ID = id;
    resetState();
    console.log(`[Config] Équipe → ${TEAM_ID}`);
  }
  res.json({ ok: true, teamId: TEAM_ID });
});

app.get('/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

app.post('/test/goal', (req, res) => {
  const fake = {
    eventId: 'TEST-' + Date.now(), scoringTeamId: TEAM_ID, isOurTeam: true,
    period: state.period || 1, timeInPeriod: '10:00',
    homeScore: state.homeScore + 1, awayScore: state.awayScore,
    detectedAt: Date.now(), test: true,
  };
  state.goals.push(fake);
  state.lastGoalEventId = fake.eventId;
  console.log('[TEST] But simulé');
  res.json({ ok: true, goal: fake });
});

// ─── DÉMARRAGE ───────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚨 GOAL LIGHT SERVER v5.0 — port ${PORT} — équipe ${TEAM_ID}\n`);
  try {
    const game = await findGame();
    if (game) {
      state.gameId    = game.id;
      state.homeScore = game.homeTeam?.score || 0;
      state.awayScore = game.awayTeam?.score || 0;
      const pbp   = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
      const plays = pbp.plays || [];
      state.period    = pbp.periodDescriptor?.number || 0;
      state.homeScore = pbp.homeTeam?.score ?? state.homeScore;
      state.awayScore = pbp.awayTeam?.score ?? state.awayScore;
      if (plays.length) {
        state.lastEventId  = plays[plays.length - 1].eventId;
        state.clockRunning = clockFor(plays[plays.length - 1].typeDescKey || '', false);
      }
      console.log(`[Démarrage] Partie: ${state.gameId} | P${state.period} | lastEvent=${state.lastEventId}`);
    } else {
      console.log('[Démarrage] Aucune partie — polling en attente...');
    }
  } catch(e) {
    console.log('[Démarrage] Erreur:', e.message);
  }
  setInterval(poll, 2000);
});
