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
async function buildBufferFromHistory(plays, currentPeriod) {
  if (!plays || plays.length === 0) return;
  const now = Date.now();
  const pp = plays.filter(p => {
    const per  = p.periodDescriptor?.number || 0;
    const type = p.typeDescKey || '';
    const secs = toSecs(p.timeInPeriod || '00:00');
    return per === currentPeriod &&
           !['period-start','period-end','game-start','game-end'].includes(type) &&
           secs > 0;
  });
  if (pp.length === 0) { console.log('[Buffer] Aucun play historique valide'); return; }
  const ts = new Array(pp.length);
  ts[pp.length - 1] = now - 5000;
  for (let i = pp.length - 2; i >= 0; i--) {
    const diffSecs = toSecs(pp[i].timeInPeriod) - toSecs(pp[i+1].timeInPeriod);
    const interval = (diffSecs > 0 && diffSecs < 120) ? diffSecs * 1300 : 4000;
    ts[i] = ts[i+1] - interval;
  }
  let clock = false;
  for (let i = 0; i < pp.length; i++) {
    clock = clockFor(pp[i].typeDescKey || '', clock);
    pushBuffer({ period: currentPeriod, timeInPeriod: pp[i].timeInPeriod, realAt: ts[i], clockRunning: clock });
  }
  console.log(`[Buffer] Historique P${currentPeriod}: ${pp.length} entrées | ${pp[0].timeInPeriod} → ${pp[pp.length-1].timeInPeriod}`);
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

      // Ajouter au buffer — exclure period-start/end qui ont 00:00 et faussent la synchro
      if (!['period-start','period-end','game-start','game-end'].includes(type)) {
        pushBuffer({ period, timeInPeriod: time, realAt: now, clockRunning: state.clockRunning });
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

  // Filtrer: bonne période, exclure 00:00 (period-start/end), chrono > 0
  const entries = state.buffer.filter(e =>
    e.period === period &&
    toSecs(e.timeInPeriod) > 0
  );

  console.log(`[Sync] Calcul: P${period} tvTime=${tvTime}(${tvSecs}s) clickMs=${clickMs}`);
  console.log(`[Sync] Buffer: ${state.buffer.length} total, ${entries.length} valides P${period}`);

  if (entries.length === 0)
    return { ok: false, error: `Pas encore de données pour P${period} — patientez` };

  // Afficher la plage disponible (du plus récent au plus ancien en chrono)
  const byTime = [...entries].sort((a,b) => toSecs(b.timeInPeriod) - toSecs(a.timeInPeriod));
  const newest = byTime[0];   // chrono le plus grand = début de période
  const oldest = byTime[byTime.length-1]; // chrono le plus petit = moment le plus récent
  console.log(`[Sync] Plage chrono dispo: ${newest.timeInPeriod} → ${oldest.timeInPeriod}`);

  // Vérifier que tvTime est dans la plage du buffer
  const newestSecs = toSecs(newest.timeInPeriod);
  const oldestSecs = toSecs(oldest.timeInPeriod);
  if (tvSecs > newestSecs + 30 || tvSecs < oldestSecs - 30) {
    return { ok: false, error: `${tvTime} hors buffer (dispo: ${oldest.timeInPeriod}–${newest.timeInPeriod}). Synchronisez sur un temps récent.` };
  }

  // Trouver l'entrée dont le realAt correspond le mieux au clic
  // Stratégie: pour chaque entrée avec timeInPeriod proche de tvTime,
  // calculer le délai et prendre celui qui est dans la plage valide [0, 120s]
  let best     = null;
  let bestDiff = Infinity;

  for (const e of entries) {
    const diff = Math.abs(toSecs(e.timeInPeriod) - tvSecs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }

  console.log(`[Sync] Meilleure: ${best.timeInPeriod} realAt=${best.realAt} diff=${bestDiff}s`);

  const delaySec = Math.round((clickMs - best.realAt) / 1000);
  console.log(`[Sync] delaySec=${delaySec}`);

  if (delaySec < 0 || delaySec > 120) {
    // Essayer avec les 5 entrées les plus proches
    const candidates = [...entries]
      .sort((a,b) => Math.abs(toSecs(a.timeInPeriod)-tvSecs) - Math.abs(toSecs(b.timeInPeriod)-tvSecs))
      .slice(0, 5);
    console.log('[Sync] Candidats:', candidates.map(e => `${e.timeInPeriod}→${Math.round((clickMs-e.realAt)/1000)}s`).join(', '));
    // Prendre le premier candidat avec délai valide
    for (const c of candidates) {
      const d = Math.round((clickMs - c.realAt) / 1000);
      if (d >= 0 && d <= 120) {
        console.log(`[Sync] Candidat valide: ${c.timeInPeriod} → ${d}s`);
        return { ok: true, tvDelaySec: d, confidence: 'medium', note: `fallback (diff ${Math.abs(toSecs(c.timeInPeriod)-tvSecs)}s)` };
      }
    }
    return { ok: false, error: `Délai calculé hors limites (${delaySec}s) — réessayez dans 30s` };
  }

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
