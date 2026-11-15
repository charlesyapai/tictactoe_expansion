// Tests for js/engine.js. Run from the project root with:  node --test tests/
//
// Indices are 0..8 everywhere, row by row:
//     0 1 2
//     3 4 5
//     6 7 8
// A scripted move is written [board, cell]. Each move sends the opponent to
// the big square with the same index as `cell`, so positions are reached by
// playing real legal sequences through play(), which names the first move
// that is not legal. No test edits a state by hand.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  LINES,
  createGame,
  isLegalMove,
  applyMove,
  setMode,
  neighbors,
  notation,
} from '../js/engine.js';

// ---------------------------------------------------------------- helpers

const BOTH_MODES = ['anywhere', 'adjacent'];
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const EMPTY9 = () => new Array(9).fill(null);

// Written out by hand, on purpose, so neighbors() is checked against a table
// and not against the same arithmetic.
const TOUCHING = [
  [1, 3, 4],
  [0, 2, 3, 4, 5],
  [1, 4, 5],
  [0, 1, 4, 6, 7],
  [0, 1, 2, 3, 5, 6, 7, 8],
  [1, 2, 4, 7, 8],
  [3, 4, 7],
  [3, 4, 5, 6, 8],
  [4, 5, 7],
];

function describeState(state) {
  return (
    `constraint=${state.constraint}, legalBoards=[${state.legalBoards}], ` +
    `targetBoard=${state.targetBoard}, winner=${state.winner}`
  );
}

// Plays a list of [board, cell] moves. Fails with the offending move if one
// is illegal. Starts from `from` when given, otherwise from a new game.
function play(moves, { mode = 'anywhere', from } = {}) {
  let state = from ?? createGame({ mode });
  moves.forEach(([board, cell], i) => {
    if (!isLegalMove(state, board, cell)) {
      const occupant = state.cells[board]?.[cell];
      assert.fail(
        `scripted move #${i + 1} of ${moves.length}, [${board}, ${cell}] ` +
          `("${board + 1}-${cell + 1}") by ${state.currentPlayer}, is illegal in mode ` +
          `${state.mode}: ${describeState(state)}, that square holds ${JSON.stringify(occupant)}`,
      );
    }
    state = applyMove(state, board, cell);
  });
  return state;
}

function assertIllegal(state, board, cell, why) {
  const before = JSON.stringify(state);
  assert.equal(isLegalMove(state, board, cell), false, `isLegalMove should be false: ${why}`);
  assert.throws(() => applyMove(state, board, cell), Error, `applyMove should throw: ${why}`);
  assert.equal(JSON.stringify(state), before, `a rejected move must not change the state: ${why}`);
}

