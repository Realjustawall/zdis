import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerVoiceActivities } from '../server/src/services/voiceActivities.js';

function harness() {
  const handle = new DatabaseSync(':memory:');
  handle.exec('CREATE TABLE voice_activities (channel_id TEXT PRIMARY KEY, activity TEXT, started_by TEXT, state TEXT, created_at INTEGER, updated_at INTEGER)');
  const db = { get:async(sql,args)=>handle.prepare(sql).get(...args), run:async(sql,args)=>({changes:Number(handle.prepare(sql).run(...args).changes)}) };
  const events = [], rooms = new Map(), forbidden = new Set();
  function client(userId) {
    let handler;
    const socket = { id:userId, data:{userId}, on:(_name,callback)=>{handler=callback;} };
    rooms.set(userId,'channel');
    registerVoiceActivities(socket,{getDb:()=>db,channelForSocket:id=>rooms.get(id),hasPermission:async(user,_room,permission)=>!forbidden.has(user)&&(permission==='useEmbeddedActivities'||user==='manager'),broadcast:(channelId,activity)=>events.push({channelId,activity})});
    return async payload => { let result; await handler(payload,reply=>{result=reply;}); return result; };
  }
  const current=()=>{const row=handle.prepare('SELECT * FROM voice_activities').get();return row?JSON.parse(row.state):null;};
  const payload=(state,move)=>({action:'play',gameId:state.id,revision:state.revision,move});
  return {client,current,payload,rooms,forbidden,events,close:()=>handle.close()};
}
test('Activities persist in SQLite, broadcast state, and reject forged or stale moves',async()=>{
  const h=harness();try{
    const alice=h.client('alice'),bob=h.client('bob'),eve=h.client('eve');
    let result=await alice({action:'start',activity:'tic-tac-toe'});assert.equal(result.ok,true);
    const initial=h.current();assert.equal(h.events.length,1);
    assert.equal((await eve({action:'start',activity:'chess'})).ok,false);
    assert.equal((await bob(h.payload(initial,{type:'join'}))).ok,true);
    let state=h.current();
    assert.equal((await eve(h.payload(state,{type:'move',cell:0,board:Array(9).fill(0)}))).ok,false);
    assert.deepEqual(h.current().board,Array(9).fill(null));
    assert.equal((await bob(h.payload(state,{type:'move',cell:0}))).ok,false);
    result=await alice(h.payload(state,{type:'move',cell:0}));assert.equal(result.ok,true);
    assert.equal(h.current().board[0],0);
    assert.equal((await alice(h.payload(state,{type:'move',cell:1}))).ok,false);
    state=h.current();
    assert.equal((await bob({action:'end',gameId:state.id,revision:state.revision})).ok,false);
    assert.equal((await alice({action:'end',gameId:state.id,revision:state.revision})).ok,true);
    assert.equal(h.current(),null);assert.equal(h.events.at(-1).activity,null);
  }finally{h.close();}
});
test('Concurrent seat requests cannot overwrite each other',async()=>{
  const h=harness();try{
    const alice=h.client('alice'),bob=h.client('bob'),eve=h.client('eve');
    await alice({action:'start',activity:'chess'});const state=h.current();
    const results=await Promise.all([bob(h.payload(state,{type:'join'})),eve(h.payload(state,{type:'join'}))]);
    assert.equal(results.filter(result=>result.ok).length,1);
    assert.equal(h.current().revision,1);assert.ok(['bob','eve'].includes(h.current().players[1]));
  }finally{h.close();}
});
test('Permissions, voice membership, game identity and server dice are enforced',async()=>{
  const h=harness();try{
    const alice=h.client('alice'),bob=h.client('bob'),manager=h.client('manager');
    h.rooms.delete('alice');assert.equal((await alice({action:'start',activity:'chess'})).ok,false);
    h.rooms.set('alice','channel');h.forbidden.add('alice');assert.equal((await alice({action:'start',activity:'chess'})).ok,false);h.forbidden.delete('alice');
    assert.equal((await alice({action:'start',activity:'poker'})).ok,false);
    await alice({action:'start',activity:'backgammon'});let state=h.current();
    assert.equal((await bob({...h.payload(state,{type:'join'}),gameId:'forged'})).ok,false);
    await bob(h.payload(state,{type:'join',dice:[6,6,6,6]}));state=h.current();
    assert.equal(state.dice.length,2);assert.notEqual(state.dice[0],state.dice[1]);
    assert.equal((await manager({action:'end',gameId:state.id,revision:state.revision})).ok,true);
  }finally{h.close();}
});
