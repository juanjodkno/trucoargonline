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
  requestDepositPersistent,
  getPendingDepositsFresh,
  approveDeposit,
  rejectDeposit,
  getUserChipsFresh,
  adjustUserChipsAndRecord,
  getAllUsersListFresh,
  resetUserPassword,
  deleteUser,
  getUserAvatar,
  updateUserAvatar,
  ALLOWED_AVATARS,
  getAdminMetricsFresh,
  getAllTransactionsFresh,
  resetRakeCounter
} from './auth/userService';

const app = express();
const server = http.createServer(app);

// Habilitar trust proxy para reconocer la IP real del cliente detrás del proxy de Render
app.set('trust proxy', 1);

const ADMIN_PIN = process.env.ADMIN_PIN || '36049655Dk,';
const ADMIN_PIN_2 = process.env.ADMIN_PIN_2 || 'Emilia051';

const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
  transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Servir la vista de administración
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Limitador de tasa contra ataques de fuerza bruta en Login y Registro
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, message: 'Demasiadas solicitudes. Por favor reintentá en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limitador estricto para el acceso de Administrador.
// Se conserva el fix previo: los accesos correctos no consumen intentos.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Demasiados intentos de acceso admin. Bloqueado temporalmente.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const requireAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const pinReceived = req.headers['x-admin-pin'];
  if (!pinReceived || (pinReceived !== ADMIN_PIN && pinReceived !== ADMIN_PIN_2)) {
    return res.status(401).json({ success: false, message: 'Acceso no autorizado. Contraseña de Administrador requerida.' });
  }
  next();
};

app.post('/api/admin/auth', adminAuthLimiter, (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN || pin === ADMIN_PIN_2) {
    return res.json({ success: true, message: 'Acceso autorizado.' });
  }
  return res.status(401).json({ success: false, message: 'Contraseña de Administrador incorrecta.' });
});

// Rutas de autenticación
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
app.get('/api/wallet/balance/:username', async (req, res) => {
  try {
    const chips = await getUserChipsFresh(req.params.username);
    return res.json({ chips });
  } catch {
    return res.status(503).json({ success: false, message: 'No se pudo consultar el saldo.' });
  }
});

app.post('/api/wallet/deposit-request', async (req, res) => {
  const { username, amount, reference } = req.body;
  const result = await requestDepositPersistent(username, Number(amount), reference);
  return res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/wallet/withdraw-request', async (req, res) => {
  const { username, amount, cbuAlias } = req.body;
  const numAmount = Number(amount);

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
  }

  const result = await adjustUserChipsAndRecord(
    username,
    -numAmount,
    'WITHDRAW',
    `Retiro solicitado a ${cbuAlias || 'Alias/CBU'}`
  );

  if (!result.success) {
    return res.status(400).json({
      success: false,
      message: result.message || 'Saldo insuficiente para realizar el retiro.'
    });
  }

  return res.json({
    success: true,
    message: 'Retiro procesado y descontado correctamente.',
    chips: result.balance ?? 0
  });
});

// Panel Administrativo - Métricas y Contabilidad
app.get('/api/admin/metrics', requireAdminAuth, async (req, res) => {
  try {
    return res.json(await getAdminMetricsFresh());
  } catch (err) {
    console.error('Error cargando métricas admin:', err);
    return res.status(503).json({ success: false, message: 'No se pudieron cargar las métricas.' });
  }
});


// Reinicia únicamente el acumulador visible del rake. No borra partidas,
// transacciones ni modifica fichas de usuarios.
app.post('/api/admin/reset-rake-counter', requireAdminAuth, async (req, res) => {
  const result = await resetRakeCounter();
  return res.status(result.success ? 200 : 503).json({
    ...result,
    message: result.success
      ? 'Contador de comisión reiniciado a $0. El historial se conserva intacto.'
      : (result.message || 'No se pudo reiniciar el contador de comisión.')
  });
});

app.get('/api/admin/transactions', requireAdminAuth, async (req, res) => {
  try {
    return res.json(await getAllTransactionsFresh(100));
  } catch (err) {
    console.error('Error cargando historial admin:', err);
    return res.status(503).json({ success: false, message: 'No se pudo cargar el historial contable.' });
  }
});

app.get('/api/admin/users-list', requireAdminAuth, async (req, res) => {
  try {
    const users = await getAllUsersListFresh();
    return res.json(users);
  } catch (err) {
    console.error('Error cargando usuarios admin:', err);
    return res.status(503).json({ success: false, message: 'No se pudo cargar la lista de usuarios.' });
  }
});

app.post('/api/admin/add-chips', requireAdminAuth, async (req, res) => {
  const { username, amount } = req.body;
  const numAmount = Number(amount);

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Monto inválido.' });
  }

  const result = await adjustUserChipsAndRecord(
    username,
    numAmount,
    'DEPOSIT',
    'Carga manual desde Panel Admin'
  );

  if (!result.success) {
    return res.status(400).json({ success: false, message: result.message || 'Usuario no encontrado.' });
  }

  return res.json({
    success: true,
    message: `¡Se acreditaron $${new Intl.NumberFormat('es-AR').format(numAmount)} fichas a @${username}!`,
    chips: result.balance ?? 0
  });
});

app.post('/api/admin/remove-chips', requireAdminAuth, async (req, res) => {
  const { username, amount } = req.body;
  const numAmount = Number(amount);

  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Monto inválido.' });
  }

  const result = await adjustUserChipsAndRecord(
    username,
    -numAmount,
    'WITHDRAW',
    'Débito manual desde Panel Admin'
  );

  if (!result.success) {
    return res.status(400).json({
      success: false,
      message: result.message || 'Usuario no encontrado o saldo insuficiente para descontar.'
    });
  }

  return res.json({
    success: true,
    message: `¡Se descontaron $${new Intl.NumberFormat('es-AR').format(numAmount)} fichas a @${username}!`,
    chips: result.balance ?? 0
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

app.get('/api/admin/pending-deposits', requireAdminAuth, async (req, res) => {
  try {
    return res.json(await getPendingDepositsFresh());
  } catch (err) {
    console.error('Error cargando depósitos pendientes:', err);
    return res.status(503).json({ success: false, message: 'No se pudieron cargar los depósitos pendientes.' });
  }
});

app.post('/api/admin/approve-deposit', requireAdminAuth, async (req, res) => {
  const { depositId } = req.body;
  const result = await approveDeposit(depositId);
  return res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/admin/reject-deposit', requireAdminAuth, async (req, res) => {
  const { depositId } = req.body;
  const result = await rejectDeposit(depositId);
  return res.status(result.success ? 200 : 400).json(result);
});

setupSocketEvents(io);

const PORT = process.env.PORT || 3000;

async function startServer() {
  // Una sola inicialización. userService.ts ya no se auto-inicializa al importarse.
  await initDatabase();

  server.listen(PORT, () => {
    console.log(`🎮 Servidor de Truco corriendo en http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('❌ No se pudo iniciar el servidor:', err);
  process.exit(1);
});
