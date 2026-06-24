const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.get('/', (req, res) => res.send('WarZone Server Online ⚔️'));

const rooms = {};
const GRID = 13;
const TURN_TIMEOUT = 60000; // 60s
const MAX_WARNINGS = 3;

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.status === 'waiting')
    .map(r => ({ id: r.id, name: r.name, host: r.host, players: r.players.length }));
}

function place(grid, r, c, type, owner) {
  const stats = { infantry:{hp:10,maxHp:10}, tank:{hp:15,maxHp:15}, artillery:{hp:8,maxHp:8}, sniper:{hp:7,maxHp:7} };
  grid[r][c].unit = { type, owner, ...stats[type], moved: false };
}

function createInitialGameState() {
  const terrainPool = ['plains','plains','plains','plains','plains','forest','forest','mountain','river'];
  const grid = Array.from({length: GRID}, () =>
    Array.from({length: GRID}, () => ({
      terrain: terrainPool[Math.floor(Math.random() * terrainPool.length)],
      unit: null
    }))
  );

  // Player 0 (bottom rows) — 10 units
  place(grid, GRID-1, 1,  'infantry',  0);
  place(grid, GRID-1, 3,  'tank',      0);
  place(grid, GRID-1, 5,  'artillery', 0);
  place(grid, GRID-1, 7,  'tank',      0);
  place(grid, GRID-1, 9,  'infantry',  0);
  place(grid, GRID-1, 11, 'sniper',    0);
  place(grid, GRID-2, 2,  'infantry',  0);
  place(grid, GRID-2, 6,  'infantry',  0);
  place(grid, GRID-2, 10, 'infantry',  0);
  place(grid, GRID-3, 4,  'tank',      0);

  // Player 1 (top rows) — 10 units
  place(grid, 0, 1,  'infantry',  1);
  place(grid, 0, 3,  'tank',      1);
  place(grid, 0, 5,  'artillery', 1);
  place(grid, 0, 7,  'tank',      1);
  place(grid, 0, 9,  'infantry',  1);
  place(grid, 0, 11, 'sniper',    1);
  place(grid, 1, 2,  'infantry',  1);
  place(grid, 1, 6,  'infantry',  1);
  place(grid, 1, 10, 'infantry',  1);
  place(grid, 2, 4,  'tank',      1);

  return {
    grid,
    currentTurn: 0,
    turnNumber: 1,
    resources: [15, 15],
    log: [{ txt: '⚔ La bataille commence !', cls: 'log-turn' }],
    winner: null
  };
}

function applyAutoPlay(gs, playerIdx) {
  // Simple auto: move each unit forward one step toward enemy
  const grid = gs.grid;
  const dir = playerIdx === 0 ? -1 : 1;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const unit = grid[r][c].unit;
      if (!unit || unit.owner !== playerIdx || unit.moved) continue;
      const nr = r + dir;
      if (nr >= 0 && nr < GRID && !grid[nr][c].unit) {
        grid[nr][c].unit = { ...unit, moved: true };
        grid[r][c].unit = null;
      } else {
        unit.moved = true;
      }
    }
  }
  endTurnLogic(gs);
}

