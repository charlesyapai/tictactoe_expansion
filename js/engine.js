// Rules engine for Tic-Tac-Toe Expansion.
//
// Pure ES module: no DOM, no globals, no side effects. Every function returns
// a new state and never mutates the one it was given. State is plain JSON, so
// JSON.parse(JSON.stringify(state)) gives back a state that plays the same.
//
// Everything here is 0-indexed (0..8), row by row:
//     0 1 2
//     3 4 5
//     6 7 8
// Only notation() uses the 1..9 numbering shown to players.

const SIZE = 9;
const ALL_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export const MODES = Object.freeze({ ANYWHERE: 'anywhere', ADJACENT: 'adjacent' });

// The 8 winning triples: rows, columns, diagonals.
export const LINES = Object.freeze(
  [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ].map((line) => Object.freeze(line)),
);

function isIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < SIZE;
}

function isMode(value) {
  return value === MODES.ANYWHERE || value === MODES.ADJACENT;
}

function emptyBoard() {
  return new Array(SIZE).fill(null);
}

// First line in LINES that `player` holds completely, as a fresh array, or null.
function findLine(squares, player) {
  for (const [a, b, c] of LINES) {
    if (squares[a] === player && squares[b] === player && squares[c] === player) {
      return [a, b, c];
    }
  }
  return null;
}

function cloneState(state) {
  return {
    mode: state.mode,
    cells: state.cells.map((small) => small.slice()),
    boardWinners: state.boardWinners.slice(),
    boardWinLines: state.boardWinLines.map((line) => (line ? line.slice() : null)),
    resets: state.resets.slice(),
    currentPlayer: state.currentPlayer,
    targetBoard: state.targetBoard,
    legalBoards: state.legalBoards.slice(),
    constraint: state.constraint,
    winner: state.winner,
    winLine: state.winLine ? state.winLine.slice() : null,
    lastMove: state.lastMove ? { board: state.lastMove.board, cell: state.lastMove.cell } : null,
    history: state.history.map((entry) => ({
      player: entry.player,
      board: entry.board,
      cell: entry.cell,
      notation: entry.notation,
      wonBoard: entry.wonBoard,
      tiedBoard: entry.tiedBoard,
      tiedCells: entry.tiedCells ? entry.tiedCells.slice() : null,
    })),
  };
}

// Where may the player to move play? Derived from winner, targetBoard,
// boardWinners and mode only.
function restriction(state) {
  if (state.winner !== null) {
    return { constraint: 'over', legalBoards: [] };
  }
  const open = ALL_INDICES.filter((board) => state.boardWinners[board] === null);
  if (state.targetBoard === null) {
    return { constraint: 'start', legalBoards: open };
  }
  if (state.boardWinners[state.targetBoard] === null) {
    return { constraint: 'forced', legalBoards: [state.targetBoard] };
  }
  if (state.mode === MODES.ADJACENT) {
    const touching = neighbors(state.targetBoard).filter(
      (board) => state.boardWinners[board] === null,
    );
    if (touching.length > 0) {
      return { constraint: 'adjacent', legalBoards: touching };
    }
  }
  return { constraint: 'free', legalBoards: open };
}

function describeIllegal(state, board, cell) {
  if (!isIndex(board) || !isIndex(cell)) {
    return `Illegal move: board and cell must be integers 0..8 (got board ${String(board)}, cell ${String(cell)})`;
  }
  const name = notation(board, cell);
  if (state.winner !== null) {
    return `Illegal move ${name}: the game is over`;
  }
  if (state.boardWinners[board] !== null) {
    return `Illegal move ${name}: big square ${board + 1} is already won`;
  }
  if (!state.legalBoards.includes(board)) {
    const allowed = state.legalBoards.map((b) => b + 1).join(', ');
    return `Illegal move ${name}: ${state.currentPlayer} must play in big square ${allowed}`;
  }
  return `Illegal move ${name}: that square is taken`;
}

