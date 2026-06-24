// game.js — WarZone v2 — Logique principale

const SERVER_URL = 'https://warzone-tzun.onrender.com'; // ← Remplace après déploiement

// ─── État global ────────────────────────────────────────────────
let mode = null;
let playerIndex = 0;
let gameState = null;
let selectedCell = null;
let reachableCells = [];
let socket = null;
let onlinePlayers = [];

// ─── Audio (Web Audio API) ──────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
  return audioCtx;
}

function playTone(freq, type, duration, gainVal = 0.15) {
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(); osc.stop(ctx.currentTime + duration);
  } catch(e) {}
}

function sfxSelect()   { playTone(660, 'sine', 0.08, 0.1); }
function sfxMove()     { playTone(220, 'square', 0.12, 0.08); setTimeout(() => playTone(330, 'square', 0.1, 0.06), 60); }
function sfxAttack()   { playTone(120, 'sawtooth', 0.25, 0.18); setTimeout(() => playTone(80, 'sawtooth', 0.2, 0.12), 80); }
function sfxDestroy()  { [100,80,60,40].forEach((f,i) => setTimeout(() => playTone(f, 'sawtooth', 0.15, 0.2), i*60)); }
function sfxEndTurn()  { [440,550,660].forEach((f,i) => setTimeout(() => playTone(f, 'sine', 0.15, 0.1), i*80)); }
function sfxVictory()  { [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, 'sine', 0.4, 0.15), i*150)); }
function sfxDefeat()   { [300,250,200,150].forEach((f,i) => setTimeout(() => playTone(f, 'triangle', 0.4, 0.15), i*180)); }

// ─── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  showScreen('screen-home');
});

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Mode Solo ──────────────────────────────────────────────────
function startSolo() {
  mode = 'solo';
  playerIndex = 0;
  gameState = createInitialGameState();
  onlinePlayers = [{ pseudo: 'Vous', index: 0 }, { pseudo: 'IA', index: 1 }];
  document.getElementById('label-p0').textContent = 'Vous';
  document.getElementById('label-p1').textContent = 'IA';
  showScreen('screen-game');
  renderGame();
  addLog('⚔ Mode Solo — Affrontez l\'IA !', 'log-turn');
}

// ─── Mode En ligne ──────────────────────────────────────────────
function showOnlineMenu() {
  showScreen('screen-online');
  connectSocket();
}

function connectSocket() {
  if (socket && socket.connected) return;
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    document.getElementById('online-status').textContent = '🟢 Connecté au serveur';
  });
  socket.on('connect_error', () => {
    document.getElementById('online-status').textContent = '🔴 Serveur inaccessible (Render peut être en veille, patiente 30s)';
  });
  socket.on('lobby_update', (rooms) => renderLobby(rooms));
  socket.on('room_created', ({ roomId, playerIndex: idx }) => {
    playerIndex = idx;
    document.getElementById('waiting-room-id').textContent = roomId;
    showScreen('screen-waiting');
  });
  socket.on('game_start', ({ gameState: gs, players }) => {
    gameState = gs;
    onlinePlayers = players;
    document.getElementById('label-p0').textContent = players[0].pseudo;
    document.getElementById('label-p1').textContent = players[1].pseudo;
    showScreen('screen-game');
    renderGame();
    addLog(`🌐 ${players[0].pseudo} vs ${players[1].pseudo}`, 'log-turn');
  });
  socket.on('game_update', (gs) => {
    gameState = gs;
    selectedCell = null; reachableCells = [];
    renderGame();
    if (gs.winner !== null) { setTimeout(() => showWinner(gs.winner), 400); }
  });
  socket.on('opponent_left', (msg) => { alert(msg); backToHome(); });
  socket.on('error', (msg) => alert('⚠ ' + msg));
}

function renderLobby(rooms) {
  const list = document.getElementById('lobby-list');
  if (!rooms.length) {
    list.innerHTML = '<p class="no-rooms">Aucune partie en attente…<br>Crée la première !</p>';
    return;
  }
  list.innerHTML = rooms.map(r => `
    <div class="lobby-room">
      <span class="room-name">⚔ ${r.name}</span>
      <span class="room-host">${r.host}</span>
      <button class="btn-join" onclick="joinRoom('${r.id}')">Rejoindre</button>
    </div>
  `).join('');
}

