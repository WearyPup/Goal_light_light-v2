/**
 * GOAL LIGHT SERVER v6.0
 * - Poll NHL API toutes les 2s
 * - Détection but fiable (parseInt)

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
  console.log(`[NHL] Recherche parties en cours: ${yest} et ${today}`);
  let games = [];
  for (const d of [today, yest]) {
    try {
      const data = await nhlGet(`/schedule/${d}`);
      const g = (data.gameWeek || []).flatMap(w => w.games || []);
      games = games.concat(g);
    } catch(e) {
      console.error(`[NHL] Erreur schedule ${d}:`, e.message);
    }
  }
  // Trouver N'IMPORTE QUELLE partie en cours — pas besoin de filtrer par équipe
  // L'ESP32 filtre lui-même selon son équipe configurée
  const live = games.filter(g => !['OFF','FINAL','FUT','PRE'].includes(g.gameState));
  console.log(`[NHL] ${live.length} partie(s) en cours: ${live.map(g => g.id+' ('+g.gameState+')').join(', ') || 'aucune'}`);
  // Prendre la première partie en cours
  return live[0] || null;
}

// ─── POLLING ─────────────────────────────────────────────────
async function poll() {
  try {
    // Chercher partie en cours (n'importe quelle équipe)
    if (!state.gameId) {
      const game = await findGame();
      if (!game) return;
      state.gameId    = game.id;
      state.homeScore = game.homeTeam?.score || 0;
      state.awayScore = game.awayTeam?.score || 0;
      console.log(`[NHL] Partie: ${state.gameId} | ${game.awayTeam?.id} vs ${game.homeTeam?.id}`);
      const pbp   = await nhlGet(`/gamecenter/${state.gameId}/play-by-play`);
      const plays = pbp.plays || [];
      state.period    = pbp.periodDescriptor?.number || 0;
      state.homeScore = pbp.homeTeam?.score ?? state.homeScore;
      state.awayScore = pbp.awayTeam?.score ?? state.awayScore;
      if (plays.length) {
        state.lastEventId  = plays[plays.length - 1].eventId;
        state.clockRunning = clockFor(plays[plays.length - 1].typeDescKey || '', false);
      }
      console.log(`[NHL] Reprise P${state.period} score: ${state.awayScore}-${state.homeScore}`);
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
        const sid = parseInt(play.details?.eventOwnerTeamId);
        state.lastGoalEventId = play.eventId;
        // Stocker TOUS les buts — l'ESP32 filtre selon son équipe
        const goal = {
          eventId:       play.eventId,
          scoringTeamId: sid,
          period,
          timeInPeriod:  time,
          homeScore:     state.homeScore,
          awayScore:     state.awayScore,
          detectedAt:    now,
        };
        state.goals.push(goal);
        console.log(`[GOAL] But equipe ${sid} | ${time} P${period} | score: ${state.awayScore}-${state.homeScore}`);
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
// Le serveur envoie TOUS les buts avec scoringTeamId
// Chaque ESP32 filtre lui-même selon son équipe configurée
app.get('/poll', (req, res) => {
  const lastGoal = state.goals.length > 0 ? state.goals[state.goals.length - 1] : null;
  res.json({
    gameState:    state.gameId ? 'LIVE' : 'IDLE',
    period:       state.period,
    homeScore:    state.homeScore,
    awayScore:    state.awayScore,
    clockRunning: state.clockRunning,
    goal:         lastGoal, // contient scoringTeamId — filtrage côté ESP32
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
    uptime:      Math.floor(process.uptime()),
  });
});

// /config/team gardé pour compatibilité mais n'affecte plus la détection
// Le serveur détecte TOUS les buts — filtrage côté ESP32
app.post('/config/team', (req, res) => {
  res.json({ ok: true });
});

// Test but
app.post('/test/goal', (req, res) => {
  const fake = {
    eventId: 'TEST-' + Date.now(), scoringTeamId: 0, isOurTeam: true,
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

// Historique des appareils connectés
const devices = {}; // { deviceId: { lastSeen, teamId, goalCount, lastGoal } }

// Middleware pour tracker les appareils
app.use((req, res, next) => {
  const deviceId = req.headers['x-device'];
  const teamId   = req.query.teamId || req.body?.teamId;
  if (deviceId) {
    if (!devices[deviceId]) devices[deviceId] = { goalCount: 0 };
    devices[deviceId].lastSeen = Date.now();
    if (teamId) devices[deviceId].teamId = teamId;
  }
  next();
});

// Dashboard — état des matchs en temps réel, refresh 2s via fetch
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html><head>
<meta charset='UTF-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>GoalLight</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0D0D0D;color:#F0F0F0;font-family:system-ui,sans-serif;min-height:100vh}
header{background:linear-gradient(135deg,#8B0000,#C8102E);padding:16px 20px;display:flex;align-items:center;gap:12px}
header h1{font-size:20px;font-weight:900;letter-spacing:4px;text-transform:uppercase}
.sub{font-size:10px;opacity:.6;letter-spacing:2px;margin-top:2px}
.con{padding:16px;display:flex;flex-direction:column;gap:12px;max-width:600px;margin:0 auto}
.card{background:#181818;border:1px solid #282828;border-radius:12px;overflow:hidden}
.ch{padding:11px 16px 8px;border-bottom:1px solid #282828;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#606060}
.cb{padding:14px}
.score{font-size:48px;font-weight:900;text-align:center;letter-spacing:4px;color:#F0F0F0;line-height:1;padding:10px 0}
.teams{display:flex;justify-content:space-between;font-size:12px;color:#606060;margin-top:4px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.stat{background:#111;border-radius:8px;padding:10px;text-align:center}
.sv{font-size:22px;font-weight:900;line-height:1}
.sv.live{color:#1DB954}.sv.idle{color:#444}
.sv.red{color:#C8102E}
.sl{font-size:9px;color:#606060;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px}
.goals{display:flex;flex-direction:column;gap:6px}
.goal-row{background:#111;border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:10px}
.goal-row.new{border-left:3px solid #1DB954;animation:flash 1s ease}
@keyframes flash{0%,100%{background:#111}50%{background:#0d2a14}}
.team-badge{background:#C8102E;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;flex-shrink:0}
.goal-info{flex:1;font-size:13px}
.goal-time{font-size:11px;color:#606060}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-right:4px}
.dot.on{background:#1DB954;box-shadow:0 0 8px #1DB954;animation:bl 1s infinite}
.dot.off{background:#444}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.status-bar{display:flex;align-items:center;gap:6px;font-size:11px;color:#606060;padding:8px 16px;background:#111;border-bottom:1px solid #282828}
.empty{color:#444;text-align:center;padding:20px;font-size:13px}
</style></head><body>
<header><div>
  <h1>🚨 Goal Light</h1>
  <div class='sub'>DASHBOARD ADMIN</div>
</div></header>
<div class='status-bar'>
  <span class='dot' id='sdot'></span>
  <span id='stxt'>Connexion...</span>
  <span style='margin-left:auto;font-size:10px' id='upd'></span>
</div>
<div class='con'>

  <div class='card'>
    <div class='ch'>Match en cours</div>
    <div class='cb'>
      <div class='score' id='score'>–</div>
      <div class='teams'><span id='away'>–</span><span id='home'>–</span></div>
      <div class='g3' style='margin-top:12px'>
        <div class='stat'><div class='sv' id='gstate'>–</div><div class='sl'>État</div></div>
        <div class='stat'><div class='sv red' id='period'>–</div><div class='sl'>Période</div></div>
        <div class='stat'><div class='sv' id='clock'>–</div><div class='sl'>Chrono</div></div>
      </div>
    </div>
  </div>

  <div class='card'>
    <div class='ch'>Buts détectés</div>
    <div class='cb'><div class='goals' id='goals'><div class='empty'>Aucun but</div></div></div>
  </div>

</div>
<script>
var lastGoalId = null;
var lastGoalCount = 0;

function fmt(ms) {
  var s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s/60) + 'm' + (s%60) + 's';
}

function refresh() {
  fetch('/api/dashboard')
    .then(function(r){ return r.json(); })
    .then(function(d) {
      // Status
      document.getElementById('sdot').className = 'dot on';
      document.getElementById('stxt').textContent = 'Connecté · Render';
      document.getElementById('upd').textContent = 'Mis à jour: ' + new Date().toLocaleTimeString();

      // Match
      if (d.gameId) {
        document.getElementById('score').textContent = d.awayScore + ' – ' + d.homeScore;
        document.getElementById('gstate').textContent = d.gameState;
        document.getElementById('gstate').className = 'sv live';
        document.getElementById('period').textContent = 'P' + d.period;
        document.getElementById('clock').textContent = d.lastTimer || '–';
      } else {
        document.getElementById('score').textContent = '–';
        document.getElementById('gstate').textContent = 'IDLE';
        document.getElementById('gstate').className = 'sv idle';
        document.getElementById('period').textContent = '–';
        document.getElementById('clock').textContent = '–';
      }

      // Buts
      var goals = d.goals || [];
      if (goals.length === 0) {
        document.getElementById('goals').innerHTML = '<div class=\'empty\'>Aucun but</div>';
      } else {
        var html = '';
        goals.forEach(function(g, i) {
          var isNew = i === 0 && g.eventId !== lastGoalId;
          html += '<div class=\'goal-row' + (isNew ? ' new' : '') + '\'>';
          html += '<span class=\'team-badge\'>Équipe ' + g.scoringTeamId + '</span>';
          html += '<div class=\'goal-info\'>P' + g.period + ' · ' + g.timeInPeriod + '</div>';
          html += '<span class=\'goal-time\'>' + fmt(g.detectedAt) + '</span>';
          html += '</div>';
        });
        document.getElementById('goals').innerHTML = html;
        if (goals.length > 0) lastGoalId = goals[0].eventId;
      }
    })
    .catch(function() {
      document.getElementById('sdot').className = 'dot off';
      document.getElementById('stxt').textContent = 'Hors ligne';
    });
}

refresh();
setInterval(refresh, 2000);
</script></body></html>`);
});

// API pour le dashboard
app.get('/api/dashboard', (req, res) => {
  const last = state.buffer ? state.buffer[state.buffer.length - 1] : null;
  res.json({
    gameId:     state.gameId,
    gameState:  state.gameId ? 'LIVE' : 'IDLE',
    period:     state.period,
    homeScore:  state.homeScore,
    awayScore:  state.awayScore,
    clockRunning: state.clockRunning,
    lastTimer:  last?.timeInPeriod || null,
    goals:      state.goals.slice(-10).reverse(),
    uptime:     Math.floor(process.uptime()),
  });
});

// ─── DÉMARRAGE ───────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚨 GOAL LIGHT SERVER v7.0 — port ${PORT}\n`);
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
