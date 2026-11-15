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
//   ?tie=reset|stay
//   ?clock=1|3|5|10      minutes each. For testing, ?clock=8s gives 8 seconds.
//   ?inc=0|2|5|10        seconds added after each move
//   ?opponent=two|computer   &level=easy|medium|hard   &side=X|O
//   ?numbers=1
//   ?theme=light|dark

import {
  MODES,
  TIE_RULES,
  createGame,
  isLegalMove,
  applyMove,
  setMode,
  forfeit,
} from './engine.js';

// The key keeps its first name so games saved by the first release are found.
// The data inside carries its own version number (see loadSaved).
const STORAGE_KEY = 'tictactoe-expansion:v1';
const SAVE_VERSION = 2;
const TIE_FLASH_MS = 900;

// The computer waits a moment before it replies so the human's move is seen
// first. Short on clock time, it waits less and searches less.
const AI_DELAY_MS = 450;
const AI_DELAY_LOW_MS = 150;
const AI_LOW_CLOCK_MS = 20000;
const AI_MIN_BUDGET_MS = 30;
const AI_LEVEL_BUDGET_MS = { easy: 0, medium: 150, hard: 600 };

const LOW_TIME_MS = 10000;     // under this a clock shows tenths and a warning
const MAX_CLOCK_SECONDS = 3600;

const MODE_VALUES = Object.values(MODES);
const TIE_VALUES = Object.values(TIE_RULES);
const OPPONENTS = ['human', 'computer'];
const LEVEL_VALUES = ['easy', 'medium', 'hard'];
const SIDES = ['X', 'O'];
const CONSTRAINTS = ['start', 'forced', 'free', 'adjacent', 'over'];
const ENDINGS = [null, 'line', 'full', 'time'];
const CLOCK_MINUTES = [1, 3, 5, 10];
const INCREMENTS = [0, 2, 5, 10];

// The free-move note names the squares that give a free move: won ones, and
// tied ones too when ties stay closed.
const MODE_NOTES = {
  [MODES.ANYWHERE]: 'If you are sent to a %s square, you can play in any open square.',
  [MODES.ADJACENT]: 'If you are sent to a %s square, you can play in any open square that touches it.',
};

