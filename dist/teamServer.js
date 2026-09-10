"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const socket_io_1 = require("socket.io");
const teamGameSocket_1 = require("./sockets/teamGameSocket");
// Servidor de laboratorio EXCLUSIVO para el modo 2 vs 2.
// No importa ni ejecuta gameSocket.ts, TrucoRound 1v1 ni la billetera.
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: { origin: '*' },
    pingTimeout: 30000,
    pingInterval: 10000,
    transports: ['websocket', 'polling']
});
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
app.get('/', (_req, res) => {
    res.redirect('/2v2');
});
app.get('/2v2', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/team.html'));
});
(0, teamGameSocket_1.setupTeamSocketEvents)(io);
const PORT = Number(process.env.TEAM_PORT || 3001);
server.listen(PORT, () => {
    console.log(`🧪 Laboratorio Truco 2 vs 2: http://localhost:${PORT}/2v2`);
    console.log('✅ El servidor 1 vs 1 y la billetera NO se cargan en este proceso.');
});
