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


// ─── RECONSTRUCTION BUFFER DEPUIS HISTORIQUE ────────────────────────────────
// Principe:
//   - L'API nous donne tous les plays avec timeInPeriod (temps de jeu)
//   - On reçoit ces plays maintenant → le DERNIER play = anchorRealAt = now - 5s
//   - Chaque play précédent a un realAt calculé depuis l'ancre:
//       realAt(play) = anchorRealAt - (anchorGameSecs - playGameSecs) * 1000
//   - Le chrono descend donc anchorGameSecs < playGameSecs pour les plays plus tôt
//   - Exemple: ancre=10:48 (648s), play=14:21 (861s)
//       realAt = anchorRealAt - (648 - 861) * 1000 = anchorRealAt + 213s → FAUX
//
// CORRECTION: le chrono descend → 14:21 EST PLUS TÔT dans le match
//   temps de jeu avant l'ancre = 861 - 648 = 213s
//   realAt(14:21) = anchorRealAt - 213s ← 213s AVANT l'ancre ✓
async function buildBufferFromHistory(plays, currentPeriod) {
  if (!plays || plays.length === 0) return;
  const now = Date.now();

  // Filtrer: période courante uniquement, exclure period-start/end, timeInPeriod > 0
  const pp = plays.filter(p => {
    const per  = p.periodDescriptor?.number || 0;
    const type = p.typeDescKey || '';
    const secs = toSecs(p.timeInPeriod || '00:00');
    return per === currentPeriod &&
           !['period-start','period-end','game-start','game-end'].includes(type) &&
           secs > 0;
  });

  if (pp.length === 0) {
    console.log('[Buffer] Pas de plays historiques valides');
    return;
  }

  // Ancre = dernier play de la liste = le plus récent = now - 5s
  // Utiliser timeRemaining pour l'ancre — c'est ce que voit l'utilisateur
  // timeRemaining DESCEND: 20:00 → 0:00 (comme le chrono à la télé)
  // Le dernier play = plus petit timeRemaining = le plus récent = ancre = now-5s
  const anchorPlay    = pp[pp.length - 1];
  const anchorRemSecs = toSecs(anchorPlay.timeRemaining || '00:00');
  const anchorRealAt  = now - 5000;

  console.log(`[Buffer] Ancre: remaining=${anchorPlay.timeRemaining}(${anchorRemSecs}s) inPeriod=${anchorPlay.timeInPeriod} realAt=${anchorRealAt}`);

  let clock = false;
  for (let i = 0; i < pp.length; i++) {
    const play       = pp[i];
    const type       = play.typeDescKey || '';
    const playRemSecs = toSecs(play.timeRemaining || '00:00');

    clock = clockFor(type, clock);

    // timeRemaining descend → playRemSecs > anchorRemSecs = play plus tôt = realAt plus ancien
    const secsBeforeAnchor = playRemSecs - anchorRemSecs; // positif = plus tôt dans le match
    const realAt = anchorRealAt - (secsBeforeAnchor * 1000);

    pushBuffer({
      period:       currentPeriod,
      timeInPeriod: play.timeInPeriod,
      timeRemaining: play.timeRemaining || '',
      realAt,
      clockRunning: clock,
    });
  }

  const first = pp[0];
  const last  = pp[pp.length - 1];
  const first = pp[0];
  const last  = pp[pp.length - 1];
  console.log(`[Buffer] Historique P${currentPeriod}: ${pp.length} plays | remaining: ${first.timeRemaining} → ${last.timeRemaining}`);
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
      await buildBufferFromHistory(plays, state.period);
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

      // Ajouter au buffer — exclure period-start/end
      if (!['period-start','period-end','game-start','game-end'].includes(type)) {
        const remaining = play.timeRemaining || '';
        pushBuffer({ period, timeInPeriod: time, timeRemaining: remaining, realAt: now, clockRunning: state.clockRunning });
      }

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
      // Seulement interpoler si le dernier event a un chrono valide (> 00:00)
      if (last.clockRunning && last.period === state.period && toSecs(last.timeInPeriod) > 0) {
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
  const tvSecs = toSecs(tvTime);

  // Filtrer: bonne période, avoir un timeRemaining valide
  const entries = state.buffer.filter(e =>
    e.period === period && e.timeRemaining && toSecs(e.timeRemaining) > 0
  );

  console.log(`[Sync] Calcul: P${period} tvTime(remaining)=${tvTime}(${tvSecs}s) clickMs=${clickMs}`);
  console.log(`[Sync] Buffer: ${state.buffer.length} total, ${entries.length} avec timeRemaining P${period}`);

  if (entries.length === 0)
    return { ok: false, error: `Pas de données P${period} — patientez 30s` };

  // Plage disponible en timeRemaining
  const rSecs = entries.map(e => toSecs(e.timeRemaining));
  const maxR  = Math.max(...rSecs);
  const minR  = Math.min(...rSecs);
  console.log(`[Sync] Plage timeRemaining: ${maxR}s → ${minR}s`);

  // Trouver l'entrée avec timeRemaining le plus proche de tvTime
  let best     = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(toSecs(e.timeRemaining) - tvSecs);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }

  console.log(`[Sync] Meilleure: remaining=${best.timeRemaining} inPeriod=${best.timeInPeriod} realAt=${best.realAt} diff=${bestDiff}s`);

  const delaySec = Math.round((clickMs - best.realAt) / 1000);
  console.log(`[Sync] delaySec=${delaySec}`);

  if (delaySec < 0 || delaySec > 120)
    return { ok: false, error: `Délai hors limites (${delaySec}s) — réessayez` };

  return {
    ok:         true,
    tvDelaySec: delaySec,
    confidence: bestDiff <= 5 ? 'high' : bestDiff <= 20 ? 'medium' : 'low',
    note:       `diff ${bestDiff}s`,
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

// DEBUG: voir la structure des plays pour trouver les timestamps UTC
app.get('/debug/plays', async (req, res) => {
  if (!state.gameId) return res.json({ error: 'Pas de partie' });
  try {
    const pbp   = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
    const plays = pbp.plays || [];
    // Retourner les 3 premiers et 3 derniers plays avec tous leurs champs
    const sample = [
      ...plays.slice(0, 3),
      ...plays.slice(-3),
    ];
    res.json({
      total: plays.length,
      sample: sample.map(p => ({
        eventId:      p.eventId,
        typeDescKey:  p.typeDescKey,
        timeInPeriod: p.timeInPeriod,
        period:       p.periodDescriptor?.number,
        // Chercher tous les champs qui ressemblent à des timestamps
        allKeys:      Object.keys(p),
        timeRemaining: p.timeRemaining,
        situationCode: p.situationCode,
        // Champs potentiels de timestamp
        wallClock:    p.wallClock,
        dateTime:     p.dateTime,
        timestamp:    p.timestamp,
        eventDate:    p.eventDate,
      }))
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

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
