import { Server } from 'socket.io';
import { TournamentService, clock } from './service';
import { getActiveGamePresence } from '../sockets/activeGameRegistry';
import { getUserChipsFresh } from '../auth/userService';
export function mountTournament(app:any,io:Server, engine:any, service:TournamentService, auth:any, sessionUser:(cookie:string)=>string|null){
  const presence=new Map<string,{socketId:string;at:number;since:number;inLobby:boolean}>();
  io.use((socket,next)=>{socket.data.tournamentUser=sessionUser(String(socket.handshake.headers.cookie||''));next();});
  function socketFor(user:string){
    const p=presence.get(user); if(p&&io.sockets.sockets.get(p.socketId)?.connected)return p.socketId;
    if(p)return '';
    return [...io.sockets.sockets.values()].find(s=>s.data.tournamentUser===user)?.id||'';
  }
  const snapshotHashes=new Map<string,string>();
  service.bridge={
    available(user,before=Infinity){const p=presence.get(user);return !!p&&p.inLobby&&p.since<before&&!!io.sockets.sockets.get(p.socketId)?.connected&&!getActiveGamePresence(user)&&!engine.busy(user);},
    start(m){return engine.start(m.id,m.players,m.players.map(u=>socketFor(u!)));},
    activate(id){engine.activate(id);},
    exists(id){return engine.exists(id);},
    restore(m){engine.start(m.id,m.players,m.players.map(u=>socketFor(u!)),m.snapshot);engine.activate(m.id,true);},
    close(id){engine.close(id);},
    notify(users,event,data){for(const user of new Set(users))for(const s of io.sockets.sockets.values())if(s.data.tournamentUser===user)s.emit(event,data);}
  };
  const handle=(fn:any)=>async(req:any,res:any)=>{try{const result=await fn(req,res);if(!res.headersSent)res.json({success:true,...result});}catch(e){res.status(400).json({success:false,message:(e as Error).message});}};
  app.get('/api/tournament',auth,handle(async()=>({tournament:service.publicState(await service.state())})));
  app.post('/api/tournament/register',auth,handle(async(req,res)=>({entryId:await service.register(res.locals.authUsername,String(req.body.requestId||'')),chips:await getUserChipsFresh(res.locals.authUsername)})));
  app.post('/api/tournament/cancel',auth,handle(async(req,res)=>{await service.cancel(res.locals.authUsername,String(req.body.entryId||''));return {chips:await getUserChipsFresh(res.locals.authUsername)};}));
  app.post('/api/tournament/presence',auth,handle(async(req,res)=>{
    const user=res.locals.authUsername,socket=io.sockets.sockets.get(String(req.body.socketId||''));
    if(!socket||socket.data.tournamentUser!==user)throw Error('Reconectá tu sesión para participar del torneo.');
    const prev=presence.get(user), now=clock.now(),inLobby=req.body.inLobby===true;
    presence.set(user,{socketId:socket.id,at:now,since:prev?.inLobby&&inLobby&&prev.socketId===socket.id?prev.since:now,inLobby});
    const assigned=service.playingMatchFor(user), active=getActiveGamePresence(user);
    const selected=presence.get(user)?.socketId===socket.id;
    // Recupera la misma sala ya creada; no crea partidas ni mueve fichas.
    const assignedRoomId=selected&&assigned&&engine.exists(assigned.id)&&(!active||active.roomId===assigned.id)?assigned.id:null;
    return {assignedRoomId};
  }));
  let running=false;
  async function tick(){if(running)return;running=true;try{await service.tick();}catch(e){console.error('Torneo:',e);}finally{running=false;}}
  let interval: NodeJS.Timeout | undefined;
  return {tick,start:()=>{if(!interval)interval=setInterval(tick,1000);},stop:()=>{if(interval)clearInterval(interval);interval=undefined;},checkpoint(id:string,snapshot:any){
    const hash=JSON.stringify(snapshot);if(snapshotHashes.get(id)===hash)return;
    snapshotHashes.set(id,hash);
    service.snapshot(id,snapshot).catch(e=>{snapshotHashes.delete(id);console.error('Persistencia de torneo:',e);});
  }};
}