function createRoom() {
  const pseudo = document.getElementById('pseudo-input').value.trim();
  const roomName = document.getElementById('room-name-input').value.trim();
  if (!pseudo) return alert('Entre ton pseudo !');
  socket.emit('create_room', { pseudo, roomName: roomName || `Partie de ${pseudo}` });
}

function joinRoom(roomId) {
  const pseudo = document.getElementById('pseudo-input').value.trim();
  if (!pseudo) return alert('Entre ton pseudo !');
  socket.emit('join_room', { roomId, pseudo });
}

// ─── Logique de jeu ─────────────────────────────────────────────
function createInitialGameState() {
  const grid = [];
  const terrainPool = ['plains','plains','plains','plains','forest','forest','mountain'];
  for (let r = 0; r < 7; r++) {
    grid[r] = [];
    for (let c = 0; c < 7; c++) {
      grid[r][c] = { terrain: terrainPool[Math.floor(Math.random() * terrainPool.length)], unit: null };
    }
  }
  const place = (r, c, type, owner) => {
    const stats = { infantry: { hp:10, maxHp:10 }, tank: { hp:15, maxHp:15 }, artillery: { hp:8, maxHp:8 } };
    grid[r][c].unit = { type, owner, ...stats[type], moved: false };
  };
  place(6,1,'infantry',0); place(6,3,'tank',0); place(6,5,'artillery',0); place(5,3,'infantry',0);
  place(0,1,'infantry',1); place(0,3,'tank',1); place(0,5,'artillery',1); place(1,3,'infantry',1);
  return { grid, currentTurn:0, turnNumber:1, resources:[10,10], log:[], winner:null };
}

function getMoveRange(type) { return { infantry:2, tank:3, artillery:1 }[type] ?? 2; }

function getNeighbors(row, col) {
  const isEven = row % 2 === 0;
  const dirs = isEven ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]] : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
  return dirs.map(([dr,dc]) => ({ row:row+dr, col:col+dc })).filter(p => p.row>=0&&p.row<7&&p.col>=0&&p.col<7);
}

function getReachable(grid, sr, sc, range) {
  const visited = new Set([`${sr},${sc}`]);
  const queue = [{ row:sr, col:sc, steps:0 }];
  const cells = [];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.steps > 0) cells.push({ row:cur.row, col:cur.col });
    if (cur.steps >= range) continue;
    for (const n of getNeighbors(cur.row, cur.col)) {
      const key = `${n.row},${n.col}`;
      if (!visited.has(key)) {
        visited.add(key);
        const cell = grid[n.row][n.col];
        if (!cell.unit || cell.unit.owner !== grid[sr][sc].unit?.owner) {
          queue.push({ ...n, steps: cur.steps+1 });
        }
      }
    }
  }
  return cells;
}

function applyMoveLocally(from, to) {
  const gs = gameState;
  const unit = gs.grid[from.row][from.col].unit;
  if (!unit || unit.owner !== playerIndex || unit.moved) return false;

  const target = gs.grid[to.row][to.col];
  if (target.unit && target.unit.owner === playerIndex) return false;

  if (target.unit && target.unit.owner !== playerIndex) {
    sfxAttack();
    animateHex(to.row, to.col, 'hit');
    const dmg = { infantry:3, tank:6, artillery:8 }[unit.type] ?? 3;
    const defBonus = target.terrain==='forest' ? 0.7 : target.terrain==='mountain' ? 0.5 : 1;
    const finalDmg = Math.round(dmg * defBonus);
    target.unit.hp -= finalDmg;
    addLog(`💥 ${unitLabel(unit.type)} → ${unitLabel(target.unit.type)} −${finalDmg} HP`, 'log-damage');

    if (target.unit.hp <= 0) {
      sfxDestroy();
      animateHex(to.row, to.col, 'explode');
      addLog(`💀 ${unitLabel(target.unit.type)} détruit !`, 'log-kill');
      gs.grid[to.row][to.col].unit = { ...unit, moved:true };
      gs.grid[from.row][from.col].unit = null;
    } else {
      addLog(`🛡 Résiste (${target.unit.hp} HP)`, 'log-damage');
      unit.moved = true;
    }
  } else {
    sfxMove();
    gs.grid[to.row][to.col].unit = { ...unit, moved:true };
    gs.grid[from.row][from.col].unit = null;
  }

  const p0 = gs.grid.flat().filter(c => c.unit && c.unit.owner===0).length;
  const p1 = gs.grid.flat().filter(c => c.unit && c.unit.owner===1).length;
  if (p0===0) gs.winner=1;
  if (p1===0) gs.winner=0;
  return true;
}

