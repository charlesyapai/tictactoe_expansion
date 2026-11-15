// Interface for Tic-Tac-Toe Expansion.
//
// All rules live in engine.js. This file keeps the current state, an undo
// stack and the settings, draws them, and turns clicks into engine calls.
// It never works out legality itself: it asks isLegalMove and reads
// state.legalBoards.
//
// URL parameters (all optional):
//   ?moves=4-1,1-5,5-5   replay these moves on load. Nothing is read from or
//                        written to localStorage while this is present.
//   ?mode=anywhere|adjacent
//   ?opponent=two|computer   &level=easy|medium|hard   &side=X|O
//   ?numbers=1
//   ?theme=light|dark

import { MODES, createGame, isLegalMove, applyMove, setMode } from './engine.js';

const STORAGE_KEY = 'tictactoe-expansion:v1';
const TIE_FLASH_MS = 900;
const AI_DELAY_MS = 450;

const MODE_VALUES = Object.values(MODES);
const OPPONENTS = ['human', 'computer'];
const LEVEL_VALUES = ['easy', 'medium', 'hard'];
const SIDES = ['X', 'O'];
const CONSTRAINTS = ['start', 'forced', 'free', 'adjacent', 'over'];

const MODE_NOTES = {
  [MODES.ANYWHERE]: 'If you are sent to a won square, you can play in any open square.',
  [MODES.ADJACENT]: 'If you are sent to a won square, you can play in any open square that touches it.',
};

const AI_NOTES = {
  missing: 'The computer opponent could not be loaded.',
  failed: 'The computer opponent stopped working. This game is now for two players.',
};

const CONFIRM_TEXT = {
  newGame: 'Start a new game? This one will be lost.',
  change: 'This change starts a new game. The current one will be lost.',
};

// ---------- App state ----------

const app = {
  state: null,
  undo: [],              // earlier states, oldest first; one per move played
  mode: MODES.ANYWHERE,
  showNumbers: false,
  opponent: 'human',     // 'human' (two players) or 'computer'
  level: 'medium',
  side: 'X',             // the human's mark in a computer game
  persist: true,

  ai: null,              // the ai.js module once loaded
  aiStatus: 'loading',   // 'loading' | 'ready' | 'missing' | 'failed'
  aiToken: 0,            // bumped to cancel a pending computer reply
  aiTimer: null,
  ignoreClicksBefore: 0, // clicks stamped earlier than this are dropped (see scheduleComputer)

  confirm: null,         // { text, apply } while the inline confirm is open
  tieFlash: null,        // { board, cells, timer } while a tied square is shown
  hover: null,           // { board, cell } under a mouse pointer, if any
  focus: null,           // { board, cell } holding keyboard focus, if any
  pop: null,             // { board, cell, wonBoard } for the landing animation
  keyboard: false,       // the last board input came from the keyboard
};

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);