function emptyCells(state, board) {
  return ALL.filter((cell) => state.cells[board][cell] === null);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// -------------------------------------------------------- scripted positions

// X wins big square `target` with the small-square line [a, b, c], then O
// sends X straight back to the square X just won.
//
// X plays `a` inside target, which forces O into big square a. O answers at
// cell `target` there, which forces X back. Same again for b. X's third mark
// completes the line and forces O into big square c, and O's reply at cell
// `target` points X at a won square. The line must not contain `target`.
function xWinsThenIsSentBack(target, [a, b, c]) {
  return [
    [target, a], [a, target],
    [target, b], [b, target],
    [target, c], // X wins `target`; O is forced into c
    [c, target], // X is sent to `target`, which is won
  ];
}

// X wins big squares 0, 1, 2 (top row). Every move is forced, so the list is
// legal in both modes.
const ROW_WIN = [
  [0, 3], [3, 0], [0, 4], [4, 0], [0, 5], // X wins 0 with [3,4,5]; O forced into 5
  [5, 1],                                 // O sends X to 1
  [1, 3], [3, 1], [1, 4], [4, 1], [1, 5], // X wins 1 with [3,4,5]; O forced into 5
  [5, 2],                                 // O sends X to 2
  [2, 6], [6, 2], [2, 7], [7, 2], [2, 8], // X wins 2 with [6,7,8] and the game
];
const TWO_BOARDS_WON = ROW_WIN.slice(0, 11); // X holds 0 and 1; O to move, forced into 5

// O wins big squares 1, 4, 7 (middle column). Every move is forced.
const COLUMN_WIN = [
  [8, 1],                                 // X's opener sends O to 1
  [1, 0], [0, 1], [1, 3], [3, 1], [1, 6], // O wins 1 with [0,3,6]; X forced into 6
  [6, 4],                                 // X sends O to 4
  [4, 0], [0, 4], [4, 3], [3, 4], [4, 6], // O wins 4 with [0,3,6]; X forced into 6
  [6, 7],                                 // X sends O to 7
  [7, 2], [2, 7], [7, 5], [5, 7], [7, 8], // O wins 7 with [2,5,8] and the game
];

// X wins big squares 2, 4, 6 (anti-diagonal). Every move is forced.
const DIAGONAL_WIN = [
  [2, 1], [1, 2], [2, 4], [4, 2], [2, 7], // X wins 2 with [1,4,7]; O forced into 7
  [7, 4],                                 // O sends X to 4
  [4, 0], [0, 4], [4, 3], [3, 4], [4, 6], // X wins 4 with [0,3,6]; O forced into 6
  [6, 6],                                 // O plays 6's own cell, sending X to 6
  [6, 0], [0, 6], [6, 1], [1, 6], [6, 2], // X wins 6 with [0,1,2] and the game
];

// X holds 0 and 1, O holds 3 and 4, and O has just been sent to big square 0.
// All three squares touching 0 (1, 3, 4) are won. Every move is forced.
const CORNER_SURROUNDED = [
  ...TWO_BOARDS_WON, // O already has cells 0 and 1 in both big squares 3 and 4
  [5, 6],            // O (forced into 5) sends X to 6
  [6, 3],            // X sends O to 3
  [3, 2],            // O wins 3 with [0,1,2]; X forced into 2
  [2, 4],            // X sends O to 4
  [4, 2],            // O wins 4 with [0,1,2]; X forced into 2
  [2, 0],            // X sends O to 0, which is won
];

// Big square 0 fills up with no line. X takes cells 2, 3, 7, 8 (O answers at
// cell 0 of the square it is sent to, sending X back each time), then X takes
// cell 0, which hands square 0 to O. O takes 1, 4, 5 the same way and the
// ninth mark goes on cell 6:
//     X O X
//     X O O
//     O X X
// The last move is [0, 6], so X is sent to big square 6. Every move is forced.
const TIE_SENDS_ELSEWHERE = [
  [0, 2], [2, 0], [0, 3], [3, 0], [0, 7], [7, 0], [0, 8], [8, 0],
  [0, 0],
  [0, 1], [1, 0], [0, 4], [4, 0], [0, 5], [5, 0],
  [0, 6],
];
const TIE_SENDS_ELSEWHERE_LAYOUT = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'];

// Big square 0 fills up with no line and the ninth mark is its own cell 0, so
// X is sent to the square that was just wiped. X takes 1, 4, 5, 6; O then
// plays [6, 6] to hand the turn order over, takes 2, 3, 7, 8 and finally 0:
//     O X O
//     O X X
//     X O O
// Every move is forced.
const TIE_SENDS_TO_ITSELF = [
  [0, 1], [1, 0], [0, 4], [4, 0], [0, 5], [5, 0], [0, 6],
  [6, 6], [6, 0],
  [0, 2], [2, 0], [0, 3], [3, 0], [0, 7], [7, 0], [0, 8], [8, 0],
  [0, 0],
];
const TIE_SENDS_TO_ITSELF_LAYOUT = ['O', 'X', 'O', 'O', 'X', 'X', 'X', 'O', 'O'];

// Big square 0 fills up and the ninth mark completes O's diagonal [2,4,6].
// That is a win, not a tie. X takes 3, 5, 7, 8 then 0; O takes 1, 2, 4, 6:
//     X O O
//     X O X
//     O X X
// Every move is forced.
const FULL_BOARD_WIN = [
  [0, 3], [3, 0], [0, 5], [5, 0], [0, 7], [7, 0], [0, 8], [8, 0],
  [0, 0],
  [0, 1], [1, 0], [0, 2], [2, 0], [0, 4], [4, 0],
  [0, 6],
];

// A complete drawn game: all nine big squares won, nobody has a line.
//     O O X
//     X X O
//     O O X
// A draw needs nine big-square wins and the free moves that come with them,
// so this list was not designed by hand. It is a real game found by a seeded
// random search over legal moves in mode 'adjacent' (whose legal moves are
// always legal in mode 'anywhere' too) and is replayed here move by move
// through play(). No state is edited by hand.
const DRAW_GAME = [
  [3, 7], [7, 0], [0, 1], [1, 4], [4, 6], [6, 4], [4, 3], [3, 3], [3, 0], [0, 4],
  [4, 0], [0, 3], [3, 1], [1, 6], [6, 3], [3, 8], [8, 6], [6, 2], [2, 0], [0, 8],
  [8, 8], [8, 1], [1, 5], [5, 8], [8, 0], [0, 0], [3, 4], [7, 8], [8, 7], [7, 6],
  [6, 8], [7, 7], [6, 0], [1, 7], [6, 1], [1, 2], [2, 6], [6, 6], [5, 1], [5, 2],
  [2, 3], [5, 0], [5, 6], [5, 4],
];
const DRAW_OWNERS = ['O', 'O', 'X', 'X', 'X', 'O', 'O', 'O', 'X'];

// A complete game in which the ninth big square is won and that same move
// completes a line: X wins, it is not a draw. Found the same way as DRAW_GAME.
//     O X X
//     O O X
//     X X X
const FULL_BIG_BOARD_WIN = [
  [5, 0], [0, 6], [6, 0], [0, 4], [4, 0], [0, 2], [2, 0], [4, 1], [1, 0], [1, 2],
  [2, 4], [4, 7], [7, 3], [3, 7], [7, 6], [6, 5], [5, 1], [1, 1], [1, 4], [4, 4],
  [5, 7], [7, 8], [8, 0], [1, 6], [6, 6], [6, 7], [7, 0], [3, 8], [8, 2], [2, 1],
  [1, 8], [8, 5], [5, 2], [2, 6], [6, 3], [3, 6], [8, 7], [8, 6], [2, 8], [8, 4],
  [8, 1],
];

// ------------------------------------------------------------------ exports

describe('exports', () => {
  test('MODES holds the two mode strings', () => {
    assert.deepEqual({ ...MODES }, { ANYWHERE: 'anywhere', ADJACENT: 'adjacent' });
  });

  test('LINES holds the 8 winning triples', () => {
    const expected = [
      '0,1,2', '0,3,6', '0,4,8', '1,4,7', '2,4,6', '2,5,8', '3,4,5', '6,7,8',
    ];
    assert.equal(LINES.length, 8);
    assert.deepEqual(LINES.map((line) => line.join(',')).sort(), expected);
  });
});

// --------------------------------------------------------------- fresh game

describe('createGame', () => {
  test('fresh game: constraint start, all nine boards legal, X to move', () => {
    assert.deepEqual(createGame(), {
      mode: 'anywhere',
      cells: ALL.map(EMPTY9),
      boardWinners: EMPTY9(),
      boardWinLines: EMPTY9(),
      resets: new Array(9).fill(0),
      currentPlayer: 'X',
      targetBoard: null,
      legalBoards: ALL,
      constraint: 'start',
      winner: null,
      winLine: null,
      lastMove: null,
      history: [],
    });
  });

  test('mode option', () => {
    assert.equal(createGame({}).mode, 'anywhere');
    assert.equal(createGame({ mode: 'anywhere' }).mode, 'anywhere');
    assert.equal(createGame({ mode: MODES.ADJACENT }).mode, 'adjacent');
    assert.deepEqual({ ...createGame({ mode: 'adjacent' }), mode: 'anywhere' }, createGame());
    assert.throws(() => createGame({ mode: 'diagonal' }), Error);
  });

  test('every one of the 81 squares is legal on the first move', () => {
    const state = createGame();
    for (const board of ALL) {
      for (const cell of ALL) {
        assert.equal(isLegalMove(state, board, cell), true, notation(board, cell));
      }
    }
  });

  test('two games share nothing', () => {
    const a = createGame();
    const b = createGame();
    assert.equal(new Set(a.cells).size, 9, 'each big square has its own array');
    a.cells[0][0] = 'X';
    a.legalBoards.pop();
    assert.deepEqual(b, createGame());
  });
});

// ------------------------------------------------------------- forced moves

describe('a move sends the opponent to the matching big square', () => {
  test('after "4-1" O must play in big square 1', () => {
    const state = play([[3, 0]]);
    const expectedCells = ALL.map(EMPTY9);
    expectedCells[3][0] = 'X';
    assert.deepEqual(state, {
      mode: 'anywhere',
      cells: expectedCells,
      boardWinners: EMPTY9(),
      boardWinLines: EMPTY9(),
      resets: new Array(9).fill(0),
      currentPlayer: 'O',
      targetBoard: 0,
      legalBoards: [0],
      constraint: 'forced',
      winner: null,
      winLine: null,
      lastMove: { board: 3, cell: 0 },
      history: [
        {
          player: 'X',
          board: 3,
          cell: 0,
          notation: '4-1',
          wonBoard: false,
          tiedBoard: false,
          tiedCells: null,
        },
      ],
    });
  });

  test('all 81 opening moves force the matching square, in both modes', () => {
    for (const mode of BOTH_MODES) {
      for (const board of ALL) {
        for (const cell of ALL) {
          const state = play([[board, cell]], { mode });
          assert.equal(state.constraint, 'forced');
          assert.equal(state.targetBoard, cell);
          assert.deepEqual(state.legalBoards, [cell]);
          assert.equal(state.currentPlayer, 'O');
        }
      }
    }
  });

  test('players alternate and each reply is forced in turn', () => {
    let state = play([[4, 4]]); // X centre of centre: O stays in 4
    assert.deepEqual(state.legalBoards, [4]);
    state = play([[4, 0]], { from: state }); // O sends X to 0
    assert.equal(state.currentPlayer, 'X');
    assert.deepEqual(state.legalBoards, [0]);
    assert.equal(state.cells[4][4], 'X');
    assert.equal(state.cells[4][0], 'O');
    assert.deepEqual(state.history.map((h) => h.player + h.notation), ['X5-5', 'O5-1']);
    assert.deepEqual(state.lastMove, { board: 4, cell: 0 });
  });
});

// ------------------------------------------------------------ illegal moves

describe('illegal moves: isLegalMove is false and applyMove throws', () => {
  test('wrong big square', () => {
    const state = play([[4, 0]]); // O must play in 0
    for (const board of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const cell of ALL) {
        assertIllegal(state, board, cell, `O must play in big square 0, not ${board}`);
      }
    }
    for (const cell of ALL) assert.equal(isLegalMove(state, 0, cell), true);
  });

  test('occupied square', () => {
    const state = play([[0, 0]]); // X took 0-0 and O is forced into 0
    assertIllegal(state, 0, 0, 'square already holds X');
    const later = play([[0, 4], [4, 0]], { from: state }); // X back in 0
    assertIllegal(later, 0, 0, 'square holds X');
    assertIllegal(later, 0, 4, 'square holds O');
    assert.deepEqual(emptyCells(later, 0), [1, 2, 3, 5, 6, 7, 8]);
  });

  test('won big square', () => {
    // X won 0 with [1,4,7] and now has a free move. Square 0 still has empty
    // cells, but it is closed.
    const state = play(xWinsThenIsSentBack(0, [1, 4, 7]));
    assert.equal(state.boardWinners[0], 'X');
    assert.equal(state.constraint, 'free');
    for (const cell of ALL) assertIllegal(state, 0, cell, 'big square 0 is won');
    assert.equal(state.cells[0][0], null, 'the cell itself is empty; the square is closed');
  });

  test('out-of-range and non-integer arguments', () => {
    const state = createGame();
    const bad = [-1, 9, 100, 1.5, NaN, Infinity, -Infinity, '0', '4', '', null, undefined, true, [0], {}];
    for (const value of bad) {
      assertIllegal(state, value, 0, `board ${String(value)}`);
      assertIllegal(state, 0, value, `cell ${String(value)}`);
      assertIllegal(state, value, value, `board and cell ${String(value)}`);
    }
    assert.equal(isLegalMove(state), false, 'missing arguments');
    assert.throws(() => applyMove(state), Error);
  });

  test('any move after the game is over', () => {
    for (const moves of [ROW_WIN, COLUMN_WIN, DIAGONAL_WIN, DRAW_GAME]) {
      const state = play(moves);
      assert.notEqual(state.winner, null);
      for (const board of ALL) {
        for (const cell of ALL) assertIllegal(state, board, cell, 'the game is over');
      }
    }
  });

  test('the error message names the move', () => {
    const state = play([[4, 0]]);
    assert.throws(() => applyMove(state, 3, 0), /4-1/);
  });
});

