// Computer opponent for Tic-Tac-Toe Expansion.
//
// Pure ES module: no DOM, no imports, runs in a browser and in Node. The UI
// uses LEVELS and chooseMove only. `_internals` exists for the tests.
//
// The engine's applyMove copies the whole state (history included), which is
// far too slow for a search. So this file keeps its own compact, mutable copy
// of the position and plays the rules itself: small-square win, the tie (wiped
// under tie rule 'reset', closed for good under 'stay'), game win and draw,
// and the forced / free / adjacent rule with its fallback. tests/ai.test.mjs
// plays thousands of random moves through both and checks they never disagree.
//
// A big square is OPEN when nobody has won it and it has not been closed by a
// tie. Only open squares can be played in.
//
// Everything is 0-indexed, row by row, same as the engine.

export const LEVELS = ['easy', 'medium', 'hard'];

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const LINE_MASKS = LINES.map(([a, b, c]) => (1 << a) | (1 << b) | (1 << c));
const FULL = 511;

// A 9-bit mask says which of nine squares one player holds.
const HAS_LINE = new Uint8Array(512); // 1 when the mask contains a full line
const POP = new Uint8Array(512); // bit count
const T3 = new Int32Array(512); // the mask read as a base-3 number of 0/1 digits
// Touching big squares, diagonals included, as a bit mask.
const ADJ = new Int32Array(9);

for (let m = 0; m < 512; m += 1) {
  let pop = 0;
  let t = 0;
  let p = 1;
  for (let i = 0; i < 9; i += 1) {
    if ((m >> i) & 1) {
      pop += 1;
      t += p;
    }
    p *= 3;
  }
  POP[m] = pop;
  T3[m] = t;
  for (const lm of LINE_MASKS) {
    if ((m & lm) === lm) HAS_LINE[m] = 1;
  }
}
for (let b = 0; b < 9; b += 1) {
  const row = (b / 3) | 0;
  const col = b % 3;
  for (let r = row - 1; r <= row + 1; r += 1) {
    for (let c = col - 1; c <= col + 1; c += 1) {
      if (r < 0 || r > 2 || c < 0 || c > 2 || (r === row && c === col)) continue;
      ADJ[b] |= 1 << (r * 3 + c);
    }
  }
}

const MOVE_BOARD = new Int8Array(81);
const MOVE_CELL = new Int8Array(81);
for (let m = 0; m < 81; m += 1) {
  MOVE_BOARD[m] = (m / 9) | 0;
  MOVE_CELL[m] = m % 9;
}

// Evaluation weights.
const WIN = 1000000; // a game win scores WIN minus the number of plies it took
const WIN_ZONE = WIN - 1000; // any score beyond this is a forced win or loss
const INF = 2000000;
const SQUARE_BASE = 40; // a won big square is worth BASE + PER_LINE * lines through it
const SQUARE_PER_LINE = 30; // edge 100, corner 130, centre 160
const BIG_TWO = 180; // two won big squares in a line, third still winnable
const BIG_ONE = 15; // one won big square in a line, other two still winnable
const SMALL_TWO = 5; // two in a small line, third cell empty
const SMALL_ONE = 1; // one in a small line, other two cells empty
const LINE_IMPORTANCE = [1, 2, 6]; // how much a live big line adds to a square on it, by squares already won
const FREE_MOVE = 60; // side to move may play in any open big square
const FREE_MOVE_ADJACENT = 35; // side to move has a free move limited to touching squares
const TEMPO_BASE = 40; // side to move can win a small board right now
const TEMPO_PER_IMPORTANCE = 4;