const dom = {
  app: $('app'),
  board: $('board'),
  status: $('status'),
  statusText: $('status-text'),
  playAgain: $('play-again'),
  newGame: $('new-game'),
  undo: $('undo'),
  confirm: $('confirm'),
  confirmText: $('confirm-text'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  aiNote: $('ai-note'),
  rowLevel: $('row-level'),
  rowSide: $('row-side'),
  modeNote: $('mode-note'),
  numbers: $('numbers'),
  movesList: $('moves-list'),
  movesEmpty: $('moves-empty'),
  help: $('help'),
  helpOpen: $('help-open'),
  helpClose: $('help-close'),
};

const radios = (name) => Array.from(document.querySelectorAll(`input[name="${name}"]`));

const MARK_SHAPES =
  '<path class="mark-x" d="M27 27 73 73M73 27 27 73"/><circle class="mark-o" cx="50" cy="50" r="25"/>';

const squares = [];      // squares[board] = { el, cells[9], resets, hint }
// Larger shapes for the mark laid over a won big square.
const BIG_MARK_SHAPES =
  '<path class="mark-x" d="M19 19 81 81M81 19 19 81"/><circle class="mark-o" cx="50" cy="50" r="33"/>';

let activeCell = null;   // the one small square in the tab order
let ghostCell = null;
let targetSquare = null;
let poppedCell = null;
let renderedHistory = null;

function buildBoard() {
  for (let b = 0; b < 9; b += 1) {
    const sq = document.createElement('div');
    sq.className = 'sq';
    sq.dataset.board = String(b);
    sq.setAttribute('role', 'group');

    const grid = document.createElement('div');
    grid.className = 'sq-grid';
    const cells = [];
    for (let c = 0; c < 9; c += 1) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.dataset.board = String(b);
      btn.dataset.cell = String(c);
      btn.tabIndex = -1;
      btn.innerHTML =
        `<svg class="mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${MARK_SHAPES}</svg>` +
        `<span class="cell-num" aria-hidden="true">${c + 1}</span>`;
      grid.append(btn);
      cells.push(btn);
    }

    const extras = document.createElement('div');
    extras.setAttribute('aria-hidden', 'true');
    extras.innerHTML =
      `<div class="sq-won"><svg viewBox="0 0 100 100" focusable="false">${BIG_MARK_SHAPES}</svg></div>` +
      `<span class="sq-num">${b + 1}</span>` +
      '<span class="sq-resets" hidden></span>' +
      '<div class="sq-tie"><span>Tie, square reset</span></div>' +
      '<span class="sq-hint"></span>';

    sq.append(grid, extras);
    dom.board.append(sq);
    squares.push({
      el: sq,
      cells,
      resets: extras.querySelector('.sq-resets'),
      hint: extras.querySelector('.sq-hint'),
    });
  }
}

// ---------- Small helpers ----------

const other = (player) => (player === 'X' ? 'O' : 'X');
const isOver = () => app.state.winner !== null;
const vsComputer = () => app.opponent === 'computer';

function isComputerTurn() {
  return vsComputer() && !isOver() && app.state.currentPlayer !== app.side;
}