// ------------------------------------------------------- winning a big square

describe('winning a big square', () => {
  test('sets boardWinners, boardWinLines and history.wonBoard', () => {
    const moves = xWinsThenIsSentBack(0, [1, 4, 7]).slice(0, 5);
    const before = play(moves.slice(0, 4));
    assert.deepEqual(before.boardWinners, EMPTY9());
    assert.deepEqual(before.boardWinLines, EMPTY9());

    const state = play(moves.slice(4), { from: before });
    assert.deepEqual(state.boardWinners, ['X', null, null, null, null, null, null, null, null]);
    assert.deepEqual(state.boardWinLines, [[1, 4, 7], null, null, null, null, null, null, null, null]);
    assert.deepEqual(state.history.map((h) => h.wonBoard), [false, false, false, false, true]);
    assert.deepEqual(state.history.at(-1), {
      player: 'X',
      board: 0,
      cell: 7,
      notation: '1-8',
      wonBoard: true,
      tiedBoard: false,
      tiedCells: null,
    });
    // The marks stay where they are.
    assert.deepEqual(state.cells[0], [null, 'X', null, null, 'X', null, null, 'X', null]);
    assert.deepEqual(state.resets, new Array(9).fill(0));
    // One big square is not a game.
    assert.equal(state.winner, null);
    assert.equal(state.winLine, null);
    // O is sent to 7 as usual.
    assert.equal(state.currentPlayer, 'O');
    assert.equal(state.targetBoard, 7);
    assert.equal(state.constraint, 'forced');
    assert.deepEqual(state.legalBoards, [7]);
  });

  test('O can win a big square too', () => {
    const state = play(COLUMN_WIN.slice(0, 6));
    assert.equal(state.boardWinners[1], 'O');
    assert.deepEqual(state.boardWinLines[1], [0, 3, 6]);
    assert.equal(state.history.at(-1).player, 'O');
    assert.equal(state.history.at(-1).wonBoard, true);
  });

  test('a ninth mark that completes a line is a win, not a tie', () => {
    const before = play(FULL_BOARD_WIN.slice(0, -1));
    assert.deepEqual(emptyCells(before, 0), [6]);
    const state = play(FULL_BOARD_WIN.slice(-1), { from: before });
    assert.equal(state.boardWinners[0], 'O');
    assert.deepEqual(state.boardWinLines[0], [2, 4, 6]);
    assert.deepEqual(state.cells[0], ['X', 'O', 'O', 'X', 'O', 'X', 'O', 'X', 'X']);
    assert.equal(state.resets[0], 0);
    const last = state.history.at(-1);
    assert.equal(last.wonBoard, true);
    assert.equal(last.tiedBoard, false);
    assert.equal(last.tiedCells, null);
    assert.deepEqual(state.legalBoards, [6]);
  });
});

// ------------------------------------------------------ sent to a won square

