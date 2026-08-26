// src/server.ts
import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { setupSocketEvents } from './sockets/gameSocket';
import { 
  registerUser, 
  loginUser, 
  requestDeposit, 
  getPendingDeposits, 
  approveDeposit, 
  getUserChips,
  modifyUserChips,
  getAllUsersList,
  resetUserPassword
} from './auth/userService';

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

// Auth
app.post('/api/auth/register', (req, res) => {
  const { fullName, email, username, password } = req.body;
  const result = registerUser(fullName, email, username, password);
  return res.status(result.success ? 201 : 400).json(result);
});

app.post('/api/auth/login', (req, res) => {
  const { usernameOrEmail, password } = req.body;
  const result = loginUser(usernameOrEmail, password);
  return res.status(result.success ? 200 : 401).json(result);
});

// Billetera: Saldo
app.get('/api/wallet/balance/:username', (req, res) => {
  const chips = getUserChips(req.params.username);
  return res.json({ chips });
});

// Billetera: Solicitud de Carga
app.post('/api/wallet/deposit-request', (req, res) => {
  const { username, amount, reference } = req.body;
  const result = requestDeposit(username, Number(amount), reference);
  return res.status(result.success ? 200 : 400).json(result);
});

// Billetera: Retiro con descuento automático de saldo
app.post('/api/wallet/withdraw-request', (req, res) => {
  const { username, amount } = req.body;
  const numAmount = Number(amount);

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
  }

  const success = modifyUserChips(username, -numAmount);
  if (!success) {
    return res.status(400).json({ success: false, message: 'Saldo insuficiente para realizar el retiro.' });
  }

  const currentChips = getUserChips(username);
  return res.json({ 
    success: true, 
    message: 'Retiro procesado y descontado correctamente.',
    chips: currentChips 
  });
});

// Panel Admin: Listar usuarios
app.get('/api/admin/users-list', (req, res) => {
  const users = getAllUsersList();
  return res.json(users);
});

// Panel Admin: Cargar fichas (+)
app.post('/api/admin/add-chips', (req, res) => {
  const { username, amount } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Monto inválido.' });
  }

  const success = modifyUserChips(username, numAmount);
  if (!success) {
    return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
  }
  const currentChips = getUserChips(username);
  return res.json({ 
    success: true, 
    message: `¡Se acreditaron $${new Intl.NumberFormat('es-AR').format(numAmount)} fichas a @${username}!`, 
    chips: currentChips 
  });
});

// Panel Admin: Descontar fichas (-)
app.post('/api/admin/remove-chips', (req, res) => {
  const { username, amount } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Monto inválido.' });
  }

  const success = modifyUserChips(username, -numAmount);
  if (!success) {
    return res.status(400).json({ success: false, message: 'Usuario no encontrado o saldo insuficiente para descontar.' });
  }
  const currentChips = getUserChips(username);
  return res.json({ 
    success: true, 
    message: `¡Se descontaron $${new Intl.NumberFormat('es-AR').format(numAmount)} fichas a @${username}!`, 
    chips: currentChips 
  });
});

// Panel Admin: Resetear Contraseña
app.post('/api/admin/reset-password', (req, res) => {
  const { username, newPassword } = req.body;
  const ok = resetUserPassword(username, newPassword);
  if (!ok) {
    return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
  }
  return res.json({ success: true, message: `Contraseña de @${username} actualizada con éxito.` });
});

app.get('/api/admin/pending-deposits', (req, res) => {
  return res.json(getPendingDeposits());
});

app.post('/api/admin/approve-deposit', (req, res) => {
  const { depositId } = req.body;
  const result = approveDeposit(depositId);
  return res.status(result.success ? 200 : 400).json(result);
});

setupSocketEvents(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Servidor de Truco corriendo en http://localhost:${PORT}`);
});