// Tables over (mine, theirs) pairs of disjoint masks, indexed by
// T3[mine] + 2 * T3[theirs] (a base-3 number, 3^9 = 19683 values).
const N3 = 19683;
const LOCAL = new Int16Array(N3); // my progress inside a small board
const WIN_CELLS = new Int16Array(N3); // cells where I would complete a line
const BIG_LINES = new Int16Array(N3); // my open lines on the big board
const IMPORTANCE = new Int8Array(N3 * 9); // per big square: how much winning it helps me
const SQUARE_VALUE = new Int16Array(512); // total static value of a set of won big squares

for (let m = 0; m < 512; m += 1) {
  let total = 0;
  for (let b = 0; b < 9; b += 1) {
    if (!((m >> b) & 1)) continue;
    let lines = 0;
    for (const lm of LINE_MASKS) if ((lm >> b) & 1) lines += 1;
    total += SQUARE_BASE + SQUARE_PER_LINE * lines;
  }
  SQUARE_VALUE[m] = total;
}
for (let mine = 0; mine < 512; mine += 1) {
  for (let theirs = 0; theirs < 512; theirs += 1) {
    if (mine & theirs) continue;
    const key = T3[mine] + 2 * T3[theirs];
    let local = 0;
    let winCells = 0;
    let big = 0;
    for (let b = 0; b < 9; b += 1) IMPORTANCE[key * 9 + b] = 1;
    for (const lm of LINE_MASKS) {
      if (theirs & lm) continue; // dead line
      const n = POP[mine & lm];
      if (n === 3) continue;
      if (n === 2) {
        local += SMALL_TWO;
        big += BIG_TWO;
        winCells |= lm & ~mine;
      } else if (n === 1) {
        local += SMALL_ONE;
        big += BIG_ONE;
      }
      for (let b = 0; b < 9; b += 1) {
        if ((lm >> b) & 1) IMPORTANCE[key * 9 + b] += LINE_IMPORTANCE[n];
      }
    }
    LOCAL[key] = local;
    WIN_CELLS[key] = winCells;
    BIG_LINES[key] = big;
  }
}

// Zobrist keys, from a fixed seed so every run hashes the same way.
function makeSeededInts(seed, count) {
  const out = new Int32Array(count);
  let a = seed >>> 0;
  for (let i = 0; i < count; i += 1) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (t ^ (t >>> 14)) | 0;
  }
  return out;
}
const Z1 = makeSeededInts(0x1234abcd, 18 * 512); // [player * 9 + board][mask]
const Z2 = makeSeededInts(0x0badf00d, 18 * 512);
const ZT1 = makeSeededInts(0x51ed270b, 10); // [target + 1]
const ZT2 = makeSeededInts(0x2545f491, 10);
const ZS1 = 0x3c6ef372 | 0; // side to move
const ZS2 = 0xa54ff53a | 0;

// ---------------------------------------------------------------------------
// The position (module-level and mutable; chooseMove is synchronous)
// ---------------------------------------------------------------------------

const MAX_DEPTH = 40;
const MAX_PLY = MAX_DEPTH + 2;
const STACK = 512; // make/unmake depth available to callers (search uses far less)

const masks = new Int32Array(18); // masks[player * 9 + board]; player 0 is X, 1 is O
const big = new Int32Array(2); // big squares won by each player
let tied = 0; // big squares closed by a tie (tie rule 'stay' only)
let closed = 0; // big[0] | big[1] | tied, kept up to date by make/unmake
let stayRule = false; // true: a tie closes the square; false: a tie wipes it
let side = 0; // player to move
let target = -1; // big square the last move pointed at, -1 before the first move
let winner = -1; // -1 none, 0 X, 1 O, 2 draw
let adjacentMode = false;
let hash1 = 0;
let hash2 = 0;

const undoBoard = new Int8Array(STACK);
const undoMine = new Int32Array(STACK);
const undoTheirs = new Int32Array(STACK);
const undoTarget = new Int8Array(STACK);
const undoHash1 = new Int32Array(STACK);
const undoHash2 = new Int32Array(STACK);
let sp = 0;

