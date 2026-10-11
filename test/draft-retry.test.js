import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const source=server.slice(server.indexOf("  on('draft:progress'"),server.indexOf('  // 初期化'));
test('losers retry the same slot; winners wait; advance only when every team has one player',async()=>{
  const ids=[...'ABCDEFGHIJ'];
  const d={locks:Object.fromEntries(ids.map(t=>[t,true])),picks:Object.fromEntries(ids.map(t=>[t,['same',t+'2',t+'3',t+'4',t+'5']])),teams:Object.fromEntries(ids.map(t=>[t,[]])),state:{mode:'sequential',round:0,cycle:1}};
  const context=vm.createContext({on:(name,fn)=>{context.progress=fn;},getRoom:()=>({draft:d}),roomId:'test',TEAM_IDS:ids,MAX_ROUNDS:5,MAX_TEAM:5,REQUIRE_LOCKS:false,rnd100:(()=>{let n=0;return ()=>++n;})(),saveDraft:async()=>{},publicRoom:x=>x,io:{to:()=>({emit(){}})},socket:{id:'test'},console});
  vm.runInContext(source,context);
  await context.progress();
  assert.equal(d.state.round,0);assert.equal(d.teams.J.length,1);assert.equal(d.locks.J,true);
  for(const t of ids.slice(0,-1)){assert.equal(d.picks[t][0],'');assert.equal(d.locks[t],false);}
  // Even a stale alternative pick for a winner must not award a second player.
  d.picks.J[0]='extra';
  for(const t of ids.slice(0,-1)){d.picks[t][0]=t+'1';d.locks[t]=true;}
  await context.progress();assert.equal(d.state.round,1);assert.ok(ids.every(t=>d.teams[t].length===1));
  for(let round=1;round<5;round++){await context.progress();assert.ok(ids.every(t=>d.teams[t].length===round+1));}
  assert.equal(d.state.mode,'idle');assert.equal(d.state.round,5);assert.ok(ids.every(t=>!d.locks[t]));
  await context.progress();assert.ok(ids.every(t=>d.teams[t].length===5));
});
