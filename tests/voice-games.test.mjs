import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyGameAction, backgammonMoves } from '../server/src/services/voiceGames.js';

const ready = name => applyGameAction(name, createGame(name,'alice'),'bob',{type:'join'}, (() => { let n=0; return () => ++n % 2 ? 6 : 1; })());
const move = (name,state,payload) => applyGameAction(name,state,state.players[state.turn],{type:'move',...payload});

test('game seats, turn ownership, rematch consent and immutable input', () => {
  const initial = createGame('tic-tac-toe','alice');
  const game = applyGameAction('tic-tac-toe',initial,'bob',{type:'join'});
  assert.equal(initial.players[1],null);
  assert.throws(() => applyGameAction('tic-tac-toe',game,'eve',{type:'move',cell:0}),/Join/);
  assert.throws(() => applyGameAction('tic-tac-toe',game,'bob',{type:'move',cell:0}),/turn/);
  assert.throws(() => applyGameAction('tic-tac-toe',game,'eve',{type:'join'}),/two players/);
  assert.throws(() => applyGameAction('tic-tac-toe',game,'alice',{type:'reset'}),/Finish/);
  const resigned = applyGameAction('tic-tac-toe',game,'alice',{type:'resign'});
  assert.equal(resigned.winner,1);
  const reset = applyGameAction('tic-tac-toe',resigned,'bob',{type:'reset'});
  assert.equal(reset.status,'waiting'); assert.deepEqual(reset.players,['bob',null]);
  assert.equal(reset.id,game.id); assert.equal(reset.revision,resigned.revision+1);
});
test('tic-tac-toe detects win, occupied square, draw and completed game', () => {
  let game = ready('tic-tac-toe');
  game = move('tic-tac-toe',game,{cell:0});
  assert.throws(() => move('tic-tac-toe',game,{cell:0}),/occupied/);
  for(const cell of [3,1,4,2]) game = move('tic-tac-toe',game,{cell});
  assert.equal(game.winner,0); assert.deepEqual(game.winningLine,[0,1,2]);
  assert.throws(() => move('tic-tac-toe',game,{cell:8}),/progress/);
  game = ready('tic-tac-toe');
  for(const cell of [0,1,2,4,3,5,7,6,8]) game = move('tic-tac-toe',game,{cell});
  assert.equal(game.status,'finished'); assert.equal(game.reason,'draw');
});
test('chess rejects illegal moves and detects checkmate', () => {
  let game = ready('chess');
  assert.throws(() => move('chess',game,{from:'e2',to:'e5'}),/Invalid move/);
  for(const [from,to] of [['f2','f3'],['e7','e5'],['g2','g4'],['d8','h4']]) game = move('chess',game,{from,to});
  assert.equal(game.reason,'checkmate'); assert.equal(game.winner,1); assert.deepEqual(game.legal,[]);
});
test('chess castling, en passant and underpromotion', () => {
  let game = {...ready('chess'),fen:'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'};
  game = move('chess',game,{from:'e1',to:'g1'}); assert.match(game.fen,/R4RK1/);
  game = ready('chess');
  for(const [from,to] of [['e2','e4'],['a7','a6'],['e4','e5'],['d7','d5'],['e5','d6']]) game = move('chess',game,{from,to});
  assert.equal(game.fen.split('/')[3],'8');
  game = {...ready('chess'),fen:'7k/P7/8/8/8/8/8/7K w - - 0 1'};
  game = move('chess',game,{from:'a7',to:'a8',promotion:'n'}); assert.match(game.fen,/^N6k/);
});
test('chess persists repetition history and detects draw', () => {
  let game = ready('chess');
  for(let round=0;round<2;round++) for(const [from,to] of [['g1','f3'],['g8','f6'],['f3','g1'],['f6','g8']]) game = move('chess',game,{from,to});
  assert.equal(game.status,'finished'); assert.equal(game.reason,'draw');
  assert.equal(game.history.length,8);
});
test('backgammon opening roll and standard setup preserve 15 checkers per player', () => {
  const game = ready('backgammon'); assert.equal(game.turn,0); assert.deepEqual(game.dice,[6,1]);
  assert.equal(game.points.reduce((n,p)=>n+Math.max(0,p),0),15);
  assert.equal(game.points.reduce((n,p)=>n+Math.max(0,-p),0),15);
});
const bgFixture = () => ({...ready('backgammon'),points:Array(24).fill(0),bar:[0,0],off:[14,14],dice:[1,2],turn:0});
test('backgammon bar priority, blocked entry and hitting a blot', () => {
  let game = bgFixture(); game.bar[0]=1; game.off[0]=14; game.points[23]=-2; game.off[1]=13;
  assert.deepEqual(backgammonMoves(game),[{from:-1,to:22,die:2}]);
  game.points[22]=-2; assert.deepEqual(backgammonMoves(game),[]);
  game = bgFixture(); game.points[5]=1; game.points[4]=-1; game.dice=[1];
  game = move('backgammon',game,{from:5,to:4,die:1});
  assert.equal(game.points[4],1); assert.equal(game.bar[1],1); assert.equal(game.turn,1); assert.equal(game.dice.length,0);
});
test('backgammon bearing off, oversized dice and forced higher die', () => {
  let game=bgFixture(); game.points[0]=1;
  assert.deepEqual(backgammonMoves(game),[{from:0,to:24,die:2}]);
  game=move('backgammon',game,{from:0,to:24,die:2}); assert.equal(game.winner,0); assert.equal(game.score,1);
  game=bgFixture(); game.off[0]=13; game.points[0]=1; game.points[5]=1; game.dice=[4];
  assert.equal(backgammonMoves(game).some(move=>move.from===0&&move.to===24),false);
  game.points[5]=0; game.points[6]=1;
  assert.equal(backgammonMoves(game).some(move=>move.to===24),false);
});
test('backgammon must maximize usable dice', () => {
  const game=bgFixture(); game.off[0]=13; game.points[5]=1; game.points[0]=1; game.points[2]=-2; game.off[1]=13; game.dice=[2,1];
  // Moving 5->4 with die 1 strands die 2 against the blocked point 2.
  // Moving 5->4 with die 1 then 0/off with die 2 is also illegal oversized bearing off.
  assert.equal(backgammonMoves(game).some(move=>move.from===5&&move.to===4&&move.die===1),false);
  assert.equal(backgammonMoves(game).some(move=>move.from===0&&move.to===24&&move.die===1),true);
});
test('backgammon doubles use four dice and cannot reroll midturn', () => {
  let game=ready('backgammon'); game.dice=[];
  game=applyGameAction('backgammon',game,'alice',{type:'roll'},()=>3);
  assert.deepEqual(game.dice,[3,3,3,3]);
  assert.throws(()=>applyGameAction('backgammon',game,'alice',{type:'roll'}),/current dice/);
});
test('backgammon randomized complete games conserve checkers and always terminate', () => {
  let randomSeed=7927; const random=()=>{randomSeed=(randomSeed*1664525+1013904223)>>>0;return randomSeed;};
  const roll=()=>random()%6+1;
  for(let gameIndex=0;gameIndex<3;gameIndex++) {
    let game=applyGameAction('backgammon',createGame('backgammon','alice'),'bob',{type:'join'},roll);
    let steps=0;
    while(game.status==='playing'&&steps++<5000) {
      const user=game.players[game.turn];
      if(!game.dice.length) game=applyGameAction('backgammon',game,user,{type:'roll'},roll);
      else { const legal=backgammonMoves(game); assert.ok(legal.length); const selected=legal[random()%legal.length]; game=applyGameAction('backgammon',game,user,{type:'move',...selected}); }
      for(let p=0;p<2;p++) assert.equal(game.points.reduce((sum,n)=>sum+Math.max(0,n*(p===0?1:-1)),0)+game.bar[p]+game.off[p],15);
    }
    assert.equal(game.status,'finished');
  }
});