function load(state) {
  if (!state || !Array.isArray(state.cells) || !Array.isArray(state.boardWinners)) {
    throw new TypeError('ai: expected an engine state');
  }
  masks.fill(0);
  big[0] = 0;
  big[1] = 0;
  tied = 0;
  // A state from before the tie rule existed has neither field: it plays 'reset'.
  stayRule = state.tieRule === 'stay';
  const boardTied = Array.isArray(state.boardTied) ? state.boardTied : null;
  for (let b = 0; b < 9; b += 1) {
    const small = state.cells[b];
    for (let c = 0; c < 9; c += 1) {
      if (small[c] === 'X') masks[b] |= 1 << c;
      else if (small[c] === 'O') masks[9 + b] |= 1 << c;
    }
    if (state.boardWinners[b] === 'X') big[0] |= 1 << b;
    else if (state.boardWinners[b] === 'O') big[1] |= 1 << b;
    else if (boardTied !== null && boardTied[b]) tied |= 1 << b;
  }
  closed = big[0] | big[1] | tied;
  side = state.currentPlayer === 'O' ? 1 : 0;
  target = Number.isInteger(state.targetBoard) ? state.targetBoard : -1;
  if (state.winner === 'X') winner = 0;
  else if (state.winner === 'O') winner = 1;
  else if (state.winner === 'draw') winner = 2;
  else winner = -1;
  adjacentMode = state.mode === 'adjacent';
  sp = 0;
  hash1 = ZT1[target + 1] ^ (side ? ZS1 : 0);
  hash2 = ZT2[target + 1] ^ (side ? ZS2 : 0);
  for (let i = 0; i < 18; i += 1) {
    hash1 ^= Z1[i * 512 + masks[i]];
    hash2 ^= Z2[i * 512 + masks[i]];
  }
}

// Bit mask of the big squares the side to move may play in. 0 when the game is over.
function legalMask() {
  if (winner !== -1) return 0;
  const open = FULL & ~closed;
  if (target < 0) return open;
  if ((open >> target) & 1) return 1 << target;
  if (adjacentMode) {
    const touching = open & ADJ[target];
    if (touching !== 0) return touching;
  }
  return open;
}

// Plays (board, cell) for the side to move. The caller guarantees it is legal.
function make(board, cell) {
  const me = side;
  const i = me * 9 + board;
  const j = (1 - me) * 9 + board;
  const mine = masks[i];
  const theirs = masks[j];
  undoBoard[sp] = board;
  undoMine[sp] = mine;
  undoTheirs[sp] = theirs;
  undoTarget[sp] = target;
  undoHash1[sp] = hash1;
  undoHash2[sp] = hash2;
  sp += 1;

  let nextMine = mine | (1 << cell);
  let nextTheirs = theirs;
  if (HAS_LINE[nextMine]) {
    // Big square won. Only this can end the game.
    const mineBig = big[me] | (1 << board);
    big[me] = mineBig;
    closed |= 1 << board;
    if (HAS_LINE[mineBig]) winner = me;
    else if (closed === FULL) winner = 2;
  } else if ((nextMine | theirs) === FULL) {
    if (stayRule) {
      // Tie: the square keeps its marks and is closed. That can use up the
      // last open square, which is a draw.
      tied |= 1 << board;
      closed |= 1 << board;
      if (closed === FULL) winner = 2;
    } else {
      // Tie: the square is wiped and stays open.
      nextMine = 0;
      nextTheirs = 0;
    }
  }
  masks[i] = nextMine;
  masks[j] = nextTheirs;
  hash1 ^=
    Z1[i * 512 + mine] ^
    Z1[i * 512 + nextMine] ^
    Z1[j * 512 + theirs] ^
    Z1[j * 512 + nextTheirs] ^
    ZT1[target + 1] ^
    ZT1[cell + 1] ^
    ZS1;
  hash2 ^=
    Z2[i * 512 + mine] ^
    Z2[i * 512 + nextMine] ^
    Z2[j * 512 + theirs] ^
    Z2[j * 512 + nextTheirs] ^
    ZT2[target + 1] ^
    ZT2[cell + 1] ^
    ZS2;
  target = cell;
  side = 1 - me;
}

