// game.js — WarZone v3

const SERVER_URL = 'https://warzone-server.onrender.com'; // ← Remplace après déploiement

const GRID = 13;
const EMOJIS = ['👍','😂','😤','💀','🔥','😱','🤝','👏','😈','💪','🫡','🤡'];

let mode = null, playerIndex = 0, gameState = null;
let selectedCell = null, reachableCells = [];
let socket = null, onlinePlayers = [];
let timerInterval = null, timerSeconds = 60;

// ─── Audio ──────────────────────────────────────────────────────
let audioCtx = null;
function getAudio() { if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)(); return audioCtx; }
function playTone(freq,type,dur,vol=0.12){try{const c=getAudio(),o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.type=type;o.frequency.value=freq;g.gain.setValueAtTime(vol,c.currentTime);g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+dur);o.start();o.stop(c.currentTime+dur);}catch(e){}}
function sfxSelect()  { playTone(660,'sine',0.08,0.08); }
function sfxMove()    { playTone(220,'square',0.1,0.07); setTimeout(()=>playTone(330,'square',0.08,0.05),60); }
function sfxAttack()  { playTone(120,'sawtooth',0.22,0.15); setTimeout(()=>playTone(80,'sawtooth',0.18,0.1),80); }
function sfxDestroy() { [100,80,60,40].forEach((f,i)=>setTimeout(()=>playTone(f,'sawtooth',0.14,0.18),i*55)); }
function sfxEndTurn() { [440,550,660].forEach((f,i)=>setTimeout(()=>playTone(f,'sine',0.12,0.09),i*75)); }
function sfxVictory() { [523,659,784,1047].forEach((f,i)=>setTimeout(()=>playTone(f,'sine',0.35,0.13),i*140)); }
function sfxDefeat()  { [300,250,200,150].forEach((f,i)=>setTimeout(()=>playTone(f,'triangle',0.35,0.13),i*170)); }
function sfxWarn()    { [880,440].forEach((f,i)=>setTimeout(()=>playTone(f,'square',0.15,0.12),i*100)); }

// ─── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  showScreen('screen-home');
  buildEmojiPicker();
});

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Emoji picker ───────────────────────────────────────────────
function buildEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.onclick = () => sendEmoji(e);
    picker.appendChild(btn);
  });
}

function toggleEmojiPicker() {
  const p = document.getElementById('emoji-picker');
  p.classList.toggle('open');
}

function sendEmoji(emoji) {
  if (socket) socket.emit('send_emoji', { emoji });
  document.getElementById('emoji-picker').classList.remove('open');
}

