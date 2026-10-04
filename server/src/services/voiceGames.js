import { randomInt, randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';

export const GAME_NAMES = ['chess', 'tic-tac-toe', 'backgammon'];
const die = () => randomInt(1, 7);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function createGame(name, userId) {
  assert(GAME_NAMES.includes(name), 'Unknown activity.');
  const common = { id: randomUUID(), revision: 0, players: [userId, null], winner: null, status: 'waiting', turn: 0 };
  if (name === 'chess') return { ...common, ...chessView(new Chess()), pgn: '' };
  if (name === 'tic-tac-toe') return { ...common, board: Array(9).fill(null), winningLine: [] };
  const points = Array(24).fill(0);
  for (const [point, count] of [[23, 2], [12, 5], [7, 3], [5, 5], [0, -2], [11, -5], [16, -3], [18, -5]]) points[point] = count;
  return { ...common, points, bar: [0, 0], off: [0, 0], dice: [], lastRoll: [], opening: true, legal: [], score: 0 };
}

function chessView(chess) {
  return { fen: chess.fen(), turn: chess.turn() === 'w' ? 0 : 1, check: chess.isCheck(), legal: chess.moves({ verbose: true }).map(move => ({ from: move.from, to: move.to, promotion: move.promotion ?? null })), history: chess.history() };
}

export function applyGameAction(name, current, userId, action, rollDie = die) {
  const state = structuredClone(current);
  assert(GAME_NAMES.includes(name), 'Unknown activity.');
  if (action.type === 'join') {
    assert(state.status === 'waiting', 'The game already has two players. You can watch.');
    assert(!state.players.includes(userId), 'You already joined this game.');
    state.players[1] = userId;
    state.status = 'playing';
    if (name === 'backgammon') {
      let rolls;
      do { rolls = [rollDie(), rollDie()]; } while (rolls[0] === rolls[1]);
      state.turn = rolls[0] > rolls[1] ? 0 : 1;
      state.dice = rolls;
      state.lastRoll = rolls;
      state.opening = false;
      finishDice(state);
    }
  } else if (action.type === 'reset') {
    assert(state.status === 'finished', 'Finish the current game before starting a rematch.');
    assert(state.players.includes(userId), 'Only a player can request a rematch.');
    // A rematch needs the other player to explicitly accept the second seat.
    const reset = createGame(name, userId);
    return { ...reset, id: state.id, revision: state.revision + 1 };
  } else {
    const player = state.players.indexOf(userId);
    assert(player !== -1, 'Join a player seat before playing.');
    assert(state.status === 'playing', 'The game is not in progress.');
    if (action.type === 'resign') {
      state.status = 'finished'; state.winner = 1 - player; state.reason = 'resigned';
    } else {
      assert(player === state.turn, 'Wait for your turn.');
      if (name === 'chess') {
        assert(action.type === 'move', 'Invalid chess action.');
        const chess = new Chess();
        if (state.pgn) chess.loadPgn(state.pgn); else chess.load(state.fen);
        assert(typeof action.from === 'string' && /^[a-h][1-8]$/.test(action.from) && typeof action.to === 'string' && /^[a-h][1-8]$/.test(action.to), 'Choose a valid square.');
        const promotion = action.promotion ?? 'q';
        assert(['q', 'r', 'b', 'n'].includes(promotion), 'Invalid promotion piece.');
        chess.move({ from: action.from, to: action.to, promotion });
        Object.assign(state, chessView(chess), { pgn: chess.pgn() });
        if (chess.isGameOver()) {
          state.status = 'finished'; state.winner = chess.isCheckmate() ? player : null;
          state.reason = chess.isCheckmate() ? 'checkmate' : 'draw'; state.legal = [];
        }
      } else if (name === 'tic-tac-toe') {
        assert(action.type === 'move' && Number.isInteger(action.cell) && action.cell >= 0 && action.cell < 9, 'Choose a valid cell.');
        assert(state.board[action.cell] === null, 'That cell is occupied.');
        state.board[action.cell] = player;
        const line = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]].find(indices => indices.every(index => state.board[index] === player));
        if (line) { state.status = 'finished'; state.winner = player; state.winningLine = line; state.reason = 'win'; }
        else if (state.board.every(cell => cell !== null)) { state.status = 'finished'; state.reason = 'draw'; }
        else state.turn = 1 - player;
      } else {
        if (action.type === 'roll') {
          assert(!state.dice.length, 'Use the current dice before rolling again.');
          const rolls = [rollDie(), rollDie()];
          state.lastRoll = rolls; state.dice = rolls[0] === rolls[1] ? Array(4).fill(rolls[0]) : rolls;
          finishDice(state);
        } else {
          assert(action.type === 'move', 'Invalid backgammon action.');
          const legal = backgammonMoves(state);
          const move = legal.find(move => move.from === action.from && move.to === action.to && move.die === action.die);
          assert(move, 'That move is not legal for these dice.');
          moveChecker(state, move);
          state.dice.splice(state.dice.indexOf(move.die), 1);
          if (state.off[player] === 15) {
            state.status = 'finished'; state.winner = player; state.reason = 'borne-off'; state.legal = [];
            const opponent = 1 - player;
            const inHome = state.points.some((count, index) => count * (opponent === 0 ? 1 : -1) > 0 && (player === 0 ? index < 6 : index > 17));
            state.score = state.off[opponent] ? 1 : (state.bar[opponent] || inHome ? 3 : 2);
          } else {
            if (!state.dice.length) state.turn = 1 - player;
            finishDice(state);
          }
        }
      }
    }
  }
  state.revision++;
  return state;
}