describe("sent to a won square, mode 'anywhere'", () => {
  test('free move: every open board is legal', () => {
    const state = play(xWinsThenIsSentBack(0, [1, 4, 7]), { mode: 'anywhere' });
    assert.equal(state.currentPlayer, 'X');
    assert.equal(state.targetBoard, 0, 'targetBoard still names the won square');
    assert.equal(state.constraint, 'free');
    assert.deepEqual(state.legalBoards, [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const board of state.legalBoards) {
      for (const cell of ALL) {
        assert.equal(isLegalMove(state, board, cell), state.cells[board][cell] === null);
      }
    }
    // Take the free move far from the target; the reply is forced again.
    const next = play([[8, 8]], { from: state });
    assert.equal(next.constraint, 'forced');
    assert.deepEqual(next.legalBoards, [8]);
  });

  test('won boards are left out of the free move', () => {
    const state = play([...TWO_BOARDS_WON, [5, 0]], { mode: 'anywhere' });
    assert.deepEqual(state.boardWinners.slice(0, 2), ['X', 'X']);
    assert.equal(state.targetBoard, 0);
    assert.equal(state.constraint, 'free');
    assert.deepEqual(state.legalBoards, [2, 3, 4, 5, 6, 7, 8]);
  });

  test('a corner whose touching squares are all won is still just a free move', () => {
    const state = play(CORNER_SURROUNDED, { mode: 'anywhere' });
    assert.equal(state.constraint, 'free');
    assert.deepEqual(state.legalBoards, [2, 5, 6, 7, 8]);
  });
});

describe("sent to a won square, mode 'adjacent'", () => {
  const cases = [
    { name: 'corner', target: 0, line: [1, 4, 7], touching: [1, 3, 4] },
    { name: 'edge', target: 1, line: [3, 4, 5], touching: [0, 2, 3, 4, 5] },
    { name: 'centre', target: 4, line: [0, 1, 2], touching: [0, 1, 2, 3, 5, 6, 7, 8] },
    { name: 'other corner', target: 8, line: [0, 1, 2], touching: [4, 5, 7] },
    { name: 'other edge', target: 3, line: [2, 5, 8], touching: [0, 1, 4, 6, 7] },
  ];

  for (const { name, target, line, touching } of cases) {
    test(`${name} target ${target}: only the open touching boards`, () => {
      const state = play(xWinsThenIsSentBack(target, line), { mode: 'adjacent' });
      assert.equal(state.boardWinners[target], 'X');
      assert.equal(state.targetBoard, target);
      assert.equal(state.currentPlayer, 'X');
      assert.equal(state.constraint, 'adjacent');
      assert.deepEqual(state.legalBoards, touching);
      for (const board of ALL) {
        for (const cell of ALL) {
          const expected = touching.includes(board) && state.cells[board][cell] === null;
          assert.equal(isLegalMove(state, board, cell), expected, notation(board, cell));
        }
      }
      // The same moves in mode 'anywhere' give every open board.
      const anywhere = play(xWinsThenIsSentBack(target, line), { mode: 'anywhere' });
      assert.equal(anywhere.constraint, 'free');
      assert.deepEqual(anywhere.legalBoards, ALL.filter((b) => b !== target));
    });
  }

  test('a far-away open board is illegal, a touching one is playable', () => {
    const state = play(xWinsThenIsSentBack(0, [1, 4, 7]), { mode: 'adjacent' });
    assertIllegal(state, 8, 8, 'big square 8 does not touch big square 0');
    const next = play([[3, 8]], { from: state });
    assert.equal(next.constraint, 'forced');
    assert.deepEqual(next.legalBoards, [8]);
  });

  test('a won touching board is left out', () => {
    // X holds 0 and 1 and is sent to 0. Of the squares touching 0 (1, 3, 4),
    // 1 is won.
    const state = play([...TWO_BOARDS_WON, [5, 0]], { mode: 'adjacent' });
    assert.deepEqual(state.boardWinners.slice(0, 2), ['X', 'X']);
    assert.equal(state.targetBoard, 0);
    assert.equal(state.constraint, 'adjacent');
    assert.deepEqual(state.legalBoards, [3, 4]);
  });

  test("falls back to 'free' when every touching board is won", () => {
    const state = play(CORNER_SURROUNDED, { mode: 'adjacent' });
    assert.deepEqual(state.boardWinners, ['X', 'X', null, 'O', 'O', null, null, null, null]);
    assert.equal(state.winner, null);
    assert.equal(state.currentPlayer, 'O');
    assert.equal(state.targetBoard, 0);
    assert.equal(state.constraint, 'free');
    assert.deepEqual(state.legalBoards, [2, 5, 6, 7, 8]);
    for (const board of [2, 5, 6, 7, 8]) {
      for (const cell of emptyCells(state, board)) {
        assert.equal(isLegalMove(state, board, cell), true, notation(board, cell));
      }
    }
  });
});

// --------------------------------------------------------------------- ties

describe('a tied big square is wiped in the same move', () => {
  for (const mode of BOTH_MODES) {
    test(`tie sends the opponent to another square (mode ${mode})`, () => {
      const before = play(TIE_SENDS_ELSEWHERE.slice(0, -1), { mode });
      assert.deepEqual(emptyCells(before, 0), [6], 'one empty cell left in big square 0');
      assert.equal(before.currentPlayer, 'O');
      assert.deepEqual(before.resets, new Array(9).fill(0));

      const state = play(TIE_SENDS_ELSEWHERE.slice(-1), { from: before });
      // Wiped, counted, still open.
      assert.deepEqual(state.cells[0], EMPTY9());
      assert.deepEqual(state.resets, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
      assert.equal(state.boardWinners[0], null);
      assert.equal(state.boardWinLines[0], null);
      assert.equal(state.winner, null);
      // Recorded in history.
      assert.deepEqual(state.history.at(-1), {
        player: 'O',
        board: 0,
        cell: 6,
        notation: '1-7',
        wonBoard: false,
        tiedBoard: true,
        tiedCells: TIE_SENDS_ELSEWHERE_LAYOUT,
      });
      for (const entry of state.history.slice(0, -1)) {
        assert.equal(entry.tiedBoard, false);
        assert.equal(entry.tiedCells, null);
      }
      assert.deepEqual(state.lastMove, { board: 0, cell: 6 });
      // The opponent is still sent to the matching square.
      assert.equal(state.currentPlayer, 'X');
      assert.equal(state.targetBoard, 6);
      assert.equal(state.constraint, 'forced');
      assert.deepEqual(state.legalBoards, [6]);
      // Nothing else was touched.
      for (const board of [1, 2, 3, 4, 5, 6, 7, 8]) {
        assert.deepEqual(state.cells[board], before.cells[board], `big square ${board}`);
      }

      // The wiped square is playable again, all nine cells.
      const back = play([[6, 0]], { from: state });
      assert.deepEqual(back.legalBoards, [0]);
      for (const cell of ALL) assert.equal(isLegalMove(back, 0, cell), true);
      const replayed = play([[0, 6]], { from: back });
      assert.deepEqual(replayed.cells[0], [null, null, null, null, null, null, 'O', null, null]);
      assert.equal(replayed.resets[0], 1);
    });

    test(`tie sends the opponent to the square that was just wiped (mode ${mode})`, () => {
      const before = play(TIE_SENDS_TO_ITSELF.slice(0, -1), { mode });
      assert.deepEqual(emptyCells(before, 0), [0]);

      const state = play(TIE_SENDS_TO_ITSELF.slice(-1), { from: before });
      assert.deepEqual(state.cells[0], EMPTY9());
      assert.deepEqual(state.resets, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
      assert.equal(state.boardWinners[0], null);
      const last = state.history.at(-1);
      assert.equal(last.player, 'O');
      assert.equal(last.notation, '1-1');
      assert.equal(last.wonBoard, false);
      assert.equal(last.tiedBoard, true);
      assert.deepEqual(last.tiedCells, TIE_SENDS_TO_ITSELF_LAYOUT);
      // X is sent to big square 0, which is empty again.
      assert.equal(state.currentPlayer, 'X');
      assert.equal(state.targetBoard, 0);
      assert.equal(state.constraint, 'forced');
      assert.deepEqual(state.legalBoards, [0]);
      for (const cell of ALL) assert.equal(isLegalMove(state, 0, cell), true, `cell ${cell}`);

      const next = play([[0, 4]], { from: state });
      assert.deepEqual(next.cells[0], [null, null, null, null, 'X', null, null, null, null]);
    });
  }

  test('tiedCells is a snapshot, not a live reference to the board', () => {
    const state = play(TIE_SENDS_TO_ITSELF);
    const next = play([[0, 4]], { from: state });
    assert.deepEqual(next.history.at(-2).tiedCells, TIE_SENDS_TO_ITSELF_LAYOUT);
    assert.notEqual(next.history.at(-2).tiedCells, next.cells[0]);
  });
});

// ---------------------------------------------------------------- game over

describe('winning the game', () => {
  const wins = [
    { name: 'row', moves: ROW_WIN, winner: 'X', winLine: [0, 1, 2] },
    { name: 'column', moves: COLUMN_WIN, winner: 'O', winLine: [1, 4, 7] },
    { name: 'diagonal', moves: DIAGONAL_WIN, winner: 'X', winLine: [2, 4, 6] },
  ];

  for (const { name, moves, winner, winLine } of wins) {
    for (const mode of BOTH_MODES) {
      test(`${name} of big squares ${winLine} for ${winner} (mode ${mode})`, () => {
        const before = play(moves.slice(0, -1), { mode });
        assert.equal(before.winner, null);
        assert.equal(before.winLine, null);
        assert.notEqual(before.constraint, 'over');
        assert.equal(before.currentPlayer, winner);

        const state = play(moves.slice(-1), { from: before });
        assert.equal(state.winner, winner);
        assert.deepEqual(state.winLine, winLine);
        assert.equal(state.constraint, 'over');
        assert.deepEqual(state.legalBoards, []);
        for (const board of winLine) assert.equal(state.boardWinners[board], winner);
        assert.equal(state.history.length, moves.length);
        assert.equal(state.history.at(-1).wonBoard, true);
        assert.equal(state.history.at(-1).player, winner);
        // currentPlayer keeps its meaning: the player who would have moved.
        assert.equal(state.currentPlayer, winner === 'X' ? 'O' : 'X');
        const [lastBoard, lastCell] = moves.at(-1);
        assert.deepEqual(state.lastMove, { board: lastBoard, cell: lastCell });
        assert.equal(state.targetBoard, lastCell);
      });
    }
  }

  test('two won big squares in a line are not a win', () => {
    const state = play(TWO_BOARDS_WON);
    assert.deepEqual(state.boardWinners.slice(0, 3), ['X', 'X', null]);
    assert.equal(state.winner, null);
    assert.equal(state.constraint, 'forced');
  });

  test('a line completed by the ninth big square is a win, not a draw', () => {
    for (const mode of BOTH_MODES) {
      const state = play(FULL_BIG_BOARD_WIN, { mode });
      assert.deepEqual(state.boardWinners, ['O', 'X', 'X', 'O', 'O', 'X', 'X', 'X', 'X']);
      assert.equal(state.winner, 'X');
      // X completes [6,7,8] and [2,5,8] with the same move. The engine
      // reports the first one in LINES order.
      assert.deepEqual(state.winLine, [6, 7, 8]);
      assert.equal(state.constraint, 'over');
      assert.deepEqual(state.legalBoards, []);
    }
  });
});

describe('drawing the game', () => {
  for (const mode of BOTH_MODES) {
    test(`all nine big squares won with no line (mode ${mode})`, () => {
      const before = play(DRAW_GAME.slice(0, -1), { mode });
      assert.equal(before.winner, null);
      assert.equal(before.boardWinners.filter((w) => w !== null).length, 8);
      assert.deepEqual(before.legalBoards, [5], 'only one big square is still open');

      const state = play(DRAW_GAME.slice(-1), { from: before });
      assert.deepEqual(state.boardWinners, DRAW_OWNERS);
      assert.equal(state.winner, 'draw');
      assert.equal(state.winLine, null);
      assert.equal(state.constraint, 'over');
      assert.deepEqual(state.legalBoards, []);
      assert.equal(state.history.length, DRAW_GAME.length);
      assert.equal(state.history.at(-1).wonBoard, true);
      assert.deepEqual(state.resets, new Array(9).fill(0));

      // Checked here without the engine's help: nobody owns a line of big
      // squares, and every big square really holds its owner's line.
      for (const [a, b, c] of LINES) {
        const owners = new Set([DRAW_OWNERS[a], DRAW_OWNERS[b], DRAW_OWNERS[c]]);
        assert.equal(owners.size, 2, `big-square line ${a},${b},${c} is mixed`);
      }
      for (const board of ALL) {
        const line = state.boardWinLines[board];
        assert.ok(LINES.some((l) => l.join() === line.join()), `big square ${board} line`);
        for (const cell of line) assert.equal(state.cells[board][cell], DRAW_OWNERS[board]);
      }
    });
  }
});

// ------------------------------------------------------------------ setMode

describe('setMode', () => {
  test('recomputes a free-move position both ways', () => {
    for (const [target, line] of [[0, [1, 4, 7]], [1, [3, 4, 5]], [4, [0, 1, 2]]]) {
      const moves = xWinsThenIsSentBack(target, line);
      const inAnywhere = play(moves, { mode: 'anywhere' });
      const inAdjacent = play(moves, { mode: 'adjacent' });
      assert.equal(inAnywhere.constraint, 'free');
      assert.equal(inAdjacent.constraint, 'adjacent');

      const toAdjacent = setMode(inAnywhere, 'adjacent');
      assert.equal(toAdjacent.mode, 'adjacent');
      assert.equal(toAdjacent.constraint, 'adjacent');
      assert.deepEqual(toAdjacent.legalBoards, TOUCHING[target]);
      assert.deepEqual(toAdjacent, inAdjacent, 'same as having played in that mode all along');

      const toAnywhere = setMode(inAdjacent, 'anywhere');
      assert.equal(toAnywhere.mode, 'anywhere');
      assert.equal(toAnywhere.constraint, 'free');
      assert.deepEqual(toAnywhere.legalBoards, ALL.filter((b) => b !== target));
      assert.deepEqual(toAnywhere, inAnywhere);

      assert.deepEqual(setMode(toAdjacent, 'anywhere'), inAnywhere, 'there and back again');
    }
  });

  test('leaves out won touching boards when switching to adjacent', () => {
    const state = setMode(play([...TWO_BOARDS_WON, [5, 0]], { mode: 'anywhere' }), 'adjacent');
    assert.equal(state.constraint, 'adjacent');
    assert.deepEqual(state.legalBoards, [3, 4]);
  });

  test("keeps 'free' when adjacent has nothing open to offer", () => {
    const inAnywhere = play(CORNER_SURROUNDED, { mode: 'anywhere' });
    const inAdjacent = play(CORNER_SURROUNDED, { mode: 'adjacent' });
    const toAdjacent = setMode(inAnywhere, 'adjacent');
    assert.equal(toAdjacent.constraint, 'free');
    assert.deepEqual(toAdjacent.legalBoards, [2, 5, 6, 7, 8]);
    assert.deepEqual(toAdjacent, inAdjacent);
    assert.deepEqual(setMode(inAdjacent, 'anywhere'), inAnywhere);
  });

  test('start, forced and over positions only change mode', () => {
    const positions = {
      start: [],
      forced: [[4, 0]],
      'forced after a board win': TWO_BOARDS_WON,
      'forced after a tie': TIE_SENDS_TO_ITSELF,
      'over (win)': ROW_WIN,
      'over (draw)': DRAW_GAME,
    };
    for (const [name, moves] of Object.entries(positions)) {
      for (const [from, to] of [['anywhere', 'adjacent'], ['adjacent', 'anywhere']]) {
        const state = play(moves, { mode: from });
        assert.ok(['start', 'forced', 'over'].includes(state.constraint), name);
        assert.deepEqual(setMode(state, to), { ...state, mode: to }, `${name}: ${from} -> ${to}`);
      }
    }
  });

  test('the new mode applies to later free moves', () => {
    // Switch during a forced position, then reach the free move.
    const moves = xWinsThenIsSentBack(0, [1, 4, 7]);
    const forced = play(moves.slice(0, 5), { mode: 'anywhere' });
    assert.equal(forced.constraint, 'forced');
    const state = play(moves.slice(5), { from: setMode(forced, 'adjacent') });
    assert.equal(state.mode, 'adjacent');
    assert.equal(state.constraint, 'adjacent');
    assert.deepEqual(state.legalBoards, [1, 3, 4]);
  });

  test('setting the mode it already has changes nothing', () => {
    for (const mode of BOTH_MODES) {
      const state = play(xWinsThenIsSentBack(0, [1, 4, 7]), { mode });
      assert.deepEqual(setMode(state, mode), state);
    }
  });

  test('throws on an unknown mode', () => {
    const state = createGame();
    for (const mode of ['diagonal', 'ANYWHERE', 'Adjacent', '', undefined, null, 0, {}]) {
      assert.throws(() => setMode(state, mode), Error, `mode ${String(mode)}`);
    }
    assert.deepEqual(state, createGame());
  });

  test('returns a new state and does not mutate its input', () => {
    const state = deepFreeze(play(xWinsThenIsSentBack(0, [1, 4, 7])));
    const before = JSON.stringify(state);
    const next = setMode(state, 'adjacent');
    assert.notEqual(next, state);
    assert.equal(JSON.stringify(state), before);
    assert.equal(Object.isFrozen(next.legalBoards), false, 'no array shared with the input');
    assert.equal(Object.isFrozen(next.cells[0]), false);
    assert.equal(Object.isFrozen(next.history[0]), false);
  });
});

// ------------------------------------------------- immutability and plain JSON

describe('state handling', () => {
  // Nothing reachable from `value` is frozen, so nothing in it is shared with
  // a deep-frozen input.
  function assertNothingFrozen(value, path) {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), false, `${path} is shared with the input state`);
    for (const [key, child] of Object.entries(value)) assertNothingFrozen(child, `${path}.${key}`);
  }

  test('applyMove does not mutate its input', () => {
    const games = [ROW_WIN, TIE_SENDS_TO_ITSELF, FULL_BOARD_WIN, DRAW_GAME, FULL_BIG_BOARD_WIN];
    for (const mode of BOTH_MODES) {
      for (const moves of games) {
        let state = createGame({ mode });
        moves.forEach(([board, cell], i) => {
          deepFreeze(state); // a write to a frozen object throws in module code
          const before = JSON.stringify(state);
          const next = applyMove(state, board, cell);
          assert.notEqual(next, state);
          assert.equal(JSON.stringify(state), before, `input changed by move #${i + 1}`);
          assertNothingFrozen(next, 'next');
          state = next;
        });
      }
    }
  });

  test('older states stay usable after later moves (undo stack)', () => {
    const stack = [createGame()];
    for (const [board, cell] of TIE_SENDS_ELSEWHERE) {
      stack.push(applyMove(stack.at(-1), board, cell));
    }
    stack.forEach((state, i) => {
      assert.deepEqual(state, play(TIE_SENDS_ELSEWHERE.slice(0, i)), `state after ${i} moves`);
    });
    // Branch from the middle of the stack.
    const branch = applyMove(stack[9], 0, 6);
    assert.equal(branch.cells[0][6], 'O');
    assert.equal(stack[9].cells[0][6], null);
    assert.equal(stack[10].cells[0][6], null);
  });

  test('state is plain JSON: it survives a round trip and stays playable', () => {
    const games = [DRAW_GAME, FULL_BIG_BOARD_WIN, TIE_SENDS_ELSEWHERE, TIE_SENDS_TO_ITSELF, ROW_WIN];
    for (const mode of BOTH_MODES) {
      for (const moves of games) {
        const direct = play(moves, { mode });
        // Round-trip after every single move and carry on from the copy.
        let state = createGame({ mode });
        moves.forEach(([board, cell], i) => {
          const copy = JSON.parse(JSON.stringify(state));
          assert.deepEqual(copy, state, `round trip before move #${i + 1}`);
          assert.equal(isLegalMove(copy, board, cell), true);
          state = applyMove(copy, board, cell);
        });
        assert.deepEqual(state, direct);
        assert.deepEqual(JSON.parse(JSON.stringify(direct)), direct);
      }
    }
  });

  test('state has exactly the contract keys', () => {
    const stateKeys = [
      'boardWinLines', 'boardWinners', 'cells', 'constraint', 'currentPlayer', 'history',
      'lastMove', 'legalBoards', 'mode', 'resets', 'targetBoard', 'winLine', 'winner',
    ];
    const entryKeys = ['board', 'cell', 'notation', 'player', 'tiedBoard', 'tiedCells', 'wonBoard'];
    for (const moves of [[], [[4, 0]], TIE_SENDS_ELSEWHERE, ROW_WIN, DRAW_GAME]) {
      const state = play(moves);
      assert.deepEqual(Object.keys(state).sort(), stateKeys);
      for (const entry of state.history) assert.deepEqual(Object.keys(entry).sort(), entryKeys);
      if (state.lastMove) assert.deepEqual(Object.keys(state.lastMove).sort(), ['board', 'cell']);
    }
  });
});

// ------------------------------------------------------ neighbors and notation

describe('neighbors', () => {
  for (const board of ALL) {
    test(`big square ${board} touches [${TOUCHING[board]}]`, () => {
      assert.deepEqual(neighbors(board), TOUCHING[board]);
    });
  }

  test('touching is mutual and never includes the square itself', () => {
    for (const a of ALL) {
      assert.equal(neighbors(a).includes(a), false);
      for (const b of neighbors(a)) assert.ok(neighbors(b).includes(a), `${a} <-> ${b}`);
    }
  });

  test('returns a fresh array each call', () => {
    neighbors(0).push(99);
    assert.deepEqual(neighbors(0), [1, 3, 4]);
  });
});

describe('notation', () => {
  test('is 1-indexed "B-C"', () => {
    assert.equal(notation(3, 0), '4-1');
    assert.equal(notation(0, 0), '1-1');
    assert.equal(notation(8, 8), '9-9');
    assert.equal(notation(4, 2), '5-3');
    for (const board of ALL) {
      for (const cell of ALL) assert.equal(notation(board, cell), `${board + 1}-${cell + 1}`);
    }
  });

  test('history entries carry the same notation', () => {
    const state = play(ROW_WIN);
    for (const entry of state.history) {
      assert.equal(entry.notation, notation(entry.board, entry.cell));
    }
  });
});

// ------------------------------------------------------ randomized playthrough

// Small seeded PRNG (mulberry32) so a failing game can be replayed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A second, deliberately separate implementation of the rules, used only to
// cross-check the engine during random play. It shares no code with the
// engine: lines are found by row/column arithmetic and touching squares come
// from the hand-written TOUCHING table.
function threeInARow(squares, p) {
  for (let i = 0; i < 3; i += 1) {
    if (squares[3 * i] === p && squares[3 * i + 1] === p && squares[3 * i + 2] === p) return true;
    if (squares[i] === p && squares[i + 3] === p && squares[i + 6] === p) return true;
  }
  if (squares[0] === p && squares[4] === p && squares[8] === p) return true;
  return squares[2] === p && squares[4] === p && squares[6] === p;
}

function refCreate(mode) {
  return {
    mode,
    marks: ALL.map(EMPTY9),
    owners: EMPTY9(),
    wipes: new Array(9).fill(0),
    toMove: 'X',
    sentTo: null,
    result: null,
  };
}

function refAllowed(ref) {
  if (ref.result !== null) return { kind: 'over', boards: [] };
  const open = ALL.filter((b) => ref.owners[b] === null);
  if (ref.sentTo === null) return { kind: 'start', boards: open };
  if (ref.owners[ref.sentTo] === null) return { kind: 'forced', boards: [ref.sentTo] };
  if (ref.mode === 'adjacent') {
    const near = TOUCHING[ref.sentTo].filter((b) => ref.owners[b] === null);
    if (near.length > 0) return { kind: 'adjacent', boards: near };
  }
  return { kind: 'free', boards: open };
}

function refPlay(ref, board, cell) {
  const p = ref.toMove;
  const outcome = { won: false, tied: null };
  ref.marks[board][cell] = p;
  if (threeInARow(ref.marks[board], p)) {
    outcome.won = true;
    ref.owners[board] = p;
    if (threeInARow(ref.owners, p)) ref.result = p;
    else if (!ref.owners.includes(null)) ref.result = 'draw';
  } else if (!ref.marks[board].includes(null)) {
    outcome.tied = ref.marks[board];
    ref.marks[board] = EMPTY9();
    ref.wipes[board] += 1;
  }
  ref.sentTo = cell;
  ref.toMove = p === 'X' ? 'O' : 'X';
  return outcome;
}

const MOVE_CAP = 2000; // generous: the longest random game seen is well under 200 moves

function checkInvariants(state, ref, movesMade, wonSnapshots) {
  const over = state.winner !== null;

  // The engine agrees with the reference rules.
  assert.equal(state.mode, ref.mode, 'mode');
  assert.deepEqual(state.cells, ref.marks, 'cells');
  assert.deepEqual(state.boardWinners, ref.owners, 'boardWinners');
  assert.deepEqual(state.resets, ref.wipes, 'resets');
  assert.equal(state.currentPlayer, ref.toMove, 'currentPlayer');
  assert.equal(state.targetBoard, ref.sentTo, 'targetBoard');
  assert.equal(state.winner, ref.result, 'winner');
  const allowed = refAllowed(ref);
  assert.equal(state.constraint, allowed.kind, 'constraint');
  assert.deepEqual(state.legalBoards, allowed.boards, 'legalBoards');

  // An open board always has an empty cell.
  for (const board of ALL) {
    if (state.boardWinners[board] === null) {
      assert.ok(state.cells[board].includes(null), `open big square ${board} has no empty cell`);
    }
  }

  // legalBoards is never empty unless the game is over.
  assert.equal(state.legalBoards.length === 0, over, 'legalBoards is empty exactly when over');
  assert.equal(state.constraint === 'over', over, "constraint is 'over' exactly when over");

  // legalBoards contains only open boards, ascending, no repeats.
  state.legalBoards.forEach((board, i) => {
    assert.ok(Number.isInteger(board) && board >= 0 && board <= 8, `legal board ${board}`);
    assert.equal(state.boardWinners[board], null, `legal big square ${board} is won`);
    if (i > 0) assert.ok(state.legalBoards[i - 1] < board, 'legalBoards is ascending');
  });

  // Won boards never change.
  for (const board of ALL) {
    const owner = state.boardWinners[board];
    const line = state.boardWinLines[board];
    if (owner === null) {
      assert.equal(line, null, `open big square ${board} has a win line`);
      assert.equal(wonSnapshots[board], undefined, `big square ${board} was won and is open again`);
      continue;
    }
    assert.ok(LINES.some((l) => l.join() === line.join()), `big square ${board} win line`);
    for (const cell of line) assert.equal(state.cells[board][cell], owner);
    const snapshot = JSON.stringify([owner, line, state.cells[board], state.resets[board]]);
    if (wonSnapshots[board] === undefined) wonSnapshots[board] = snapshot;
    assert.equal(snapshot, wonSnapshots[board], `won big square ${board} changed`);
  }

  // The game result is consistent.
  if (state.winner === 'X' || state.winner === 'O') {
    assert.ok(LINES.some((l) => l.join() === state.winLine.join()), 'winLine is a line');
    for (const board of state.winLine) assert.equal(state.boardWinners[board], state.winner);
  } else {
    assert.equal(state.winLine, null, 'winLine without a winner');
  }
  if (state.winner === 'draw') assert.ok(!state.boardWinners.includes(null));

  // History length equals moves made.
  assert.equal(state.history.length, movesMade, 'history length');

  // isLegalMove agrees with legalBoards and the empty cells, for all 81 squares.
  for (const board of ALL) {
    for (const cell of ALL) {
      const expected = state.legalBoards.includes(board) && state.cells[board][cell] === null;
      assert.equal(isLegalMove(state, board, cell), expected, `isLegalMove ${notation(board, cell)}`);
    }
  }
}

// Plays `games` random games. With `toggle` the mode is flipped with setMode
// at random points mid-game. Returns counts for the report.
function runRandomGames({ mode, games, seed, toggle = false }) {
  const stats = { X: 0, O: 0, draw: 0, unfinished: 0, moves: 0, longest: 0, ties: 0, modeFlips: 0 };

  for (let game = 0; game < games; game += 1) {
    const random = mulberry32(seed + game); // each game replays on its own
    const moves = [];
    try {
      let state = createGame({ mode });
      const ref = refCreate(mode);
      const wonSnapshots = {};
      checkInvariants(state, ref, 0, wonSnapshots);

      while (state.winner === null && moves.length < MOVE_CAP) {
        if (toggle && random() < 0.15) {
          const other = state.mode === 'anywhere' ? 'adjacent' : 'anywhere';
          const before = JSON.stringify(state);
          const switched = setMode(state, other);
          assert.equal(JSON.stringify(state), before, 'setMode changed its input');
          ref.mode = other;
          state = switched;
          stats.modeFlips += 1;
          moves.push(`setMode:${other}`);
          checkInvariants(state, ref, state.history.length, wonSnapshots);
        }

        const options = [];
        for (const board of state.legalBoards) {
          for (const cell of ALL) {
            if (state.cells[board][cell] === null) options.push([board, cell]);
          }
        }
        assert.ok(options.length > 0, 'no legal move although the game is not over');
        const [board, cell] = options[Math.floor(random() * options.length)];
        const player = state.currentPlayer;

        const before = JSON.stringify(state);
        const next = applyMove(state, board, cell);
        assert.equal(JSON.stringify(state), before, 'applyMove changed its input');
        moves.push([board, cell]);

        const outcome = refPlay(ref, board, cell);
        if (outcome.tied) stats.ties += 1;
        assert.deepEqual(next.history.slice(0, -1), state.history, 'earlier history changed');
        assert.deepEqual(
          next.history.at(-1),
          {
            player,
            board,
            cell,
            notation: `${board + 1}-${cell + 1}`,
            wonBoard: outcome.won,
            tiedBoard: outcome.tied !== null,
            tiedCells: outcome.tied,
          },
          'history entry',
        );
        assert.deepEqual(next.lastMove, { board, cell }, 'lastMove');

        state = next;
        checkInvariants(state, ref, state.history.length, wonSnapshots);
      }

      const played = state.history.length;
      assert.equal(played, moves.filter(Array.isArray).length, 'history length equals moves made');
      assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'final state is plain JSON');
      stats.moves += played;
      stats.longest = Math.max(stats.longest, played);
      if (state.winner === null) stats.unfinished += 1;
      else stats[state.winner] += 1;
    } catch (err) {
      err.message =
        `${err.message}\n[random game failed: mode=${mode} toggle=${toggle} seed=${seed} ` +
        `game=${game} (PRNG seed ${seed + game}) after ${moves.length} steps: ${JSON.stringify(moves)}]`;
      throw err;
    }
  }
  return stats;
}

