import { TEAM_IDS, ROUND_NAMES, bracket, emptyTournament } from './tournament-rules.js';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountTournament(socket, showTab) {
  let tournament = emptyTournament(), config = { teamNames: {} }, adminConfig = null;
  let admin = false, spinning = false, rotation = 0, animationToken = 0, toastTimer;
  const name = t => config.teamNames[t] || `チーム${t}`;
  const notify = message => { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>$('toast').classList.remove('show'),4500); };
  const request = (event, data) => new Promise((resolve,reject) => {
    if (!socket.connected) return reject(Error('接続が切れています。再接続後にお試しください'));
    socket.timeout(15000).emit(event, data, (error,result) => {
      if (error) reject(Error('応答を確認できませんでした。再読み込みして最新状態を確認してください'));
      else if (!result?.ok) reject(Error(result?.error || '操作に失敗しました'));
      else resolve(result);
    });
  });
  const label = p => p.bye ? 'BYE' : p.team ? name(p.team) : p.seed ? `枠${p.seed}・抽選待ち` : '勝者待ち';
  const summary = m => `<div class="match-id">${m.id.toUpperCase()}${m.bye ? ' · シード' : ' · BO3'}</div>
    <div class="match-wins">${m.bye ? '—' : `${m.wins[0]} <span>–</span> ${m.wins[1]}`}</div>
    <div class="match-teams"><span class="${m.winner && m.winner===m.a.team?'winner':''}">${esc(label(m.a))}</span><small>VS</small><span class="${m.winner && m.winner===m.b.team?'winner':''}">${esc(label(m.b))}</span></div>`;
  function renderBracket() {
    const rounds = bracket(tournament), champion = rounds[3][0].winner;
    $('tournamentProgress').textContent = `抽選 ${tournament.slots.filter(Boolean).length} / 10 チーム`;
    $('champion').classList.toggle('hidden', !champion);
    $('champion').textContent = champion ? `🏆 優勝 ${name(champion)}` : '';
    $('bracket').innerHTML = rounds.map((matches,r)=>`<section class="bracket-round"><h3>${ROUND_NAMES[r]}</h3><div class="round-matches">${matches.map(m=>`<article class="match ${m.bye?'bye':''}">${summary(m)}<div class="game-scores">${m.games.map((g,i)=>`<div><small>GAME ${i+1}</small><span>${g[0]} – ${g[1]}</span></div>`).join('') || `<p class="note">${m.bye ? '1回戦シード' : 'スコア未入力'}</p>`}</div>${m.winner?`<div class="advance">${esc(name(m.winner))} ${r===3?'優勝':'進出'}</div>`:''}</article>`).join('')}</div></section>`).join('');
    requestAnimationFrame(connectBracket);
  }
  function connectBracket() {
    const root=$('bracket'); root.querySelector('svg')?.remove();
    if (!root.offsetWidth) return;
    const origin=root.getBoundingClientRect(), rounds=[...root.querySelectorAll('.bracket-round')];
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('width',root.scrollWidth);svg.setAttribute('height',root.scrollHeight);svg.classList.add('bracket-lines');svg.setAttribute('aria-hidden','true');
    rounds.slice(0,-1).forEach((round,r)=>[...round.querySelectorAll('.match')].forEach((card,i)=>{
      const from=card.getBoundingClientRect(), to=rounds[r+1].querySelectorAll('.match')[Math.floor(i/2)].getBoundingClientRect();
      const x=from.right-origin.left,y=from.top+from.height/2-origin.top,x2=to.left-origin.left,y2=to.top+to.height/2-origin.top,mid=(x+x2)/2;
      const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',`M ${x} ${y} H ${mid} V ${y2} H ${x2}`);svg.append(path);
    }));root.prepend(svg);
  }
  new ResizeObserver(()=>requestAnimationFrame(connectBracket)).observe($('bracket'));
  function renderScores(preserveEdits = true) {
    if (!admin) return;
    const pending = preserveEdits ? [...$('scoreMatches').querySelectorAll('[data-dirty="true"]')] : [];
    const complete = tournament.slots.every(Boolean);
    $('scoreMatches').innerHTML = bracket(tournament).map((matches,r)=>matches.filter(m=>!m.bye).map(m=>{
      const ready = complete && m.a.team && m.b.team;
      return `<form class="score-card" data-match="${m.id}" data-revision="${tournament.revision}"><div class="eyebrow">${ROUND_NAMES[r]}</div>${summary(m)}<fieldset ${ready?'':'disabled'}><legend class="sr-only">${esc(label(m.a))} VS ${esc(label(m.b))} のスコア</legend>${[0,1,2].map(i=>`<div class="score-row"><label>第${i+1}試合</label><input type="number" min="0" max="99999" step="1" data-game="${i}" data-side="0" aria-label="第${i+1}試合 ${esc(label(m.a))}" value="${m.games[i]?.[0] ?? ''}"><span>–</span><input type="number" min="0" max="99999" step="1" data-game="${i}" data-side="1" aria-label="第${i+1}試合 ${esc(label(m.b))}" value="${m.games[i]?.[1] ?? ''}"></div>`).join('')}<button class="btn acc" type="submit">スコアを保存</button></fieldset>${ready?'':`<p class="note">${complete?'対戦チームの確定待ち':'10チームの抽選を完了してください'}</p>`}<p class="score-message" role="status"></p></form>`;
    }).join('')).join('');
    for (const form of pending) {
      const replacement = $('scoreMatches').querySelector(`[data-match="${form.dataset.match}"]`);
      if (replacement) replacement.replaceWith(form);
    }
  }
  function wheel(items, angle = 0) {
    const canvas = $('wheel'), ctx = canvas.getContext('2d'), center = 210, radius = 196;
    const teams = items.length ? items : [null], segment = Math.PI*2/teams.length;
    const colors = ['#22d3ee','#8b5cf6','#34d399','#fbbf24','#fb7185','#38bdf8','#a78bfa','#2dd4bf','#f97316','#e879f9'];
    ctx.clearRect(0,0,420,420); ctx.save(); ctx.translate(center,center); ctx.rotate(angle);
    teams.forEach((t,i)=>{
      ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,radius,i*segment,(i+1)*segment);ctx.closePath();ctx.fillStyle=colors[i%10];ctx.fill();ctx.strokeStyle='#0f172a';ctx.lineWidth=3;ctx.stroke();
      ctx.save();ctx.rotate((i+.5)*segment);ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#081321';ctx.font='bold 16px sans-serif';
      const text = t ? name(t) : '抽選完了'; ctx.fillText(text.length>12?text.slice(0,11)+'…':text,radius-16,0);ctx.restore();
    });
    ctx.beginPath();ctx.arc(0,0,17,0,Math.PI*2);ctx.fillStyle='#0f172a';ctx.fill();ctx.restore();
  }
  function renderDraw() {
    if (!admin || spinning) return;
    const selected = Number($('targetSeed').value), free = tournament.slots.map((t,i)=>!t?i+1:null).filter(Boolean);
    $('targetSeed').innerHTML = free.map(seed=>`<option value="${seed}">枠${seed}${seed<=6?'（1回戦シード）':''}</option>`).join('') || '<option>全枠確定</option>';
    if (free.includes(selected)) $('targetSeed').value = selected;
    $('spinButton').disabled = !free.length; $('targetSeed').disabled = !free.length;
    $('allocationList').innerHTML = tournament.slots.map((t,i)=>`<span class="pill ${t?'ok':''}">枠${i+1}：${t?esc(name(t)):'未抽選'}</span>`).join('');
    wheel(TEAM_IDS.filter(t=>!tournament.slots.includes(t)),rotation);
  }
  function update(next) {
    if (!next || next.revision < tournament.revision) return;
    tournament = next; renderBracket(); renderDraw();
    // Do not silently discard an administrator's in-progress score entry.
    if (!$('scoreMatches').querySelector('[data-dirty="true"]')) renderScores();
    else notify('表が更新されました。編集中のスコアは保存前に最新状態を確認してください');
  }
  function renderSettings() {
    if (!adminConfig) return;
    $('teamSettings').innerHTML = TEAM_IDS.map(t=>`<div class="team-setting"><strong>${t}</strong><label>チーム名<input type="text" maxlength="40" required data-team-name="${t}" value="${esc(adminConfig.teamNames[t])}"></label><label>ドラフト用パスワード<input type="text" maxlength="100" required autocomplete="off" data-team-pass="${t}" value="${esc(adminConfig.teamPasswords[t])}"></label></div>`).join('');
    $('rankSettings').innerHTML = ''; adminConfig.ranks.forEach(addRank);
  }
  function addRank(rank = { name:'', points:0 }) {
    const row = document.createElement('div'); row.className='rank-row';
    row.innerHTML = `<label>ランク帯<input type="text" required maxlength="40" data-rank-name value="${esc(rank.name)}"></label><label>ポイント<input type="number" required min="0" max="99999" step="1" data-rank-points value="${rank.points}"></label><button class="btn bad" type="button" aria-label="ランク帯を削除">削除</button>`;
    row.querySelector('button').onclick=()=>row.remove(); $('rankSettings').append(row);
  }
  function lock(navigate = true) {
    if (admin) socket.emit('admin:logout');
    admin=false; adminConfig=null; animationToken++; spinning=false;
    $('settingsForm').reset(); $('teamSettings').innerHTML=''; $('rankSettings').innerHTML=''; $('scoreMatches').innerHTML='';
    if (navigate && !$('panel-admin').classList.contains('hidden')) showTab('tournament');
  }
  function open() { $('adminPass').value=''; $('adminLoginError').textContent=''; $('adminDialog').showModal(); $('adminPass').focus(); }
  $('adminCancel').onclick=()=>$('adminDialog').close();
  $('adminLogout').onclick=()=>lock();
  $('adminLoginForm').onsubmit=async e=>{
    e.preventDefault(); const button=e.submitter; button.disabled=true;
    try { const result=await request('admin:login',{pass:$('adminPass').value}); admin=true; adminConfig=result.settings; config=result.settings; $('adminDialog').close(); $('adminPass').value=''; renderSettings(); renderDraw(); renderScores(); showTab('admin'); }
    catch(error){ $('adminLoginError').textContent=error.message; }
    finally { button.disabled=false; }
  };
  $('addRank').onclick=()=>addRank();
  $('settingsForm').onsubmit=async e=>{
    e.preventDefault(); const button=e.submitter; button.disabled=true;
    const input={revision:adminConfig.revision,teamNames:{},teamPasswords:{},ranks:[]};
    TEAM_IDS.forEach(t=>{ input.teamNames[t]=$('teamSettings').querySelector(`[data-team-name="${t}"]`).value; input.teamPasswords[t]=$('teamSettings').querySelector(`[data-team-pass="${t}"]`).value; });
    input.ranks=[...$('rankSettings').children].map(row=>({name:row.querySelector('[data-rank-name]').value,points:Number(row.querySelector('[data-rank-points]').value)}));
    try { const result=await request('admin:settings',input); adminConfig=result.settings; renderSettings(); notify('設定を保存しました'); }
    catch(error){notify(error.message);} finally {button.disabled=false;}
  };
  $('scoreMatches').addEventListener('input',e=>{ const form=e.target.closest('form'); if(form) form.dataset.dirty='true'; });
  $('scoreMatches').addEventListener('submit', async e=>{
    e.preventDefault(); const form=e.target, button=e.submitter; button.disabled=true;
    const games=[0,1,2].map(i=>[0,1].map(side=>{ const v=form.querySelector(`[data-game="${i}"][data-side="${side}"]`).value; return v===''?null:Number(v); }));
    try {
      await request('tournament:score',{matchId:form.dataset.match,games,revision:Number(form.dataset.revision)});
      form.dataset.dirty='false'; renderScores(); notify('スコアを保存しました');
    } catch(error){ form.querySelector('.score-message').textContent=error.message; if(Number(form.dataset.revision)!==tournament.revision){ const reload=document.createElement('button'); reload.type='button';reload.className='btn';reload.textContent='入力を破棄して最新の表を表示';reload.onclick=()=>renderScores(false);form.querySelector('.score-message').append(reload); } }
    finally{button.disabled=false;}
  });
  $('spinButton').onclick=async()=>{
    if(spinning) return;
    const seed=Number($('targetSeed').value), items=TEAM_IDS.filter(t=>!tournament.slots.includes(t)), token=++animationToken;
    spinning=true; $('spinButton').disabled=true; $('targetSeed').disabled=true; $('resetTournament').disabled=true; $('rouletteResult').textContent='抽選中…';
    try {
      const result=await request('tournament:draw',{seed,revision:tournament.revision});
      if(token!==animationToken) return;
      const index=items.indexOf(result.team), segment=Math.PI*2/items.length;
      const desired=-Math.PI/2-(index+.5)*segment, start=rotation;
      const end=start+Math.PI*2*6+((desired-start)%(Math.PI*2)+Math.PI*2)%(Math.PI*2), started=performance.now();
      const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:3200;
      await new Promise(resolve=>{function frame(now){if(token!==animationToken)return resolve();const p=duration?Math.min(1,(now-started)/duration):1;rotation=start+(end-start)*(1-(1-p)**4);wheel(items,rotation);if(p<1)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});
      if(token!==animationToken) return;
      $('rouletteResult').textContent=`${name(result.team)} → 枠${seed} に決定！`;
    } catch(error){notify(error.message);$('rouletteResult').textContent=error.message;}
    finally{spinning=false;$('resetTournament').disabled=false;rotation=0;renderDraw();}
  };
  $('resetTournament').onclick=async()=>{
    if(!confirm('このルームのトーナメント抽選・全スコアをリセットします。ドラフトと選手登録は残ります。続けますか？'))return;
    try{await request('tournament:reset',{revision:tournament.revision});renderScores(false);$('rouletteResult').textContent='未抽選のチームから選びます';notify('トーナメントをリセットしました');}catch(error){notify(error.message);}
  };
  socket.on('tournament:updated',update);
  return { open, lock, update, settings(next){config=next;renderBracket();renderDraw();if(!$('scoreMatches').querySelector('[data-dirty="true"]'))renderScores();} };
}
