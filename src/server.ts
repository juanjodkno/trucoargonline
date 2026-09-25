// src/server.ts
// PRUEBA DE DEPLOY PARA DETECTOR DE ACTUALIZACION
import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import { getWeeklyRanking } from './ranking/weeklyRanking';
import { setupSocketEvents } from './sockets/gameSocket';
import { setupTeamSocketEvents } from './sockets/teamGameSocket';
import {
  initDatabase,
  registerUser,
  loginUser,
  requestDepositPersistent,
  getPendingDepositsFresh,
  approveDeposit,
  rejectDeposit,
  getUserChipsFresh,
  userExistsFresh,
  adjustUserChipsAndRecord,
  getAllUsersListFresh,
  resetUserPassword,
  deleteUser,
  getUserAvatar,
  updateUserAvatar,
  ALLOWED_AVATARS,
  getAdminMetricsFresh,
  getAllTransactionsFresh,
  getUserHistoryFresh,
  resetRakeCounter,
} from './auth/userService';

const app = express();
const server = http.createServer(app);
/* =========================================================
   SESIONES SEGURAS DE USUARIO
   ========================================================= */

const SESSION_SECRET = process.env.SESSION_SECRET || '';

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET no está configurado.');
}

const SESSION_COOKIE = 'truco_session';

