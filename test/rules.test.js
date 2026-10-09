import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_IDS, emptyTournament, drawTeam, bracket, setMatchScore, validateGames } from '../public/tournament-rules.js';
import { defaultSettings, publicSettings, validateSettings } from '../settings.js';
function drawn(){let t=emptyTournament(); for(let i=1;i<=10;i++)t=drawTeam(t,i,0).tournament; return t;}
test('10 distinct teams, six first-round byes and nine actual BO3 matches',()=>{
  const t=drawn(), rounds=bracket(t);
  assert.deepEqual(t.slots,TEAM_IDS); assert.equal(rounds[0].filter(m=>m.bye).length,6);
  assert.equal(rounds.flat().filter(m=>!m.bye).length,9);
  assert.throws(()=>drawTeam(t,1,0));
});
test('2–1 and 2–0 advance automatically; partial scores do not',()=>{
  let t=drawn(); t=setMatchScore(t,'r1m2',[[300,150]]);
  assert.equal(bracket(t)[0][1].winner,null);
  t=setMatchScore(t,'r1m2',[[300,150],[150,300],[300,150]]);
  assert.equal(bracket(t)[0][1].winner,'H'); assert.deepEqual(bracket(t)[0][1].wins,[2,1]);
  t=setMatchScore(t,'r1m6',[[0,1],[0,1],[null,null]]);
  assert.equal(bracket(t)[0][5].winner,'J');
});
test('reject tied, negative, fractional, incomplete, out-of-order and post-clinch games',()=>{
  for(const g of [[[1,1]],[[-1,2]],[[1.5,2]],[[1,null]],[[null,null],[1,2]],[[1,0],[1,0],[1,0]],[[1,0],[0,1],[1,0],[1,0]]])assert.throws(()=>validateGames(g));
  assert.throws(()=>setMatchScore(emptyTournament(),'r1m2',[[1,0]]));
});
test('full tournament produces champion; corrections clear only dependent results',()=>{
  let t=drawn();
  for(let r=0;r<4;r++)for(const m of bracket(t)[r])if(!m.bye)t=setMatchScore(t,m.id,[[300,100],[300,100]]);
  assert.equal(bracket(t)[3][0].winner,'A');
  t=setMatchScore(t,'r1m2',[[100,300],[100,300]]);
  assert.equal(t.results.r2m1,undefined);assert.equal(t.results.r3m1,undefined);assert.equal(t.results.r4m1,undefined);
  assert.ok(t.results.r2m2); assert.ok(t.results.r3m2); assert.equal(bracket(t)[3][0].winner,null);
});
test('settings validation and public password exclusion',()=>{
  const current=defaultSettings(), next=structuredClone(current);
  next.teamNames.J='10番目';next.ranks.push({name:'新ランク',points:25});
  assert.equal(validateSettings(next,current,[]).teamNames.J,'10番目');
  assert.equal('teamPasswords' in publicSettings(current),false);
  next.teamNames.J=next.teamNames.A;assert.throws(()=>validateSettings(next,current,[]));
  assert.throws(()=>validateSettings(current,current,[{rank:'使用中'}]));
});