const TIE_NOTES = {
  [TIE_RULES.RESET]: 'A tied square is wiped clean and stays in play.',
  [TIE_RULES.STAY]: 'A tied square stays as it is. Nobody can play in it again.',
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
  tieRule: TIE_RULES.RESET, // fixed for a game
  showNumbers: false,
  opponent: 'human',     // 'human' (two players) or 'computer'
  level: 'medium',
  side: 'X',             // the human's mark in a computer game
  persist: true,
  settingsOpen: null,    // true or false once the player has opened or closed Settings

  // Clock. Times are in milliseconds. `remaining` is exact whenever startedAt
  // is null; while a clock runs, the time since startedAt still has to come off
  // the runner's figure (see timeLeft).
  clockBase: 0,          // seconds each for the whole game; 0 means no clock
  clockInc: 0,           // seconds added to the mover's clock after each move
  clock: { remaining: { X: 0, O: 0 }, runner: null, startedAt: null, paused: false },
  clockAt: { X: 0, O: 0 }, // what both clocks showed when this position came up
  clockUndo: [],         // the same for every entry of `undo`
  tickTimer: null,

  ai: null,              // the ai.js module once loaded
  aiStatus: 'loading',   // 'loading' | 'ready' | 'missing' | 'failed'
  aiToken: 0,            // bumped to cancel a pending computer reply
  aiTimer: null,
  ignoreClicksBefore: 0, // clicks stamped earlier than this are dropped (see scheduleComputer)

  confirm: null,         // { text, apply } while the inline confirm is open
  tieFlash: null,        // { board, cells, timer } while a tied square is shown
  hover: null,           // { board, cell } under a mouse pointer, if any
  focus: null,           // { board, cell } holding keyboard focus, if any
  pop: null,             // { board, cell, wonBoard, closedBoard } for the landing animation
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
  clocks: $('clocks'),
  clockFace: { X: $('clock-x'), O: $('clock-o') },
  clockTime: { X: $('clock-time-x'), O: $('clock-time-o') },
  pause: $('pause'),
  paused: $('paused'),
  resume: $('resume'),
  newGame: $('new-game'),
  undo: $('undo'),
  confirm: $('confirm'),
  confirmText: $('confirm-text'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  settings: $('settings'),
  settingsSummary: $('settings-summary'),
  aiNote: $('ai-note'),
  rowLevel: $('row-level'),
  rowSide: $('row-side'),
  rowInc: $('row-inc'),
  modeNote: $('mode-note'),
  tieNote: $('tie-note'),
  clockNote: $('clock-note'),
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
      '<div class="sq-closed"><span>Tie</span></div>' +
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
  if (s.winner && s.endedBy === 'time') {
    const loser = other(s.winner);
    if (!computer) return `${loser} ran out of time. ${s.winner} wins.`;
    return loser === app.side
      ? 'You ran out of time. Computer wins.'
      : 'Computer ran out of time. You win.';
  }
  if (s.winner) {
    if (!computer) return `${s.winner} wins`;
    return s.winner === app.side ? 'You win' : 'Computer wins';
  }
  if (app.clock.paused) return 'Paused';
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
  let over = 'no';
  if (s.winner === 'draw') over = 'draw';
  else if (s.winner) over = s.endedBy === 'time' ? 'time' : 'win';
  dom.app.dataset.over = over;
  renderBoard(s);
  renderPreview();
  renderStatus(s);
  renderClock(s);
  renderControls(s);
  renderMoves(s);
}

function renderBoard(s) {
  const over = isOver();
  const humanTurn = !over && !isComputerTurn() && !app.clock.paused;
  const flash = app.tieFlash;
  const pop = app.pop;
  app.pop = null;

  if (poppedCell) poppedCell.classList.remove('pop');
  poppedCell = null;

  for (let b = 0; b < 9; b += 1) {
    const sq = squares[b];
    const winner = s.boardWinners[b];
    const tied = s.boardTied[b] === true; // tied and closed, under the 'stay' rule
    const legal = s.legalBoards.includes(b);
    const winLine = s.boardWinLines[b];
    const flashing = flash !== null && flash.board === b;

    sq.el.classList.toggle('is-legal', legal);
    sq.el.classList.toggle('is-won', winner !== null);
    sq.el.classList.toggle('is-tied', tied);
    sq.el.classList.toggle('pop-tie', pop !== null && pop.closedBoard && pop.board === b);
    sq.el.classList.toggle('is-gameline', Array.isArray(s.winLine) && s.winLine.includes(b));
    sq.el.classList.toggle('is-tie-flash', flashing);
    sq.el.classList.toggle('pop', pop !== null && pop.wonBoard && pop.board === b);
    setData(sq.el, 'winner', winner);

    let label = `Big square ${b + 1}`;
    if (winner) label += `, won by ${winner}`;
    else if (tied) label += ', tied and closed';
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
        `Big ${b + 1}, small ${c + 1}, ${mark ?? 'empty'}${isLast ? ', last move' : ''}${
          tied ? ', square tied and closed' : ''
        }`,
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
  if (isComputerTurn() || app.clock.paused) return;
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
  dom.status.dataset.thinking = isComputerTurn() && !app.clock.paused ? 'true' : 'false';
  setText(dom.statusText, statusText(s));
  dom.playAgain.hidden = !isOver();
}

// ---------- Clock ----------

const clockOn = () => app.clockBase > 0;
const now = () => performance.now();

// A timed game with at least one move played and no result yet.
function timedGameRunning() {
  return clockOn() && app.state.history.length > 0 && !isOver();
}

// Time left for a player, worked out from when their clock last started
// rather than by counting ticks, so a slow or sleeping tab loses nothing.
function timeLeft(player) {
  const c = app.clock;
  let ms = c.remaining[player];
  if (c.runner === player && c.startedAt !== null) ms -= now() - c.startedAt;
  return Math.max(0, ms);
}

// Takes the time used so far off the running clock and stops it.
function settleClock() {
  const c = app.clock;
  if (c.runner !== null && c.startedAt !== null) c.remaining[c.runner] = timeLeft(c.runner);
  c.startedAt = null;
}

// Call with the clock settled, after the position or the pause flag changed.
// The player to move counts down, but only once the first move has landed.
function restartClock() {
  const c = app.clock;
  c.runner = timedGameRunning() ? app.state.currentPlayer : null;
  if (c.runner === null) c.paused = false;
  c.startedAt = c.runner !== null && !c.paused ? now() : null;
  scheduleTick();
}

function resetClocks() {
  const ms = app.clockBase * 1000;
  app.clock = { remaining: { X: ms, O: ms }, runner: null, startedAt: null, paused: false };
  app.clockAt = { X: ms, O: ms };
  app.clockUndo = [];
}

// Wakes up when the shown time next changes: every second, or every tenth
// under ten seconds. It only rewrites the two time labels.
function scheduleTick() {
  clearTimeout(app.tickTimer);
  app.tickTimer = null;
  const c = app.clock;
  if (c.runner === null || c.startedAt === null) return;
  const left = c.remaining[c.runner] - (now() - c.startedAt);
  let delay = 0;
  if (left >= LOW_TIME_MS) {
    const nextSecond = (Math.ceil(left / 1000) - 1) * 1000;
    delay = left - Math.max(nextSecond, LOW_TIME_MS);
  } else if (left > 0) {
    delay = left % 100;
  }
  app.tickTimer = setTimeout(onTick, delay + 3);
}

function onTick() {
  app.tickTimer = null;
  if (expireIfOut()) return;
  updateClockText();
  scheduleTick();
}

// True if the running clock has reached zero, in which case the game is over.
function expireIfOut() {
  const c = app.clock;
  if (c.runner === null || c.startedAt === null || timeLeft(c.runner) > 0) return false;
  flagFall(c.runner);
  return true;
}

function flagFall(player) {
  cancelComputer();
  settleClock();
  app.confirm = null;
  app.clock.remaining[player] = 0;
  app.state = forfeit(app.state, player, 'time');
  restartClock();
  render();
  save();
}

function pauseClock() {
  if (!timedGameRunning() || app.clock.paused) return;
  if (expireIfOut()) return;
  settleClock();
  app.clock.paused = true;
  cancelComputer();
  restartClock();
  render();
  save();
}

function resumeClock() {
  if (!app.clock.paused) return;
  app.clock.paused = false;
  restartClock();
  render();
  save();
  scheduleComputer();
}

// 5:00 down to 0:10, then 0:09.9 down to 0:00.0, and 0:00 once it is over.
function formatClock(ms) {
  if (ms <= 0) return '0:00';
  if (ms >= LOW_TIME_MS) {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const tenths = Math.floor(ms / 100);
  return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
}

// "5 min", "5 min + 2 s", or "8 s" for a test clock set from the URL.
function clockName() {
  const base = app.clockBase % 60 === 0 ? `${app.clockBase / 60} min` : `${app.clockBase} s`;
  return app.clockInc > 0 ? `${base} + ${app.clockInc} s` : base;
}

function updateClockText() {
  for (const p of SIDES) {
    const ms = timeLeft(p);
    setText(dom.clockTime[p], formatClock(ms));
    dom.clockFace[p].classList.toggle('is-low', ms < LOW_TIME_MS);
  }
}

function renderClock(s) {
  const on = clockOn();
  const c = app.clock;
  document.documentElement.dataset.clock = on ? 'on' : 'off';
  dom.clocks.hidden = !on;
  dom.paused.hidden = !c.paused;
  if (!on) return;

  const flagged = s.endedBy === 'time' ? other(s.winner) : null;
  for (const p of SIDES) {
    const face = dom.clockFace[p];
    face.classList.toggle('is-running', c.runner === p && c.startedAt !== null);
    face.classList.toggle('is-flagged', flagged === p);
    let name = `${p} clock`;
    if (vsComputer()) name = p === app.side ? 'Your clock' : "Computer's clock";
    face.setAttribute('aria-label', name);
  }

  const canPause = timedGameRunning();
  dom.pause.disabled = !canPause;
  dom.pause.classList.toggle('is-idle', !canPause);
  dom.pause.dataset.state = c.paused ? 'paused' : 'running';
  dom.pause.setAttribute('aria-label', c.paused ? 'Resume' : 'Pause');
  updateClockText();
}

// ---------- Controls and move list ----------

// The line under "Settings" that says what is chosen, for when it is closed.
// Spaces inside a choice do not break, so the line only wraps between choices.
function settingsSummary() {
  return [
    vsComputer() ? `Computer, ${app.level}` : 'Two players',
    app.mode === MODES.ADJACENT ? 'Touching squares' : 'Anywhere',
    app.tieRule === TIE_RULES.STAY ? 'Ties stay closed' : 'Ties reset',
    clockOn() ? clockName() : 'No clock',
  ]
    .map((choice) => choice.replaceAll(' ', '\u00a0'))
    .join(' \u00b7 ');
}

function clockNote() {
  if (!clockOn()) return 'No clock. Take as long as you like.';
  const each =
    app.clockBase % 60 === 0
      ? `${app.clockBase / 60} ${app.clockBase === 60 ? 'minute' : 'minutes'} each`
      : `${app.clockBase} seconds each`;
  if (app.clockInc === 0) return `${each} for the whole game.`;
  return `${each}, plus ${app.clockInc} seconds after every move you make.`;
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
  for (const input of radios('tie')) input.checked = input.value === app.tieRule;
  for (const input of radios('clock')) input.checked = Number(input.value) === app.clockBase;
  for (const input of radios('inc')) input.checked = Number(input.value) === app.clockInc;

  dom.rowLevel.hidden = !vsComputer();
  dom.rowSide.hidden = !vsComputer();
  dom.rowInc.hidden = !clockOn();
  dom.aiNote.hidden = !aiDown;
  if (aiDown) setText(dom.aiNote, AI_NOTES[app.aiStatus]);
  const closedSquare = app.tieRule === TIE_RULES.STAY ? 'won or tied' : 'won';
  setText(dom.modeNote, MODE_NOTES[app.mode].replace('%s', closedSquare));
  setText(dom.tieNote, TIE_NOTES[app.tieRule]);
  setText(dom.clockNote, clockNote());
  setText(dom.settingsSummary, settingsSummary());
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
      const wonGame = isLatest && s.endedBy === 'line';
      tag = wonGame ? 'won game' : 'won';
      detail = wonGame
        ? `Won big square ${entry.board + 1} and the game`
        : `Won big square ${entry.board + 1}`;
    } else if (entry.tiedBoard) {
      tag = 'tie';
      detail =
        s.tieRule === TIE_RULES.STAY
          ? `Tied big square ${entry.board + 1}, which is now closed`
          : `Tied big square ${entry.board + 1}, which was reset`;
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
  const mover = app.state.currentPlayer;
  settleClock();
  app.undo.push(app.state);
  app.clockUndo.push(app.clockAt);
  app.state = applyMove(app.state, board, cell);

  // The mover's clock has stopped. Add the increment, note what both clocks
  // show for this new position, and start the other player's clock.
  if (clockOn()) app.clock.remaining[mover] += app.clockInc * 1000;
  app.clockAt = { ...app.clock.remaining };
  restartClock();

  // A tie either wipes the square ('reset': the old layout is flashed for a
  // moment) or closes it ('stay': nothing is wiped, the square gets a short
  // pulse). The game's tie rule says which; the history entry alone does not.
  const last = app.state.history[app.state.history.length - 1];
  const closed = last.tiedBoard && app.state.boardTied[board] === true;
  const wiped =
    last.tiedBoard && app.state.tieRule === TIE_RULES.RESET && Array.isArray(last.tiedCells);
  app.pop = { board, cell, wonBoard: last.wonBoard, closedBoard: closed };
  if (wiped) startTieFlash(board, last.tiedCells);

  render();
  save();
  scheduleComputer();
  followWithFocus();

  // A pause asked for before the first move had nothing to stop. If the page
  // is hidden or How to play is open when a move starts a clock (the
  // computer's opening move, say), pause now so nobody loses time unseen.
  if (document.hidden || dom.help.open) pauseClock();
}

function playHuman(board, cell) {
  if (app.clock.paused || isComputerTurn() || !isLegalMove(app.state, board, cell)) return;
  if (expireIfOut()) return;
  app.confirm = null;
  commitMove(board, cell);
}

// For keyboard players: after a move, put focus where the next move can go.
function followWithFocus() {
  if (!app.keyboard || isOver() || isComputerTurn() || app.clock.paused) return;
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
  app.state = createGame({ mode: app.mode, tieRule: app.tieRule });
  app.undo = [];
  app.confirm = null;
  resetClocks();
  restartClock();
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
  // Each undo entry has the clocks as they stood when its position came up.
  // After a flag fall this takes back the last move, like any other Undo.
  settleClock();
  let restored = app.state;
  let clocks = app.clockAt;
  for (let i = 0; i < steps; i += 1) {
    restored = app.undo.pop();
    clocks = app.clockUndo.pop() ?? clocks;
  }
  app.state = setMode(restored, app.mode);
  app.clock.remaining = { ...clocks };
  app.clockAt = clocks;
  restartClock();
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
  if (!isComputerTurn() || app.aiStatus !== 'ready' || app.clock.paused) return;
  const token = app.aiToken;
  app.aiTimer = setTimeout(() => {
    app.aiTimer = null;
    if (token !== app.aiToken || !isComputerTurn() || app.clock.paused) return;
    const options = { level: app.level };
    const budget = computerBudget();
    if (budget !== null) options.timeLimitMs = budget;
    let move = null;
    try {
      move = app.ai.chooseMove(app.state, options);
    } catch (err) {
      console.error(err);
    }
    if (token !== app.aiToken) return;
    // The search blocks the page. Clicks made meanwhile arrive after the
    // reply is on the board, and must not count as the human's next move.
    app.ignoreClicksBefore = performance.now();
    // The clock tick could not run during the search either.
    if (expireIfOut()) return;
    if (!move || !isLegalMove(app.state, move.board, move.cell)) {
      computerUnavailable('failed');
      return;
    }
    commitMove(move.board, move.cell);
  }, computerDelay());
}

// With a clock, the computer plays faster as its time runs down, so that it
// does not lose on time: it spends about a thirtieth of what is left on a
// move, never more than its level normally takes.
function computerClockLeft() {
  return timedGameRunning() ? timeLeft(app.state.currentPlayer) : null;
}

function computerDelay() {
  const left = computerClockLeft();
  return left !== null && left < AI_LOW_CLOCK_MS ? AI_DELAY_LOW_MS : AI_DELAY_MS;
}

// Search time in ms, or null to leave the level's own default in place.
function computerBudget() {
  const left = computerClockLeft();
  const usual = AI_LEVEL_BUDGET_MS[app.level];
  if (left === null || !usual) return null;
  return Math.max(AI_MIN_BUDGET_MS, Math.min(usual, left / 30));
}

function computerUnavailable(status) {
  cancelComputer();
  app.confirm = null;
  app.aiStatus = status;
  if (vsComputer()) {
    // The player asked for the computer and is not getting it. The note that
    // says so is in Settings, so make sure Settings is open.
    app.opponent = 'human';
    dom.settings.open = true;
  }
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
    TIE_VALUES.includes(s.tieRule) &&
    isNine(s.boardTied, (tied) => typeof tied === 'boolean') &&
    ENDINGS.includes(s.endedBy) &&
    (s.winner === null) === (s.endedBy === null) &&
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

const isMs = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isClockPair = (v) => v !== null && typeof v === 'object' && isMs(v.X) && isMs(v.O);

function isValidClock(clock, moves) {
  return (
    clock !== null &&
    typeof clock === 'object' &&
    isClockPair(clock.remaining) &&
    isClockPair(clock.at) &&
    Array.isArray(clock.undo) &&
    clock.undo.length === moves &&
    clock.undo.every(isClockPair)
  );
}

// A save from the first release has no tie rule, no tied squares, no record
// of how the game ended and no clock. Fill those in with what that release
// meant, then let the usual checks run.
function migrateV1(data) {
  const upgrade = (state) => {
    if (state === null || typeof state !== 'object') return state;
    let endedBy = null;
    if (state.winner === 'draw') endedBy = 'full';
    else if (SIDES.includes(state.winner)) endedBy = 'line';
    return { ...state, tieRule: TIE_RULES.RESET, boardTied: new Array(9).fill(false), endedBy };
  };
  return {
    ...data,
    v: SAVE_VERSION,
    tieRule: TIE_RULES.RESET,
    clockBase: 0,
    clockInc: 0,
    clock: null,
    settingsOpen: null,
    state: upgrade(data.state),
    undo: Array.isArray(data.undo) ? data.undo.map(upgrade) : data.undo,
  };
}

// Each undo entry is the state before move i, so its history is the first i
// entries of the current one. It is left out when saving and put back on load.
// Called after every move and when the page is hidden, never on a clock tick.
function save() {
  if (!app.persist) return;
  try {
    const data = {
      v: SAVE_VERSION,
      mode: app.mode,
      tieRule: app.tieRule,
      showNumbers: app.showNumbers,
      opponent: app.opponent,
      level: app.level,
      side: app.side,
      settingsOpen: app.settingsOpen,
      clockBase: app.clockBase,
      clockInc: app.clockInc,
      clock: clockOn()
        ? {
            remaining: { X: timeLeft('X'), O: timeLeft('O') },
            at: app.clockAt,
            undo: app.clockUndo,
            paused: app.clock.paused,
          }
        : null,
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
    let data = JSON.parse(raw);
    if (data !== null && typeof data === 'object' && data.v === 1) data = migrateV1(data);
    const ok =
      data !== null &&
      typeof data === 'object' &&
      data.v === SAVE_VERSION &&
      MODE_VALUES.includes(data.mode) &&
      TIE_VALUES.includes(data.tieRule) &&
      typeof data.showNumbers === 'boolean' &&
      OPPONENTS.includes(data.opponent) &&
      LEVEL_VALUES.includes(data.level) &&
      SIDES.includes(data.side) &&
      (data.settingsOpen === null || typeof data.settingsOpen === 'boolean') &&
      Number.isInteger(data.clockBase) &&
      data.clockBase >= 0 &&
      data.clockBase <= MAX_CLOCK_SECONDS &&
      INCREMENTS.includes(data.clockInc) &&
      isValidState(data.state) &&
      data.state.tieRule === data.tieRule &&
      Array.isArray(data.undo) &&
      data.undo.length === data.state.history.length &&
      (data.clockBase === 0 || isValidClock(data.clock, data.undo.length));
    if (!ok) throw new Error('Saved game has the wrong shape');

    const undo = data.undo.map((entry, i) => ({
      ...entry,
      history: data.state.history.slice(0, i),
    }));
    if (!undo.every(isValidState)) throw new Error('Saved undo stack has the wrong shape');

    return {
      mode: data.mode,
      tieRule: data.tieRule,
      showNumbers: data.showNumbers,
      opponent: data.opponent,
      level: data.level,
      side: data.side,
      settingsOpen: data.settingsOpen,
      clockBase: data.clockBase,
      clockInc: data.clockInc,
      clock: data.clockBase > 0 ? data.clock : null,
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
  let state = createGame({ mode: app.mode, tieRule: app.tieRule });
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

// ?clock=5 is minutes and must be one of the presets. ?clock=8s is seconds,
// for testing. ?clock=off turns it off. Anything else is ignored.
function parseClockParam(text) {
  if (text === null) return null;
  const value = text.trim().toLowerCase();
  if (value === 'off' || value === '0') return 0;
  const seconds = /^(\d{1,4})s$/.exec(value);
  if (seconds) {
    const n = Number(seconds[1]);
    return n >= 1 && n <= MAX_CLOCK_SECONDS ? n : null;
  }
  const minutes = Number(value);
  return CLOCK_MINUTES.includes(minutes) ? minutes * 60 : null;
}

// Settings is open when the player left it open, or when nothing is saved and
// there is room: always in the one-column layout, where it sits below the
// board, and in the two-column layout only if the page then needs no scrolling.
function placeSettings() {
  if (typeof app.settingsOpen === 'boolean') {
    dom.settings.open = app.settingsOpen;
    return;
  }
  dom.settings.open = true;
  const twoColumns = window.matchMedia(
    '(min-width: 900px) and (min-aspect-ratio: 1/1), (min-width: 560px) and (min-aspect-ratio: 4/3)',
  ).matches;
  if (twoColumns && document.documentElement.scrollHeight > window.innerHeight + 1) {
    dom.settings.open = false;
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
    app.tieRule = saved.tieRule;
    app.showNumbers = saved.showNumbers;
    app.opponent = saved.opponent;
    app.level = saved.level;
    app.side = saved.side;
    app.settingsOpen = saved.settingsOpen;
    app.clockBase = saved.clockBase;
    app.clockInc = saved.clockInc;
  }

  // Settings in the URL win over saved ones.
  const mode = params.get('mode') === 'touching' ? MODES.ADJACENT : params.get('mode');
  if (MODE_VALUES.includes(mode)) app.mode = mode;
  if (params.has('numbers')) app.showNumbers = !['0', 'off', 'false'].includes(params.get('numbers'));
  const level = (params.get('level') ?? '').toLowerCase();
  if (LEVEL_VALUES.includes(level)) app.level = level;

  // These are fixed for a game. If the URL changes one, the saved game is
  // left alone and a new one starts.
  const fixed = () =>
    [app.opponent, app.side, app.tieRule, app.clockBase, app.clockInc].join('/');
  const before = fixed();
  let opponent = (params.get('opponent') ?? '').toLowerCase();
  if (opponent === 'two' || opponent === 'human') opponent = 'human';
  const side = (params.get('side') ?? '').toUpperCase();
  if (OPPONENTS.includes(opponent)) app.opponent = opponent;
  if (SIDES.includes(side)) app.side = side;
  const tie = (params.get('tie') ?? '').toLowerCase();
  if (TIE_VALUES.includes(tie)) app.tieRule = tie;
  const clock = parseClockParam(params.get('clock'));
  if (clock !== null) app.clockBase = clock;
  const inc = Number(params.get('inc'));
  if (params.has('inc') && INCREMENTS.includes(inc)) app.clockInc = inc;
  const sameGame = before === fixed();

  resetClocks();
  if (replaying) {
    const replay = replayMoves(params.get('moves'));
    app.state = replay.state;
    app.undo = replay.undo;
    app.clockUndo = app.undo.map(() => ({ ...app.clockAt }));
  } else if (saved && sameGame) {
    app.state = setMode(saved.state, app.mode);
    app.undo = saved.undo;
    if (saved.clock) {
      app.clock.remaining = { X: saved.clock.remaining.X, O: saved.clock.remaining.O };
      app.clockAt = saved.clock.at;
      app.clockUndo = saved.clock.undo;
    }
  } else {
    app.state = createGame({ mode: app.mode, tieRule: app.tieRule });
    app.undo = [];
  }

  // A timed game already under way comes back paused, so nobody loses time
  // to a reload or to opening a shared position.
  app.clock.paused = timedGameRunning();
  restartClock();

  bindEvents();
  render();
  placeSettings();
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
  for (const input of radios('tie')) {
    input.addEventListener('change', () => {
      const value = input.value;
      if (value === app.tieRule) return;
      restartWith(() => {
        app.tieRule = value;
      });
      render();
    });
  }
  for (const input of radios('clock')) {
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (value === app.clockBase) return;
      restartWith(() => {
        app.clockBase = value;
      });
      render();
    });
  }
  for (const input of radios('inc')) {
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (value === app.clockInc) return;
      restartWith(() => {
        app.clockInc = value;
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

  // Remember whether the player wants Settings open. The click arrives before
  // the browser toggles it, so read the state a moment later.
  dom.settings.querySelector('summary').addEventListener('click', () => {
    setTimeout(() => {
      app.settingsOpen = dom.settings.open;
      save();
    }, 0);
  });

  dom.pause.addEventListener('click', () => {
    if (app.clock.paused) resumeClock();
    else pauseClock();
  });
  dom.resume.addEventListener('click', () => {
    resumeClock();
    dom.pause.focus({ preventScroll: true });
  });

  // Leaving the page pauses a running clock, which also saves the times.
  // Closing or reloading it saves them too. Without a running clock there is
  // nothing new to save: every move was saved when it was made.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseClock();
  });
  window.addEventListener('pagehide', () => {
    if (timedGameRunning()) save();
  });

  dom.helpOpen.addEventListener('click', () => {
    pauseClock();
    if (typeof dom.help.showModal === 'function') dom.help.showModal();
    else dom.help.setAttribute('open', '');
  });
  dom.helpClose.addEventListener('click', () => dom.help.close());
  dom.help.addEventListener('click', (e) => {
    if (e.target === dom.help) dom.help.close();
  });
}

start();
