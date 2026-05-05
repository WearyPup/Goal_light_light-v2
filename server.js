/**
 * GOAL LIGHT — Serveur Node.js v3.0
 * =====================================================================
 * - Poll NHL API toutes les 2s durant un match
 * - Buffer glissant de 5 minutes avec horodatage réel UTC
 * - Détection clockRunning (stoppage / faceoff / goal / penalty...)
 * - Interpolation précise du timer entre deux événements
 * - Calcul du délai TV basé sur le buffer horodaté
 * - Reconstruction du buffer au réveil (Render gratuit)
 * - Compatible GitHub → Render (npm start)
 * =====================================================================
 * npm install express axios cors
 */
app.get('/sync/calc', (req, res) => {
  const period  = parseInt(req.query.period)  || 1;
  const tvTime  = req.query.tvTime            || '';
  const clickMs = parseInt(req.query.clickMs) || Date.now();

  console.log(`[Sync] Reçu — period: ${period} | tvTime: ${tvTime} | clickMs: ${clickMs}`);
  console.log(`[Sync] now: ${Date.now()} | diff: ${Date.now() - clickMs}ms`);
  
  const last = state.timerBuffer[state.timerBuffer.length - 1];
  console.log(`[Sync] Buffer last — realAt: ${last?.realAt} | time: ${last?.timeInPeriod}`);
  console.log(`[Sync] click vs buffer: ${clickMs - (last?.realAt || 0)}ms`);
  
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const TEAM_ID      = parseInt(process.env.TEAM_ID || '8'); // 8 = Canadiens MTL
const POLL_MS      = 2000;   // Poll NHL API toutes les 2s
const BUFFER_MAX   = 150;    // 5 minutes × 30 entrées/min
const NHL_API      = 'https://api-web.nhle.com/v1';

// ─── ÉVÉNEMENTS QUI GÈLENT LE CHRONO ─────────────────────────────────────────
const CLOCK_STOP_EVENTS = new Set([
  'stoppage', 'goal', 'penalty', 'period-end', 'period-start',
  'game-end', 'shootout-complete', 'failed-shot', 'blocked-shot'
]);
const CLOCK_START_EVENTS = new Set([
  'faceoff'
]);

// ─── ÉTAT GLOBAL ─────────────────────────────────────────────────────────────
const state = {
  // Partie en cours
  gameId:      null,
  gameState:   'IDLE',   // IDLE | LIVE | FINAL
  period:      0,
  homeScore:   0,
  awayScore:   0,
  homeTeamId:  null,
  awayTeamId:  null,
  clockRunning: false,

  // Buffer timer — tableau ordonné d'entrées horodatées
  // Chaque entrée : { timeInPeriod, period, realAt (ms), clockRunning }
  timerBuffer: [],

  // Buts détectés
  goals: [],
  lastGoalEventId: null,

  // Dernier poll
  lastPollAt: 0,
  lastEventId: null,
};

let pollingInterval = null;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Convertit "MM:SS" en secondes totales */
function parseTime(t) {
  if (!t) return 0;
  const [m, s] = t.split(':').map(Number);
  return m * 60 + s;
}

/** Convertit des secondes en "MM:SS" */
function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

/** Ajoute une entrée dans le buffer glissant */
function pushBuffer(entry) {
  state.timerBuffer.push(entry);
  if (state.timerBuffer.length > BUFFER_MAX) {
    state.timerBuffer.shift(); // Retirer la plus ancienne
  }
}

/** Détermine si un type d'événement arrête ou reprend le chrono */
function getClockRunning(typeDescKey, currentClock) {
  if (CLOCK_START_EVENTS.has(typeDescKey)) return true;
  if (CLOCK_STOP_EVENTS.has(typeDescKey))  return false;
  return currentClock; // Autres événements → garder l'état actuel
}

// ─── NHL API ──────────────────────────────────────────────────────────────────
async function nhlGet(path) {
  const { data } = await axios.get(`${NHL_API}${path}`, { timeout: 6000 });
  return data;
}

async function getTodaysGame() {
  // Chercher aujourd'hui ET hier (pour les matchs du soir en UTC)
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const yesterday = new Date(now - 86400000).toISOString().split('T')[0];

  console.log(`[NHL] Recherche: ${yesterday} et ${today}`);

  let games = [];
  for (const date of [today, yesterday]) {
    const data = await nhlGet(`/schedule/${date}`);
    const g = (data.gameWeek || []).flatMap(d => d.games || []);
    games = games.concat(g);
  }

  games.forEach(g => console.log(
    `[NHL] ${g.id} | ${g.awayTeam?.id} vs ${g.homeTeam?.id} | ${g.gameState}`
  ));

  return games.find(g =>
    (g.homeTeam?.id === TEAM_ID || g.awayTeam?.id === TEAM_ID) &&
    !['OFF', 'FINAL', 'FUT', 'PRE'].includes(g.gameState)
  ) || null;
}

async function getPlayByPlay(gameId) {
  return await nhlGet(`/gamecenter/${gameId}/play-by-play`);
}

// ─── RECONSTRUCTION DU BUFFER AU RÉVEIL ──────────────────────────────────────
/**
 * Quand le serveur redémarre (réveil Render), on refetch le play-by-play
 * complet et on reconstruit les 5 dernières minutes du buffer.
 */
async function rebuildBuffer(gameId) {
  console.log('[Buffer] Reconstruction depuis le play-by-play...');
  try {
    const pbp   = await getPlayByPlay(gameId);
    const plays = pbp.plays || [];
    if (!plays.length) return;

    // Prendre les événements récents — on estime ~1 événement/4s en moyenne
    // 5 minutes = 300s → environ 75 événements max
    const recent = plays.slice(-80);
    const now    = Date.now();

    // On ne connaît pas l'heure exacte des anciens événements,
    // donc on les positionne relativement au dernier événement reçu maintenant.
    // Le dernier événement = maintenant - latence API estimée (8s)
    const ESTIMATED_API_LATENCY_MS = 8000;
    let clockMs = now - ESTIMATED_API_LATENCY_MS;
    let clock   = state.clockRunning;

    // Parcourir en sens inverse pour reconstruire les timestamps
    for (let i = recent.length - 1; i >= 0; i--) {
      const play = recent[i];
      const type = play.typeDescKey || '';
      clock = getClockRunning(type, clock);

      pushBuffer({
        timeInPeriod: play.timeInPeriod || '00:00',
        period:       play.periodDescriptor?.number || 0,
        realAt:       clockMs,
        clockRunning: clock,
        eventType:    type,
        rebuilt:      true,
      });

      // Estimer le timestamp précédent (4s par événement en moyenne)
      clockMs -= 4000;
    }

    // Remettre dans l'ordre chronologique
    state.timerBuffer.sort((a, b) => a.realAt - b.realAt);
    console.log(`[Buffer] Reconstruit avec ${state.timerBuffer.length} entrées`);
  } catch (err) {
    console.error('[Buffer] Erreur reconstruction:', err.message);
  }
}

// ─── POLLING PRINCIPAL ────────────────────────────────────────────────────────
async function poll() {
  try {
    const now = Date.now();

    // 1. Chercher une partie en cours si on n'en a pas
    if (!state.gameId) {
      const game = await getTodaysGame();
      if (!game) return;

      state.gameId     = game.id;
      state.gameState  = 'LIVE';
      state.homeTeamId = game.homeTeam?.id;
      state.awayTeamId = game.awayTeam?.id;
      state.homeScore  = game.homeTeam?.score || 0;
      state.awayScore  = game.awayTeam?.score || 0;
      console.log(`[NHL] Partie trouvée: ${state.gameId}`);

      // Reconstruire le buffer immédiatement
      await rebuildBuffer(state.gameId);
      return;
    }

    // 2. Récupérer le play-by-play
    const pbp   = await getPlayByPlay(state.gameId);
    const plays = pbp.plays || [];

    // Mettre à jour le score et la période
    state.homeScore = pbp.homeTeam?.score ?? state.homeScore;
    state.awayScore = pbp.awayTeam?.score ?? state.awayScore;
    state.period    = pbp.periodDescriptor?.number ?? state.period;

    // 3. Traiter les nouveaux événements depuis le dernier poll
    const newPlays = state.lastEventId
      ? plays.slice(plays.findIndex(p => p.eventId === state.lastEventId) + 1)
      : plays.slice(-5); // Premier poll → prendre les 5 derniers

    for (const play of newPlays) {
      const type        = play.typeDescKey || '';
      const period      = play.periodDescriptor?.number || state.period;
      const timeInPeriod = play.timeInPeriod || '00:00';

      // Mettre à jour clockRunning
      state.clockRunning = getClockRunning(type, state.clockRunning);

      // Ajouter au buffer avec horodatage réel
      pushBuffer({
        timeInPeriod,
        period,
        realAt:       now,
        clockRunning: state.clockRunning,
        eventType:    type,
        eventId:      play.eventId,
      });

      // Détecter les buts
      if (type === 'goal') {
        const scoringTeamId = play.details?.eventOwnerTeamId;
        const isOurTeam     = scoringTeamId === TEAM_ID;

        if (play.eventId !== state.lastGoalEventId) {
          state.lastGoalEventId = play.eventId;
          const goal = {
            eventId:      play.eventId,
            scoringTeamId,
            isOurTeam,
            period,
            timeInPeriod,
            homeScore:    state.homeScore,
            awayScore:    state.awayScore,
            detectedAt:   now,
          };
          state.goals.push(goal);
          console.log(`[GOAL] But! Équipe ${scoringTeamId} | Notre équipe: ${isOurTeam} | ${timeInPeriod} P${period}`);
        }
      }

      state.lastEventId = play.eventId;
    }

    // 4. Si aucun événement depuis 2s mais jeu en cours → entrée d'interpolation
    // Permet une résolution fine entre deux événements
    if (state.clockRunning && newPlays.length === 0) {
      const last = state.timerBuffer[state.timerBuffer.length - 1];
      if (last && last.clockRunning) {
        // Calculer où devrait être le timer maintenant par interpolation
        const elapsedSec = Math.floor((now - last.realAt) / 1000);
        const lastTimeSec = parseTime(last.timeInPeriod);
        // Chrono descend (20:00 → 0:00)
        const newTimeSec = Math.max(0, lastTimeSec - elapsedSec);

        pushBuffer({
          timeInPeriod: formatTime(newTimeSec),
          period:       last.period,
          realAt:       now,
          clockRunning: true,
          eventType:    'interpolated',
        });
      }
    }

    // 5. Vérifier fin de partie
    if (['FINAL', 'OFF'].includes(pbp.gameState)) {
      console.log(`[NHL] Partie terminée`);
      state.gameState = 'FINAL';
      setTimeout(resetGame, 30000); // Reset 30s après
    }

    state.lastPollAt = now;

  } catch (err) {
    console.error('[Poll] Erreur:', err.message);
  }
}

function resetGame() {
  state.gameId        = null;
  state.gameState     = 'IDLE';
  state.period        = 0;
  state.homeScore     = 0;
  state.awayScore     = 0;
  state.clockRunning  = false;
  state.timerBuffer   = [];
  state.goals         = [];
  state.lastGoalEventId = null;
  state.lastEventId   = null;
  console.log('[Game] État réinitialisé');
}

// ─── CALCUL DU DÉLAI TV ───────────────────────────────────────────────────────
/**
 * Cherche dans le buffer l'horodatage réel correspondant à un temps TV donné.
 * Gère l'interpolation et les stoppages.
 *
 * @param {number} period       - Période (1, 2, 3)
 * @param {string} tvTime       - Temps vu à la télé "MM:SS" (chrono descend)
 * @param {number} clickMs      - Date.now() au moment du clic utilisateur
 * @returns {{ tvDelaySec, confidence, note }}
 */
function calcTvDelay(period, tvTime, clickMs) {
  const tvSecs = parseTime(tvTime);
  const buf    = state.timerBuffer;

  if (!buf.length) {
    return { tvDelaySec: 45, confidence: 'low', note: 'Buffer vide' };
  }

  // Filtrer le buffer sur la bonne période
  const periodBuf = buf.filter(e => e.period === period);
  if (!periodBuf.length) {
    return { tvDelaySec: 45, confidence: 'low', note: `Aucune entrée P${period}` };
  }

  // Chercher l'entrée exacte ou encadrante
  // Le chrono descend donc tvSecs décroît avec le temps
  // On cherche deux entrées A et B telles que timeA >= tvSecs >= timeB

  let entryA = null; // Plus récente avec time > tvSecs (avant dans le match)
  let entryB = null; // Plus ancienne avec time < tvSecs (après dans le match)

  for (let i = 0; i < periodBuf.length; i++) {
    const t = parseTime(periodBuf[i].timeInPeriod);
    if (t >= tvSecs) entryA = periodBuf[i];
    if (t <= tvSecs && !entryB) entryB = periodBuf[i];
  }

  let realAtMs;
  let note;

  if (entryA && entryA.timeInPeriod === tvTime) {
    // Correspondance exacte
    realAtMs = entryA.realAt;
    note = 'exact';
  } else if (entryA && entryB && entryA.clockRunning && entryB.clockRunning) {
    // Interpolation entre A et B — jeu en cours entre les deux
    const timeA = parseTime(entryA.timeInPeriod);
    const timeB = parseTime(entryB.timeInPeriod);
    const ratio = (timeA - tvSecs) / (timeA - timeB);
    realAtMs = entryA.realAt + ratio * (entryB.realAt - entryA.realAt);
    note = 'interpolated';
  } else if (entryA && !entryA.clockRunning) {
    // Stoppage → utiliser le timestamp exact du stoppage
    realAtMs = entryA.realAt;
    note = 'stoppage';
  } else if (entryA) {
    // Fallback sur l'entrée la plus proche
    realAtMs = entryA.realAt;
    note = 'nearest';
  } else {
    return { tvDelaySec: 45, confidence: 'low', note: 'Temps introuvable dans le buffer' };
  }

  // Délai = heure du clic - heure réelle du timer dans l'API
  // Soustraire ~250ms pour le réflexe humain moyen
  const HUMAN_REFLEX_MS = 250;
  const delayMs  = clickMs - realAtMs - HUMAN_REFLEX_MS;
  const delaySec = Math.round(delayMs / 1000);

  // Sanity check — délai doit être entre 0 et 120s
  if (delaySec < 0 || delaySec > 120) {
    console.warn(`[Sync] Délai hors limites: ${delaySec}s (${note})`);
    return { tvDelaySec: 45, confidence: 'low', note: `Délai hors limites: ${delaySec}s` };
  }

  console.log(`[Sync] TV: P${period} ${tvTime} | Délai: ${delaySec}s | Mode: ${note}`);
  return {
    tvDelaySec:  delaySec,
    confidence:  note === 'exact' ? 'high' : note === 'interpolated' ? 'medium' : 'low',
    note,
  };
}

// ─── ROUTES REST ─────────────────────────────────────────────────────────────

/**
 * GET /poll
 * Endpoint principal de l'ESP32 — appelé toutes les secondes.
 * Retourne : état de la partie, dernier but, délai TV configuré.
 */
app.get('/poll', (req, res) => {
  const lastGoal = state.goals.length > 0
    ? state.goals[state.goals.length - 1]
    : null;

  res.json({
    gameState:   state.gameState,
    period:      state.period,
    homeScore:   state.homeScore,
    awayScore:   state.awayScore,
    clockRunning: state.clockRunning,
    goal:        lastGoal,
    serverTime:  Date.now(),
  });
});

/**
 * GET /sync/calc?period=2&tvTime=14:23&clickMs=1705346052841
 * Calcule le délai TV depuis le buffer horodaté.
 */
app.get('/sync/calc', (req, res) => {
  const period  = parseInt(req.query.period)  || 1;
  const tvTime  = req.query.tvTime            || '';
  const clickMs = parseInt(req.query.clickMs) || Date.now();

  if (!tvTime.match(/^\d{1,2}:\d{2}$/)) {
    return res.status(400).json({ ok: false, error: 'tvTime invalide (format MM:SS)' });
  }

  if (!state.gameId) {
    return res.json({ ok: false, error: 'Aucune partie en cours', tvDelaySec: 45 });
  }

  const result = calcTvDelay(period, tvTime, clickMs);
  res.json({ ok: true, ...result });
});

/**
 * GET /status
 * État général du serveur.
 */
app.get('/status', (req, res) => {
  const last = state.timerBuffer[state.timerBuffer.length - 1];
  res.json({
    ok:           true,
    gameId:       state.gameId,
    gameState:    state.gameState,
    period:       state.period,
    homeScore:    state.homeScore,
    awayScore:    state.awayScore,
    clockRunning: state.clockRunning,
    bufferSize:   state.timerBuffer.length,
    lastTimer:    last?.timeInPeriod || null,
    lastEventType: last?.eventType  || null,
    teamId:       TEAM_ID,
    uptime:       Math.floor(process.uptime()),
  });
});

/**
 * GET /ping
 * Health check simple.
 */
app.get('/ping', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

/**
 * POST /test/goal
 * Simule un but pour tester les ESP32.
 */
app.post('/test/goal', (req, res) => {
  const fake = {
    eventId:      'TEST-' + Date.now(),
    scoringTeamId: TEAM_ID,
    isOurTeam:    true,
    period:       state.period || 2,
    timeInPeriod: '10:00',
    homeScore:    state.homeScore + 1,
    awayScore:    state.awayScore,
    detectedAt:   Date.now(),
    test:         true,
  };
  state.goals.push(fake);
  state.lastGoalEventId = fake.eventId;
  console.log('[TEST] But simulé');
  res.json({ ok: true, goal: fake });
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚨 GOAL LIGHT SERVER v3.0 — port ${PORT}`);
  console.log(`   Équipe: ID ${TEAM_ID} | Poll: ${POLL_MS}ms\n`);

  // Vérifier si une partie est déjà en cours au démarrage (réveil Render)
  try {
    const game = await getTodaysGame();
    if (game) {
      state.gameId     = game.id;
      state.gameState  = 'LIVE';
      state.homeTeamId = game.homeTeam?.id;
      state.awayTeamId = game.awayTeam?.id;
      state.homeScore  = game.homeTeam?.score || 0;
      state.awayScore  = game.awayTeam?.score || 0;
      console.log(`[Démarrage] Partie en cours détectée: ${state.gameId}`);
      await rebuildBuffer(state.gameId);
    } else {
      console.log('[Démarrage] Aucune partie en cours — attente...');
    }
  } catch (e) {
    console.log('[Démarrage] Impossible de vérifier — polling démarré');
  }

  // Démarrer le polling
  pollingInterval = setInterval(poll, POLL_MS);
});