function animateHex(row, col, cls) {
  const hexEl = document.querySelector(`[data-r="${row}"][data-c="${col}"]`);
  if (!hexEl) return;
  hexEl.classList.remove('hit','explode');
  void hexEl.offsetWidth;
  hexEl.classList.add(cls);
  hexEl.addEventListener('animationend', () => hexEl.classList.remove(cls), { once:true });
}

function endTurn() {
  if (!gameState || gameState.winner !== null) return;
  if (mode === 'online') {
    if (gameState.currentTurn !== playerIndex) return;
    socket.emit('end_turn');
  } else {
    if (gameState.currentTurn !== 0) return;
    sfxEndTurn();
    gameState.currentTurn = 1;
    gameState.turnNumber++;
    gameState.resources[1] += 5;
    gameState.grid.flat().forEach(c => { if(c.unit) c.unit.moved = false; });
    addLog(`— Tour ${gameState.turnNumber} — IA réfléchit…`, 'log-turn');
    selectedCell = null; reachableCells = [];
    renderGame();
    setTimeout(playAITurn, 900);
  }
}

function playAITurn() {
  const actions = AI.playTurn(gameState);
  let i = 0;
  function nextAction() {
    if (i >= actions.length) {
      gameState.currentTurn = 0;
      gameState.turnNumber++;
      gameState.resources[0] += 5;
      gameState.grid.flat().forEach(c => { if(c.unit) c.unit.moved = false; });
      addLog(`— Tour ${gameState.turnNumber} — Votre tour`, 'log-turn');
      renderGame();
      if (gameState.winner !== null) showWinner(gameState.winner);
      return;
    }
    const { from, to } = actions[i++];
    const unit = gameState.grid[from.row][from.col].unit;
    if (unit && !unit.moved) {
      const saved = playerIndex;
      playerIndex = 1;
      applyMoveLocally(from, to);
      playerIndex = saved;
    }
    renderGame();
    setTimeout(nextAction, 600);
  }
  nextAction();
}

// ─── Interactions ───────────────────────────────────────────────
function onCellClick(row, col) {
  if (!gameState || gameState.winner !== null) return;
  if (gameState.currentTurn !== playerIndex) return;

  const cell = gameState.grid[row][col];

  if (selectedCell) {
    const isReachable = reachableCells.some(c => c.row===row && c.col===col);
    if (isReachable) {
      const from = selectedCell, to = { row, col };
      if (mode === 'online') {
        socket.emit('move_unit', { from, to });
      } else {
        applyMoveLocally(from, to);
        renderGame();
        if (gameState.winner !== null) { setTimeout(() => showWinner(gameState.winner), 500); }
      }
      selectedCell = null; reachableCells = [];
      return;
    }
    selectedCell = null; reachableCells = [];
  }

  if (cell.unit && cell.unit.owner === playerIndex && !cell.unit.moved) {
    selectedCell = { row, col };
    reachableCells = getReachable(gameState.grid, row, col, getMoveRange(cell.unit.type));
    sfxSelect();
  }

  renderGame();
}

// ─── Rendu ─────────────────────────────────────────────────────
const UNIT_SVG_ID = { infantry:'svg-infantry', tank:'svg-tank', artillery:'svg-artillery' };
const TERRAIN_CLASS = { plains:'terrain-plains', forest:'terrain-forest', mountain:'terrain-mountain' };

function unitLabel(type) {
  return { infantry:'Infanterie', tank:'Tank', artillery:'Artillerie' }[type] ?? type;
}

function unitSVG(unit) {
  const color = unit.owner === 0 ? '#6ab4ff' : '#ff6a6a';
  return `<svg viewBox="0 0 32 32" fill="${color}"><use href="#${UNIT_SVG_ID[unit.type]}"/></svg>`;
}