// "2", "2 or 4", "2, 4 or 5"
function listBoards(boards) {
  const names = boards.map((b) => String(b + 1));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function statusText(s) {
  const computer = vsComputer();
  if (s.winner === 'draw') return 'Draw';
  if (s.winner) {
    if (!computer) return `${s.winner} wins`;
    return s.winner === app.side ? 'You win' : 'Computer wins';
  }
  if (isComputerTurn()) return 'Computer is thinking';

  const p = s.currentPlayer;
  const where = `big square${s.legalBoards.length === 1 ? '' : 's'} ${listBoards(s.legalBoards)}`;
  switch (s.constraint) {
    case 'start':
      return computer ? 'Your move, anywhere' : `${p} to move, anywhere`;
    case 'forced':
      return computer ? `Your move in ${where}` : `${p} to move in ${where}`;
    case 'adjacent':
      return computer ? `Your free move: ${where}` : `${p} has a free move: ${where}`;
    default:
      return computer ? 'Your free move: anywhere open' : `${p} has a free move: anywhere open`;
  }
}

function setData(el, key, value) {
  if (value === null || value === undefined) delete el.dataset[key];
  else if (el.dataset[key] !== value) el.dataset[key] = value;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ---------- Render ----------

function render() {
  const s = app.state;
  dom.app.dataset.turn = s.currentPlayer;
  dom.app.dataset.numbers = app.showNumbers ? 'on' : 'off';
  dom.app.dataset.over = s.winner === null ? 'no' : s.winner === 'draw' ? 'draw' : 'win';
  renderBoard(s);
  renderPreview();
  renderStatus(s);
  renderControls(s);
  renderMoves(s);
}

function renderBoard(s) {
  const over = isOver();
  const humanTurn = !over && !isComputerTurn();
  const flash = app.tieFlash;
  const pop = app.pop;
  app.pop = null;

  if (poppedCell) poppedCell.classList.remove('pop');
  poppedCell = null;

  for (let b = 0; b < 9; b += 1) {
    const sq = squares[b];
    const winner = s.boardWinners[b];
    const legal = s.legalBoards.includes(b);
    const winLine = s.boardWinLines[b];
    const flashing = flash !== null && flash.board === b;

    sq.el.classList.toggle('is-legal', legal);
    sq.el.classList.toggle('is-won', winner !== null);
    sq.el.classList.toggle('is-gameline', Array.isArray(s.winLine) && s.winLine.includes(b));
    sq.el.classList.toggle('is-tie-flash', flashing);
    sq.el.classList.toggle('pop', pop !== null && pop.wonBoard && pop.board === b);
    setData(sq.el, 'winner', winner);

    let label = `Big square ${b + 1}`;
    if (winner) label += `, won by ${winner}`;
    else if (legal) label += ', open for this move';
    sq.el.setAttribute('aria-label', label);

    const resets = s.resets[b];
    sq.resets.hidden = resets === 0;
    if (resets > 0) setText(sq.resets, resets === 1 ? '1 reset' : `${resets} resets`);

    for (let c = 0; c < 9; c += 1) {
      const btn = sq.cells[c];
      const mark = s.cells[b][c];
      const open = humanTurn && isLegalMove(s, b, c);
      const isLast = s.lastMove !== null && s.lastMove.board === b && s.lastMove.cell === c;

      // While a tie is being shown, draw the layout from before the wipe.
      setData(btn, 'mark', flashing ? flash.cells[c] : mark);
      btn.classList.toggle('is-open', open);
      btn.classList.toggle('is-last', isLast);
      btn.classList.toggle('is-winline', Array.isArray(winLine) && winLine.includes(c));
      btn.setAttribute('aria-disabled', open ? 'false' : 'true');
      btn.setAttribute(
        'aria-label',
        `Big ${b + 1}, small ${c + 1}, ${mark ?? 'empty'}${isLast ? ', last move' : ''}`,
      );

      if (pop !== null && pop.board === b && pop.cell === c) {
        btn.classList.add('pop');
        poppedCell = btn;
      }
    }
  }

  updateTabStop();
}

// One small square is in the tab order. Arrow keys move from there.
function updateTabStop() {
  const focused = document.activeElement;
  let next = focused && focused.classList.contains('cell') ? focused : firstOpenCell();
  if (!next) next = activeCell ?? squares[4].cells[4];
  if (activeCell && activeCell !== next) activeCell.tabIndex = -1;
  next.tabIndex = 0;
  activeCell = next;
}

function firstOpenCell() {
  for (const b of app.state.legalBoards) {
    const btn = squares[b].cells.find((cell) => cell.classList.contains('is-open'));
    if (btn) return btn;
  }
  return null;
}

// Ghost mark on the hovered or focused square, plus a marker on the big
// square that move would send the other player to.
function renderPreview() {
  if (ghostCell) delete ghostCell.dataset.ghost;
  if (targetSquare) targetSquare.el.classList.remove('is-target', 'is-target-free');
  ghostCell = null;
  targetSquare = null;

  // The pointer wins over keyboard focus. Either one only counts while it
  // rests on a square the player could take right now.
  const s = app.state;
  if (isComputerTurn()) return;
  const p = [app.hover, app.focus].find((at) => at && isLegalMove(s, at.board, at.cell));
  if (!p) return;

  // A tied square still shows its old marks for a moment. No ghost over those.
  if (app.tieFlash && app.tieFlash.board === p.board) return;

  ghostCell = squares[p.board].cells[p.cell];
  ghostCell.dataset.ghost = s.currentPlayer;

  // The move sends the other player to the big square with the same number
  // as the small square. Ask the engine what the move leads to: the target
  // may already be won, or this move may win it, and then they get a free
  // move. A move that ends the game sends nobody anywhere.
  const after = applyMove(s, p.board, p.cell);
  if (after.winner !== null) return;
  targetSquare = squares[p.cell];
  const free = after.constraint !== 'forced';
  const who = other(s.currentPlayer);
  let hint;
  if (vsComputer()) hint = free ? 'Free move for computer' : 'Computer goes here';
  else hint = free ? `Free move for ${who}` : `${who} goes here`;
  setText(targetSquare.hint, hint);
  targetSquare.el.classList.add(free ? 'is-target-free' : 'is-target');
}

function setPreviewSource(source, at) {
  const was = app[source];
  if (was === at) return;
  if (was && at && was.board === at.board && was.cell === at.cell) return;
  app[source] = at;
  renderPreview();
}

function renderStatus(s) {
  let player = s.currentPlayer;
  if (s.winner === 'draw') player = 'none';
  else if (s.winner) player = s.winner;
  dom.status.dataset.player = player;
  dom.status.dataset.thinking = isComputerTurn() ? 'true' : 'false';
  setText(dom.statusText, statusText(s));
  dom.playAgain.hidden = !isOver();
}

function renderControls() {
  dom.undo.disabled = undoSteps() === 0;

  const aiDown = app.aiStatus === 'missing' || app.aiStatus === 'failed';
  for (const input of radios('opponent')) {
    input.checked = input.value === app.opponent;
    if (input.value === 'computer') input.disabled = aiDown;
  }
  for (const input of radios('level')) input.checked = input.value === app.level;
  for (const input of radios('side')) input.checked = input.value === app.side;
  for (const input of radios('mode')) input.checked = input.value === app.mode;

  dom.rowLevel.hidden = !vsComputer();
  dom.rowSide.hidden = !vsComputer();
  dom.aiNote.hidden = !aiDown;
  if (aiDown) setText(dom.aiNote, AI_NOTES[app.aiStatus]);
  setText(dom.modeNote, MODE_NOTES[app.mode]);
  dom.numbers.checked = app.showNumbers;

  dom.confirm.hidden = app.confirm === null;
  if (app.confirm) setText(dom.confirmText, app.confirm.text);
}

function renderMoves(s) {
  if (s.history === renderedHistory) return;
  renderedHistory = s.history;

  const items = s.history.map((entry, i) => {
    const li = document.createElement('li');
    const isLatest = i === s.history.length - 1;
    if (isLatest) li.className = 'is-latest';

    let tag = '';
    let detail = '';
    if (entry.wonBoard) {
      const wonGame = isLatest && (s.winner === 'X' || s.winner === 'O');
      tag = wonGame ? 'won game' : 'won';
      detail = wonGame
        ? `Won big square ${entry.board + 1} and the game`
        : `Won big square ${entry.board + 1}`;
    } else if (entry.tiedBoard) {
      tag = 'tie';
      detail = `Tied big square ${entry.board + 1}, which was reset`;
    }

    const n = document.createElement('span');
    n.className = 'mv-n';
    n.textContent = `${i + 1}.`;
    const p = document.createElement('span');
    p.className = 'mv-p';
    p.dataset.player = entry.player;
    p.textContent = entry.player;
    const t = document.createElement('span');
    t.className = 'mv-t';
    t.textContent = entry.notation;
    li.append(n, p, t);
    if (tag) {
      const g = document.createElement('span');
      g.className = 'mv-tag';
      g.textContent = tag;
      g.title = detail;
      li.append(g);
    }
    return li;
  });

  dom.movesList.replaceChildren(...items);
  dom.movesEmpty.hidden = items.length > 0;
  dom.movesList.scrollTop = dom.movesList.scrollHeight;
}

// ---------- Playing ----------

function commitMove(board, cell) {
  if (app.tieFlash && app.tieFlash.board === board) clearTieFlash();
  app.undo.push(app.state);
  app.state = applyMove(app.state, board, cell);

  const last = app.state.history[app.state.history.length - 1];
  app.pop = { board, cell, wonBoard: last.wonBoard };
  if (last.tiedBoard && Array.isArray(last.tiedCells)) startTieFlash(board, last.tiedCells);

  render();
  save();
  scheduleComputer();
  followWithFocus();
}

function playHuman(board, cell) {
  if (isComputerTurn() || !isLegalMove(app.state, board, cell)) return;
  app.confirm = null;
  commitMove(board, cell);
}

// For keyboard players: after a move, put focus where the next move can go.
function followWithFocus() {
  if (!app.keyboard || isOver() || isComputerTurn()) return;
  if (!dom.board.contains(document.activeElement)) return;
  const next = firstOpenCell();
  if (next && next !== document.activeElement) next.focus();
}

function startTieFlash(board, cells) {
  clearTieFlash();
  const timer = setTimeout(() => {
    app.tieFlash = null;
    render();
  }, TIE_FLASH_MS);
  app.tieFlash = { board, cells, timer };
}

function clearTieFlash() {
  if (!app.tieFlash) return;
  clearTimeout(app.tieFlash.timer);
  app.tieFlash = null;
}

function startNewGame() {
  cancelComputer();
  clearTieFlash();
  app.state = createGame({ mode: app.mode });
  app.undo = [];
  app.confirm = null;
  render();
  save();
  scheduleComputer();
}

// How many states Undo takes off the stack. Against the computer it goes back
// to the human's previous turn, so it removes the reply and the human's move.
function undoSteps() {
  if (!vsComputer()) return app.undo.length > 0 ? 1 : 0;
  for (let i = app.undo.length - 1; i >= 0; i -= 1) {
    if (app.undo[i].currentPlayer === app.side) return app.undo.length - i;
  }
  return 0;
}

function undoMove() {
  const steps = undoSteps();
  if (steps === 0) return;
  cancelComputer();
  clearTieFlash();
  let restored = app.state;
  for (let i = 0; i < steps; i += 1) restored = app.undo.pop();
  app.state = setMode(restored, app.mode);
  app.confirm = null;
  render();
  save();
  scheduleComputer();
}

// A game in progress that the player would lose by starting over.
function gameInProgress() {
  if (isOver()) return false;
  const computerOpened = vsComputer() && app.side === 'O';
  return app.state.history.length > (computerOpened ? 1 : 0);
}

function askConfirm(text, apply) {
  app.confirm = { text, apply };
  render();
  dom.confirm.scrollIntoView({ block: 'nearest' });
  dom.confirmYes.focus({ preventScroll: true });
}

function restartWith(change) {
  const apply = () => {
    change();
    startNewGame();
  };
  if (gameInProgress()) askConfirm(CONFIRM_TEXT.change, apply);
  else apply();
}

// ---------- Computer opponent ----------

function cancelComputer() {
  app.aiToken += 1;
  if (app.aiTimer !== null) clearTimeout(app.aiTimer);
  app.aiTimer = null;
}

// Called after every change of position. The reply is worked out from a timer
// so the human's move is painted first, and it is dropped if anything
// (New game, Undo, a settings change) cancelled it in the meantime.
function scheduleComputer() {
  cancelComputer();
  if (!isComputerTurn() || app.aiStatus !== 'ready') return;
  const token = app.aiToken;
  app.aiTimer = setTimeout(() => {
    app.aiTimer = null;
    if (token !== app.aiToken || !isComputerTurn()) return;
    let move = null;
    try {
      move = app.ai.chooseMove(app.state, { level: app.level });
    } catch (err) {
      console.error(err);
    }
    if (token !== app.aiToken) return;
    // The search blocks the page. Clicks made meanwhile arrive after the
    // reply is on the board, and must not count as the human's next move.
    app.ignoreClicksBefore = performance.now();
    if (!move || !isLegalMove(app.state, move.board, move.cell)) {
      computerUnavailable('failed');
      return;
    }
    commitMove(move.board, move.cell);
  }, AI_DELAY_MS);
}

function computerUnavailable(status) {
  cancelComputer();
  app.confirm = null;
  app.aiStatus = status;
  if (vsComputer()) app.opponent = 'human';
  render();
}

// ai.js is loaded on its own so the two-player game works without it.
async function loadComputer() {
  try {
    const mod = await import('./ai.js');
    if (typeof mod.chooseMove !== 'function') throw new Error('ai.js has no chooseMove');
    app.ai = mod;
    app.aiStatus = 'ready';
    render();
    scheduleComputer();
  } catch (err) {
    console.warn('Computer opponent not available.', err);
    computerUnavailable('missing');
  }
}

// ---------- Persistence ----------

const isMark = (v) => v === null || v === 'X' || v === 'O';
const isIndex = (v) => Number.isInteger(v) && v >= 0 && v <= 8;
const isTriple = (v) => Array.isArray(v) && v.length === 3 && v.every(isIndex);
const isNine = (v, test) => Array.isArray(v) && v.length === 9 && v.every(test);

function isValidEntry(e) {
  return (
    e !== null &&
    typeof e === 'object' &&
    SIDES.includes(e.player) &&
    isIndex(e.board) &&
    isIndex(e.cell) &&
    typeof e.notation === 'string' &&
    typeof e.wonBoard === 'boolean' &&
    typeof e.tiedBoard === 'boolean' &&
    (e.tiedCells === null || isNine(e.tiedCells, isMark))
  );
}

function isValidState(s) {
  return (
    s !== null &&
    typeof s === 'object' &&
    MODE_VALUES.includes(s.mode) &&
    isNine(s.cells, (small) => isNine(small, isMark)) &&
    isNine(s.boardWinners, isMark) &&
    isNine(s.boardWinLines, (line) => line === null || isTriple(line)) &&
    isNine(s.resets, (n) => Number.isInteger(n) && n >= 0) &&
    SIDES.includes(s.currentPlayer) &&
    (s.targetBoard === null || isIndex(s.targetBoard)) &&
    Array.isArray(s.legalBoards) &&
    s.legalBoards.length <= 9 &&
    s.legalBoards.every(isIndex) &&
    CONSTRAINTS.includes(s.constraint) &&
    (s.winner === null || s.winner === 'draw' || SIDES.includes(s.winner)) &&
    (s.winner === null
      ? s.legalBoards.length > 0 && s.constraint !== 'over'
      : s.legalBoards.length === 0 && s.constraint === 'over') &&
    (s.winLine === null || isTriple(s.winLine)) &&
    (s.lastMove === null ||
      (typeof s.lastMove === 'object' && isIndex(s.lastMove.board) && isIndex(s.lastMove.cell))) &&
    Array.isArray(s.history) &&
    s.history.every(isValidEntry)
  );
}

// Each undo entry is the state before move i, so its history is the first i
// entries of the current one. It is left out when saving and put back on load.
function save() {
  if (!app.persist) return;
  try {
    const data = {
      v: 1,
      mode: app.mode,
      showNumbers: app.showNumbers,
      opponent: app.opponent,
      level: app.level,
      side: app.side,
      state: app.state,
      undo: app.undo.map((entry) => ({ ...entry, history: undefined })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage is full or blocked. The game still works without it.
  }
}

function loadSaved() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    const ok =
      data !== null &&
      typeof data === 'object' &&
      data.v === 1 &&
      MODE_VALUES.includes(data.mode) &&
      typeof data.showNumbers === 'boolean' &&
      OPPONENTS.includes(data.opponent) &&
      LEVEL_VALUES.includes(data.level) &&
      SIDES.includes(data.side) &&
      isValidState(data.state) &&
      Array.isArray(data.undo) &&
      data.undo.length === data.state.history.length;
    if (!ok) throw new Error('Saved game has the wrong shape');

    const undo = data.undo.map((entry, i) => ({
      ...entry,
      history: data.state.history.slice(0, i),
    }));
    if (!undo.every(isValidState)) throw new Error('Saved undo stack has the wrong shape');

    return {
      mode: data.mode,
      showNumbers: data.showNumbers,
      opponent: data.opponent,
      level: data.level,
      side: data.side,
      state: setMode(data.state, data.mode),
      undo,
    };
  } catch (err) {
    console.warn('Saved game discarded.', err);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing more to do.
    }
    return null;
  }
}

// ---------- Start-up ----------

function replayMoves(text) {
  let state = createGame({ mode: app.mode });
  const undo = [];
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  for (const token of tokens) {
    const match = /^([1-9])-([1-9])$/.exec(token);
    const board = match ? Number(match[1]) - 1 : -1;
    const cell = match ? Number(match[2]) - 1 : -1;
    if (!isLegalMove(state, board, cell)) {
      console.warn(`Replay stopped at "${token}": not a legal move here.`);
      break;
    }
    undo.push(state);
    state = applyMove(state, board, cell);
  }
  return { state, undo };
}

function applyTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  document.documentElement.dataset.theme = theme;
  const colour = theme === 'dark' ? '#161513' : '#f1eee8';
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', colour);
  }
}