function endTurnLogic(gs) {
  gs.currentTurn = gs.currentTurn === 0 ? 1 : 0;
  gs.turnNumber++;
  gs.resources[gs.currentTurn] += 5;
  gs.grid.flat().forEach(c => { if (c.unit) c.unit.moved = false; });
  gs.log.unshift({ txt: `— Tour ${gs.turnNumber}`, cls: 'log-turn' });
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearTimeout(room.turnTimer);

  room.turnTimer = setTimeout(() => {
    if (!rooms[roomId] || room.status !== 'playing') return;
    const gs = room.gameState;
    const timedOutPlayer = gs.currentTurn;
    room.warnings = room.warnings || [0, 0];
    room.warnings[timedOutPlayer]++;

    if (room.warnings[timedOutPlayer] >= MAX_WARNINGS) {
      // Forfait
      gs.winner = timedOutPlayer === 0 ? 1 : 0;
      gs.log.unshift({ txt: `🏳 Joueur ${timedOutPlayer+1} forfait (AFK)`, cls: 'log-kill' });
      io.to(roomId).emit('game_update', gs);
    } else {
      // Avertissement + jeu automatique
      io.to(roomId).emit('turn_warning', {
        playerIdx: timedOutPlayer,
        warning: room.warnings[timedOutPlayer],
        max: MAX_WARNINGS
      });
      applyAutoPlay(gs, timedOutPlayer);
      gs.log.unshift({ txt: `⚠ Joueur ${timedOutPlayer+1} AFK (avert. ${room.warnings[timedOutPlayer]}/${MAX_WARNINGS})`, cls: 'log-damage' });
      io.to(roomId).emit('game_update', gs);
      startTurnTimer(roomId);
    }
  }, TURN_TIMEOUT);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socket.emit('lobby_update', getRoomList());

  socket.on('create_room', ({ pseudo, roomName }) => {
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: roomName || `Partie de ${pseudo}`,
      host: pseudo, hostId: socket.id,
      players: [{ id: socket.id, pseudo, index: 0 }],
      status: 'waiting',
      gameState: null,
      warnings: [0, 0],
      turnTimer: null
    };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.pseudo = pseudo;
    socket.data.playerIndex = 0;
    socket.emit('room_created', { roomId, playerIndex: 0 });
    io.emit('lobby_update', getRoomList());
  });

  socket.on('join_room', ({ roomId, pseudo }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Partie introuvable.');
    if (room.status !== 'waiting') return socket.emit('error', 'Partie déjà en cours.');
    if (room.players.length >= 2) return socket.emit('error', 'Partie complète.');

    room.players.push({ id: socket.id, pseudo, index: 1 });
    room.status = 'playing';
    room.gameState = createInitialGameState();

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.pseudo = pseudo;
    socket.data.playerIndex = 1;

    io.to(roomId).emit('game_start', {
      gameState: room.gameState,
      players: room.players.map(p => ({ pseudo: p.pseudo, index: p.index }))
    });
    io.emit('lobby_update', getRoomList());
    startTurnTimer(roomId);
  });

  socket.on('move_unit', ({ from, to }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;
    const gs = room.gameState;
    if (gs.currentTurn !== socket.data.playerIndex) return socket.emit('error', 'Pas votre tour.');

    const unit = gs.grid[from.row][from.col].unit;
    if (!unit || unit.owner !== socket.data.playerIndex || unit.moved) return;
    const target = gs.grid[to.row][to.col];
    if (target.unit && target.unit.owner === socket.data.playerIndex) return;

    if (target.unit) {
      const dmgTable = { infantry:3, tank:6, artillery:8, sniper:10 };
      const defBonus = target.terrain==='forest'?0.7:target.terrain==='mountain'?0.5:target.terrain==='river'?0.8:1;
      const dmg = Math.round(dmgTable[unit.type] * defBonus);
      target.unit.hp -= dmg;
      gs.log.unshift({ txt: `💥 ${unit.type} → ${target.unit.type} −${dmg}`, cls:'log-damage' });
      if (target.unit.hp <= 0) {
        gs.log.unshift({ txt: `💀 ${target.unit.type} détruit`, cls:'log-kill' });
        gs.grid[to.row][to.col].unit = { ...unit, moved: true };
        gs.grid[from.row][from.col].unit = null;
      } else { unit.moved = true; }
    } else {
      gs.grid[to.row][to.col].unit = { ...unit, moved: true };
      gs.grid[from.row][from.col].unit = null;
    }

    const p0 = gs.grid.flat().filter(c=>c.unit&&c.unit.owner===0).length;
    const p1 = gs.grid.flat().filter(c=>c.unit&&c.unit.owner===1).length;
    if (p0===0) gs.winner=1;
    if (p1===0) gs.winner=0;

    io.to(roomId).emit('game_update', gs);
    if (gs.winner !== null) clearTimeout(room.turnTimer);
  });

  socket.on('end_turn', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;
    const gs = room.gameState;
    if (gs.currentTurn !== socket.data.playerIndex) return;

    // Reset warnings for this player on successful turn
    room.warnings[socket.data.playerIndex] = 0;
    endTurnLogic(gs);
    io.to(roomId).emit('game_update', gs);
    startTurnTimer(roomId);
  });

  // Emoji reaction
  socket.on('send_emoji', ({ emoji }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    io.to(roomId).emit('receive_emoji', {
      pseudo: socket.data.pseudo,
      playerIndex: socket.data.playerIndex,
      emoji
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      clearTimeout(room.turnTimer);
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[roomId]; }
      else {
        room.status = 'waiting';
        io.to(roomId).emit('opponent_left', 'Votre adversaire a quitté la partie.');
      }
      io.emit('lobby_update', getRoomList());
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WarZone server on port ${PORT}`));
