// src/server.ts
import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import { setupSocketEvents } from './sockets/gameSocket';
import { 
  initDatabase,
  registerUser, 
  loginUser, 
  requestDeposit, 
  getPendingDeposits, 
  approveDeposit, 
  getUserChips,
  modifyUserChips,
  getAllUsersList,
  resetUserPassword,
  deleteUser,
  getUserAvatar,
  updateUserAvatar,
  ALLOWED_AVATARS
} from './auth/userService';

const app = express();
const server = http.createServer(app);

// Habilitar trust proxy para reconocer la IP real del cliente detrás del proxy de Render
app.set('trust proxy', 1);

// Inicializar conexión
initDatabase();

const ADMIN_PIN = process.env.ADMIN_PIN || '36049655Dk,';

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Limitador de tasa contra ataques de fuerza bruta en Login y Registro
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Ventana de 15 minutos
  max: 15, // Máximo 15 intentos por IP
  message: { success: false, message: 'Demasiadas solicitudes. Por favor reintentá en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limitador estricto para el acceso de Administrador
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Máximo 5 intentos para adivinar el PIN
  message: { success: false, message: 'Demasiados intentos de acceso admin. Bloqueado temporalmente.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const requireAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const pinReceived = req.headers['x-admin-pin'];
  if (!pinReceived || pinReceived !== ADMIN_PIN) {
    return res.status(401).json({ success: false, message: 'Acceso no autorizado. Contraseña de Administrador requerida.' });
  }
  next();
};

app.post('/api/admin/auth', adminAuthLimiter, (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN) {
    return res.json({ success: true, message: 'Acceso autorizado.' });
  }
  return res.status(401).json({ success: false, message: 'Contraseña de Administrador incorrecta.' });
});

// Rutas de autenticación protegidas con Rate Limiting
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { fullName, email, username, password } = req.body;
  const result = await registerUser(fullName, email, username, password);
  return res.status(result.success ? 201 : 400).json(result);
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { usernameOrEmail, password } = req.body;
  const result = await loginUser(usernameOrEmail, password);
  return res.status(result.success ? 200 : 401).json(result);
});

// Gestión de Avatares
app.get('/api/user/avatars-list', (req, res) => {
  return res.json({ avatars: ALLOWED_AVATARS });
});

app.get('/api/user/avatar/:username', (req, res) => {
  const avatar = getUserAvatar(req.params.username);
  return res.json({ avatar });
});

app.post('/api/user/avatar', (req, res) => {
  const { username, avatarId } = req.body;
  if (!username || !avatarId) {
    return res.status(400).json({ success: false, message: 'Datos incompletos.' });
  }

  const ok = updateUserAvatar(username, avatarId);
  if (!ok) {
    return res.status(400).json({ success: false, message: 'Avatar no válido o usuario inexistente.' });
  }

  return res.json({ success: true, message: 'Avatar actualizado correctamente.', avatar: avatarId });
});

// Billetera
app.get('/api/wallet/balance/:username', (req, res) => {
  const chips = getUserChips(req.params.username);
  return res.json({ chips });
});

app.post('/api/wallet/deposit-request', (req, res) => {
  const { username, amount, reference } = req.body;
  const result = requestDeposit(username, Number(amount), reference);
  return res.status(result.success ? 200 : 400).json(result);
});

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

// Panel Administrativo
app.get('/api/admin/users-list', requireAdminAuth, (req, res) => {
  const users = getAllUsersList();
  return res.json(users);
});

app.post('/api/admin/add-chips', requireAdminAuth, (req, res) => {
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

app.post('/api/admin/remove-chips', requireAdminAuth, (req, res) => {
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

app.post('/api/admin/reset-password', requireAdminAuth, (req, res) => {
  const { username, newPassword } = req.body;
  const ok = resetUserPassword(username, newPassword);
  if (!ok) {
    return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
  }
  return res.json({ success: true, message: `Contraseña de @${username} actualizada con éxito.` });
});

app.post('/api/admin/delete-user', requireAdminAuth, async (req, res) => {
  const { username } = req.body;
  const ok = await deleteUser(username);
  if (!ok) {
    return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
  }
  return res.json({ success: true, message: `Usuario @${username} eliminado correctamente.` });
});

app.get('/api/admin/pending-deposits', requireAdminAuth, (req, res) => {
  return res.json(getPendingDeposits());
});

app.post('/api/admin/approve-deposit', requireAdminAuth, (req, res) => {
  const { depositId } = req.body;
  const result = approveDeposit(depositId);
  return res.status(result.success ? 200 : 400).json(result);
});

setupSocketEvents(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Servidor de Truco corriendo en http://localhost:${PORT}`);
});