function rawMoves(state, dice = state.dice) {
  const player = state.turn, sign = player === 0 ? 1 : -1;
  const sources = state.bar[player] ? [-1] : state.points.flatMap((count, index) => count * sign > 0 ? [index] : []);
  const allHome = !state.bar[player] && !state.points.some((count, index) => count * sign > 0 && (player === 0 ? index >= 6 : index < 18));
  const result = [];
  for (const value of new Set(dice)) for (const from of sources) {
    let to = from === -1 ? (player === 0 ? 24 - value : value - 1) : from - sign * value;
    if (to < 0 || to >= 24) {
      if (!allHome || from === -1) continue;
      const distance = player === 0 ? from + 1 : 24 - from;
      if (value > distance && state.points.some((count, index) => count * sign > 0 && (player === 0 ? index > from : index < from))) continue;
      to = 24;
    } else if (state.points[to] * sign < -1) continue;
    result.push({ from, to, die: value });
  }
  return result;
}

function moveChecker(state, { from, to }) {
  const player = state.turn, sign = player === 0 ? 1 : -1;
  if (from === -1) state.bar[player]--; else state.points[from] -= sign;
  if (to === 24) state.off[player]++;
  else {
    if (state.points[to] === -sign) { state.bar[1 - player]++; state.points[to] = 0; }
    state.points[to] += sign;
  }
}

// Maximum usable dice, not maximum pip total. Memoization bounds doubles work.
export function backgammonMoves(state) {
  if (!state.dice.length || state.status !== 'playing') return [];
  const memo = new Map();
  function depth(board, dice) {
    if (!dice.length) return 0;
    const key = JSON.stringify([board.points, board.bar, board.off, [...dice].sort()]);
    if (memo.has(key)) return memo.get(key);
    let best = 0;
    for (const move of rawMoves(board, dice)) {
      const next = structuredClone(board); moveChecker(next, move);
      const remaining = [...dice]; remaining.splice(remaining.indexOf(move.die), 1);
      best = Math.max(best, 1 + depth(next, remaining));
    }
    memo.set(key, best); return best;
  }
  const scored = rawMoves(state).map(move => {
    const next = structuredClone(state); moveChecker(next, move);
    const remaining = [...state.dice]; remaining.splice(remaining.indexOf(move.die), 1);
    return { move, uses: 1 + depth(next, remaining) };
  });
  const maximum = Math.max(0, ...scored.map(entry => entry.uses));
  let legal = scored.filter(entry => entry.uses === maximum).map(entry => entry.move);
  if (maximum === 1) { const largest = Math.max(...legal.map(move => move.die)); legal = legal.filter(move => move.die === largest); }
  return legal;
}

function finishDice(state) {
  state.legal = backgammonMoves(state);
  if (!state.legal.length && state.dice.length) { state.dice = []; state.turn = 1 - state.turn; }
}