function unmake() {
  sp -= 1;
  side = 1 - side;
  const board = undoBoard[sp];
  masks[side * 9 + board] = undoMine[sp];
  masks[(1 - side) * 9 + board] = undoTheirs[sp];
  // The square was open before the move, so it was neither won nor tied.
  big[side] &= ~(1 << board);
  tied &= ~(1 << board);
  closed &= ~(1 << board);
  winner = -1; // moves are only ever made in a live game
  target = undoTarget[sp];
  hash1 = undoHash1[sp];
  hash2 = undoHash2[sp];
}

// ---------------------------------------------------------------------------
// Evaluation, from the side to move's point of view
// ---------------------------------------------------------------------------

function evaluate(ply) {
  const bx = big[0];
  const bo = big[1];
  const open = FULL & ~closed;
  // A tied square is lost to both players, so in each player's table key it
  // counts as the other side's: every big line through it is dead for both.
  // (Under 'stay', tying a square the opponent was building in, or letting
  // your own tie, shows up here by itself: the progress score inside it goes
  // and the lines through it die. Going further and writing off squares a
  // player can no longer win was tried and won nothing in 4400 games.)
  const kx = T3[bx] + 2 * T3[bo | tied];
  const ko = T3[bo] + 2 * T3[bx | tied];

  // Won big squares and live lines of them, X minus O. Tied squares count
  // for nothing.
  let score = SQUARE_VALUE[bx] - SQUARE_VALUE[bo] + BIG_LINES[kx] - BIG_LINES[ko];

  // Progress inside each open small board, weighted by how much that big
  // square matters to each player. Closed squares score nothing here.
  for (let b = 0; b < 9; b += 1) {
    if (!((open >> b) & 1)) continue;
    const tx = T3[masks[b]];
    const to = T3[masks[9 + b]];
    score += LOCAL[tx + 2 * to] * IMPORTANCE[kx * 9 + b] - LOCAL[to + 2 * tx] * IMPORTANCE[ko * 9 + b];
  }
  if (side === 1) score = -score;

  // What the side to move can do with the move it has.
  const me = side;
  const myKey = me === 0 ? kx : ko;
  const myBig = big[me];
  const legal = legalMask();
  let tempo = 0;
  for (let b = 0; b < 9; b += 1) {
    if (!((legal >> b) & 1)) continue;
    const key = T3[masks[me * 9 + b]] + 2 * T3[masks[(1 - me) * 9 + b]];
    if (WIN_CELLS[key] === 0) continue;
    // A small board can be won at once. If that also completes a big line the
    // game is won on the next ply.
    if (HAS_LINE[myBig | (1 << b)]) return WIN - (ply + 1);
    const value = TEMPO_BASE + TEMPO_PER_IMPORTANCE * IMPORTANCE[myKey * 9 + b];
    if (value > tempo) tempo = value;
  }
  score += tempo;
  // Being handed a free move (the target square is already closed) is worth
  // something by itself; equivalently, handing one over is penalised.
  if (target >= 0 && !((open >> target) & 1)) {
    score += legal === open ? FREE_MOVE : FREE_MOVE_ADJACENT;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Move generation and ordering
// ---------------------------------------------------------------------------

const moveBuf = new Int32Array(MAX_PLY * 81);
const killer1 = new Int8Array(MAX_PLY);
const killer2 = new Int8Array(MAX_PLY);

const ORDER_OFFSET = 8192;
const ORDER_TT = 1 << 20;
const ORDER_GAME_WIN = 1 << 18;
const ORDER_BOARD_WIN = 1000;
const ORDER_KILLER = 250;
const ORDER_BLOCK = 60;
const ORDER_GIVES_FREE_MOVE = -500;
const ORDER_GIVES_BOARD = -150;
const ORDER_GIVES_GAME = -5000;

// Rough guess at how good a move is, used only to sort moves.
function orderScore(move, ttMove, ply) {
  const me = side;
  const opp = 1 - me;
  const board = MOVE_BOARD[move];
  const cell = MOVE_CELL[move];
  const mine = masks[me * 9 + board];
  const theirs = masks[opp * 9 + board];
  const key = T3[mine] + 2 * T3[theirs];
  let closedAfter = closed;
  let s = 0;
  let winsBoard = false;
  if ((WIN_CELLS[key] >> cell) & 1) {
    winsBoard = true;
    s += ORDER_BOARD_WIN;
    if (HAS_LINE[big[me] | (1 << board)]) return ORDER_GAME_WIN + (move === ttMove ? ORDER_TT : 0);
    closedAfter |= 1 << board;
  } else {
    if ((WIN_CELLS[T3[theirs] + 2 * T3[mine]] >> cell) & 1) s += ORDER_BLOCK;
    s += LOCAL[key + T3[1 << cell]] - LOCAL[key];
    // Under 'stay' the move that fills the square closes it.
    if (stayRule && (mine | theirs | (1 << cell)) === FULL) closedAfter |= 1 << board;
  }
  // Where the opponent is sent.
  if ((closedAfter >> cell) & 1) {
    s += ORDER_GIVES_FREE_MOVE;
  } else {
    let destTheirs = masks[opp * 9 + cell];
    let destMine = masks[me * 9 + cell];
    if (cell === board && !winsBoard) destMine |= 1 << cell;
    if ((destMine | destTheirs) !== FULL && WIN_CELLS[T3[destTheirs] + 2 * T3[destMine]] !== 0) {
      s += HAS_LINE[big[opp] | (1 << cell)] ? ORDER_GIVES_GAME : ORDER_GIVES_BOARD;
    }
  }
  if (move === ttMove) s += ORDER_TT;
  else if (move === killer1[ply] || move === killer2[ply]) s += ORDER_KILLER;
  return s;
}

// Writes the legal moves in `legal` into moveBuf at this ply, best guess first.
// Each entry is (orderScore + offset) * 128 + move. Returns the count.
function generateOrdered(ply, legal, ttMove) {
  const base = ply * 81;
  let n = 0;
  for (let b = 0; b < 9; b += 1) {
    if (!((legal >> b) & 1)) continue;
    const empty = FULL & ~(masks[b] | masks[9 + b]);
    for (let c = 0; c < 9; c += 1) {
      if (!((empty >> c) & 1)) continue;
      const move = b * 9 + c;
      const entry = (orderScore(move, ttMove, ply) + ORDER_OFFSET) * 128 + move;
      // Insertion sort, descending.
      let k = base + n;
      while (k > base && moveBuf[k - 1] < entry) {
        moveBuf[k] = moveBuf[k - 1];
        k -= 1;
      }
      moveBuf[k] = entry;
      n += 1;
    }
  }
  return n;
}

// Plain list of legal moves in board, cell order.
function listMoves(legal) {
  const out = [];
  for (let b = 0; b < 9; b += 1) {
    if (!((legal >> b) & 1)) continue;
    const empty = FULL & ~(masks[b] | masks[9 + b]);
    for (let c = 0; c < 9; c += 1) {
      if ((empty >> c) & 1) out.push(b * 9 + c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;
let ttKey = null; // second hash, to tell positions sharing a slot apart
let ttScore = null;
let ttInfo = null; // depth << 9 | flag << 7 | move; 0 means empty

const CLOCK_EVERY = 512; // nodes between clock checks (a power of two)
const UNTIMED_DEPTH = 2; // depths searched in full even with no time at all

const now =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

let nodes = 0;
let timed = false;
let deadline = 0;
let aborted = false;

const lastSearch = { level: null, depth: 0, nodes: 0, score: 0, ms: 0, timedOut: false };

// Negamax alpha-beta, fail-soft. Returns the score for the side to move.
function search(depth, alpha, beta, ply) {
  nodes += 1;
  if (timed && (nodes & (CLOCK_EVERY - 1)) === 0 && now() >= deadline) aborted = true;
  if (aborted) return 0;
  if (depth <= 0) return evaluate(ply);

  const alphaStart = alpha;
  const slot = hash1 & TT_MASK;
  const info = ttInfo[slot];
  let ttMove = -1;
  if (info !== 0 && ttKey[slot] === hash2) {
    ttMove = info & 127;
    if (info >> 9 >= depth) {
      let s = ttScore[slot];
      if (s > WIN_ZONE) s -= ply;
      else if (s < -WIN_ZONE) s += ply;
      const flag = (info >> 7) & 3;
      if (flag === TT_EXACT) return s;
      if (flag === TT_LOWER) {
        if (s >= beta) return s;
        if (s > alpha) alpha = s;
      } else {
        if (s <= alpha) return s;
        if (s < beta) beta = s;
      }
    }
  }

  const base = ply * 81;
  const n = generateOrdered(ply, legalMask(), ttMove);
  if (n === 0) return evaluate(ply); // cannot happen in a position the engine produced
  let best = -INF;
  let bestMove = -1;
  for (let i = 0; i < n; i += 1) {
    const move = moveBuf[base + i] & 127;
    make(MOVE_BOARD[move], MOVE_CELL[move]);
    let s;
    if (winner !== -1) s = winner === 2 ? 0 : WIN - (ply + 1);
    else s = -search(depth - 1, -beta, -alpha, ply + 1);
    unmake();
    if (aborted) return 0;
    if (s > best) {
      best = s;
      bestMove = move;
      if (s > alpha) {
        alpha = s;
        if (alpha >= beta) {
          if (killer1[ply] !== move) {
            killer2[ply] = killer1[ply];
            killer1[ply] = move;
          }
          break;
        }
      }
    }
  }

  let stored = best;
  if (stored > WIN_ZONE) stored += ply;
  else if (stored < -WIN_ZONE) stored -= ply;
  const flag = best <= alphaStart ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
  ttKey[slot] = hash2;
  ttScore[slot] = stored;
  ttInfo[slot] = (depth << 9) | (flag << 7) | bestMove;
  return best;
}

function pick(list, rng) {
  if (list.length === 1) return list[0];
  const r = Number(rng());
  const i = Number.isFinite(r) ? Math.floor(r * list.length) : 0;
  return list[Math.min(list.length - 1, Math.max(0, i))];
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const r = Number(rng());
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

// Iterative deepening from the loaded position.
//   margin < 0  : ordinary alpha-beta at the root; the first best move wins ties
//                 (the root order is shuffled by rng first).
//   margin >= 0 : every root move within `margin` of the best gets an exact
//                 score and rng picks among them.
function think(rootLegal, { maxDepth, timeLimitMs, margin, rng, level }) {
  const start = now();
  deadline = start + timeLimitMs;
  aborted = false;
  nodes = 0;
  if (ttInfo === null) {
    ttKey = new Int32Array(TT_SIZE);
    ttScore = new Int32Array(TT_SIZE);
    ttInfo = new Int32Array(TT_SIZE);
  } else {
    ttInfo.fill(0);
  }
  killer1.fill(-1);
  killer2.fill(-1);

  // Root moves: shuffled, then sorted by the ordering guess (the sort is
  // stable, so equal guesses stay in shuffled order).
  let rootMoves = shuffle(listMoves(rootLegal), rng).map((move) => ({
    move,
    order: orderScore(move, -1, 0),
    score: 0,
  }));
  rootMoves.sort((a, b) => b.order - a.order);
  const count = rootMoves.length;

  let candidates = [rootMoves[0].move];
  let doneDepth = 0;
  let doneScore = 0;
  const window = margin >= 0 ? margin + 1 : 0;

  // Under 'stay' every move fills a cell of an open square for good, so the
  // game cannot last longer than the empty cells left in open squares.
  // Searching that deep reaches the end of every line; deeper adds nothing.
  let deepest = maxDepth;
  if (stayRule) {
    let cellsLeft = 0;
    for (let b = 0; b < 9; b += 1) {
      if (!((closed >> b) & 1)) cellsLeft += 9 - POP[masks[b] | masks[9 + b]];
    }
    if (cellsLeft < deepest) deepest = cellsLeft;
  }

  if (count > 1) {
    for (let depth = 1; depth <= deepest; depth += 1) {
      // The first depths always run to the end, whatever the clock says, so
      // there is always a searched move that has looked at the reply. They
      // cost well under a millisecond.
      timed = depth > UNTIMED_DEPTH;
      let best = -INF;
      const exact = [];
      for (let i = 0; i < count; i += 1) {
        const entry = rootMoves[i];
        const alpha = best === -INF ? -INF : best - window;
        make(MOVE_BOARD[entry.move], MOVE_CELL[entry.move]);
        let s;
        if (winner !== -1) s = winner === 2 ? 0 : WIN - 1;
        else s = -search(depth - 1, -INF, -alpha, 1);
        unmake();
        if (aborted) break;
        entry.score = s;
        exact[i] = s > alpha;
        if (s > best) best = s;
      }
      if (aborted) break; // keep the result of the last completed depth

      const decided = best > WIN_ZONE || best < -WIN_ZONE;
      const slack = margin >= 0 && !decided ? margin : 0;
      candidates = [];
      for (let i = 0; i < count; i += 1) {
        if (exact[i] && rootMoves[i].score >= best - slack) candidates.push(rootMoves[i].move);
      }
      doneDepth = depth;
      doneScore = best;
      if (decided) break; // a forced win or loss does not change with depth
      // Best first for the next depth.
      rootMoves = rootMoves.slice().sort((a, b) => b.score - a.score);
      // Not enough time left to finish another depth: stop here.
      if (depth >= UNTIMED_DEPTH && now() - start >= timeLimitMs * 0.5) break;
    }
  }

  lastSearch.level = level;
  lastSearch.depth = doneDepth;
  lastSearch.nodes = nodes;
  lastSearch.score = doneScore;
  lastSearch.ms = now() - start;
  lastSearch.timedOut = aborted;
  aborted = false;
  timed = false;
  return pick(candidates, rng);
}

// Easy: win the game if it can, otherwise random with a mild lean towards
// moves that win a small board.
const EASY_BOARD_WIN_WEIGHT = 3;

function chooseEasy(rootLegal, rng) {
  const moves = listMoves(rootLegal);
  const me = side;
  const gameWins = [];
  const weights = [];
  let total = 0;
  for (const move of moves) {
    const board = MOVE_BOARD[move];
    const cell = MOVE_CELL[move];
    const key = T3[masks[me * 9 + board]] + 2 * T3[masks[(1 - me) * 9 + board]];
    const winsBoard = ((WIN_CELLS[key] >> cell) & 1) === 1;
    if (winsBoard && HAS_LINE[big[me] | (1 << board)]) gameWins.push(move);
    const weight = winsBoard ? EASY_BOARD_WIN_WEIGHT : 1;
    weights.push(weight);
    total += weight;
  }
  if (gameWins.length > 0) return pick(gameWins, rng);
  const r = Number(rng());
  let x = (Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.9999999) : 0) * total;
  for (let i = 0; i < moves.length; i += 1) {
    x -= weights[i];
    if (x < 0) return moves[i];
  }
  return moves[moves.length - 1];
}

const DEFAULT_TIME_MS = { easy: 0, medium: 150, hard: 600 };
const MEDIUM_DEPTH = 3;
const MEDIUM_MARGIN = 8;

// Returns a legal move { board, cell } (0-indexed) for state.currentPlayer.
// Synchronous. Never mutates `state`. Throws if the game is over.
export function chooseMove(state, { level = 'medium', timeLimitMs, rng = Math.random } = {}) {
  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown level: ${String(level)}`);
  }
  load(state);
  if (winner !== -1) {
    throw new Error('chooseMove: the game is over');
  }

  // The engine's isLegalMove goes by state.legalBoards, so the root does too.
  // (Inside the search the rules are worked out here.)
  let rootLegal = legalMask();
  if (Array.isArray(state.legalBoards)) {
    const open = FULL & ~closed;
    let listed = 0;
    for (const b of state.legalBoards) {
      if (Number.isInteger(b) && b >= 0 && b < 9) listed |= 1 << b;
    }
    listed &= open;
    if (listed !== 0) rootLegal = listed;
  }
  if (rootLegal === 0) {
    throw new Error('chooseMove: no legal move in this position');
  }

  const limit =
    typeof timeLimitMs === 'number' && Number.isFinite(timeLimitMs) && timeLimitMs >= 0
      ? timeLimitMs
      : DEFAULT_TIME_MS[level];

  let move;
  if (level === 'easy') {
    move = chooseEasy(rootLegal, rng);
  } else if (level === 'medium') {
    move = think(rootLegal, { maxDepth: MEDIUM_DEPTH, timeLimitMs: limit, margin: MEDIUM_MARGIN, rng, level });
  } else {
    move = think(rootLegal, { maxDepth: MAX_DEPTH, timeLimitMs: limit, margin: -1, rng, level });
  }
  return { board: MOVE_BOARD[move], cell: MOVE_CELL[move] };
}

// ---------------------------------------------------------------------------
// For tests only. The UI must not use these.
// ---------------------------------------------------------------------------

const NAMES = ['X', 'O'];

function maskToList(mask) {
  const out = [];
  for (let b = 0; b < 9; b += 1) if ((mask >> b) & 1) out.push(b);
  return out;
}

export const _internals = {
  LINES,
  // Touching big squares, ascending.
  neighbors: (board) => maskToList(ADJ[board]),
  // Copies an engine state into the internal position.
  load,
  // Legal moves of the internal position as [{ board, cell }].
  legalMoves: () => listMoves(legalMask()).map((m) => ({ board: MOVE_BOARD[m], cell: MOVE_CELL[m] })),
  make,
  unmake,
  // Static score of the internal position for the side to move.
  evaluate: () => evaluate(0),
  // The internal position in the engine's vocabulary.
  snapshot() {
    const cells = [];
    const boardWinners = [];
    const boardTied = [];
    for (let b = 0; b < 9; b += 1) {
      const small = [];
      for (let c = 0; c < 9; c += 1) {
        small.push((masks[b] >> c) & 1 ? 'X' : (masks[9 + b] >> c) & 1 ? 'O' : null);
      }
      cells.push(small);
      boardWinners.push((big[0] >> b) & 1 ? 'X' : (big[1] >> b) & 1 ? 'O' : null);
      boardTied.push(((tied >> b) & 1) === 1);
    }
    return {
      tieRule: stayRule ? 'stay' : 'reset',
      cells,
      boardWinners,
      boardTied,
      currentPlayer: NAMES[side],
      targetBoard: target < 0 ? null : target,
      legalBoards: maskToList(legalMask()),
      winner: winner === -1 ? null : winner === 2 ? 'draw' : NAMES[winner],
      hash: [hash1, hash2],
    };
  },
  // Figures from the most recent medium/hard search: { level, depth, nodes, score, ms, timedOut }.
  lastSearch,
};
