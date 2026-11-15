// Tests for the computer opponent (js/ai.js).
// Run from the project root: node --test tests/ai.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../js/engine.js';
import { LEVELS, chooseMove, _internals as ai } from '../js/ai.js';

const MODES = ['anywhere', 'adjacent'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Small seeded generator (mulberry32) so every run sees the same games.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function engineMoves(state) {
  const moves = [];
  for (let board = 0; board < 9; board += 1) {
    for (let cell = 0; cell < 9; cell += 1) {
      if (engine.isLegalMove(state, board, cell)) moves.push({ board, cell });
    }
  }
  return moves;
}

const key = (move) => move.board * 9 + move.cell;
const sortedKeys = (moves) => moves.map(key).sort((a, b) => a - b);

function randomMove(state, rng) {
  const moves = engineMoves(state);
  return moves[Math.floor(rng() * moves.length)];
}

// A position reached by `plies` random moves (or fewer if the game ended; then
// it backs up to the last live position).
function randomPosition(mode, plies, rng) {
  let state = engine.createGame({ mode });
  for (let i = 0; i < plies; i += 1) {
    const move = randomMove(state, rng);
    const next = engine.applyMove(state, move.board, move.cell);
    if (next.winner !== null) break;
    state = next;
  }
  return state;
}

// Moves for the side to move that end the game in its favour.
function winningMoves(state) {
  const player = state.currentPlayer;
  return engineMoves(state).filter(
    (move) => engine.applyMove(state, move.board, move.cell).winner === player,
  );
}

// Walks random games and collects live positions that satisfy `wanted`.
function collectPositions(wanted, howMany, seed) {
  const found = [];
  const rng = seeded(seed);
  for (let game = 0; game < 4000 && found.length < howMany; game += 1) {
    let state = engine.createGame({ mode: MODES[game % 2] });
    let takenFromThisGame = 0;
    for (let ply = 0; ply < 400 && state.winner === null; ply += 1) {
      if (takenFromThisGame < 2 && found.length < howMany && wanted(state)) {
        found.push(state);
        takenFromThisGame += 1;
      }
      const move = randomMove(state, rng);
      state = engine.applyMove(state, move.board, move.cell);
    }
  }
  return found;
}

function pickFields(state) {
  return {
    cells: state.cells,
    boardWinners: state.boardWinners,
    currentPlayer: state.currentPlayer,
    targetBoard: state.targetBoard,
    legalBoards: state.legalBoards,
    winner: state.winner,
  };
}

function snapshotFields() {
  const snap = ai.snapshot();
  delete snap.hash;
  return snap;
}

// Plays one engine-driven game between two choosers. Returns 'X', 'O' or 'draw'.
function playGame(mode, chooseX, chooseO, maxPlies = 400) {
  let state = engine.createGame({ mode });
  for (let ply = 0; ply < maxPlies && state.winner === null; ply += 1) {
    const choose = state.currentPlayer === 'X' ? chooseX : chooseO;
    const move = choose(state);
    assert.ok(engine.isLegalMove(state, move.board, move.cell), 'ladder move must be legal');
    state = engine.applyMove(state, move.board, move.cell);
  }
  return state.winner === 'X' || state.winner === 'O' ? state.winner : 'draw';
}

// `games` games of `level` against `opponent`, alternating sides and modes.
function ladder(level, opponent, games, timeLimitMs, seed) {
  const tally = { wins: 0, draws: 0, losses: 0 };
  for (let game = 0; game < games; game += 1) {
    const strongIsX = game % 2 === 0;
    const mode = MODES[(game >> 1) % 2];
    const strongRng = seeded(seed + game * 2);
    const weakRng = seeded(seed + game * 2 + 1);
    const strong = (state) => chooseMove(state, { level, timeLimitMs, rng: strongRng });
    const weak = (state) => chooseMove(state, { level: opponent, rng: weakRng });
    const result = strongIsX ? playGame(mode, strong, weak) : playGame(mode, weak, strong);
    if (result === 'draw') tally.draws += 1;
    else if ((result === 'X') === strongIsX) tally.wins += 1;
    else tally.losses += 1;
  }
  return tally;
}

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

test('LEVELS is exactly easy, medium, hard', () => {
  assert.deepEqual(LEVELS, ['easy', 'medium', 'hard']);
});

test('the internal line and neighbour tables match the engine', () => {
  assert.deepEqual(ai.LINES, engine.LINES.map((line) => [...line]));
  for (let board = 0; board < 9; board += 1) {
    assert.deepEqual(ai.neighbors(board), engine.neighbors(board));
  }
});

test('chooseMove defaults to a legal medium move and rejects unknown levels', () => {
  const state = engine.createGame();
  const move = chooseMove(state);
  assert.ok(engine.isLegalMove(state, move.board, move.cell));
  assert.deepEqual(Object.keys(move).sort(), ['board', 'cell']);
  assert.throws(() => chooseMove(state, { level: 'impossible' }), /Unknown level/);
});

// ---------------------------------------------------------------------------
// The rules inside ai.js agree with the engine
// ---------------------------------------------------------------------------

test('internal move generation and move effects match the engine over random games', () => {
  const seen = {
    positions: 0,
    boardWins: 0,
    tieWipes: 0,
    forced: 0,
    free: 0,
    adjacent: 0,
    adjacentFallback: 0,
    gameWins: 0,
    gameDraws: 0,
    capped: 0,
  };
  const GAMES_PER_MODE = 250;
  for (const mode of MODES) {
    for (let game = 0; game < GAMES_PER_MODE; game += 1) {
      const rng = seeded(1000 + game + (mode === 'adjacent' ? 50000 : 0));
      let state = engine.createGame({ mode });
      let ply = 0;
      for (; ply < 600 && state.winner === null; ply += 1) {
        seen.positions += 1;
        if (state.constraint === 'forced') seen.forced += 1;
        if (state.constraint === 'free' && mode === 'anywhere') seen.free += 1;
        if (state.constraint === 'adjacent') seen.adjacent += 1;
        if (state.constraint === 'free' && mode === 'adjacent') seen.adjacentFallback += 1;

        // Same position, same legal moves.
        ai.load(state);
        const before = ai.snapshot();
        assert.deepEqual(snapshotFields(), pickFields(state), 'load must reproduce the engine state');
        const legal = engineMoves(state);
        assert.deepEqual(sortedKeys(ai.legalMoves()), sortedKeys(legal), 'legal move sets differ');
        assert.ok(legal.length > 0, 'a live game always has a move');

        // On a free-move position the other mode must agree too.
        if (state.constraint === 'free' || state.constraint === 'adjacent') {
          const other = engine.setMode(state, mode === 'anywhere' ? 'adjacent' : 'anywhere');
          ai.load(other);
          assert.deepEqual(sortedKeys(ai.legalMoves()), sortedKeys(engineMoves(other)));
          ai.load(state);
        }

        // Same move, same result.
        const move = legal[Math.floor(rng() * legal.length)];
        const next = engine.applyMove(state, move.board, move.cell);
        ai.make(move.board, move.cell);
        assert.deepEqual(
          snapshotFields(),
          pickFields(next),
          `position after ${engine.notation(move.board, move.cell)} differs (mode ${mode}, game ${game}, ply ${ply})`,
        );
        const afterMake = ai.snapshot();

        // The incremental hash equals a hash computed from scratch.
        ai.load(next);
        assert.deepEqual(ai.snapshot().hash, afterMake.hash, 'incremental hash drifted');

        // Unmake restores everything.
        ai.load(state);
        ai.make(move.board, move.cell);
        ai.unmake();
        assert.deepEqual(ai.snapshot(), before, 'unmake did not restore the position');

        const last = next.history[next.history.length - 1];
        if (last.wonBoard) seen.boardWins += 1;
        if (last.tiedBoard) seen.tieWipes += 1;
        state = next;
      }
      if (state.winner === 'draw') seen.gameDraws += 1;
      else if (state.winner !== null) seen.gameWins += 1;
      else seen.capped += 1;
    }
  }

  // The random games must actually have exercised every rule being compared.
  assert.ok(seen.boardWins > 500, `too few small-board wins: ${seen.boardWins}`);
  assert.ok(seen.tieWipes > 50, `too few tie wipes: ${seen.tieWipes}`);
  assert.ok(seen.forced > 5000, `too few forced positions: ${seen.forced}`);
  assert.ok(seen.free > 200, `too few free-move positions: ${seen.free}`);
  assert.ok(seen.adjacent > 200, `too few adjacent positions: ${seen.adjacent}`);
  assert.ok(seen.adjacentFallback > 0, 'the adjacent fallback never came up');
  assert.ok(seen.gameWins > 100, `too few finished games: ${seen.gameWins}`);
  assert.ok(seen.gameDraws > 0, 'no drawn game came up');
  console.log(`  cross-check coverage: ${JSON.stringify(seen)}`);
});

test('multi-move make/unmake sequences unwind exactly', () => {
  const rng = seeded(77);
  for (const mode of MODES) {
    for (let round = 0; round < 40; round += 1) {
      const state = randomPosition(mode, Math.floor(rng() * 70), rng);
      ai.load(state);
      const start = ai.snapshot();
      let made = 0;
      for (; made < 30; made += 1) {
        const moves = ai.legalMoves();
        if (moves.length === 0) break;
        const move = moves[Math.floor(rng() * moves.length)];
        ai.make(move.board, move.cell);
      }
      for (; made > 0; made -= 1) ai.unmake();
      assert.deepEqual(ai.snapshot(), start);
    }
  }
});

// ---------------------------------------------------------------------------
// Legality and purity
// ---------------------------------------------------------------------------

for (const level of LEVELS) {
  test(`${level}: returns a legal move and leaves the state alone, both modes`, () => {
    const rng = seeded(4242 + LEVELS.indexOf(level));
    const POSITIONS = level === 'hard' ? 40 : 100;
    for (const mode of MODES) {
      for (let i = 0; i < POSITIONS; i += 1) {
        const state = randomPosition(mode, Math.floor(rng() * 90), rng);
        const copy = clone(state);
        const move = chooseMove(state, { level, timeLimitMs: 15, rng });
        assert.ok(Number.isInteger(move.board) && Number.isInteger(move.cell));
        assert.ok(
          engine.isLegalMove(state, move.board, move.cell),
          `${level} chose illegal ${move.board},${move.cell} in mode ${mode}`,
        );
        assert.deepEqual(state, copy, 'chooseMove mutated the state it was given');
      }
    }
  });
}

test('every level works on a state rebuilt from JSON and after setMode', () => {
  const rng = seeded(31337);
  for (let i = 0; i < 30; i += 1) {
    const mode = MODES[i % 2];
    let state = randomPosition(mode, 30 + Math.floor(rng() * 50), rng);
    state = clone(engine.setMode(state, MODES[(i + 1) % 2]));
    for (const level of LEVELS) {
      const move = chooseMove(state, { level, timeLimitMs: 10, rng });
      assert.ok(engine.isLegalMove(state, move.board, move.cell));
    }
  }
});

test('every level throws on a finished game', () => {
  const rng = seeded(9);
  for (const mode of MODES) {
    let state = engine.createGame({ mode });
    while (state.winner === null) {
      const move = randomMove(state, rng);
      state = engine.applyMove(state, move.board, move.cell);
    }
    for (const level of LEVELS) {
      assert.throws(() => chooseMove(state, { level }), /over/);
    }
  }
});

test('hard still answers with a time limit of zero (depth 1 always completes)', () => {
  const rng = seeded(5);
  for (let i = 0; i < 20; i += 1) {
    const state = randomPosition(MODES[i % 2], Math.floor(rng() * 80), rng);
    const move = chooseMove(state, { level: 'hard', timeLimitMs: 0, rng });
    assert.ok(engine.isLegalMove(state, move.board, move.cell));
    if (engineMoves(state).length > 1) assert.equal(ai.lastSearch.depth, 1);
  }
});

// ---------------------------------------------------------------------------
// Tactics
// ---------------------------------------------------------------------------

test('every level takes a game-winning move when there is one', () => {
  const positions = collectPositions((state) => winningMoves(state).length > 0, 40, 2024);
  assert.equal(positions.length, 40);
  const rng = seeded(11);
  for (const state of positions) {
    for (const level of LEVELS) {
      const move = chooseMove(state, { level, timeLimitMs: 30, rng });
      const next = engine.applyMove(state, move.board, move.cell);
      assert.equal(
        next.winner,
        state.currentPlayer,
        `${level} missed a game win (chose ${engine.notation(move.board, move.cell)})`,
      );
    }
  }
});

test('medium and hard block an immediate game win when a block exists', () => {
  // The side to move cannot win now, at least one of its moves lets the
  // opponent win at once, and at least one does not.
  const analyse = (state) => {
    if (winningMoves(state).length > 0) return null;
    const safe = [];
    const losing = [];
    for (const move of engineMoves(state)) {
      const next = engine.applyMove(state, move.board, move.cell);
      if (next.winner !== null) continue;
      (winningMoves(next).length > 0 ? losing : safe).push(key(move));
    }
    return safe.length > 0 && losing.length > 0 ? { safe, losing } : null;
  };
  const positions = collectPositions((state) => analyse(state) !== null, 40, 606);
  assert.equal(positions.length, 40);
  const rng = seeded(12);
  for (const state of positions) {
    const { safe } = analyse(state);
    for (const level of ['medium', 'hard']) {
      const move = chooseMove(state, { level, timeLimitMs: 40, rng });
      assert.ok(
        safe.includes(key(move)),
        `${level} let the opponent win at once with ${engine.notation(move.board, move.cell)}`,
      );
    }
  }
});

test('medium and hard take a small-board win that costs nothing', () => {
  // X keeps sending O back to big square 1 by playing the first cell of other
  // squares. O ends up holding 1-4, 1-5, 1-7 and 1-9 there, to move, with
  // three ways to win the square (1-3, 1-6, 1-8), each sending X to an empty
  // big square.
  let state = engine.createGame();
  for (const [board, cell] of [
    [0, 0], // X 1-1 -> O to 1
    [0, 4], // O 1-5 -> X to 5
    [4, 0], // X 5-1 -> O to 1
    [0, 8], // O 1-9 -> X to 9
    [8, 0], // X 9-1 -> O to 1
    [0, 3], // O 1-4 -> X to 4
    [3, 0], // X 4-1 -> O to 1
    [0, 6], // O 1-7 -> X to 7
    [6, 0], // X 7-1 -> O to 1
  ]) {
    state = engine.applyMove(state, board, cell);
  }
  assert.equal(state.currentPlayer, 'O');
  assert.deepEqual(state.legalBoards, [0]);
  assert.deepEqual(state.cells[0], ['X', null, null, 'O', 'O', null, 'O', null, 'O']);
  for (const level of ['medium', 'hard']) {
    const move = chooseMove(state, { level, timeLimitMs: 60, rng: seeded(3) });
    const next = engine.applyMove(state, move.board, move.cell);
    assert.equal(next.boardWinners[0], 'O', `${level} did not win the small board`);
  }
});

// ---------------------------------------------------------------------------
// Time budget
// ---------------------------------------------------------------------------

test('hard with timeLimitMs 200 returns within about 300ms', () => {
  const rng = seeded(808);
  const opening = engine.createGame();
  // Busy mid-game positions come from medium playing itself, so they are
  // balanced and the search has real work to do (random play leaves positions
  // that are won on the spot). Per mode: one after 24 plies, and the first
  // later one where the mover has a free move.
  const busy = [];
  for (const mode of MODES) {
    let state = engine.createGame({ mode });
    let wantFree = true;
    for (let ply = 0; ply < 80 && state.winner === null; ply += 1) {
      if (ply === 24) busy.push(state);
      if (ply > 24 && wantFree && state.legalBoards.length > 1) {
        busy.push(state);
        wantFree = false;
      }
      const move = chooseMove(state, { level: 'medium', timeLimitMs: 1000, rng });
      state = engine.applyMove(state, move.board, move.cell);
    }
  }
  assert.ok(busy.length >= 2);
  // Warm up the JIT so the measurement is of the search, not of compilation.
  chooseMove(opening, { level: 'hard', timeLimitMs: 100, rng });

  const cases = [
    ['opening', opening],
    ...busy.map((state, i) => [`mid-game ${i + 1} (${state.mode}, ${state.constraint}, ply ${state.history.length})`, state]),
  ];
  let usedTheBudget = 0;
  for (const [name, state] of cases) {
    const started = performance.now();
    const move = chooseMove(state, { level: 'hard', timeLimitMs: 200, rng });
    const elapsed = performance.now() - started;
    assert.ok(engine.isLegalMove(state, move.board, move.cell));
    assert.ok(elapsed < 300, `${name}: took ${elapsed.toFixed(1)}ms`);
    if (elapsed >= 100) usedTheBudget += 1;
    console.log(
      `  hard 200ms, ${name}: ${elapsed.toFixed(0)}ms, depth ${ai.lastSearch.depth}, ${ai.lastSearch.nodes} nodes`,
    );
  }
  // The limit is only tested if the search was still running when it hit.
  assert.ok(usedTheBudget >= 3, `only ${usedTheBudget} positions kept the search busy for 100ms`);
});

test('the root follows state.legalBoards, which is what isLegalMove checks', () => {
  // A forced position edited by hand so legalBoards names a different open
  // square than the target. The engine would accept moves only there.
  let state = engine.createGame();
  state = engine.applyMove(state, 4, 0); // O is sent to big square 1
  const edited = clone(state);
  edited.legalBoards = [7];
  for (const level of LEVELS) {
    const move = chooseMove(edited, { level, timeLimitMs: 10, rng: seeded(1) });
    assert.equal(move.board, 7);
    assert.ok(engine.isLegalMove(edited, move.board, move.cell));
  }
});

test('hard with its default 600ms budget returns within 650ms from the opening', () => {
  const state = engine.createGame({ mode: 'adjacent' });
  const started = performance.now();
  const move = chooseMove(state, { level: 'hard', rng: seeded(6) });
  const elapsed = performance.now() - started;
  assert.ok(engine.isLegalMove(state, move.board, move.cell));
  assert.ok(elapsed >= 300, `stopped early after ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 650, `took ${elapsed.toFixed(1)}ms`);
  assert.ok(ai.lastSearch.depth >= 5, `only reached depth ${ai.lastSearch.depth}`);
  console.log(
    `  hard 600ms, opening: ${elapsed.toFixed(0)}ms, depth ${ai.lastSearch.depth}, ${ai.lastSearch.nodes} nodes, cut short: ${ai.lastSearch.timedOut}`,
  );
});

test('medium stays inside its default 150ms budget', () => {
  const rng = seeded(909);
  for (let i = 0; i < 10; i += 1) {
    const state = randomPosition(MODES[i % 2], 10 + i * 6, rng);
    const started = performance.now();
    chooseMove(state, { level: 'medium', rng });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `medium took ${elapsed.toFixed(1)}ms`);
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('easy is deterministic with a seeded rng, and varies with the seed', () => {
  const positions = [];
  const rng = seeded(1);
  for (let i = 0; i < 60; i += 1) positions.push(randomPosition(MODES[i % 2], Math.floor(rng() * 60), rng));

  const run = (seed) => {
    const r = seeded(seed);
    return positions.map((state) => key(chooseMove(state, { level: 'easy', rng: r })));
  };
  assert.deepEqual(run(123), run(123));
  assert.notDeepEqual(run(123), run(124));
});

test('medium and hard are deterministic with a seeded rng when the clock does not cut in', () => {
  const positions = [];
  const rng = seeded(2);
  for (let i = 0; i < 12; i += 1) positions.push(randomPosition(MODES[i % 2], 5 + Math.floor(rng() * 50), rng));

  // Medium is capped by depth, so a generous clock never interrupts it.
  const medium = (seed) => {
    const r = seeded(seed);
    return positions.map((state) => key(chooseMove(state, { level: 'medium', timeLimitMs: 10000, rng: r })));
  };
  assert.deepEqual(medium(55), medium(55));

  // Hard with a zero budget is a complete depth-1 search.
  const hard = (seed) => {
    const r = seeded(seed);
    return positions.map((state) => key(chooseMove(state, { level: 'hard', timeLimitMs: 0, rng: r })));
  };
  assert.deepEqual(hard(55), hard(55));
});

test('easy does not always win a small board when it could', () => {
  // "Mild preference, not a guarantee": over many seeds easy sometimes passes
  // up a small-board win and sometimes takes it.
  const positions = collectPositions((state) => {
    if (winningMoves(state).length > 0) return false;
    const moves = engineMoves(state);
    const wins = moves.filter((m) => engine.applyMove(state, m.board, m.cell).history.at(-1).wonBoard);
    return wins.length > 0 && wins.length < moves.length;
  }, 20, 404);
  assert.equal(positions.length, 20);
  let took = 0;
  let passed = 0;
  const rng = seeded(8);
  for (const state of positions) {
    for (let i = 0; i < 20; i += 1) {
      const move = chooseMove(state, { level: 'easy', rng });
      if (engine.applyMove(state, move.board, move.cell).history.at(-1).wonBoard) took += 1;
      else passed += 1;
    }
  }
  assert.ok(took > 0 && passed > 0, `took ${took}, passed ${passed}`);
  console.log(`  easy took a small-board win ${took} of ${took + passed} times it could`);
});

// ---------------------------------------------------------------------------
// Strength ladder
// ---------------------------------------------------------------------------

test('hard beats easy in a clear majority of 20 games', () => {
  const tally = ladder('hard', 'easy', 20, 20, 70000);
  console.log(`  hard (20ms) vs easy, 20 games: ${tally.wins} wins, ${tally.draws} draws, ${tally.losses} losses`);
  assert.ok(tally.wins >= 15, `hard won only ${tally.wins} of 20: ${JSON.stringify(tally)}`);
});

test('medium beats easy in a majority of 20 games', () => {
  const tally = ladder('medium', 'easy', 20, 30, 80000);
  console.log(`  medium (30ms) vs easy, 20 games: ${tally.wins} wins, ${tally.draws} draws, ${tally.losses} losses`);
  assert.ok(tally.wins >= 11, `medium won only ${tally.wins} of 20: ${JSON.stringify(tally)}`);
});
