(() => {
  let attached=null, latest=null, requestId=null, busy=false, walletState='', walletDesired='', walletRequest=null, walletSyncedAt=0, lastRecoveryKey='', lastRecoveryAt=0;
  const card=document.createElement('section');
  card.id='dailyTournament';
  card.style.cssText='background:linear-gradient(135deg,#123348,#172438);border:1px solid #48cae4;border-radius:14px;padding:20px;color:#e2e8f0';
  card.innerHTML='<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><strong style="font-size:1.2rem;color:#7dd3fc">🏆 Torneo diario · 22:00 hs</strong><span>8 jugadores · 30 puntos · Sin flor</span></div><p>Inscripción: <b>3.000 fichas</b> · 1º: 13.000 · 2º: 5.000 · 3º: 3.000</p><p style="font-size:.85rem;color:#b8c9d8">Horario argentino. Inscripciones de 18:00 a 22:00. Cancelación hasta antes de las 21:55. No afecta el ranking semanal.</p><p id="tournamentStatus" aria-live="polite">Consultando torneo…</p><button id="tournamentJoin" type="button" class="btn-bot-lobby">Inscribirme por 3.000 fichas</button> <button id="tournamentCancel" type="button" class="btn-bot-lobby" hidden>Cancelar inscripción</button><p id="tournamentMessage" aria-live="polite"></p><div id="tournamentBracket" style="display:grid;gap:8px;margin-top:12px"></div>';
  document.querySelector('.lobby-header').insertAdjacentElement('afterend',card);
  const status=card.querySelector('#tournamentStatus'),message=card.querySelector('#tournamentMessage'),join=card.querySelector('#tournamentJoin'),cancel=card.querySelector('#tournamentCancel');
  async function api(url,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{const r=await fetch(url,{method:body?'POST':'GET',signal:controller.signal,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok||!d.success)throw Error(d.message||'No se pudo completar la operación.');return d;}
    catch(e){if(e.name==='AbortError')throw Error('La conexión demoró demasiado. Podés reintentar; la inscripción se cobra una sola vez.');throw e;}
    finally{clearTimeout(timer);}
  }
  function newRequestId(){
    // randomUUID no está disponible en HTTP por IP local; getRandomValues sí.
    if(typeof globalThis.crypto?.randomUUID==='function')return globalThis.crypto.randomUUID();
    const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  }
  function time(now){const p=new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);const v=Object.fromEntries(p.map(x=>[x.type,x.value]));return +v.hour*3600 + +v.minute*60 + +v.second;}
  function syncWallet(key){
    walletDesired=key;
    const inLobby=getComputedStyle(document.getElementById('lobbyContainer')).display!=='none';
    if(!currentUser||currentUser.isGuest||busy||walletRequest?.key===key||(walletState===key&&(!inLobby||Date.now()-walletSyncedAt<5000)))return;
    const request={key,user:currentUser.username};walletRequest=request;
    fetch('/api/wallet/balance/'+encodeURIComponent(request.user)).then(async r=>{if(!r.ok)throw Error('Saldo no disponible');return r.json();}).then(d=>{
      if(walletRequest===request&&walletDesired===key&&currentUser?.username===request.user&&!busy&&Number.isFinite(Number(d.chips))){updateChipsDisplay(d.chips);walletState=key;walletSyncedAt=Date.now();}
    }).catch(()=>{}).finally(()=>{if(walletRequest===request)walletRequest=null;});
  }
  function recoverAssignment(roomId){
    if(!roomId||!socket?.connected||!currentUser||currentUser.isGuest)return;
    const lobbyVisible=getComputedStyle(document.getElementById('lobbyContainer')).display!=='none';
    if(!lobbyVisible||(activeRoomId&&!String(activeRoomId).startsWith('torneo_')))return;
    const key=socket.id+':'+roomId,now=Date.now();
    if(lastRecoveryKey===key&&now-lastRecoveryAt<1500)return;
    lastRecoveryKey=key;lastRecoveryAt=now;
    // Pedir el estado de la sala existente es seguro ante un evento de apertura perdido.
    socket.emit('reconnect_game',{roomId,userId:currentUser.username});
  }
  function render(s){
    // Un aviso demorado de otra fecha no puede reemplazar la inscripción del día mostrado.
    if(!s||!Number.isFinite(Number(s.serverNow)))return;
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(Number(s.serverNow));
    const date=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    if(s.day!==`${date.year}-${date.month}-${date.day}`)return;
    latest=s;const mine=s.entries.find(e=>e.user===currentUser?.username),seconds=time(s.serverNow);
    syncWallet(JSON.stringify([currentUser?.username,s.day,mine?.id||null,s.status,s.prizes]));
    const texts={open:`${s.entries.length}/8 inscriptos. ${seconds<64800?'La inscripción abre a las 18:00.':seconds<79200?'Inicio automático a las 22:00.':'Inscripciones cerradas.'}`,running:'Torneo en curso. Esperá en el lobby para ingresar al próximo cruce.',cancelled:'Torneo cancelado. Las inscripciones fueron devueltas.',done:'Torneo finalizado. Premios acreditados.'};
    status.textContent=texts[s.status]||'';
    join.hidden=!!mine||s.status!=='open';join.disabled=busy||seconds<64800||seconds>=79200||s.entries.length>=8||Number(currentUser?.chips)<3000;
    join.title=s.entries.length>=8?'El torneo está completo.':Number(currentUser?.chips)<3000?'Necesitás al menos 3.000 fichas.':'';
    if(!mine&&s.status==='open'&&seconds>=64800&&seconds<79200){
      if(s.entries.length>=8)status.textContent+=' El torneo está completo.';
      else if(Number(currentUser?.chips)<3000)status.textContent+=' Necesitás al menos 3.000 fichas para inscribirte.';
    }
    cancel.hidden=!mine||s.status!=='open';cancel.disabled=busy||seconds>=78900;
    if(mine)status.textContent+=' Estás inscripto.';
    const box=card.querySelector('#tournamentBracket');box.replaceChildren();
    for(const m of s.matches){const line=document.createElement('div');line.style.cssText='padding:9px;background:#0f172a;border-radius:8px;font-size:.9rem';const waiting=m.status==='waiting'?` · Presentarse: ${Math.max(0,Math.ceil((m.deadline-s.serverNow)/1000))} s`:'';line.textContent=`${m.stage}: ${m.players.map(u=>u?'@'+u:'Sin rival').join(' vs ')} · ${m.status==='playing'?'Jugando':m.status==='done'?(m.winner?'Avanza @'+m.winner:'Sin clasificados'):'Esperando'}${waiting}`;box.appendChild(line);}
    const prizes=Object.entries(s.prizes);if(prizes.length){const p=document.createElement('p');p.textContent=prizes.map(([rank,user])=>`${rank}º: @${user}`).join(' · ');box.appendChild(p);}
  }
  async function refresh(){if(!currentUser||currentUser.isGuest)return;try{const d=await api('/api/tournament');render(d.tournament);}catch(e){message.textContent=e.message;}}
  async function presence(){
    if(!currentUser||currentUser.isGuest||!socket?.connected)return;
    const lobby=document.getElementById('lobbyContainer');
    const inLobby=getComputedStyle(lobby).display!=='none'&&!isGameStarted;
    try{const d=await api('/api/tournament/presence',{socketId:socket.id,inLobby});recoverAssignment(d.assignedRoomId);}catch(e){message.textContent=e.message;if(inLobby&&!activeRoomId&&e.message.includes('Reconectá')){socket.disconnect();socket.connect();}}
  }
  join.onclick=async()=>{
    if(busy||join.disabled)return;
    if(!confirm('La inscripción cuesta 3.000 fichas. Debés estar en el lobby a las 22:00; si estás en otra partida o ausente tendrás 180 segundos para presentarte. Podés cancelar únicamente antes de las 21:55. ¿Confirmás la inscripción?'))return;
    busy=true;walletRequest=null;walletState='';if(latest)render(latest);message.textContent='Procesando inscripción…';
    try{requestId=requestId||newRequestId();const d=await api('/api/tournament/register',{requestId});updateChipsDisplay(d.chips);requestId=null;message.textContent='Inscripción confirmada. Esperá en el lobby a las 22:00.';}catch(e){message.textContent=e.message;}finally{busy=false;await refresh();}
  };
  cancel.onclick=async()=>{
    const mine=latest?.entries.find(e=>e.user===currentUser?.username);if(busy||!mine)return;
    busy=true;walletRequest=null;walletState='';render(latest);try{const d=await api('/api/tournament/cancel',{entryId:mine.id});updateChipsDisplay(d.chips);message.textContent='Inscripción cancelada. Se devolvieron 3.000 fichas.';}catch(e){message.textContent=e.message;}finally{busy=false;await refresh();}
  };
  function tournamentHeader(data){
    if(!String(data.roomId||'').startsWith('torneo_'))return;
    const stage=latest?.matches.find(m=>m.id===data.roomId)?.stage||'Torneo';
    document.getElementById('lblRoom').textContent=`Torneo diario · ${stage} · ${Number(data.targetPoints)||30} pts · Sin flor`;
  }
  document.getElementById('btnAbandonar').addEventListener('click',event=>{
    if(!String(activeRoomId||'').startsWith('torneo_'))return;
    event.stopImmediatePropagation();event.preventDefault();
    if(confirm('¿Abandonar este cruce del torneo? Tu rival ganará el partido. No se devuelve la inscripción.'))socket.emit('surrender_match',{roomId:activeRoomId});
  },true);
  function attach(){
    if(!socket||socket===attached)return;attached=socket;
    socket.on('tournament_state',s=>render(s));
    socket.on('tournament_match_finished',data=>{
      if(activeRoomId===data.roomId){returnToLobbyAfterMatch();message.textContent=data.winnerId===currentUser?.username?'Ganaste el cruce. Esperá en el lobby el siguiente rival.':'Terminó tu partido del torneo. Consultá el cuadro de resultados.';}
      presence();refresh();
    });
    socket.on('game_ready',data=>{presence();if(data.isTournament){document.getElementById('winnerModal').style.display='none';const box=document.getElementById('gameLogs');if(box)log(`🏆 Torneo diario · ${Number(data.targetPoints)||30} puntos · Sin flor · Sin rake por partido`);presence();}});
    socket.on('game_ready',tournamentHeader);socket.on('sync_game_state',tournamentHeader);
    socket.on('connect',()=>{presence();refresh();});presence();refresh();
  }
  new MutationObserver(()=>presence()).observe(document.getElementById('lobbyContainer'),{attributes:true,attributeFilter:['style']});
  setInterval(attach,150);
  setInterval(()=>{attach();presence();refresh();},2000);
})();
