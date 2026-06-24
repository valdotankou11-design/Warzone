const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/', (req, res) => res.send('WarZone Server Online ⚔️'));

// Lobby: { roomId: { id, name, host, hostId, players: [], status, gameState } }
const rooms = {};

function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.status === 'waiting')
    .map(r => ({ id: r.id, name: r.name, host: r.host, players: r.players.length }));
}

function createInitialGameState() {
  // 7x7 hex grid, each cell: { terrain, unit: null }
  const grid = [];
  const terrains = ['plains', 'plains', 'plains', 'forest', 'mountain', 'plains', 'plains'];
  for (let row = 0; row < 7; row++) {
    grid[row] = [];
    for (let col = 0; col < 7; col++) {
      grid[row][col] = {
        terrain: terrains[Math.floor(Math.random() * terrains.length)],
        unit: null
      };
    }
  }

  // Place starting units
  // Player 1 (top)
  grid[0][1].unit = { type: 'infantry', owner: 0, hp: 10, moved: false };
  grid[0][3].unit = { type: 'tank', owner: 0, hp: 15, moved: false };
  grid[0][5].unit = { type: 'artillery', owner: 0, hp: 8, moved: false };
  grid[1][3].unit = { type: 'infantry', owner: 0, hp: 10, moved: false };

  // Player 2 (bottom)
  grid[6][1].unit = { type: 'infantry', owner: 1, hp: 10, moved: false };
  grid[6][3].unit = { type: 'tank', owner: 1, hp: 15, moved: false };
  grid[6][5].unit = { type: 'artillery', owner: 1, hp: 8, moved: false };
  grid[5][3].unit = { type: 'infantry', owner: 1, hp: 10, moved: false };

  return {
    grid,
    currentTurn: 0,
    turnNumber: 1,
    resources: [10, 10],
    log: ['La bataille commence !'],
    winner: null
  };
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Send lobby list on connect
  socket.emit('lobby_update', getRoomList());

  // Create room
  socket.on('create_room', ({ pseudo, roomName }) => {
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: roomName || `Partie de ${pseudo}`,
      host: pseudo,
      hostId: socket.id,
      players: [{ id: socket.id, pseudo, index: 0 }],
      status: 'waiting',
      gameState: null
    };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.pseudo = pseudo;
    socket.data.playerIndex = 0;

    socket.emit('room_created', { roomId, playerIndex: 0 });
    io.emit('lobby_update', getRoomList());
    console.log(`Room created: ${roomId} by ${pseudo}`);
  });

  // Join room
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

    // Notify both players
    io.to(roomId).emit('game_start', {
      gameState: room.gameState,
      players: room.players.map(p => ({ pseudo: p.pseudo, index: p.index }))
    });

    io.emit('lobby_update', getRoomList());
    console.log(`${pseudo} joined room ${roomId}`);
  });

  // Game action: move unit
  socket.on('move_unit', ({ from, to }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;
    const gs = room.gameState;
    if (gs.currentTurn !== socket.data.playerIndex) return socket.emit('error', 'Ce n\'est pas votre tour.');

    const unit = gs.grid[from.row][from.col].unit;
    if (!unit || unit.owner !== socket.data.playerIndex) return;
    if (unit.moved) return socket.emit('error', 'Unité déjà déplacée.');

    const target = gs.grid[to.row][to.col];
    if (target.unit && target.unit.owner === socket.data.playerIndex) return socket.emit('error', 'Case occupée par votre unité.');

    // Combat if enemy unit
    if (target.unit && target.unit.owner !== socket.data.playerIndex) {
      const attacker = unit;
      const defender = target.unit;
      const dmgTable = { infantry: 3, tank: 6, artillery: 8 };
      const defBonus = target.terrain === 'forest' ? 0.7 : target.terrain === 'mountain' ? 0.5 : 1;
      const dmg = Math.round(dmgTable[attacker.type] * defBonus);
      defender.hp -= dmg;
      gs.log.unshift(`${attacker.type} attaque ${defender.type} (-${dmg} HP)`);

      if (defender.hp <= 0) {
        gs.grid[to.row][to.col].unit = null;
        gs.log.unshift(`${defender.type} ennemi détruit !`);
        // Move attacker
        gs.grid[to.row][to.col].unit = { ...attacker, moved: true };
        gs.grid[from.row][from.col].unit = null;
      } else {
        attacker.moved = true;
        gs.log.unshift(`${defender.type} résiste (${defender.hp} HP restants)`);
      }
    } else {
      gs.grid[to.row][to.col].unit = { ...unit, moved: true };
      gs.grid[from.row][from.col].unit = null;
    }

    // Check winner
    const p0Units = gs.grid.flat().filter(c => c.unit && c.unit.owner === 0).length;
    const p1Units = gs.grid.flat().filter(c => c.unit && c.unit.owner === 1).length;
    if (p0Units === 0) gs.winner = 1;
    if (p1Units === 0) gs.winner = 0;

    io.to(roomId).emit('game_update', gs);
  });

  // End turn
  socket.on('end_turn', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;
    const gs = room.gameState;
    if (gs.currentTurn !== socket.data.playerIndex) return;

    gs.currentTurn = gs.currentTurn === 0 ? 1 : 0;
    gs.turnNumber++;
    gs.resources[gs.currentTurn] += 5;

    // Reset moved flags
    gs.grid.flat().forEach(cell => { if (cell.unit) cell.unit.moved = false; });
    gs.log.unshift(`Tour ${gs.turnNumber} — Joueur ${gs.currentTurn + 1}`);

    io.to(roomId).emit('game_update', gs);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        room.status = 'waiting';
        io.to(roomId).emit('opponent_left', 'Votre adversaire a quitté la partie.');
      }
      io.emit('lobby_update', getRoomList());
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WarZone server on port ${PORT}`));