function createSessionToken(username: string): string {

  const payload = Buffer.from(
    JSON.stringify({
      username: String(username || '').trim().toLowerCase(),
      exp: Date.now() + (30 * 24 * 60 * 60 * 1000)
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}


function verifySessionToken(token: string | undefined): string | null {

  if (!token) return null;

  const parts = token.split('.');

  if (parts.length !== 2) return null;

  const [payload, receivedSignature] = parts;

  const expectedSignature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');

  try {

    const receivedBuffer =
      Buffer.from(receivedSignature, 'base64url');

    const expectedBuffer =
      Buffer.from(expectedSignature, 'base64url');

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      return null;
    }

    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );

    if (!decoded.username || !decoded.exp) {
      return null;
    }

    if (Date.now() > Number(decoded.exp)) {
      return null;
    }

    return String(decoded.username).trim().toLowerCase();

  } catch {
    return null;
  }
}


function getCookie(
  req: express.Request,
  cookieName: string
): string | undefined {

  const cookies = String(req.headers.cookie || '')
    .split(';')
    .map(v => v.trim());

  for (const cookie of cookies) {

    const separator = cookie.indexOf('=');

    if (separator === -1) continue;

    const name = cookie.slice(0, separator);
    const value = cookie.slice(separator + 1);

    if (name === cookieName) {
      return decodeURIComponent(value);
    }
  }

  return undefined;
}


function setUserSession(
  res: express.Response,
  username: string,
  remember: boolean
) {

  const token = createSessionToken(username);

  const secure =
    process.env.RENDER
      ? '; Secure'
      : '';

  const persistent =
    remember
      ? '; Max-Age=2592000'
      : '';

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${secure}${persistent}`
  );
}


function clearUserSession(res: express.Response) {

  const secure =
    process.env.RENDER
      ? '; Secure'
      : '';

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}


function requireUserSession(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {

  const token =
    getCookie(req, SESSION_COOKIE);

  const username =
    verifySessionToken(token);

  if (!username) {

    return res.status(401).json({
      success: false,
      message: 'Sesión no válida o vencida.'
    });
  }

  res.locals.authUsername =
    username;

  next();
}


function safeUserForClient(user: any) {

  if (!user) return user;

  const {
    passwordHash,
    salt,
    password,
    ...safeUser
  } = user;

  return safeUser;
} 

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
app.use(express.json());

/* =========================================================
   VERSION PUBLICADA DE LA APP
   Solo informa qué deploy está activo.
   NO modifica partidas, fichas ni lógica del juego.
   ========================================================= */

const APP_VERSION = String(
  process.env.RENDER_GIT_COMMIT ||
  `local-${Date.now()}`
);

app.get('/api/app-version', (_req, res) => {

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );

  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  return res.json({
    success: true,
    version: APP_VERSION
  });

});

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.static(path.join(__dirname, '../public')));

app.get('/ranking', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/ranking.html'));
});

app.get('/api/ranking', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const username = verifySessionToken(
      getCookie(req, SESSION_COOKIE)
    );

    res.json(await getWeeklyRanking(new Date(), username));
  } catch (error) {
    console.error('Error consultando ranking semanal:', error);

    res.status(503).json({
      message: 'No se pudo cargar el ranking semanal.'
    });
  }
});
// Servir la vista de administración
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Modo 2 vs 2 integrado. La interfaz y la lógica 2v2 se mantienen en archivos separados.
app.get('/2v2', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/team.html'));
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

  const {
    usernameOrEmail,
    password,
    remember
  } = req.body;

  const result = await loginUser(
    usernameOrEmail,
    password
  );

  if (!result.success || !result.user) {

    return res
      .status(401)
      .json(result);
  }

  // Crear cookie segura de sesión
  setUserSession(
    res,
    result.user.username,
    !!remember
  );

  return res.json({
    ...result,
    user: safeUserForClient(result.user)
  });
});

// Valida sesiones guardadas en el navegador contra la fuente autoritativa.
app.get('/api/auth/session/:username', async (req, res) => {
  try {
    const exists = await userExistsFresh(req.params.username);
    if (!exists) return res.status(404).json({ success: false, valid: false, message: 'La cuenta ya no existe.' });
    return res.json({ success: true, valid: true });
  } catch {
    return res.status(503).json({ success: false, valid: false, message: 'No se pudo validar la sesión.' });
  }
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
    return res.status(400).json({
      success: false,
      message: 'Datos incompletos.'
    });
  }

  const ok = updateUserAvatar(username, avatarId);

  if (!ok) {
    return res.status(400).json({
      success: false,
      message: 'Avatar no válido o usuario inexistente.'
    });
  }

  return res.json({
    success: true,
    message: 'Avatar actualizado correctamente.',
    avatar: avatarId
  });
});


/* =========================================================
   HISTORIAL PERSONAL DEL USUARIO
   SOLO LECTURA - NO MODIFICA FICHAS
   ========================================================= */

/* =========================================================
   HISTORIAL PRIVADO DEL USUARIO
   ========================================================= */

app.get(
  '/api/user/history',
  requireUserSession,
  async (req, res) => {

    try {

      /*
        NO usamos username enviado por el navegador.

        El usuario sale exclusivamente de
        la sesión firmada por el servidor.
      */

      const username =
        String(res.locals.authUsername || '');

      const history =
        await getUserHistoryFresh(
          username,
          100
        );

      return res.json({
        success: true,
        history
      });

    } catch (err) {

      console.error(
        'Error cargando historial del usuario:',
        err
      );

      return res.status(503).json({
        success: false,
        message:
          'No se pudo cargar el historial.'
      });
    }
  }
);



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

/* =========================================================
   PRUEBA ASTROPAY -> TASKER -> RENDER
   SOLO RECIBE Y REGISTRA LA NOTIFICACIÓN.
   NO MODIFICA FICHAS NI DEPÓSITOS.
   ========================================================= */

const ASTROPAY_DEVICE_SECRET =
  process.env.ASTROPAY_DEVICE_SECRET || '';

app.post('/api/internal/astropay-test', (req, res) => {
  const secretReceived =
    String(req.headers['x-astropay-secret'] || '');

  if (
    !ASTROPAY_DEVICE_SECRET ||
    secretReceived !== ASTROPAY_DEVICE_SECRET
  ) {
    return res.status(401).json({
      success: false,
      message: 'No autorizado.'
    });
  }

  const {
    packageName,
    title,
    text
  } = req.body || {};

  console.log('====================================');
  console.log('📲 NOTIFICACIÓN ASTROPAY RECIBIDA');
  console.log('Package:', packageName);
  console.log('Título:', title);
  console.log('Texto:', text);
  console.log('Fecha:', new Date().toISOString());
  console.log('====================================');

  return res.json({
    success: true,
    received: true,
    packageName,
    title,
    text
  });
});
setupSocketEvents(io);
setupTeamSocketEvents(io);

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
