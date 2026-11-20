import type { Server } from 'socket.io';

interface Presence { user: string; inLobby: boolean; at: number; }
interface Activity { players: string[]; matches: number; }

// Presencia efímera. Las consultas leen memoria y nunca escriben saldos o partidas.
export function mountLobbyPresence(io: Server, activity: () => Activity) {
  const records = new Map<string, Presence>(), last = new Map<string, string>();
  const normalize = (user: string) => String(user || '').trim().toLowerCase();
  function publish() {
    const now = Date.now(), active = activity(), busy = new Set(active.players.map(normalize));
    for (const [id, p] of records) {
      if (!io.sockets.sockets.get(id)?.connected || now - p.at > 35000) { records.delete(id); last.delete(id); }
    }
    const users = [...new Set([...records.values()].filter(p => p.inLobby && !busy.has(p.user)).map(p => p.user))].sort();
    for (const [id, p] of records) {
      const socket = io.sockets.sockets.get(id);
      if (!socket || !p.inLobby) continue;
      const data = { players: users.filter(user => user !== p.user), activeMatches: active.matches };
      const signature = JSON.stringify(data);
      if (last.get(id) === signature) continue;
      last.set(id, signature); socket.emit('lobby_activity', data);
    }
  }
  io.on('connection', socket => {
    socket.on('lobby_presence', (payload: any) => {
      const user = normalize(socket.data.tournamentUser);
      if (!user) return;
      const previous = records.get(socket.id), now = Date.now(), inLobby = payload?.inLobby === true;
      if (previous && now - previous.at < 500 && previous.inLobby === inLobby) return;
      records.set(socket.id, { user, inLobby, at: now });
      if (!previous || previous.inLobby !== inLobby) last.delete(socket.id);
      publish();
    });
    socket.on('disconnect', () => { records.delete(socket.id); last.delete(socket.id); publish(); });
  });
  const interval = setInterval(publish, 2000); interval.unref();
  return { publish, stop: () => clearInterval(interval) };
}