describe('randomized playthrough (seeded)', () => {
  const GAMES = 400;

  function report(t, label, stats) {
    t.diagnostic(
      `${label}: ${GAMES} games, X ${stats.X}, O ${stats.O}, draw ${stats.draw}, ` +
        `unfinished ${stats.unfinished}, mean ${(stats.moves / GAMES).toFixed(1)} moves, ` +
        `longest ${stats.longest}, tie wipes ${stats.ties}` +
        (stats.modeFlips ? `, mode flips ${stats.modeFlips}` : ''),
    );
    assert.equal(
      stats.unfinished,
      0,
      `${stats.unfinished} of ${GAMES} random games did not finish within ${MOVE_CAP} moves`,
    );
    assert.equal(stats.X + stats.O + stats.draw, GAMES);
    // With these seeds every outcome and the tie wipe do come up; if a seed is
    // changed and one of these fails, the run no longer exercises that path.
    assert.ok(stats.X > 0 && stats.O > 0 && stats.draw > 0, 'every outcome should occur');
    assert.ok(stats.ties > 0, 'at least one tie wipe should occur');
  }

  test("mode 'anywhere': invariants hold after every move", (t) => {
    report(t, 'anywhere', runRandomGames({ mode: 'anywhere', games: GAMES, seed: 20261115 }));
  });

  test("mode 'adjacent': invariants hold after every move", (t) => {
    report(t, 'adjacent', runRandomGames({ mode: 'adjacent', games: GAMES, seed: 715517 }));
  });

  test('mode flipped at random mid-game with setMode: invariants hold', (t) => {
    const stats = runRandomGames({ mode: 'anywhere', games: GAMES, seed: 90210, toggle: true });
    report(t, 'mixed', stats);
    assert.ok(stats.modeFlips > 0);
  });
});
