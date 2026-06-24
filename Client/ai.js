// ai.js — IA pour le Mode Solo (Joueur 1 = index 1)

const AI = {
  // Retourne la liste des unités IA avec leurs positions
  getUnits(grid) {
    const units = [];
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        if (grid[r][c].unit && grid[r][c].unit.owner === 1) {
          units.push({ row: r, col: c, unit: grid[r][c].unit });
        }
      }
    }
    return units;
  },

  // Voisins hexagonaux selon parité de ligne
  getNeighbors(row, col, maxRow, maxCol) {
    const isEven = row % 2 === 0;
    const dirs = isEven
      ? [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]]
      : [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]];
    return dirs
      .map(([dr, dc]) => ({ row: row + dr, col: col + dc }))
      .filter(p => p.row >= 0 && p.row < maxRow && p.col >= 0 && p.col < maxCol);
  },

  // Distance hex approximative
  hexDist(r1, c1, r2, c2) {
    return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
  },

  // Portée de mouvement selon type
  getRange(type) {
    return { infantry: 2, tank: 3, artillery: 1 };[type] ?? 2;
  },

  // BFS pour trouver les cases accessibles
  reachable(grid, startRow, startCol, range) {
    const visited = new Set();
    const queue = [{ row: startRow, col: startCol, steps: 0 }];
    const cells = [];
    visited.add(`${startRow},${startCol}`);

    while (queue.length) {
      const cur = queue.shift();
      if (cur.steps > 0) cells.push({ row: cur.row, col: cur.col });
      if (cur.steps >= range) continue;
      for (const n of this.getNeighbors(cur.row, cur.col, grid.length, grid[0].length)) {
        const key = `${n.row},${n.col}`;
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({ ...n, steps: cur.steps + 1 });
        }
      }
    }
    return cells;
  },

  // Joue un tour complet, retourne la liste des actions [{from, to}]
  playTurn(gameState) {
    const grid = gameState.grid;
    const units = this.getUnits(grid);
    const actions = [];

    for (const { row, col, unit } of units) {
      if (unit.moved) continue;

      const cells = this.reachable(grid, row, col, this.getMoveRange(unit.type));

      // Cherche une cible ennemie dans les cellules accessibles
      let bestAttack = null;
      let bestMove = null;
      let bestDist = Infinity;

      for (const cell of cells) {
        const target = grid[cell.row][cell.col].unit;
        if (target && target.owner === 0) {
          // Case avec ennemi = attaque
          bestAttack = cell;
          break;
        }
        // Sinon avancer vers les ennemis
        for (let r = 0; r < grid.length; r++) {
          for (let c = 0; c < grid[r].length; c++) {
            if (grid[r][c].unit && grid[r][c].unit.owner === 0) {
              const d = this.hexDist(cell.row, cell.col, r, c);
              if (d < bestDist && !grid[cell.row][cell.col].unit) {
                bestDist = d;
                bestMove = cell;
              }
            }
          }
        }
      }

      const dest = bestAttack || bestMove;
      if (dest) {
        actions.push({ from: { row, col }, to: dest });
      }
    }

    return actions;
  },

  getMoveRange(type) {
    const ranges = { infantry: 2, tank: 3, artillery: 1 };
    return ranges[type] ?? 2;
  }
};

if (typeof module !== 'undefined') module.exports = AI;