function start() {
  const params = new URLSearchParams(window.location.search);
  applyTheme(params.get('theme'));
  buildBoard();

  const replaying = params.has('moves');
  app.persist = !replaying;
  const saved = replaying ? null : loadSaved();
  if (saved) {
    app.mode = saved.mode;
    app.showNumbers = saved.showNumbers;
    app.opponent = saved.opponent;
    app.level = saved.level;
    app.side = saved.side;
  }

  // Settings in the URL win over saved ones.
  const mode = params.get('mode') === 'touching' ? MODES.ADJACENT : params.get('mode');
  if (MODE_VALUES.includes(mode)) app.mode = mode;
  if (params.has('numbers')) app.showNumbers = !['0', 'off', 'false'].includes(params.get('numbers'));
  const level = (params.get('level') ?? '').toLowerCase();
  if (LEVEL_VALUES.includes(level)) app.level = level;

  let opponent = (params.get('opponent') ?? '').toLowerCase();
  if (opponent === 'two' || opponent === 'human') opponent = 'human';
  const side = (params.get('side') ?? '').toUpperCase();
  const before = `${app.opponent}/${app.side}`;
  if (OPPONENTS.includes(opponent)) app.opponent = opponent;
  if (SIDES.includes(side)) app.side = side;
  const sameSeats = before === `${app.opponent}/${app.side}`;

  if (replaying) {
    const replay = replayMoves(params.get('moves'));
    app.state = replay.state;
    app.undo = replay.undo;
  } else if (saved && sameSeats) {
    app.state = setMode(saved.state, app.mode);
    app.undo = saved.undo;
  } else {
    app.state = createGame({ mode: app.mode });
    app.undo = [];
  }

  bindEvents();
  render();
  loadComputer();
}