function renderGame() {
  if (!gameState) return;
  const gs = gameState;
  const grid = document.getElementById('hex-grid');
  grid.innerHTML = '';

  for (let r = 0; r < 7; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'hex-row' + (r%2===0 ? ' offset' : '');

    for (let c = 0; c < 7; c++) {
      const cell = gs.grid[r][c];
      const hex = document.createElement('div');
      hex.className = 'hex ' + (TERRAIN_CLASS[cell.terrain] || 'terrain-plains');
      hex.dataset.r = r; hex.dataset.c = c;

      const isSel      = selectedCell && selectedCell.row===r && selectedCell.col===c;
      const isReach    = reachableCells.some(rc => rc.row===r && rc.col===c);
      const isEnemy    = cell.unit && cell.unit.owner !== playerIndex;
      const isEmpty    = !cell.unit;

      if (isSel)                  hex.classList.add('selected');
      if (isReach && isEmpty)     hex.classList.add('reachable');
      if (isReach && isEnemy)     hex.classList.add('attackable');

      if (cell.unit) {
        const hpPct   = Math.round((cell.unit.hp / cell.unit.maxHp) * 100);
        const isCrit  = hpPct <= 30;
        const ownerCls = cell.unit.owner===0 ? 'unit-p0' : 'unit-p1';
        const movedCls = cell.unit.moved ? ' moved' : '';
        hex.innerHTML = `
          <div class="unit ${ownerCls}${movedCls}">
            ${unitSVG(cell.unit)}
            <div class="hp-bar"><div class="hp-fill${isCrit?' critical':''}" style="width:${hpPct}%"></div></div>
          </div>`;
      }

      hex.addEventListener('click', () => onCellClick(r, c));
      rowEl.appendChild(hex);
    }
    grid.appendChild(rowEl);
  }

  // HUD
  const isMyTurn = gs.currentTurn === playerIndex;
  const p0name   = onlinePlayers[0]?.pseudo || 'Joueur 1';
  const p1name   = onlinePlayers[1]?.pseudo || (mode==='solo' ? 'IA' : 'Joueur 2');
  const turnName = mode==='solo'
    ? (gs.currentTurn===0 ? 'VOTRE TOUR' : 'TOUR DE L\'IA')
    : (isMyTurn ? 'VOTRE TOUR' : 'ADVERSAIRE…');

  document.getElementById('hud-turn').textContent = `T${gs.turnNumber} — ${turnName}`;
  document.getElementById('hud-res-p0').textContent = gs.resources[0];
  document.getElementById('hud-res-p1').textContent = gs.resources[1];
  document.getElementById('btn-end-turn').disabled = !isMyTurn || gs.winner!==null;

  // Log
  const logEl = document.getElementById('battle-log');
  logEl.innerHTML = (gs.log || []).slice(0,8).map((entry, i) => {
    const cls = typeof entry === 'object' ? entry.cls : '';
    const txt = typeof entry === 'object' ? entry.txt : entry;
    return `<div class="log-entry${cls?' '+cls:''}${i===0?' ':''}">${txt}</div>`;
  }).join('');
}

function addLog(msg, cls='') {
  if (!gameState) return;
  if (!gameState.log) gameState.log = [];
  gameState.log.unshift(cls ? { txt: msg, cls } : msg);
}

function showWinner(winnerIdx) {
  const name = onlinePlayers[winnerIdx]?.pseudo || (winnerIdx===0 ? 'Vous' : 'L\'IA');
  const isVictory = winnerIdx === playerIndex;
  isVictory ? sfxVictory() : sfxDefeat();
  document.getElementById('result-title').textContent    = isVictory ? '🏆 VICTOIRE' : '💀 DÉFAITE';
  document.getElementById('result-subtitle').textContent = `${name} remporte la bataille !`;
  document.getElementById('result-title').className      = isVictory ? 'victory' : 'defeat';
  setTimeout(() => showScreen('screen-result'), 300);
}

function backToHome() {
  if (socket) { socket.disconnect(); socket = null; }
  gameState = null; selectedCell = null; reachableCells = [];
  showScreen('screen-home');
}
