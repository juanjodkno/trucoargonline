"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const socket_io_1 = require("socket.io");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const gameSocket_1 = require("./sockets/gameSocket");
const teamGameSocket_1 = require("./sockets/teamGameSocket");
const userService_1 = require("./auth/userService");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
/* =========================================================
   SESIONES SEGURAS DE USUARIO
   ========================================================= */
const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET no está configurado.');
}
const SESSION_COOKIE = 'truco_session';
function createSessionToken(username) {
    const payload = Buffer.from(JSON.stringify({
        username: String(username || '').trim().toLowerCase(),
        exp: Date.now() + (30 * 24 * 60 * 60 * 1000)
    })).toString('base64url');
    const signature = crypto_1.default
        .createHmac('sha256', SESSION_SECRET)
        .update(payload)
        .digest('base64url');
    return `${payload}.${signature}`;
}
function verifySessionToken(token) {
    if (!token)
        return null;
    const parts = token.split('.');
    if (parts.length !== 2)
        return null;
    const [payload, receivedSignature] = parts;
    const expectedSignature = crypto_1.default
        .createHmac('sha256', SESSION_SECRET)
        .update(payload)
        .digest('base64url');
    try {
        const receivedBuffer = Buffer.from(receivedSignature, 'base64url');
        const expectedBuffer = Buffer.from(expectedSignature, 'base64url');
        if (receivedBuffer.length !== expectedBuffer.length ||
            !crypto_1.default.timingSafeEqual(receivedBuffer, expectedBuffer)) {
            return null;
        }
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!decoded.username || !decoded.exp) {
            return null;
        }
        if (Date.now() > Number(decoded.exp)) {
            return null;
        }
        return String(decoded.username).trim().toLowerCase();
    }
    catch {
        return null;
    }
}
function getCookie(req, cookieName) {
    const cookies = String(req.headers.cookie || '')
        .split(';')
        .map(v => v.trim());
    for (const cookie of cookies) {
        const separator = cookie.indexOf('=');
        if (separator === -1)
            continue;
        const name = cookie.slice(0, separator);
        const value = cookie.slice(separator + 1);
        if (name === cookieName) {
            return decodeURIComponent(value);
        }
    }
    return undefined;
}
function setUserSession(res, username, remember) {
    const token = createSessionToken(username);
    const secure = process.env.RENDER
        ? '; Secure'
        : '';
    const persistent = remember
        ? '; Max-Age=2592000'
        : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${secure}${persistent}`);
}
function clearUserSession(res) {
    const secure = process.env.RENDER
        ? '; Secure'
        : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}
function requireUserSession(req, res, next) {
    const token = getCookie(req, SESSION_COOKIE);
    const username = verifySessionToken(token);
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
function safeUserForClient(user) {
    if (!user)
        return user;
    const { passwordHash, salt, password, ...safeUser } = user;
    return safeUser;
}
// Habilitar trust proxy para reconocer la IP real del cliente detrás del proxy de Render
app.set('trust proxy', 1);
const ADMIN_PIN = process.env.ADMIN_PIN || '36049655Dk,';
const ADMIN_PIN_2 = process.env.ADMIN_PIN_2 || 'Emilia051';
const io = new socket_io_1.Server(server, {
    cors: { origin: '*' },
    pingTimeout: 30000,
    pingInterval: 10000,
    transports: ['websocket', 'polling']
});
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
// Servir la vista de administración
app.get('/admin', (req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/admin.html'));
});
// Modo 2 vs 2 integrado. La interfaz y la lógica 2v2 se mantienen en archivos separados.
app.get('/2v2', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/team.html'));
});
// Limitador de tasa contra ataques de fuerza bruta en Login y Registro
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { success: false, message: 'Demasiadas solicitudes. Por favor reintentá en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});
// Limitador estricto para el acceso de Administrador.
// Se conserva el fix previo: los accesos correctos no consumen intentos.
const adminAuthLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Demasiados intentos de acceso admin. Bloqueado temporalmente.' },
    standardHeaders: true,
    legacyHeaders: false,
});
const requireAdminAuth = (req, res, next) => {
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
    const result = await (0, userService_1.registerUser)(fullName, email, username, password);
    return res.status(result.success ? 201 : 400).json(result);
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { usernameOrEmail, password, remember } = req.body;
    const result = await (0, userService_1.loginUser)(usernameOrEmail, password);
    if (!result.success || !result.user) {
        return res
            .status(401)
            .json(result);
    }
    // Crear cookie segura de sesión
    setUserSession(res, result.user.username, !!remember);
    return res.json({
        ...result,
        user: safeUserForClient(result.user)
    });
});
// Valida sesiones guardadas en el navegador contra la fuente autoritativa.
app.get('/api/auth/session/:username', async (req, res) => {
    try {
        const exists = await (0, userService_1.userExistsFresh)(req.params.username);
        if (!exists)
            return res.status(404).json({ success: false, valid: false, message: 'La cuenta ya no existe.' });
        return res.json({ success: true, valid: true });
    }
    catch {
        return res.status(503).json({ success: false, valid: false, message: 'No se pudo validar la sesión.' });
    }
});
// Gestión de Avatares
app.get('/api/user/avatars-list', (req, res) => {
    return res.json({ avatars: userService_1.ALLOWED_AVATARS });
});
app.get('/api/user/avatar/:username', (req, res) => {
    const avatar = (0, userService_1.getUserAvatar)(req.params.username);
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
    const ok = (0, userService_1.updateUserAvatar)(username, avatarId);
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
app.get('/api/user/history', requireUserSession, async (req, res) => {
    try {
        /*
          NO usamos username enviado por el navegador.
  
          El usuario sale exclusivamente de
          la sesión firmada por el servidor.
        */
        const username = String(res.locals.authUsername || '');
        const history = await (0, userService_1.getUserHistoryFresh)(username, 100);
        return res.json({
            success: true,
            history
        });
    }
    catch (err) {
        console.error('Error cargando historial del usuario:', err);
        return res.status(503).json({
            success: false,
            message: 'No se pudo cargar el historial.'
        });
    }
});
// Billetera
app.get('/api/wallet/balance/:username', async (req, res) => {
    try {
        const chips = await (0, userService_1.getUserChipsFresh)(req.params.username);
        return res.json({ chips });
    }
    catch {
        return res.status(503).json({ success: false, message: 'No se pudo consultar el saldo.' });
    }
});
app.post('/api/wallet/deposit-request', async (req, res) => {
    const { username, amount, reference } = req.body;
    const result = await (0, userService_1.requestDepositPersistent)(username, Number(amount), reference);
    return res.status(result.success ? 200 : 400).json(result);
});
app.post('/api/wallet/withdraw-request', async (req, res) => {
    const { username, amount, cbuAlias } = req.body;
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
    }
    const result = await (0, userService_1.adjustUserChipsAndRecord)(username, -numAmount, 'WITHDRAW', `Retiro solicitado a ${cbuAlias || 'Alias/CBU'}`);
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
        return res.json(await (0, userService_1.getAdminMetricsFresh)());
    }
    catch (err) {
        console.error('Error cargando métricas admin:', err);
        return res.status(503).json({ success: false, message: 'No se pudieron cargar las métricas.' });
    }
});
// Reinicia únicamente el acumulador visible del rake. No borra partidas,
// transacciones ni modifica fichas de usuarios.
app.post('/api/admin/reset-rake-counter', requireAdminAuth, async (req, res) => {
    const result = await (0, userService_1.resetRakeCounter)();
    return res.status(result.success ? 200 : 503).json({
        ...result,
        message: result.success
            ? 'Contador de comisión reiniciado a $0. El historial se conserva intacto.'
            : (result.message || 'No se pudo reiniciar el contador de comisión.')
    });
});
app.get('/api/admin/transactions', requireAdminAuth, async (req, res) => {
    try {
        return res.json(await (0, userService_1.getAllTransactionsFresh)(100));
    }
    catch (err) {
        console.error('Error cargando historial admin:', err);
        return res.status(503).json({ success: false, message: 'No se pudo cargar el historial contable.' });
    }
});
app.get('/api/admin/users-list', requireAdminAuth, async (req, res) => {
    try {
        const users = await (0, userService_1.getAllUsersListFresh)();
        return res.json(users);
    }
    catch (err) {
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
    const result = await (0, userService_1.adjustUserChipsAndRecord)(username, numAmount, 'DEPOSIT', 'Carga manual desde Panel Admin');
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
    const result = await (0, userService_1.adjustUserChipsAndRecord)(username, -numAmount, 'WITHDRAW', 'Débito manual desde Panel Admin');
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
    const ok = (0, userService_1.resetUserPassword)(username, newPassword);
    if (!ok) {
        return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
    }
    return res.json({ success: true, message: `Contraseña de @${username} actualizada con éxito.` });
});
app.post('/api/admin/delete-user', requireAdminAuth, async (req, res) => {
    const { username } = req.body;
    const ok = await (0, userService_1.deleteUser)(username);
    if (!ok) {
        return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
    }
    return res.json({ success: true, message: `Usuario @${username} eliminado correctamente.` });
});
app.get('/api/admin/pending-deposits', requireAdminAuth, async (req, res) => {
    try {
        return res.json(await (0, userService_1.getPendingDepositsFresh)());
    }
    catch (err) {
        console.error('Error cargando depósitos pendientes:', err);
        return res.status(503).json({ success: false, message: 'No se pudieron cargar los depósitos pendientes.' });
    }
});
app.post('/api/admin/approve-deposit', requireAdminAuth, async (req, res) => {
    const { depositId } = req.body;
    const result = await (0, userService_1.approveDeposit)(depositId);
    return res.status(result.success ? 200 : 400).json(result);
});
app.post('/api/admin/reject-deposit', requireAdminAuth, async (req, res) => {
    const { depositId } = req.body;
    const result = await (0, userService_1.rejectDeposit)(depositId);
    return res.status(result.success ? 200 : 400).json(result);
});
(0, gameSocket_1.setupSocketEvents)(io);
(0, teamGameSocket_1.setupTeamSocketEvents)(io);
const PORT = process.env.PORT || 3000;
async function startServer() {
    // Una sola inicialización. userService.ts ya no se auto-inicializa al importarse.
    await (0, userService_1.initDatabase)();
    server.listen(PORT, () => {
        console.log(`🎮 Servidor de Truco corriendo en http://localhost:${PORT}`);
    });
}
startServer().catch(err => {
    console.error('❌ No se pudo iniciar el servidor:', err);
    process.exit(1);
});
