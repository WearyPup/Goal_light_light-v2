/**
 * GOAL LIGHT — Serveur Node.js v4.0
 * =====================================================================
 * - TEAM_ID configurable via /config (sauvegardé en mémoire)
 * - Détection but corrigée (parseInt pour comparaison)
 * - clickMs corrigé (détection secondes vs millisecondes)
 * - Buffer timer avec horodatage réel UTC
 * - Reconstruction buffer au réveil Render
 * - Compatible GitHub → Render (npm start)
 * =====================================================================
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const POLL_MS    = 2000;
const BUFFER_MAX = 150;
const NHL_API    = 'https://api-web.nhle.com/v1';

// TEAM_ID configurable depuis l'app (défaut = 8 Canadiens)
// Peut être changé via POST /config/team sans redéployer
let TEAM_ID = parseInt(process.env.TEAM_ID || '8');

// ─── ÉVÉNEMENTS CHRONO ───────────────────────────────────────────────────────
const CLOCK_STOP  = new Set(['stoppage','goal','penalty','period-end','period-start','game-end']);
const CLOCK_START = new Set(['faceoff']);

// ─── ÉTAT ────────────────────────────────────────────────────────────────────
const state = {
  gameId:          null,
  gameState:       'IDLE',
  period:          0,
  homeScore:       0,
  awayScore:       0,
  homeTeamId:      null,
  awayTeamId:      null,
  clockRunning:    false,
  timerBuffer:     [],
  goals:           [],
  lastGoalEventId: null,
  lastEventId:     null,
  lastPollAt:      0,
};

let pollingInterval = null;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function parseTime(t) {
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

function formatTime(secs) {
  const m = Math.floor(Math.abs(secs) / 60);
  const s = Math.abs(secs) % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function pushBuffer(entry) {
  state.timerBuffer.push(entry);
  if (state.timerBuffer.length > BUFFER_MAX) state.timerBuffer.shift();
}

function getClockRunning(type, current) {
  if (CLOCK_START.has(type)) return true;
  if (CLOCK_STOP.has(type))  return false;
  return current;
}

// ─── NHL API ─────────────────────────────────────────────────────────────────
async function nhlGet(path) {
  const { data } = await axios.get(`${NHL_API}${path}`, { timeout: 8000 });
  return data;
}

async function getTodaysGame() {
  const now       = new Date();
  const today     = now.toISOString().split('T')[0];
  const yesterday = new Date(now - 86400000).toISOString().split('T')[0];

  let games = [];
  for (const date of [today, yesterday]) {
    try {
      const data = await nhlGet(`/schedule/${date}`);
      const g    = (data.gameWeek || []).flatMap(d => d.games || []);
      games      = games.concat(g);
    } catch(e) {}
  }

  // Log toutes les parties trouvées
  games.forEach(g => console.log(`[NHL] ${g.id} | ${g.awayTeam?.id} vs ${g.homeTeam?.id} | ${g.gameState}`));

  return games.find(g =>
    (g.homeTeam?.id === TEAM_ID || g.awayTeam?.id === TEAM_ID) &&
    !['OFF', 'FINAL', 'FUT', 'PRE'].includes(g.gameState)
  ) || null;
}

async function getPlayByPlay(gameId) {
  return await nhlGet(`/gamecenter/${gameId}/play-by-play`);
}

// ─── RECONSTRUCTION BUFFER ───────────────────────────────────────────────────
async function rebuildBuffer(gameId) {
  console.log('[Buffer] Reconstruction...');
  try {
    const pbp   = await getPlayByPlay(gameId);
    const plays = pbp.plays || [];
    if (!plays.length) return;

    // Prendre TOUS les événements (pas juste les 80 derniers)
    // pour avoir toute la période courante dans le buffer
    const now = Date.now();

    // L'API NHL donne les plays dans l'ordre chronologique (du plus ancien au plus récent)
    // Le dernier play = maintenant - latence API (~8s)
    // On reconstruit les timestamps en partant du dernier play vers le passé
    const API_LATENCY_MS = 8000;
    let clockMs = now - API_LATENCY_MS; // timestamp du dernier play

    // Parcourir en sens inverse (du plus récent au plus ancien)
    // pour assigner des timestamps décroissants
    const entries = [];
    let clock = false;

    for (let i = plays.length - 1; i >= 0; i--) {
      const play = plays[i];
      const type = play.typeDescKey || '';
      clock = getClockRunning(type, clock);

      entries.push({
        timeInPeriod: play.timeInPeriod || '00:00',
        period:       play.periodDescriptor?.number || 0,
        realAt:       clockMs,
        clockRunning: clock,
        eventType:    type,
        rebuilt:      true,
      });

      // Estimer l'intervalle entre les plays
      // On utilise la différence de temps de jeu entre les deux plays
      let intervalMs = 4000; // défaut 4s
      if (i > 0) {
        const prevPlay    = plays[i - 1];
        const currPeriod  = play.periodDescriptor?.number || 0;
        const prevPeriod  = prevPlay.periodDescriptor?.number || 0;
        if (currPeriod === prevPeriod) {
          const currSecs = parseTime(play.timeInPeriod || '00:00');
          const prevSecs = parseTime(prevPlay.timeInPeriod || '00:00');
          // chrono descend → currSecs < prevSecs
          const gameTimeDiff = (prevSecs - currSecs) * 1000;
          if (gameTimeDiff > 0 && gameTimeDiff < 120000) {
            // Temps de jeu réel écoulé entre les deux plays
            // Ajouter overhead pour arrêts de jeu (~20%)
            intervalMs = gameTimeDiff * 1.2;
          }
        }
      }
      clockMs -= intervalMs;
    }

    // Remettre dans l'ordre chronologique (plus ancien en premier)
    entries.reverse();
    entries.forEach(e => pushBuffer(e));

    // Log pour vérifier
    if (state.timerBuffer.length > 0) {
      const first = state.timerBuffer[0];
      const last  = state.timerBuffer[state.timerBuffer.length - 1];
      console.log(`[Buffer] ${state.timerBuffer.length} entrées | range: P${first.period} ${first.timeInPeriod}(${first.realAt}) → P${last.period} ${last.timeInPeriod}(${last.realAt})`);
    }
  } catch (err) {
    console.error('[Buffer] Erreur:', err.message);
  }
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const now = Date.now();

    if (!state.gameId) {
      const game = await getTodaysGame();
      if (!game) return;
      state.gameId     = game.id;
      state.gameState  = 'LIVE';
      state.homeTeamId = game.homeTeam?.id;
      state.awayTeamId = game.awayTeam?.id;
      state.homeScore  = game.homeTeam?.score || 0;
      state.awayScore  = game.awayTeam?.score || 0;
      console.log(`[NHL] Partie trouvée: ${state.gameId} (équipe ${TEAM_ID})`);
      await rebuildBuffer(state.gameId);
      return;
    }

    const pbp   = await getPlayByPlay(state.gameId);
    const plays = pbp.plays || [];

    state.homeScore = pbp.homeTeam?.score  ?? state.homeScore;
    state.awayScore = pbp.awayTeam?.score  ?? state.awayScore;
    state.period    = pbp.periodDescriptor?.number ?? state.period;

    const lastIdx  = state.lastEventId
      ? plays.findIndex(p => p.eventId === state.lastEventId)
      : -1;
    const newPlays = lastIdx >= 0 ? plays.slice(lastIdx + 1) : plays.slice(-5);

    for (const play of newPlays) {
      const type         = play.typeDescKey || '';
      const period       = play.periodDescriptor?.number || state.period;
      const timeInPeriod = play.timeInPeriod || '00:00';

      state.clockRunning = getClockRunning(type, state.clockRunning);

      pushBuffer({ timeInPeriod, period, realAt: now, clockRunning: state.clockRunning, eventType: type });

      // ── Détection but ──
      if (type === 'goal' && play.eventId !== state.lastGoalEventId) {
        // CORRECTION: parseInt pour s'assurer que la comparaison est numérique
        const scoringTeamId = parseInt(play.details?.eventOwnerTeamId);
        const isOurTeam     = scoringTeamId === parseInt(TEAM_ID);

        state.lastGoalEventId = play.eventId;
        const goal = {
          eventId: play.eventId,
          scoringTeamId,
          isOurTeam,
          period,
          timeInPeriod,
          homeScore: state.homeScore,
          awayScore: state.awayScore,
          detectedAt: now,
        };
        state.goals.push(goal);
        console.log(`[GOAL] But! Équipe ${scoringTeamId} | Notre équipe: ${isOurTeam} | ${timeInPeriod} P${period}`);
      }

      state.lastEventId = play.eventId;
    }

    // Interpolation quand le jeu est en cours sans événement
    if (state.clockRunning && newPlays.length === 0) {
      const last = state.timerBuffer[state.timerBuffer.length - 1];
      if (last?.clockRunning) {
        const elapsedSec = Math.floor((now - last.realAt) / 1000);
        const newTimeSec = Math.max(0, parseTime(last.timeInPeriod) - elapsedSec);
        pushBuffer({
          timeInPeriod: formatTime(newTimeSec),
          period:       last.period,
          realAt:       now,
          clockRunning: true,
          eventType:    'interpolated',
        });
      }
    }

    if (['FINAL', 'OFF'].includes(pbp.gameState)) {
      console.log('[NHL] Partie terminée');
      state.gameState = 'FINAL';
      setTimeout(resetGame, 60000);
    }

    state.lastPollAt = now;

  } catch (err) {
    console.error('[Poll] Erreur:', err.message);
  }
}

function resetGame() {
  Object.assign(state, {
    gameId: null, gameState: 'IDLE', period: 0,
    homeScore: 0, awayScore: 0, clockRunning: false,
    timerBuffer: [], goals: [], lastGoalEventId: null, lastEventId: null,
  });
  console.log('[Game] Réinitialisé');
}

// ─── CALCUL DÉLAI TV ─────────────────────────────────────────────────────────
function calcTvDelay(period, tvTime, clickMsRaw) {
  let clickMs = Number(clickMsRaw);
  if (clickMs < 10000000000) clickMs *= 1000; // secondes → ms

  const tvSecs    = parseTime(tvTime);
  const buf       = state.timerBuffer;
  const periodBuf = buf.filter(e => e.period === period);

  // Log buffer pour debug
  console.log(`[Sync Calc] clickMs=${clickMs} tvTime=${tvTime} tvSecs=${tvSecs} period=${period}`);
  console.log(`[Sync Calc] buffer total=${buf.length} period_entries=${periodBuf.length}`);
  if (periodBuf.length > 0) {
    const first = periodBuf[0];
    const last  = periodBuf[periodBuf.length - 1];
    console.log(`[Sync Calc] period buffer range: ${first.timeInPeriod}(${first.realAt}) → ${last.timeInPeriod}(${last.realAt})`);
  }

  if (!periodBuf.length) {
    console.warn(`[Sync Calc] Aucune entrée pour P${period} → 45s par défaut`);
    return { tvDelaySec: 45, confidence: 'low', note: `Aucune entrée P${period}` };
  }

  let entryA = null;
  let entryB = null;

  for (const e of periodBuf) {
    const t = parseTime(e.timeInPeriod);
    if (t >= tvSecs) entryA = e;
    if (t <= tvSecs && !entryB) entryB = e;
  }

  console.log(`[Sync Calc] entryA=${entryA?.timeInPeriod}(${entryA?.realAt}) entryB=${entryB?.timeInPeriod}(${entryB?.realAt})`);

  let realAtMs, note;

  if (entryA && entryA.timeInPeriod === tvTime) {
    realAtMs = entryA.realAt;
    note     = 'exact';
  } else if (entryA && entryB && entryA.clockRunning && entryB.clockRunning) {
    const timeA = parseTime(entryA.timeInPeriod);
    const timeB = parseTime(entryB.timeInPeriod);
    const denom = timeA - timeB;
    const ratio = denom > 0 ? (timeA - tvSecs) / denom : 0;
    realAtMs    = entryA.realAt + ratio * (entryB.realAt - entryA.realAt);
    note        = 'interpolated';
  } else if (entryA) {
    realAtMs = entryA.realAt;
    note     = entryA.clockRunning ? 'nearest' : 'stoppage';
  } else {
    console.warn('[Sync Calc] Temps introuvable dans buffer → 45s');
    return { tvDelaySec: 45, confidence: 'low', note: 'Temps introuvable' };
  }

  const HUMAN_REFLEX_MS = 250;
  const delayMs  = clickMs - realAtMs - HUMAN_REFLEX_MS;
  const delaySec = Math.round(delayMs / 1000);

  console.log(`[Sync Calc] realAtMs=${realAtMs} delayMs=${delayMs} delaySec=${delaySec} note=${note}`);

  if (delaySec < 0 || delaySec > 120) {
    console.warn(`[Sync Calc] Hors limites: ${delaySec}s → 45s par défaut`);
    return { tvDelaySec: 45, confidence: 'low', note: `Hors limites: ${delaySec}s` };
  }

  console.log(`[Sync Calc] ✓ Délai TV = ${delaySec}s (${note})`);
  return {
    tvDelaySec:  delaySec,
    confidence:  note === 'exact' ? 'high' : note === 'interpolated' ? 'medium' : 'low',
    note,
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Poll principal ESP32
app.get('/poll', (req, res) => {
  const lastGoal = state.goals.length > 0 ? state.goals[state.goals.length - 1] : null;
  res.json({
    gameState:    state.gameState,
    period:       state.period,
    homeScore:    state.homeScore,
    awayScore:    state.awayScore,
    clockRunning: state.clockRunning,
    goal:         lastGoal,
    teamId:       TEAM_ID,
    serverTime:   Date.now(),
  });
});

// Calcul délai TV
app.get('/sync/calc', (req, res) => {
  const period      = parseInt(req.query.period) || 1;
  const tvTime      = req.query.tvTime || '';
  const clickMsRaw  = req.query.clickMs;
  const clickMsNum  = Number(clickMsRaw);
  const nowMs       = Date.now();

  // ── DEBUG ──
  const last = state.timerBuffer[state.timerBuffer.length - 1];
  console.log('\n[Sync Debug] ===========================');
  console.log(`[Sync Debug] period=${period} tvTime=${tvTime}`);
  console.log(`[Sync Debug] clickMs_raw=${clickMsRaw}`);
  console.log(`[Sync Debug] clickMs_number=${clickMsNum}`);
  console.log(`[Sync Debug] now=${nowMs}`);
  console.log(`[Sync Debug] diff_click_vs_now=${nowMs - clickMsNum}ms`);
  console.log(`[Sync Debug] buffer_size=${state.timerBuffer.length}`);
  if (last) {
    console.log(`[Sync Debug] last_entry: time=${last.timeInPeriod} period=${last.period} realAt=${last.realAt}`);
    console.log(`[Sync Debug] diff_click_vs_lastRealAt=${clickMsNum - last.realAt}ms`);
  }
  console.log('[Sync Debug] ===========================\n');

  if (!tvTime.match(/^\d{1,2}:\d{2}$/))
    return res.status(400).json({ ok: false, error: 'tvTime invalide' });

  if (!state.gameId)
    return res.json({ ok: false, error: 'Aucune partie', tvDelaySec: 45 });

  const result = calcTvDelay(period, tvTime, clickMsRaw || nowMs);
  res.json({ ok: true, ...result });
});

// Status
app.get('/status', (req, res) => {
  const last = state.timerBuffer[state.timerBuffer.length - 1];
  res.json({
    ok: true, gameId: state.gameId, gameState: state.gameState,
    period: state.period, homeScore: state.homeScore, awayScore: state.awayScore,
    clockRunning: state.clockRunning, bufferSize: state.timerBuffer.length,
    lastTimer: last?.timeInPeriod || null, lastEventType: last?.eventType || null,
    teamId: TEAM_ID, uptime: Math.floor(process.uptime()),
  });
});

// ── NOUVEAU: Changer l'équipe depuis l'app ESP32 ──
// L'ESP32 envoie le teamId choisi dans l'app → le serveur se met à jour
app.post('/config/team', (req, res) => {
  const newTeamId = parseInt(req.body.teamId);
  if (!newTeamId || isNaN(newTeamId)) {
    return res.status(400).json({ ok: false, error: 'teamId invalide' });
  }
  const oldTeamId = TEAM_ID;
  TEAM_ID = newTeamId;

  // Si l'équipe change, réinitialiser la partie en cours
  if (oldTeamId !== newTeamId) {
    resetGame();
    console.log(`[Config] Équipe changée: ${oldTeamId} → ${TEAM_ID}`);
  }

  res.json({ ok: true, teamId: TEAM_ID });
});

// Ping
app.get('/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

// Test but
app.post('/test/goal', (req, res) => {
  const fake = {
    eventId: 'TEST-' + Date.now(),
    scoringTeamId: TEAM_ID,
    isOurTeam: true,
    period: state.period || 2,
    timeInPeriod: '10:00',
    homeScore: state.homeScore + 1,
    awayScore: state.awayScore,
    detectedAt: Date.now(),
    test: true,
  };
  state.goals.push(fake);
  state.lastGoalEventId = fake.eventId;
  console.log('[TEST] But simulé');
  res.json({ ok: true, goal: fake });
});

// ─── DÉMARRAGE ───────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚨 GOAL LIGHT SERVER v4.0 — port ${PORT}`);
  console.log(`   Équipe par défaut: ID ${TEAM_ID} | Poll: ${POLL_MS}ms\n`);

  try {
    const game = await getTodaysGame();
    if (game) {
      state.gameId     = game.id;
      state.gameState  = 'LIVE';
      state.homeTeamId = game.homeTeam?.id;
      state.awayTeamId = game.awayTeam?.id;
      state.homeScore  = game.homeTeam?.score || 0;
      state.awayScore  = game.awayTeam?.score || 0;
      console.log(`[Démarrage] Partie en cours: ${state.gameId}`);
      await rebuildBuffer(state.gameId);
    } else {
      console.log('[Démarrage] Aucune partie — attente...');
    }
  } catch (e) {
    console.log('[Démarrage] Erreur vérification initiale');
  }

  pollingInterval = setInterval(poll, POLL_MS);
});
