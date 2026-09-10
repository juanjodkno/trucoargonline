import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { setupTeamSocketEvents } from './sockets/teamGameSocket';

// Servidor de laboratorio EXCLUSIVO para el modo 2 vs 2.
// No importa ni ejecuta gameSocket.ts, TrucoRound 1v1 ni la billetera.
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (_req, res) => {
  res.redirect('/2v2');
});

app.get('/2v2', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/team.html'));
});

setupTeamSocketEvents(io);

const PORT = Number(process.env.TEAM_PORT || 3001);
server.listen(PORT, () => {
  console.log(`🧪 Laboratorio Truco 2 vs 2: http://localhost:${PORT}/2v2`);
  console.log('✅ El servidor 1 vs 1 y la billetera NO se cargan en este proceso.');
});
