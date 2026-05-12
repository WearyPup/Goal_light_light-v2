/**
 * GOAL LIGHT SERVER v6.0
 * - Poll NHL API toutes les 2s
 * - Détection but fiable (parseInt)
 * - TEAM_ID configurable via POST /config/team
 * - Pas de synchro complexe — délai géré côté ESP32
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
};

// ─── HELPERS ─────────────────────────────────────────────────
async function nhlGet(path) {
  const { data } = await axios.get(`${NHL_API}${path}`, { timeout: 8000 });
  return data;
}

function clockFor(type, prev) {
  if (type === 'faceoff') return true;
  if (['stoppage','goal','penalty','period-end','period-start','game-end'].includes(type)) return false;
  return prev;
}

function resetState() {
  Object.assign(state, {
    gameId: null, period: 0, homeScore: 0, awayScore: 0,
    clockRunning: false, lastEventId: null, lastGoalEventId: null, goals: [],
  });
  console.log('[Game] Reset');
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
  const game = games.find(g =>
    (g.homeTeam?.id === TEAM_ID || g.awayTeam?.id === TEAM_ID) &&
    !['OFF','FINAL','FUT','PRE'].includes(g.gameState)
  );
  if (game) console.log(`[NHL] Parties dispo: ${games.filter(g=>!['OFF','FINAL','FUT','PRE'].includes(g.gameState)).map(g=>g.id).join(', ')}`);
  return game || null;
}

// ─── POLLING ─────────────────────────────────────────────────
async function poll() {
  try {
    // Chercher partie
    if (!state.gameId) {
      const game = await findGame();
      if (!game) return;
      state.gameId    = game.id;
      state.homeScore = game.homeTeam?.score || 0;
      state.awayScore = game.awayTeam?.score || 0;
      console.log(`[NHL] Partie: ${state.gameId} équipe=${TEAM_ID}`);
      // Mémoriser dernier eventId pour ne traiter que les nouveaux
      const pbp = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
      const plays = pbp.plays || [];
      state.period    = pbp.periodDescriptor?.number || 0;
      state.homeScore = pbp.homeTeam?.score ?? state.homeScore;
      state.awayScore = pbp.awayTeam?.score ?? state.awayScore;
      if (plays.length) {
        state.lastEventId  = plays[plays.length - 1].eventId;
        state.clockRunning = clockFor(plays[plays.length - 1].typeDescKey || '', false);
        // Vérifier si dernier event est un but pour notre équipe
        const lastGoalPlay = [...plays].reverse().find(p => p.typeDescKey === 'goal');
        if (lastGoalPlay && lastGoalPlay.eventId !== state.lastGoalEventId) {
          const sid = parseInt(lastGoalPlay.details?.eventOwnerTeamId);
          if (sid === parseInt(TEAM_ID)) {
            state.lastGoalEventId = lastGoalPlay.eventId;
            state.goals.push({
              eventId: lastGoalPlay.eventId, scoringTeamId: sid, isOurTeam: true,
              period: lastGoalPlay.periodDescriptor?.number || 0,
              timeInPeriod: lastGoalPlay.timeInPeriod || '',
              homeScore: state.homeScore, awayScore: state.awayScore,
              detectedAt: Date.now(),
            });
            console.log(`[GOAL] But au démarrage: P${lastGoalPlay.periodDescriptor?.number} ${lastGoalPlay.timeInPeriod}`);
          }
        }
      }
      console.log(`[NHL] Reprise P${state.period} | lastEventId=${state.lastEventId}`);
      return;
    }

    const pbp   = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
    const plays = pbp.plays || [];
    const now   = Date.now();

    state.period    = pbp.periodDescriptor?.number ?? state.period;
    state.homeScore = pbp.homeTeam?.score           ?? state.homeScore;
    state.awayScore = pbp.awayTeam?.score           ?? state.awayScore;

    // Nouveaux plays seulement
    const lastIdx  = state.lastEventId
      ? plays.findIndex(p => p.eventId === state.lastEventId)
      : -1;
    const newPlays = lastIdx >= 0 ? plays.slice(lastIdx + 1) : [];

    for (const play of newPlays) {
      const type   = play.typeDescKey || '';
      const period = play.periodDescriptor?.number || state.period;
      const time   = play.timeInPeriod || '';

      state.clockRunning = clockFor(type, state.clockRunning);

      // Détecter but
      if (type === 'goal' && play.eventId !== state.lastGoalEventId) {
        const sid       = parseInt(play.details?.eventOwnerTeamId);
        const isOurTeam = sid === parseInt(TEAM_ID);
        state.lastGoalEventId = play.eventId;
        const goal = {
          eventId: play.eventId, scoringTeamId: sid, isOurTeam,
          period, timeInPeriod: time,
          homeScore: state.homeScore, awayScore: state.awayScore,
          detectedAt: now,
        };
        state.goals.push(goal);
        console.log(`[GOAL] Équipe ${sid} isOurTeam=${isOurTeam} | ${time} P${period}`);
      }

      state.lastEventId = play.eventId;
    }

    // Fin de partie
    if (['FINAL','OFF'].includes(pbp.gameState)) {
      console.log('[NHL] Partie terminée');
      setTimeout(resetState, 60000);
    }

  } catch(e) { /* réseau silencieux */ }
}

// ─── ROUTES ──────────────────────────────────────────────────

// Poll ESP32 — appelé toutes les secondes
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

// Status
app.get('/status', (req, res) => {
  res.json({
    ok:          true,
    gameId:      state.gameId,
    gameState:   state.gameId ? 'LIVE' : 'IDLE',
    period:      state.period,
    homeScore:   state.homeScore,
    awayScore:   state.awayScore,
    clockRunning: state.clockRunning,
    goalsCount:  state.goals.length,
    lastGoal:    state.goals.length > 0 ? state.goals[state.goals.length - 1] : null,
    teamId:      TEAM_ID,
    uptime:      Math.floor(process.uptime()),
  });
});

// Changer équipe
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

// Test but
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

app.get('/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

// ─── DÉMARRAGE ───────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚨 GOAL LIGHT SERVER v6.0 — port ${PORT} — équipe ${TEAM_ID}\n`);
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
      console.log(`[Démarrage] Partie: ${state.gameId} | P${state.period} | score: ${state.homeScore}-${state.awayScore}`);
    } else {
      console.log('[Démarrage] Aucune partie — polling en attente...');
    }
  } catch(e) {
    console.log('[Démarrage] Erreur:', e.message);
  }
  setInterval(poll, 2000);
});