export function createGame({ mode = MODES.ANYWHERE } = {}) {
  if (!isMode(mode)) {
    throw new Error(`Unknown mode: ${String(mode)}`);
  }
  return {
    mode,
    cells: ALL_INDICES.map(() => emptyBoard()),
    boardWinners: emptyBoard(),
    boardWinLines: emptyBoard(),
    resets: new Array(SIZE).fill(0),
    currentPlayer: 'X',
    targetBoard: null,
    legalBoards: ALL_INDICES.slice(),
    constraint: 'start',
    winner: null,
    winLine: null,
    lastMove: null,
    history: [],
  };
}

export function isLegalMove(state, board, cell) {
  if (!isIndex(board) || !isIndex(cell)) return false;
  if (state.winner !== null) return false;
  if (!state.legalBoards.includes(board)) return false;
  return state.cells[board][cell] === null;
}

export function applyMove(state, board, cell) {
  if (!isLegalMove(state, board, cell)) {
    throw new Error(describeIllegal(state, board, cell));
  }

  const next = cloneState(state);
  const player = state.currentPlayer;
  next.cells[board][cell] = player;

  // Big-square win first, for the player who just moved. A move that fills
  // the square and completes a line is a win, not a tie.
  let wonBoard = false;
  let tiedBoard = false;
  let tiedCells = null;
  const line = findLine(next.cells[board], player);
  if (line) {
    wonBoard = true;
    next.boardWinners[board] = player;
    next.boardWinLines[board] = line;
  } else if (next.cells[board].every((mark) => mark !== null)) {
    // Tie: remember the layout, wipe the square, leave it open.
    tiedBoard = true;
    tiedCells = next.cells[board];
    next.cells[board] = emptyBoard();
    next.resets[board] += 1;
  }

  // Then the game itself. Only a newly won big square can end it.
  if (wonBoard) {
    const gameLine = findLine(next.boardWinners, player);
    if (gameLine) {
      next.winner = player;
      next.winLine = gameLine;
    } else if (next.boardWinners.every((owner) => owner !== null)) {
      next.winner = 'draw';
    }
  }

  next.history.push({
    player,
    board,
    cell,
    notation: notation(board, cell),
    wonBoard,
    tiedBoard,
    tiedCells,
  });
  next.lastMove = { board, cell };
  next.targetBoard = cell;
  next.currentPlayer = player === 'X' ? 'O' : 'X';

  // Only now work out where the opponent goes.
  const { constraint, legalBoards } = restriction(next);
  next.constraint = constraint;
  next.legalBoards = legalBoards;
  return next;
}

export function setMode(state, mode) {
  if (!isMode(mode)) {
    throw new Error(`Unknown mode: ${String(mode)}`);
  }
  const next = cloneState(state);
  next.mode = mode;
  // 'start', 'forced' and 'over' do not depend on the mode. Only a free-move
  // position (target square already won) is worked out again.
  if (state.constraint === 'free' || state.constraint === 'adjacent') {
    const { constraint, legalBoards } = restriction(next);
    next.constraint = constraint;
    next.legalBoards = legalBoards;
  }
  return next;
}

// Big squares touching `board`, diagonals included, ascending.
export function neighbors(board) {
  if (!isIndex(board)) {
    throw new RangeError(`neighbors: board must be an integer 0..8 (got ${String(board)})`);
  }
  const row = Math.floor(board / 3);
  const col = board % 3;
  const result = [];
  for (let r = row - 1; r <= row + 1; r += 1) {
    for (let c = col - 1; c <= col + 1; c += 1) {
      if (r < 0 || r > 2 || c < 0 || c > 2) continue;
      if (r === row && c === col) continue;
      result.push(r * 3 + c);
    }
  }
  return result;
}

// Player-facing name of a move: notation(3, 0) === "4-1".
export function notation(board, cell) {
  if (!isIndex(board) || !isIndex(cell)) {
    throw new RangeError(
      `notation: board and cell must be integers 0..8 (got ${String(board)}, ${String(cell)})`,
    );
  }
  return `${board + 1}-${cell + 1}`;
}
