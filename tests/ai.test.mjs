// Tests for the computer opponent (js/ai.js).
// Run from the project root: node --test tests/ai.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import * as engine from '../js/engine.js';
import { LEVELS, chooseMove, _internals as ai } from '../js/ai.js';

const MODES = ['anywhere', 'adjacent'];
const TIE_RULES = ['reset', 'stay'];
// Every way a game can be set up: 2 modes x 2 tie rules.
const SETUPS = [];
for (const tieRule of TIE_RULES) {
  for (const mode of MODES) SETUPS.push({ mode, tieRule });
}
const label = (setup) => `${setup.mode}/${setup.tieRule}`;

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

// A live position reached by up to `plies` random moves (it stops one move
// short if the game would end).
function randomPosition(setup, plies, rng) {
  let state = engine.createGame(setup);
  for (let i = 0; i < plies; i += 1) {
    const move = randomMove(state, rng);
    const next = engine.applyMove(state, move.board, move.cell);
    if (next.winner !== null) break;
    state = next;
  }
  return state;
}

// A balanced position: medium plays itself for `plies` moves.
function selfPlayPosition(setup, plies, rng) {
  let state = engine.createGame(setup);
  for (let i = 0; i < plies; i += 1) {
    const move = chooseMove(state, { level: 'medium', timeLimitMs: 1000, rng });
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

// Walks random games and collects `perSetup` live positions satisfying
// `wanted` from each of the four setups (at most two per game).
function collectPositions(wanted, perSetup, seed) {
  const found = [];
  SETUPS.forEach((setup, index) => {
    const rng = seeded(seed + index * 7919);
    let got = 0;
    for (let game = 0; game < 3000 && got < perSetup; game += 1) {
      let state = engine.createGame(setup);
      let takenFromThisGame = 0;
      for (let ply = 0; ply < 400 && state.winner === null; ply += 1) {
        if (takenFromThisGame < 2 && got < perSetup && wanted(state)) {
          found.push(state);
          got += 1;
          takenFromThisGame += 1;
        }
        const move = randomMove(state, rng);
        state = engine.applyMove(state, move.board, move.cell);
      }
    }
    assert.equal(got, perSetup, `not enough positions for ${label(setup)}`);
  });
  return found;
}

function pickFields(state) {
  return {
    tieRule: state.tieRule,
    cells: state.cells,
    boardWinners: state.boardWinners,
    boardTied: state.boardTied,
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
function playGame(setup, chooseX, chooseO, maxPlies = 400) {
  let state = engine.createGame(setup);
  for (let ply = 0; ply < maxPlies && state.winner === null; ply += 1) {
    const choose = state.currentPlayer === 'X' ? chooseX : chooseO;
    const move = choose(state);
    assert.ok(engine.isLegalMove(state, move.board, move.cell), 'ladder move must be legal');
    state = engine.applyMove(state, move.board, move.cell);
  }
  return state.winner === 'X' || state.winner === 'O' ? state.winner : 'draw';
}

// `games` games of `level` against `opponent` under one tie rule, alternating
// sides every game and modes every two games. Games that hit the ply cap
// count as draws.
function ladder(level, opponent, tieRule, games, timeLimitMs, seed) {
  const tally = { wins: 0, draws: 0, losses: 0 };
  for (let game = 0; game < games; game += 1) {
    const strongIsX = game % 2 === 0;
    const setup = { mode: MODES[(game >> 1) % 2], tieRule };
    const strongRng = seeded(seed + game * 2);
    const weakRng = seeded(seed + game * 2 + 1);
    const strong = (state) => chooseMove(state, { level, timeLimitMs, rng: strongRng });
    const weak = (state) => chooseMove(state, { level: opponent, rng: weakRng });
    const result = strongIsX ? playGame(setup, strong, weak) : playGame(setup, weak, strong);
    if (result === 'draw') tally.draws += 1;
    else if ((result === 'X') === strongIsX) tally.wins += 1;
    else tally.losses += 1;
  }
  return tally;
}

const tallyText = (t) => `${t.wins} wins, ${t.draws} draws, ${t.losses} losses`;

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

test('internal move generation and move effects match the engine over random games, all four setups', () => {
  const blank = () => ({
    positions: 0,
    boardWins: 0,
    ties: 0, // wipes under 'reset', closures under 'stay'
    forced: 0,
    freeAnywhere: 0, // free move in mode "anywhere"
    adjacent: 0, // free move limited to touching squares
    adjacentFallback: 0, // mode "adjacent" with no open touching square
    freeByTiedTarget: 0, // free move because the target square is tied and closed
    gameWins: 0,
    gameDraws: 0,
    drawsWithTiedSquare: 0,
    capped: 0,
  });
  const seen = { reset: blank(), stay: blank() };
  const GAMES_PER_SETUP = 250;

  SETUPS.forEach((setup, setupIndex) => {
    const { mode, tieRule } = setup;
    const count = seen[tieRule];
    const otherMode = mode === 'anywhere' ? 'adjacent' : 'anywhere';
    for (let game = 0; game < GAMES_PER_SETUP; game += 1) {
      const rng = seeded(1000 + game + setupIndex * 50000);
      let state = engine.createGame(setup);
      let ply = 0;
      for (; ply < 600 && state.winner === null; ply += 1) {
        count.positions += 1;
        const freeMove = state.constraint === 'free' || state.constraint === 'adjacent';
        if (state.constraint === 'forced') count.forced += 1;
        if (state.constraint === 'free' && mode === 'anywhere') count.freeAnywhere += 1;
        if (state.constraint === 'adjacent') count.adjacent += 1;
        if (state.constraint === 'free' && mode === 'adjacent') count.adjacentFallback += 1;
        if (freeMove && state.boardTied[state.targetBoard]) count.freeByTiedTarget += 1;

        // Same position, same legal moves.
        ai.load(state);
        const before = ai.snapshot();
        assert.deepEqual(snapshotFields(), pickFields(state), 'load must reproduce the engine state');
        const legal = engineMoves(state);
        assert.deepEqual(sortedKeys(ai.legalMoves()), sortedKeys(legal), 'legal move sets differ');
        assert.ok(legal.length > 0, 'a live game always has a move');

        // On a free-move position the other mode must agree too.
        if (freeMove) {
          const other = engine.setMode(state, otherMode);
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
          `position after ${engine.notation(move.board, move.cell)} differs (${label(setup)}, game ${game}, ply ${ply})`,
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
        if (last.wonBoard) count.boardWins += 1;
        if (last.tiedBoard) count.ties += 1;
        state = next;
      }
      if (state.winner === 'draw') {
        count.gameDraws += 1;
        if (state.boardTied.some(Boolean)) count.drawsWithTiedSquare += 1;
      } else if (state.winner !== null) {
        count.gameWins += 1;
      } else {
        count.capped += 1;
      }
    }
  });

  // The random games must actually have exercised every rule being compared,
  // under both tie rules.
  for (const tieRule of TIE_RULES) {
    const count = seen[tieRule];
    const need = (name, minimum) =>
      assert.ok(count[name] >= minimum, `${tieRule}: ${name} came up ${count[name]} times, wanted ${minimum}+`);
    need('boardWins', 500);
    need('ties', 50);
    need('forced', 5000);
    need('freeAnywhere', 200);
    need('adjacent', 200);
    need('adjacentFallback', 20);
    need('gameWins', 100);
    need('gameDraws', 10);
  }
  // Only 'stay' can close a square by a tie.
  assert.ok(seen.stay.freeByTiedTarget >= 10, `stay: free moves from a tied target: ${seen.stay.freeByTiedTarget}`);
  assert.ok(seen.stay.drawsWithTiedSquare >= 10, `stay: draws with a tied square: ${seen.stay.drawsWithTiedSquare}`);
  assert.equal(seen.reset.freeByTiedTarget, 0);
  assert.equal(seen.reset.drawsWithTiedSquare, 0);
  assert.equal(seen.stay.capped, 0, "a 'stay' game cannot outlast 81 moves");
  console.log(`  cross-check, reset: ${JSON.stringify(seen.reset)}`);
  console.log(`  cross-check, stay:  ${JSON.stringify(seen.stay)}`);
});

test('multi-move make/unmake sequences unwind exactly', () => {
  const rng = seeded(77);
  for (const setup of SETUPS) {
    for (let round = 0; round < 40; round += 1) {
      const state = randomPosition(setup, Math.floor(rng() * 70), rng);
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
  test(`${level}: returns a legal move and leaves the state alone, all four setups`, () => {
    const rng = seeded(4242 + LEVELS.indexOf(level));
    const POSITIONS = level === 'hard' ? 25 : 80;
    for (const setup of SETUPS) {
      for (let i = 0; i < POSITIONS; i += 1) {
        const state = randomPosition(setup, Math.floor(rng() * 90), rng);
        const copy = clone(state);
        const move = chooseMove(state, { level, timeLimitMs: 15, rng });
        assert.ok(Number.isInteger(move.board) && Number.isInteger(move.cell));
        assert.ok(
          engine.isLegalMove(state, move.board, move.cell),
          `${level} chose illegal ${move.board},${move.cell} in ${label(setup)}`,
        );
        assert.deepEqual(state, copy, 'chooseMove mutated the state it was given');
      }
    }
  });
}

test('every level works on a state rebuilt from JSON and after setMode', () => {
  const rng = seeded(31337);
  for (let i = 0; i < 40; i += 1) {
    const setup = SETUPS[i % 4];
    let state = randomPosition(setup, 30 + Math.floor(rng() * 50), rng);
    state = clone(engine.setMode(state, setup.mode === 'anywhere' ? 'adjacent' : 'anywhere'));
    for (const level of LEVELS) {
      const move = chooseMove(state, { level, timeLimitMs: 10, rng });
      assert.ok(engine.isLegalMove(state, move.board, move.cell));
    }
  }
});

test("a state from before the tie rule existed (no tieRule, boardTied, endedBy) plays as 'reset'", () => {
  const rng = seeded(1999);
  for (let i = 0; i < 30; i += 1) {
    const state = randomPosition({ mode: MODES[i % 2], tieRule: 'reset' }, 10 + Math.floor(rng() * 70), rng);
    const old = clone(state);
    delete old.tieRule;
    delete old.boardTied;
    delete old.endedBy;
    ai.load(old);
    assert.deepEqual(snapshotFields(), pickFields(state));
    for (const level of LEVELS) {
      // Depth-capped or instant settings, so the answer does not depend on the clock.
      const options = () => ({ level, timeLimitMs: level === 'hard' ? 0 : 10000, rng: seeded(i) });
      const move = chooseMove(old, options());
      assert.ok(engine.isLegalMove(old, move.board, move.cell));
      assert.deepEqual(move, chooseMove(state, options()));
    }
  }
});

test('every level throws on a finished game, however it ended', () => {
  const rng = seeded(9);
  for (const setup of SETUPS) {
    // Played to the end on the board.
    let state = engine.createGame(setup);
    let midGame = null;
    while (state.winner === null) {
      if (state.history.length === 12) midGame = state;
      const move = randomMove(state, rng);
      state = engine.applyMove(state, move.board, move.cell);
    }
    // Ended on time with moves still available on the board.
    const flagged = engine.forfeit(midGame, midGame.currentPlayer, 'time');
    assert.equal(flagged.endedBy, 'time');
    for (const level of LEVELS) {
      assert.throws(() => chooseMove(state, { level }), /over/);
      assert.throws(() => chooseMove(flagged, { level }), /over/);
    }
  }
});

test('hard with a time limit of zero still completes a two-ply search', () => {
  const rng = seeded(5);
  for (let i = 0; i < 40; i += 1) {
    const state = randomPosition(SETUPS[i % 4], Math.floor(rng() * 80), rng);
    const move = chooseMove(state, { level: 'hard', timeLimitMs: 0, rng });
    assert.ok(engine.isLegalMove(state, move.board, move.cell));
    if (engineMoves(state).length > 1) {
      const decided = Math.abs(ai.lastSearch.score) > 900000;
      assert.ok(ai.lastSearch.depth === 2 || (decided && ai.lastSearch.depth === 1));
      assert.equal(ai.lastSearch.timedOut, false);
    }
  }
});

test('the root follows state.legalBoards, which is what isLegalMove checks', () => {
  // A forced position edited by hand so legalBoards names a different open
  // square than the target. The engine would accept moves only there.
  for (const tieRule of TIE_RULES) {
    let state = engine.createGame({ tieRule });
    state = engine.applyMove(state, 4, 0); // O is sent to big square 1
    const edited = clone(state);
    edited.legalBoards = [7];
    for (const level of LEVELS) {
      const move = chooseMove(edited, { level, timeLimitMs: 10, rng: seeded(1) });
      assert.equal(move.board, 7);
      assert.ok(engine.isLegalMove(edited, move.board, move.cell));
    }
  }
});

// ---------------------------------------------------------------------------
// Tactics
// ---------------------------------------------------------------------------

test('every level takes a game-winning move when there is one, all four setups', () => {
  const positions = collectPositions((state) => winningMoves(state).length > 0, 12, 2024);
  assert.equal(positions.length, 48);
  const rng = seeded(11);
  for (const state of positions) {
    for (const level of LEVELS) {
      const move = chooseMove(state, { level, timeLimitMs: 30, rng });
      const next = engine.applyMove(state, move.board, move.cell);
      assert.equal(
        next.winner,
        state.currentPlayer,
        `${level} missed a game win in ${label(state)} (chose ${engine.notation(move.board, move.cell)})`,
      );
    }
  }
});

test('medium and hard block an immediate game win when a block exists, all four setups, on a 30ms budget', () => {
  // The side to move cannot win now, at least one of its moves lets the
  // opponent win at once, and at least one does not.
  const analyse = (state) => {
    if (winningMoves(state).length > 0) return null;
    const safe = [];
    const losing = [];
    for (const move of engineMoves(state)) {
      const next = engine.applyMove(state, move.board, move.cell);
      if (next.winner !== null) {
        safe.push(key(move)); // the move ends the game in a draw: nothing to block afterwards
        continue;
      }
      (winningMoves(next).length > 0 ? losing : safe).push(key(move));
    }
    return safe.length > 0 && losing.length > 0 ? { safe, losing } : null;
  };
  const positions = collectPositions((state) => analyse(state) !== null, 12, 606);
  assert.equal(positions.length, 48);
  const rng = seeded(12);
  for (const state of positions) {
    const { safe } = analyse(state);
    for (const level of ['medium', 'hard']) {
      const move = chooseMove(state, { level, timeLimitMs: 30, rng });
      assert.ok(
        safe.includes(key(move)),
        `${level} let the opponent win at once in ${label(state)} with ${engine.notation(move.board, move.cell)}`,
      );
    }
  }
});

test('medium and hard take a small-board win that costs nothing', () => {
  // X keeps sending O back to big square 1 by playing the first cell of other
  // squares. O ends up holding 1-4, 1-5, 1-7 and 1-9 there, to move, with
  // three ways to win the square (1-3, 1-6, 1-8), each sending X to an empty
  // big square.
  for (const tieRule of TIE_RULES) {
    let state = engine.createGame({ tieRule });
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
      assert.equal(next.boardWinners[0], 'O', `${level} did not win the small board (${tieRule})`);
    }
  }
});

// ---------------------------------------------------------------------------
// Evaluation and the 'stay' rule
// ---------------------------------------------------------------------------

// A hand-built 'stay' position: X to move, sent to the empty big square 2.
// `marks` maps a big square to 'X', 'O' (won by that player) or 'tied'.
function builtPosition(marks) {
  const WON_BY = { X: ['X', 'X', 'X', 'O', 'O', null, null, null, null], O: ['O', 'O', 'O', 'X', 'X', null, null, null, null] };
  const TIED = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'];
  const state = engine.createGame({ tieRule: 'stay' });
  for (const [board, mark] of Object.entries(marks)) {
    if (mark === 'tied') {
      state.cells[board] = TIED.slice();
      state.boardTied[board] = true;
    } else {
      state.cells[board] = WON_BY[mark].slice();
      state.boardWinners[board] = mark;
      state.boardWinLines[board] = [0, 1, 2];
    }
  }
  state.targetBoard = 1;
  state.legalBoards = [1];
  state.constraint = 'forced';
  return state;
}

function evaluateFor(state) {
  ai.load(state);
  return ai.evaluate();
}

test('the evaluation gives a tied square to nobody and treats lines through it as dead', () => {
  // Nothing on the board but a tied centre: level.
  assert.equal(evaluateFor(builtPosition({ 4: 'tied' })), 0);
  assert.equal(evaluateFor(builtPosition({ 0: 'tied', 8: 'tied' })), 0);

  // X holds two opposite corners. With the centre open the diagonal is a
  // live two-in-a-row; with the centre tied it is dead, which is worth less.
  const centreOpen = evaluateFor(builtPosition({ 0: 'X', 8: 'X' }));
  const centreTied = evaluateFor(builtPosition({ 0: 'X', 8: 'X', 4: 'tied' }));
  assert.ok(centreTied < centreOpen - 100, `open ${centreOpen}, tied ${centreTied}`);
  // A tied centre hurts X exactly as much as it would hurt O in X's place.
  const mirrored = builtPosition({ 0: 'O', 8: 'O', 4: 'tied' });
  assert.equal(evaluateFor(mirrored), -centreTied);
  // The tied square is not the opponent's either: it scores better for X than losing it.
  const centreLost = evaluateFor(builtPosition({ 0: 'X', 8: 'X', 4: 'O' }));
  assert.ok(centreTied > centreLost, `tied ${centreTied}, lost ${centreLost}`);
});

test("under 'stay' a move into a tied square's number is a free move for the opponent, and the search knows", () => {
  // X has won big squares 1 and 2 (indices 0, 1) and needs 3 (index 2).
  // Big square 9 (index 8) is tied. O, to move in big square 5, must not send
  // X anywhere X may choose big square 3 from - which includes the tied 9.
  const state = builtPosition({ 0: 'X', 1: 'X', 8: 'tied' });
  state.cells[2] = ['X', 'X', null, null, 'O', null, null, null, 'O']; // X wins it with 3-3
  state.currentPlayer = 'O';
  state.targetBoard = 4;
  state.legalBoards = [4];
  assert.ok(engine.isLegalMove(state, 4, 8));
  const afterBlunder = engine.applyMove(state, 4, 8); // sends X to tied square 9
  assert.equal(afterBlunder.constraint, 'free');
  assert.ok(winningMoves(afterBlunder).length > 0);
  for (const level of ['medium', 'hard']) {
    const move = chooseMove(state, { level, timeLimitMs: 30, rng: seeded(4) });
    const next = engine.applyMove(state, move.board, move.cell);
    assert.equal(winningMoves(next).length, 0, `${level} handed over the game with ${engine.notation(move.board, move.cell)}`);
  }
});

test("under 'stay' hard stops once it has searched to the end of the game", () => {
  // A 'stay' game cannot outlast the empty cells left in open squares. With
  // few of those left the search is complete well inside the budget, and it
  // must then answer instead of sitting out the clock.
  const cellsLeft = (state) => {
    let left = 0;
    for (let b = 0; b < 9; b += 1) {
      if (state.boardWinners[b] !== null || state.boardTied[b]) continue;
      left += state.cells[b].filter((mark) => mark === null).length;
    }
    return left;
  };
  const rng = seeded(515);
  let checked = 0;
  for (let game = 0; game < 400 && checked < 20; game += 1) {
    let state = engine.createGame({ mode: MODES[game % 2], tieRule: 'stay' });
    while (state.winner === null) {
      if (cellsLeft(state) <= 10 && engineMoves(state).length > 1) {
        const started = performance.now();
        const move = chooseMove(state, { level: 'hard', timeLimitMs: 2000, rng });
        const elapsed = performance.now() - started;
        assert.ok(engine.isLegalMove(state, move.board, move.cell));
        assert.ok(ai.lastSearch.depth <= cellsLeft(state), `depth ${ai.lastSearch.depth} with ${cellsLeft(state)} cells left`);
        assert.equal(ai.lastSearch.timedOut, false);
        assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)}ms with ${cellsLeft(state)} cells left`);
        checked += 1;
        break;
      }
      const move = randomMove(state, rng);
      state = engine.applyMove(state, move.board, move.cell);
    }
  }
  assert.equal(checked, 20);
});

// ---------------------------------------------------------------------------
// Time budget
// ---------------------------------------------------------------------------

// The opening and a balanced mid-game position for each setup.
function timingPositions(seed) {
  const rng = seeded(seed);
  const cases = [];
  for (const setup of SETUPS) {
    cases.push([`opening ${label(setup)}`, engine.createGame(setup)]);
    const state = selfPlayPosition(setup, 24, rng);
    cases.push([`ply ${state.history.length} ${label(setup)}`, state]);
  }
  return cases;
}

test('hard with timeLimitMs 200 returns within about 300ms', () => {
  const rng = seeded(808);
  const cases = timingPositions(808);
  // Plus, per setup, a later position where the mover has a free move.
  for (const setup of SETUPS) {
    let state = selfPlayPosition(setup, 25, rng);
    for (let ply = 0; ply < 60 && state.winner === null; ply += 1) {
      if (state.legalBoards.length > 1) {
        cases.push([`free move at ply ${state.history.length} ${label(setup)}`, state]);
        break;
      }
      const move = chooseMove(state, { level: 'medium', timeLimitMs: 1000, rng });
      state = engine.applyMove(state, move.board, move.cell);
    }
  }
  // Warm up the JIT so the measurement is of the search, not of compilation.
  chooseMove(cases[0][1], { level: 'hard', timeLimitMs: 100, rng });

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
  assert.ok(usedTheBudget >= 6, `only ${usedTheBudget} positions kept the search busy for 100ms`);
});

test('medium and hard return within timeLimitMs + 30ms on budgets of 30, 50 and 100ms', () => {
  const cases = timingPositions(909);
  chooseMove(cases[0][1], { level: 'hard', timeLimitMs: 100, rng: seeded(1) });
  for (const level of ['medium', 'hard']) {
    for (const timeLimitMs of [30, 50, 100]) {
      let worst = 0;
      let shallowest = Infinity;
      for (const [name, state] of cases) {
        const started = performance.now();
        const move = chooseMove(state, { level, timeLimitMs, rng: seeded(2) });
        const elapsed = performance.now() - started;
        assert.ok(engine.isLegalMove(state, move.board, move.cell));
        assert.ok(elapsed < timeLimitMs + 30, `${level} ${timeLimitMs}ms, ${name}: took ${elapsed.toFixed(1)}ms`);
        // Still a real search, not a one-ply guess.
        assert.ok(ai.lastSearch.depth >= 3, `${level} ${timeLimitMs}ms, ${name}: depth ${ai.lastSearch.depth}`);
        worst = Math.max(worst, elapsed);
        shallowest = Math.min(shallowest, ai.lastSearch.depth);
      }
      console.log(
        `  ${level} ${timeLimitMs}ms over ${cases.length} positions: slowest ${worst.toFixed(0)}ms, shallowest depth ${shallowest}`,
      );
    }
  }
});

for (const tieRule of TIE_RULES) {
  test(`hard with its default 600ms budget returns within 650ms from the opening (${tieRule})`, () => {
    const state = engine.createGame({ mode: 'adjacent', tieRule });
    const started = performance.now();
    const move = chooseMove(state, { level: 'hard', rng: seeded(6) });
    const elapsed = performance.now() - started;
    assert.ok(engine.isLegalMove(state, move.board, move.cell));
    assert.ok(elapsed >= 300, `stopped early after ${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed < 650, `took ${elapsed.toFixed(1)}ms`);
    assert.ok(ai.lastSearch.depth >= 5, `only reached depth ${ai.lastSearch.depth}`);
    console.log(
      `  hard 600ms, opening (${tieRule}): ${elapsed.toFixed(0)}ms, depth ${ai.lastSearch.depth}, ${ai.lastSearch.nodes} nodes, cut short: ${ai.lastSearch.timedOut}`,
    );
  });
}

test('medium stays inside its default 150ms budget', () => {
  const rng = seeded(909);
  for (let i = 0; i < 16; i += 1) {
    const state = randomPosition(SETUPS[i % 4], 10 + i * 4, rng);
    const started = performance.now();
    chooseMove(state, { level: 'medium', rng });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 180, `medium took ${elapsed.toFixed(1)}ms`);
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('easy is deterministic with a seeded rng, and varies with the seed', () => {
  const positions = [];
  const rng = seeded(1);
  for (let i = 0; i < 80; i += 1) positions.push(randomPosition(SETUPS[i % 4], Math.floor(rng() * 60), rng));

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
  for (let i = 0; i < 16; i += 1) positions.push(randomPosition(SETUPS[i % 4], 5 + Math.floor(rng() * 50), rng));

  // Medium is capped by depth, so a generous clock never interrupts it.
  const medium = (seed) => {
    const r = seeded(seed);
    return positions.map((state) => key(chooseMove(state, { level: 'medium', timeLimitMs: 10000, rng: r })));
  };
  assert.deepEqual(medium(55), medium(55));

  // Hard with a zero budget is a complete two-ply search.
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
  }, 5, 404);
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

for (const tieRule of TIE_RULES) {
  test(`hard beats easy in a clear majority of 20 games (${tieRule})`, () => {
    const tally = ladder('hard', 'easy', tieRule, 20, 20, 70000);
    console.log(`  hard (20ms) vs easy, ${tieRule}, 20 games: ${tallyText(tally)}`);
    assert.ok(tally.wins >= 15, `hard won only ${tally.wins} of 20: ${JSON.stringify(tally)}`);
  });

  test(`medium beats easy in a majority of 20 games (${tieRule})`, () => {
    const tally = ladder('medium', 'easy', tieRule, 20, 30, 80000);
    console.log(`  medium (30ms) vs easy, ${tieRule}, 20 games: ${tallyText(tally)}`);
    assert.ok(tally.wins >= 11, `medium won only ${tally.wins} of 20: ${JSON.stringify(tally)}`);
  });
}
