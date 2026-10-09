import './mock-postgres.js';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
const { initDB, saveDraft, loadDraft, loadOptions, loadPlayers } = await import('../db.js');
import { bracket } from '../public/tournament-rules.js';
process.env.PORT='8099';
await initDB();
await saveDraft('integration',{locks:Object.fromEntries([...'ABCDEFGHI'].map(t=>[t,false])),picks:Object.fromEntries([...'ABCDEFGHI'].map(t=>[t,Array(5).fill('')])),teams:Object.fromEntries([...'ABCDEFGHI'].map(t=>[t,[]])),state:{mode:'idle',cycle:1,round:0}});
await import('../server.js');
const clients=[];
const connect=()=>new Promise((resolve,reject)=>{const s=io('http://localhost:8099',{auth:{room:'integration'},reconnection:false});clients.push(s);s.on('state:init',state=>resolve({s,...state}));s.on('connect_error',reject);});
const event=(s,name)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout '+name)),4000);s.once(name,p=>{clearTimeout(timer);resolve(p);});});
const request=(s,name,p)=>new Promise((resolve,reject)=>s.timeout(4000).emit(name,p,(e,r)=>e?reject(e):resolve(r)));
try {
  const a=await connect(), b=await connect();
  assert.equal(a.teams.length,10);assert.deepEqual(a.state.draft.picks.J,Array(5).fill(''));
  assert.equal(a.state.settings.teamPasswords,undefined);
  assert.equal((await request(b.s,'tournament:draw',{seed:1,revision:0})).ok,false);
  assert.equal((await request(b.s,'tournament:score',{matchId:'r1m2',games:[],revision:0})).ok,false);
  assert.equal((await request(b.s,'tournament:reset',{revision:0})).ok,false);
  assert.equal((await request(b.s,'admin:settings',{})).ok,false);
  assert.equal((await request(a.s,'admin:login',{pass:'wrong'})).ok,false);
  const login=await request(a.s,'admin:login',{pass:'yamadayamada'});assert.ok(login.ok);
  let settings=login.settings;settings.teamNames.J='試験チームJ';settings.teamPasswords.J='new-j';settings.ranks.push({name:'試験ランク',points:42});
  const settingsEvent=event(b.s,'settings:updated'); assert.ok((await request(a.s,'admin:settings',settings)).ok);
  assert.equal((await settingsEvent).teamPasswords,undefined);
  const leader=event(b.s,'leader:ok');b.s.emit('leader:login',{team:'J',pass:'new-j'});assert.equal((await leader).role,'J');
  const added=event(b.s,'players:updated');a.s.emit('player:add',{actionPass:'ACTION123',name:'試験選手',rank:'試験ランク',pokes:[]});const players=await added;assert.equal(players[0].points,42);
  const picked=event(a.s,'draft:picksUpdated');b.s.emit('draft:pick',{team:'J',round:0,playerId:players[0].id});assert.equal((await picked).J[0],players[0].id);
  const locked=event(a.s,'draft:locksUpdated');b.s.emit('draft:lock',{team:'J',locked:true});await locked;
  const preview=event(b.s,'draft:preview');a.s.emit('draft:revealLocked');assert.equal((await preview).entries[0].team,'J');
  const resolved=event(b.s,'draft:resolved');a.s.emit('draft:progress');assert.deepEqual((await resolved).draft.teams.J,[players[0].id]);
  assert.deepEqual((await loadDraft('integration')).teams.J,[players[0].id]);
  const refreshed=(await request(a.s,'admin:login',{pass:'yamadayamada'})).settings;refreshed.ranks.find(r=>r.name==='試験ランク').points=77;
  assert.ok((await request(a.s,'admin:settings',refreshed)).ok);assert.equal((await loadPlayers('integration'))[0].points,77);
  let t=a.state.tournament;
  for(let seed=1;seed<=10;seed++){
    const broadcast=event(b.s,'tournament:updated'); const draw=await request(a.s,'tournament:draw',{seed,revision:t.revision});assert.ok(draw.ok);t=draw.tournament;assert.equal((await broadcast).revision,t.revision);
  }
  const match=bracket(t)[0].find(m=>!m.bye), revision=t.revision;
  const results=await Promise.all([request(a.s,'tournament:score',{matchId:match.id,games:[[300,150],[150,300],[300,150]],revision}),request(a.s,'tournament:score',{matchId:match.id,games:[[100,200],[100,200]],revision})]);
  assert.deepEqual(results.map(r=>r.ok),[true,false]);
  const persisted=await loadOptions('integration');assert.equal(bracket(persisted.tournament)[0].find(m=>m.id===match.id).winner,match.a.team);
  assert.equal(persisted.settings.teamPasswords.J,'new-j');
  const c=await connect();assert.equal(c.state.tournament.revision,revision+1);assert.equal(c.state.settings.teamPasswords,undefined);assert.equal(c.state.settings.teamNames.J,'試験チームJ');
  a.s.emit('admin:logout');assert.equal((await request(a.s,'tournament:reset',{revision:revision+1})).ok,false);
  console.log('PASS: auth, 9→10 migration, realtime draft, settings, rank recalculation, draw, BO3, concurrency, persistence, public redaction');
} catch(error){console.error(error);process.exitCode=1;}
finally{clients.forEach(s=>s.disconnect());process.exit(process.exitCode||0);}
