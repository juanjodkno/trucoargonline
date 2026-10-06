"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
// PRUEBA DE DEPLOY PARA DETECTOR DE ACTUALIZACION
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const socket_io_1 = require("socket.io");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const weeklyRanking_1 = require("./ranking/weeklyRanking");
const gameSocket_1 = require("./sockets/gameSocket");
const teamGameSocket_1 = require("./sockets/teamGameSocket");
const userService_1 = require("./auth/userService");
const astropayAuto_1 = require("./payments/astropayAuto");
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
const PASSWORD_RESET_PUBLIC_PATH = '/restablecer';
function getPublicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    if (configured)
        return configured;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'https';
    const host = String(req.get('host') || '').trim();
    return `${protocol}://${host}`;
}
/* =========================================================
   CARGA AUTOMÁTICA ASTROPAY - PRODUCCIÓN
   Se activa SOLO con ASTROPAY_AUTO_ENABLED=true.
   La acreditación reutiliza adjustUserChipsAndRecord();
   no modifica la lógica existente de fichas/depósitos/retiros.
   ========================================================= */
const ASTROPAY_AUTO_ENABLED = String(process.env.ASTROPAY_AUTO_ENABLED || '').trim().toLowerCase() === 'true';
const ASTROPAY_DEVICE_SECRET = String(process.env.ASTROPAY_DEVICE_SECRET || '').trim();
function secureSecretEquals(received, expected) {
    if (!received || !expected)
        return false;
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto_1.default.timingSafeEqual(a, b);
}
function requireAstroPayAutoEnabled(_req, res, next) {
    if (!ASTROPAY_AUTO_ENABLED) {
        return res.status(503).json({
            success: false,
            message: 'La carga automática está temporalmente desactivada.'
        });
    }
    if (!ASTROPAY_DEVICE_SECRET) {
        return res.status(503).json({
            success: false,
            message: 'La carga automática no está configurada.'
        });
    }
    if ((0, astropayAuto_1.getAstroPayAutoStorageMode)() !== 'DATABASE') {
        return res.status(503).json({
            success: false,
            message: 'La carga automática no tiene almacenamiento persistente disponible.'
        });
    }
    next();
}
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
app.use(express_1.default.json());
/* =========================================================
   VERSION PUBLICADA + HTML VERSIONADO

   Cada deploy de Render tiene su propio RENDER_GIT_COMMIT.
   El servidor inserta esa versión dentro del index.html para que
   el navegador sepa qué frontend está ejecutando realmente.

   NO modifica partidas, fichas ni lógica del juego.
   ========================================================= */
const APP_VERSION = String(process.env.RENDER_GIT_COMMIT ||
    `local-${Date.now()}`);