function showEmojiReaction(pseudo, pidx, emoji) {
  const area = document.getElementById('emoji-reactions');
  const el = document.createElement('div');
  el.className = 'emoji-reaction ' + (pidx === playerIndex ? 'reaction-me' : 'reaction-them');
  el.innerHTML = `<span class="reaction-pseudo">${pseudo}</span><span class="reaction-emoji">${emoji}</span>`;
  area.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Timer ─────────────────────────────────────────────────────
function startTimer() {
  clearInterval(timerInterval);
  timerSeconds = 60;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById('hud-timer').textContent = '';
}

function updateTimerDisplay() {
  const el = document.getElementById('hud-timer');
  if (!el) return;
  const isMyTurn = gameState && gameState.currentTurn === playerIndex;
  el.textContent = `⏱ ${timerSeconds}s`;
  el.className = 'hud-timer' + (timerSeconds <= 15 ? ' timer-urgent' : '') + (isMyTurn ? ' timer-mine' : '');
}

// ─── Solo ───────────────────────────────────────────────────────
function startSolo() {
  mode = 'solo'; playerIndex = 0;
  gameState = createInitialGameState();
  onlinePlayers = [{pseudo:'Vous',index:0},{pseudo:'IA',index:1}];
  document.getElementById('label-p0').textContent = 'Vous';
  document.getElementById('label-p1').textContent = 'IA';
  document.getElementById('emoji-bar').style.display = 'none';
  showScreen('screen-game');
  renderGame();
  addLog('⚔ Mode Solo — Affrontez l\'IA !','log-turn');
}

// ─── Online ─────────────────────────────────────────────────────
function showOnlineMenu() {
  showScreen('screen-online');
  connectSocket();
}

function connectSocket() {
  if (socket && socket.connected) return;
  socket = io(SERVER_URL, { transports: ['websocket'] });

  socket.on('connect', () => {
    document.getElementById('online-status').textContent = '🟢 Connecté au serveur';
  });
  socket.on('connect_error', () => {
    document.getElementById('online-status').textContent = '🔴 Serveur inaccessible — patiente 30s (Render en veille)';
  });
  socket.on('lobby_update', renderLobby);
  socket.on('room_created', ({ roomId, playerIndex: idx }) => {
    playerIndex = idx;
    document.getElementById('waiting-room-id').textContent = roomId;
    showScreen('screen-waiting');
  });
  socket.on('game_start', ({ gameState: gs, players }) => {
    gameState = gs; onlinePlayers = players;
    document.getElementById('label-p0').textContent = players[0].pseudo;
    document.getElementById('label-p1').textContent = players[1].pseudo;
    document.getElementById('emoji-bar').style.display = 'flex';
    showScreen('screen-game');
    renderGame();
    addLog(`🌐 ${players[0].pseudo} vs ${players[1].pseudo}`,'log-turn');
    if (gameState.currentTurn === playerIndex) startTimer();
  });
  socket.on('game_update', (gs) => {
    gameState = gs; selectedCell = null; reachableCells = [];
    renderGame();
    if (gs.winner !== null) { stopTimer(); setTimeout(()=>showWinner(gs.winner),400); return; }
    if (gs.currentTurn === playerIndex) startTimer(); else stopTimer();
  });
  socket.on('turn_warning', ({ playerIdx, warning, max }) => {
    sfxWarn();
    const isMe = playerIdx === playerIndex;
    showToast(isMe
      ? `⚠️ Tu n'as pas joué ! Avertissement ${warning}/${max}`
      : `⚠️ L'adversaire est AFK (${warning}/${max})`, isMe ? 'toast-warn' : 'toast-info');
  });
  socket.on('receive_emoji', ({ pseudo, playerIndex: pidx, emoji }) => {
    showEmojiReaction(pseudo, pidx, emoji);
  });
  socket.on('opponent_left', (msg) => { stopTimer(); alert(msg); backToHome(); });
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
    </div>`).join('');
}

function createRoom() {
  const pseudo = document.getElementById('pseudo-input').value.trim();
  const name = document.getElementById('room-name-input').value.trim();
  if (!pseudo) return alert('Entre ton pseudo !');
  socket.emit('create_room', { pseudo, roomName: name || `Partie de ${pseudo}` });
}

function joinRoom(roomId) {
  const pseudo = document.getElementById('pseudo-input').value.trim();
  if (!pseudo) return alert('Entre ton pseudo !');
  socket.emit('join_room', { roomId, pseudo });
}

// ─── Toast ──────────────────────────────────────────────────────
function showToast(msg, cls='toast-info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + cls + ' show';
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('show'), 4000);
}

// ─── Game logic ─────────────────────────────────────────────────
function createInitialGameState() {
  const terrainPool = ['plains','plains','plains','plains','plains','forest','forest','mountain','river'];
  const grid = Array.from({length:GRID}, ()=>
    Array.from({length:GRID}, ()=>({
      terrain: terrainPool[Math.floor(Math.random()*terrainPool.length)],
      unit: null
    }))
  );
  function place(r,c,type,owner) {
    const stats = {infantry:{hp:10,maxHp:10},tank:{hp:15,maxHp:15},artillery:{hp:8,maxHp:8},sniper:{hp:7,maxHp:7}};
    grid[r][c].unit = {type,owner,...stats[type],moved:false};
  }
  // Player 0 bottom — 16 unités
  place(GRID-1,0,'infantry',0); place(GRID-1,2,'tank',0);     place(GRID-1,4,'artillery',0);
  place(GRID-1,6,'infantry',0); place(GRID-1,8,'tank',0);     place(GRID-1,10,'artillery',0);
  place(GRID-1,12,'sniper',0);
  place(GRID-2,1,'infantry',0); place(GRID-2,5,'tank',0);     place(GRID-2,7,'infantry',0);
  place(GRID-2,11,'infantry',0);
  place(GRID-3,3,'tank',0);     place(GRID-3,6,'sniper',0);   place(GRID-3,9,'infantry',0);
  place(GRID-4,2,'infantry',0); place(GRID-4,8,'artillery',0);
  // Player 1 top — 16 unités
  place(0,0,'infantry',1);  place(0,2,'tank',1);     place(0,4,'artillery',1);
  place(0,6,'infantry',1);  place(0,8,'tank',1);     place(0,10,'artillery',1);
  place(0,12,'sniper',1);
  place(1,1,'infantry',1);  place(1,5,'tank',1);     place(1,7,'infantry',1);
  place(1,11,'infantry',1);
  place(2,3,'tank',1);      place(2,6,'sniper',1);   place(2,9,'infantry',1);
  place(3,2,'infantry',1);  place(3,8,'artillery',1);

  return { grid, currentTurn:0, turnNumber:1, resources:[15,15], log:[], winner:null };
}

function getMoveRange(type) { return {infantry:2,tank:3,artillery:1,sniper:3}[type]??2; }

function getNeighbors(row,col) {
  const even = row%2===0;
  const dirs = even ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]] : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
  return dirs.map(([dr,dc])=>({row:row+dr,col:col+dc})).filter(p=>p.row>=0&&p.row<GRID&&p.col>=0&&p.col<GRID);
}

function getReachable(grid,sr,sc,range) {
  const visited = new Set([`${sr},${sc}`]);
  const queue = [{row:sr,col:sc,steps:0}];
  const cells = [];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.steps>0) cells.push({row:cur.row,col:cur.col});
    if (cur.steps>=range) continue;
    for (const n of getNeighbors(cur.row,cur.col)) {
      const key=`${n.row},${n.col}`;
      if (!visited.has(key)) {
        visited.add(key);
        const cell=grid[n.row][n.col];
        if (!cell.unit||cell.unit.owner!==grid[sr][sc].unit?.owner) queue.push({...n,steps:cur.steps+1});
      }
    }
  }
  return cells;
}

function applyMove(from,to) {
  const gs = gameState;
  const unit = gs.grid[from.row][from.col].unit;
  if (!unit||unit.owner!==playerIndex||unit.moved) return false;
  const target = gs.grid[to.row][to.col];
  if (target.unit&&target.unit.owner===playerIndex) return false;

  if (target.unit) {
    sfxAttack(); animateHex(to.row,to.col,'hit');
    const dmg={infantry:3,tank:6,artillery:8,sniper:10}[unit.type]??3;
    const def=target.terrain==='forest'?.7:target.terrain==='mountain'?.5:target.terrain==='river'?.8:1;
    const fd=Math.round(dmg*def);
    target.unit.hp-=fd;
    addLog(`💥 ${unitLabel(unit.type)} → ${unitLabel(target.unit.type)} −${fd} HP`,'log-damage');
    if (target.unit.hp<=0) {
      sfxDestroy(); animateHex(to.row,to.col,'explode');
      addLog(`💀 ${unitLabel(target.unit.type)} détruit !`,'log-kill');
      gs.grid[to.row][to.col].unit={...unit,moved:true};
      gs.grid[from.row][from.col].unit=null;
    } else {
      addLog(`🛡 Résiste (${target.unit.hp} HP)`,'log-damage');
      unit.moved=true;
    }
  } else {
    sfxMove();
    gs.grid[to.row][to.col].unit={...unit,moved:true};
    gs.grid[from.row][from.col].unit=null;
  }

  const p0=gs.grid.flat().filter(c=>c.unit&&c.unit.owner===0).length;
  const p1=gs.grid.flat().filter(c=>c.unit&&c.unit.owner===1).length;
  if (p0===0) gs.winner=1;
  if (p1===0) gs.winner=0;
  return true;
}

function animateHex(row,col,cls) {
  const el=document.querySelector(`[data-r="${row}"][data-c="${col}"]`);
  if (!el) return;
  el.classList.remove('hit','explode'); void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend',()=>el.classList.remove(cls),{once:true});
}

function endTurn() {
  if (!gameState||gameState.winner!==null) return;
  if (mode==='online') {
    if (gameState.currentTurn!==playerIndex) return;
    socket.emit('end_turn');
    stopTimer();
  } else {
    if (gameState.currentTurn!==0) return;
    sfxEndTurn();
    gameState.currentTurn=1; gameState.turnNumber++;
    gameState.resources[1]+=5;
    gameState.grid.flat().forEach(c=>{if(c.unit)c.unit.moved=false;});
    addLog(`— Tour ${gameState.turnNumber} — IA réfléchit…`,'log-turn');
    selectedCell=null; reachableCells=[];
    renderGame();
    setTimeout(playAITurn,900);
  }
}

function playAITurn() {
  const actions=AI.playTurn(gameState);
  let i=0;
  function next() {
    if (i>=actions.length) {
      gameState.currentTurn=0; gameState.turnNumber++;
      gameState.resources[0]+=5;
      gameState.grid.flat().forEach(c=>{if(c.unit)c.unit.moved=false;});
      addLog(`— Tour ${gameState.turnNumber} — Votre tour`,'log-turn');
      renderGame();
      if (gameState.winner!==null) showWinner(gameState.winner);
      return;
    }
    const {from,to}=actions[i++];
    const unit=gameState.grid[from.row][from.col].unit;
    if (unit&&!unit.moved) { const sv=playerIndex; playerIndex=1; applyMove(from,to); playerIndex=sv; }
    renderGame();
    setTimeout(next,500);
  }
  next();
}

// ─── Clicks ─────────────────────────────────────────────────────
function onCellClick(row,col) {
  if (!gameState||gameState.winner!==null) return;
  if (gameState.currentTurn!==playerIndex) return;
  const cell=gameState.grid[row][col];

  if (selectedCell) {
    const reach=reachableCells.some(c=>c.row===row&&c.col===col);
    if (reach) {
      const from=selectedCell, to={row,col};
      if (mode==='online') { socket.emit('move_unit',{from,to}); }
      else { applyMove(from,to); renderGame(); if(gameState.winner!==null)setTimeout(()=>showWinner(gameState.winner),500); }
      selectedCell=null; reachableCells=[]; return;
    }
    selectedCell=null; reachableCells=[];
  }

  if (cell.unit&&cell.unit.owner===playerIndex&&!cell.unit.moved) {
    selectedCell={row,col};
    reachableCells=getReachable(gameState.grid,row,col,getMoveRange(cell.unit.type));
    sfxSelect();
  }
  renderGame();
}

// ─── Render ─────────────────────────────────────────────────────
const SVG_IDS = {infantry:'svg-infantry',tank:'svg-tank',artillery:'svg-artillery',sniper:'svg-sniper'};
const TERRAIN_CLS = {plains:'terrain-plains',forest:'terrain-forest',mountain:'terrain-mountain',river:'terrain-river'};

function unitLabel(t){ return {infantry:'Infanterie',tank:'Tank',artillery:'Artillerie',sniper:'Sniper'}[t]??t; }

function unitSVG(unit) {
  const color = unit.owner===0 ? '#6ab4ff' : '#ff6a6a';
  return `<svg viewBox="0 0 32 32" fill="${color}"><use href="#${SVG_IDS[unit.type]??'svg-infantry'}"/></svg>`;
}

function renderGame() {
  if (!gameState) return;
  const gs=gameState;
  const grid=document.getElementById('hex-grid');
  grid.innerHTML='';

  for (let r=0;r<GRID;r++) {
    const row=document.createElement('div');
    row.className='hex-row'+(r%2===0?' offset':'');
    for (let c=0;c<GRID;c++) {
      const cell=gs.grid[r][c];
      const hex=document.createElement('div');
      hex.className='hex '+(TERRAIN_CLS[cell.terrain]||'terrain-plains');
      hex.dataset.r=r; hex.dataset.c=c;
      const isSel=selectedCell&&selectedCell.row===r&&selectedCell.col===c;
      const isReach=reachableCells.some(rc=>rc.row===r&&rc.col===c);
      const isEnemy=cell.unit&&cell.unit.owner!==playerIndex;
      if (isSel) hex.classList.add('selected');
      if (isReach&&!cell.unit) hex.classList.add('reachable');
      if (isReach&&isEnemy) hex.classList.add('attackable');
      if (cell.unit) {
        const pct=Math.round((cell.unit.hp/cell.unit.maxHp)*100);
        const crit=pct<=30;
        const ownerCls=cell.unit.owner===0?'unit-p0':'unit-p1';
        const movedCls=cell.unit.moved?' moved':'';
        hex.innerHTML=`<div class="unit ${ownerCls}${movedCls}">${unitSVG(cell.unit)}<div class="hp-bar"><div class="hp-fill${crit?' critical':''}" style="width:${pct}%"></div></div></div>`;
      }
      hex.addEventListener('click',()=>onCellClick(r,c));
      row.appendChild(hex);
    }
    grid.appendChild(row);
  }

  // HUD
  const isMyTurn=gs.currentTurn===playerIndex;
  const turnName=mode==='solo'?(gs.currentTurn===0?'VOTRE TOUR':'TOUR IA'):(isMyTurn?'VOTRE TOUR':'ADVERSAIRE…');
  document.getElementById('hud-turn').textContent=`T${gs.turnNumber} — ${turnName}`;
  document.getElementById('hud-res-p0').textContent=gs.resources[0];
  document.getElementById('hud-res-p1').textContent=gs.resources[1];
  document.getElementById('btn-end-turn').disabled=!isMyTurn||gs.winner!==null;

  // Log
  const logEl=document.getElementById('battle-log');
  logEl.innerHTML=(gs.log||[]).slice(0,20).map((entry,i)=>{
    const cls=typeof entry==='object'?entry.cls:'';
    const txt=typeof entry==='object'?entry.txt:entry;
    return `<div class="log-entry${cls?' '+cls:''}${i===0?' newest':''}">${txt}</div>`;
  }).join('');
}

function addLog(msg,cls='') {
  if (!gameState) return;
  if (!gameState.log) gameState.log=[];
  gameState.log.unshift(cls?{txt:msg,cls}:msg);
}

function showWinner(idx) {
  const name=onlinePlayers[idx]?.pseudo||(idx===0?'Vous':'L\'IA');
  const win=idx===playerIndex;
  win?sfxVictory():sfxDefeat();
  document.getElementById('result-title').textContent=win?'🏆 VICTOIRE':'💀 DÉFAITE';
  document.getElementById('result-subtitle').textContent=`${name} remporte la bataille !`;
  document.getElementById('result-title').className=win?'victory':'defeat';
  setTimeout(()=>showScreen('screen-result'),300);
}

function backToHome() {
  stopTimer();
  if (socket){socket.disconnect();socket=null;}
  gameState=null; selectedCell=null; reachableCells=[];
  showScreen('screen-home');
}