// ---------- Events ----------

function cellFrom(target) {
  const btn = target instanceof Element ? target.closest('.cell') : null;
  if (!btn || !dom.board.contains(btn)) return null;
  return { btn, board: Number(btn.dataset.board), cell: Number(btn.dataset.cell) };
}

function moveFocus(from, dRow, dCol) {
  const row = Math.floor(from.board / 3) * 3 + Math.floor(from.cell / 3) + dRow;
  const col = (from.board % 3) * 3 + (from.cell % 3) + dCol;
  if (row < 0 || row > 8 || col < 0 || col > 8) return;
  const board = Math.floor(row / 3) * 3 + Math.floor(col / 3);
  const cell = (row % 3) * 3 + (col % 3);
  squares[board].cells[cell].focus();
}

function bindEvents() {
  const canHover = window.matchMedia('(hover: hover)');

  // A held Enter key repeats. Each move puts focus on the next legal square,
  // so without this one long press would play a string of moves.
  document.addEventListener('keydown', (e) => {
    if (e.repeat && e.key === 'Enter' && e.target instanceof HTMLButtonElement) e.preventDefault();
  });

  dom.board.addEventListener('click', (e) => {
    const hit = cellFrom(e.target);
    if (!hit) return;
    if (e.timeStamp < app.ignoreClicksBefore) return;
    app.keyboard = e.detail === 0;
    playHuman(hit.board, hit.cell);
  });

  dom.board.addEventListener('keydown', (e) => {
    const hit = cellFrom(e.target);
    if (!hit) return;
    const steps = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = steps[e.key];
    if (!step) return;
    e.preventDefault();
    app.keyboard = true;
    moveFocus(hit, step[0], step[1]);
  });

  // Hover preview, for devices with a real pointer only.
  dom.board.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || !canHover.matches) return;
    const hit = cellFrom(e.target);
    setPreviewSource('hover', hit ? { board: hit.board, cell: hit.cell } : null);
  });
  dom.board.addEventListener('pointerleave', () => setPreviewSource('hover', null));

  // The same preview for keyboard focus.
  dom.board.addEventListener('focusin', (e) => {
    const hit = cellFrom(e.target);
    if (!hit) return;
    if (activeCell && activeCell !== hit.btn) activeCell.tabIndex = -1;
    hit.btn.tabIndex = 0;
    activeCell = hit.btn;
    const shown = hit.btn.matches(':focus-visible');
    setPreviewSource('focus', shown ? { board: hit.board, cell: hit.cell } : null);
  });
  dom.board.addEventListener('focusout', () => setPreviewSource('focus', null));

  dom.newGame.addEventListener('click', () => {
    if (gameInProgress()) askConfirm(CONFIRM_TEXT.newGame, startNewGame);
    else startNewGame();
  });
  dom.playAgain.addEventListener('click', () => {
    startNewGame();
    dom.newGame.focus({ preventScroll: true });
  });
  dom.undo.addEventListener('click', () => {
    undoMove();
    if (dom.undo.disabled) dom.newGame.focus({ preventScroll: true });
  });

  dom.confirmYes.addEventListener('click', () => {
    const pending = app.confirm;
    app.confirm = null;
    if (pending) pending.apply();
    else render();
    dom.newGame.focus({ preventScroll: true });
  });
  dom.confirmNo.addEventListener('click', () => {
    app.confirm = null;
    render();
    dom.newGame.focus({ preventScroll: true });
  });

  for (const input of radios('opponent')) {
    input.addEventListener('change', () => {
      const value = input.value;
      if (value === app.opponent) return;
      restartWith(() => {
        app.opponent = value;
      });
      render();
    });
  }
  for (const input of radios('side')) {
    input.addEventListener('change', () => {
      const value = input.value;
      if (value === app.side) return;
      restartWith(() => {
        app.side = value;
      });
      render();
    });
  }
  for (const input of radios('level')) {
    input.addEventListener('change', () => {
      app.level = input.value;
      render();
      save();
    });
  }
  for (const input of radios('mode')) {
    input.addEventListener('change', () => {
      app.mode = input.value;
      app.state = setMode(app.state, app.mode);
      render();
      save();
    });
  }
  dom.numbers.addEventListener('change', () => {
    app.showNumbers = dom.numbers.checked;
    render();
    save();
  });

  dom.helpOpen.addEventListener('click', () => {
    if (typeof dom.help.showModal === 'function') dom.help.showModal();
    else dom.help.setAttribute('open', '');
  });
  dom.helpClose.addEventListener('click', () => dom.help.close());
  dom.help.addEventListener('click', (e) => {
    if (e.target === dom.help) dom.help.close();
  });
}

start();