const INDEX_TEMPLATE_PATH = path_1.default.join(__dirname, '../public/index.html');
let indexTemplateCache = null;
function getIndexTemplate() {
    if (indexTemplateCache === null) {
        indexTemplateCache = fs_1.default.readFileSync(INDEX_TEMPLATE_PATH, 'utf8');
    }
    return indexTemplateCache;
}
function noStore(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}
app.get('/api/app-version', (_req, res) => {
    noStore(res);
    return res.json({
        success: true,
        version: APP_VERSION
    });
});
function sendVersionedIndex(_req, res) {
    noStore(res);
    const html = getIndexTemplate().replace('__TRUCO_PAGE_VERSION_JSON__', JSON.stringify(APP_VERSION));
    res.type('html').send(html);
}
// Estas rutas van ANTES de express.static para evitar servir un index viejo.
app.get('/', sendVersionedIndex);
app.get('/index.html', sendVersionedIndex);
app.get(PASSWORD_RESET_PUBLIC_PATH, (_req, res) => {
    noStore(res);
    return res.sendFile(path_1.default.join(__dirname, '../public/reset-password.html'));
});
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
app.get('/ranking', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/ranking.html'));
});
app.get('/api/ranking', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const username = verifySessionToken(getCookie(req, SESSION_COOKIE));
        res.json(await (0, weeklyRanking_1.getWeeklyRanking)(new Date(), username));
    }
    catch (error) {
        console.error('Error consultando ranking semanal:', error);
        res.status(503).json({
            message: 'No se pudo cargar el ranking semanal.'
        });
    }
});
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
    const { fullName, email, username, password, remember } = req.body;
    const result = await (0, userService_1.registerUser)(fullName, email, username, password);
    if (!result.success || !result.user) {
        return res.status(400).json(result);
    }
    // Todo usuario nuevo sale del registro con la misma sesión segura
    // que recibiría al iniciar sesión manualmente.
    setUserSession(res, result.user.username, !!remember);
    return res.status(201).json({
        ...result,
        user: safeUserForClient(result.user)
    });
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
app.post('/api/auth/logout', (_req, res) => {
    clearUserSession(res);
    return res.json({ success: true, message: 'Sesión cerrada.' });
});
const passwordResetLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Demasiados intentos. Probá nuevamente en 15 minutos.' },
});
app.get('/api/auth/password-reset/validate', passwordResetLimiter, async (req, res) => {
    const token = String(req.query.token || '');
    const result = await (0, userService_1.validatePasswordResetToken)(token);
    return res.status(result.success ? 200 : 400).json(result);
});
app.post('/api/auth/password-reset/complete', passwordResetLimiter, async (req, res) => {
    const { token, newPassword, confirmPassword } = req.body || {};
    if (!newPassword || !confirmPassword || newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Las dos contraseñas deben coincidir.' });
    }
    const result = await (0, userService_1.resetPasswordWithToken)(String(token || ''), String(newPassword));
    return res.status(result.success ? 200 : 400).json(result);
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
/* =========================================================
   CARGA AUTOMÁTICA ASTROPAY
   Rutas nuevas y separadas de /api/wallet/deposit-request.
   La lógica manual existente queda intacta.
   ========================================================= */
app.get('/api/wallet/auto-deposit-health', requireAstroPayAutoEnabled, (_req, res) => {
    return res.json({
        success: true,
        enabled: true,
        storage: (0, astropayAuto_1.getAstroPayAutoStorageMode)(),
        ttlMinutes: 10
    });
});
app.post('/api/wallet/auto-deposit-request', requireAstroPayAutoEnabled, async (req, res) => {
    try {
        // Compatibilidad con usuarios antiguos: esta ruta NO exige la cookie
        // truco_session. El username mostrado por la web se valida contra la DB
        // dentro de createAstroPayAutoRequest().
        const username = String(req.body?.clientUsername || '').trim().toLowerCase();
        const holderName = String(req.body?.holderName || '');
        const amount = Number(req.body?.amount);
        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Usuario inválido.'
            });
        }
        const result = await (0, astropayAuto_1.createAstroPayAutoRequest)({
            username,
            holderName,
            amount
        });
        return res.status(result.success ? 200 : 400).json(result);
    }
    catch (err) {
        console.error('Error creando solicitud AstroPay AUTO:', err);
        return res.status(503).json({
            success: false,
            message: 'No se pudo crear la solicitud de carga.'
        });
    }
});
// Ruta de compatibilidad para restaurar una solicitud conocida por este
// navegador. No permite buscar solicitudes pasando solamente un username.
app.get('/api/wallet/auto-deposit-active', requireAstroPayAutoEnabled, async (req, res) => {
    try {
        const requestId = String(req.query?.requestId || '').trim();
        const accessToken = String(req.headers['x-auto-deposit-token'] || '').trim();
        res.setHeader('Cache-Control', 'no-store');
        if (!requestId || !accessToken) {
            return res.json({ success: true, request: null });
        }
        const request = await (0, astropayAuto_1.getAstroPayAutoRequestByAccess)(requestId, accessToken);
        return res.json({
            success: true,
            request
        });
    }
    catch (err) {
        console.error('Error consultando solicitud AstroPay AUTO:', err);
        return res.status(503).json({
            success: false,
            message: 'No se pudo consultar la solicitud de carga.'
        });
    }
});
app.get('/api/wallet/auto-deposit-status/:id', requireAstroPayAutoEnabled, async (req, res) => {
    try {
        const accessToken = String(req.headers['x-auto-deposit-token'] || '').trim();
        res.setHeader('Cache-Control', 'no-store');
        if (!accessToken) {
            return res.status(404).json({
                success: false,
                message: 'Solicitud de carga no encontrada.'
            });
        }
        const request = await (0, astropayAuto_1.getAstroPayAutoRequestByAccess)(req.params.id, accessToken);
        if (!request) {
            return res.status(404).json({
                success: false,
                message: 'Solicitud de carga no encontrada.'
            });
        }
        return res.json({ success: true, request });
    }
    catch (err) {
        console.error('Error consultando estado AstroPay AUTO:', err);
        return res.status(503).json({
            success: false,
            message: 'No se pudo consultar el estado de la carga.'
        });
    }
});
app.post('/api/internal/astropay', requireAstroPayAutoEnabled, async (req, res) => {
    const secretReceived = String(req.headers['x-astropay-secret'] || '');
    if (!secureSecretEquals(secretReceived, ASTROPAY_DEVICE_SECRET)) {
        return res.status(401).json({
            success: false,
            message: 'No autorizado.'
        });
    }
    const packageName = String(req.body?.packageName || '').trim();
    const title = String(req.body?.title || '').trim();
    const text = String(req.body?.text || '').trim();
    if (packageName !== 'com.astropaycard.android') {
        return res.status(400).json({
            success: false,
            message: 'Paquete de notificación no válido.'
        });
    }
    if (title.toLowerCase() !== 'transferencia recibida') {
        return res.status(400).json({
            success: false,
            message: 'Título de notificación no válido.'
        });
    }
    const result = await (0, astropayAuto_1.processAstroPayAutoNotification)(text);
    console.log('====================================');
    console.log('💳 ASTROPAY AUTO');
    console.log('Package:', packageName);
    console.log('Título:', title);
    console.log('Texto:', text);
    console.log('Parse:', result.parsed?.success ? 'OK' : 'ERROR');
    console.log('Monto:', result.parsed?.amount ?? null);
    console.log('Titular:', result.parsed?.holderNameNormalized ?? null);
    console.log('Resultado:', result.status);
    console.log('Solicitud:', result.request?.id || '(sin coincidencia)');
    console.log('Usuario:', result.request?.username || '(sin coincidencia)');
    console.log('Origen:', result.request?.source || 'ASTROPAY_AUTO');
    console.log('====================================');
    return res.status(result.status === 'CREDIT_ERROR' ? 500 : 200).json(result);
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
app.post('/api/admin/password-reset-link', requireAdminAuth, async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const result = await (0, userService_1.createPasswordResetToken)(username);
    if (!result.success || !result.token || !result.expiresAt || !result.username) {
        return res.status(400).json(result);
    }
    const link = `${getPublicBaseUrl(req)}${PASSWORD_RESET_PUBLIC_PATH}?token=${encodeURIComponent(result.token)}`;
    return res.json({
        success: true,
        message: `Enlace de recuperación generado para @${result.username}.`,
        username: result.username,
        link,
        expiresAt: result.expiresAt,
        expiresInMinutes: 15
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
    if (ASTROPAY_AUTO_ENABLED) {
        await (0, astropayAuto_1.initAstroPayAutoStorage)();
    }
    else {
        console.log('💳 AstroPay AUTO: desactivado (ASTROPAY_AUTO_ENABLED != true).');
    }
    server.listen(PORT, () => {
        console.log(`🎮 Servidor de Truco corriendo en http://localhost:${PORT}`);
    });
}
startServer().catch(err => {
    console.error('❌ No se pudo iniciar el servidor:', err);
    process.exit(1);
});
