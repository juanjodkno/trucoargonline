"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const socket_io_1 = require("socket.io");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const gameSocket_1 = require("./sockets/gameSocket");
const userService_1 = require("./auth/userService");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Habilitar trust proxy para reconocer la IP real del cliente detrás del proxy de Render
app.set('trust proxy', 1);
// Inicializar conexión
(0, userService_1.initDatabase)();
const ADMIN_PIN = process.env.ADMIN_PIN || '36049655Dk,';
const io = new socket_io_1.Server(server, {
    cors: { origin: '*' },
    pingTimeout: 30000,
    pingInterval: 10000,
    transports: ['websocket', 'polling']
});
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
// Limitador de tasa contra ataques de fuerza bruta en Login y Registro
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // Ventana de 15 minutos
    max: 15, // Máximo 15 intentos por IP
    message: { success: false, message: 'Demasiadas solicitudes. Por favor reintentá en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});
// Limitador estricto para el acceso de Administrador
const adminAuthLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 5, // Máximo 5 intentos para adivinar el PIN
    message: { success: false, message: 'Demasiados intentos de acceso admin. Bloqueado temporalmente.' },
    standardHeaders: true,
    legacyHeaders: false,
});
const requireAdminAuth = (req, res, next) => {
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
    const result = await (0, userService_1.registerUser)(fullName, email, username, password);
    return res.status(result.success ? 201 : 400).json(result);
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { usernameOrEmail, password } = req.body;
    const result = await (0, userService_1.loginUser)(usernameOrEmail, password);
    return res.status(result.success ? 200 : 401).json(result);
});
app.get('/api/wallet/balance/:username', (req, res) => {
    const chips = (0, userService_1.getUserChips)(req.params.username);
    return res.json({ chips });
});
app.post('/api/wallet/deposit-request', (req, res) => {
    const { username, amount, reference } = req.body;
    const result = (0, userService_1.requestDeposit)(username, Number(amount), reference);
    return res.status(result.success ? 200 : 400).json(result);
});
app.post('/api/wallet/withdraw-request', (req, res) => {
    const { username, amount } = req.body;
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Monto de retiro inválido.' });
    }
    const success = (0, userService_1.modifyUserChips)(username, -numAmount);
    if (!success) {
        return res.status(400).json({ success: false, message: 'Saldo insuficiente para realizar el retiro.' });
    }
    const currentChips = (0, userService_1.getUserChips)(username);
    return res.json({
        success: true,
        message: 'Retiro procesado y descontado correctamente.',
        chips: currentChips
    });
});
app.get('/api/admin/users-list', requireAdminAuth, (req, res) => {
    const users = (0, userService_1.getAllUsersList)();
    return res.json(users);
});
app.post('/api/admin/add-chips', requireAdminAuth, (req, res) => {
    const { username, amount } = req.body;
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Monto inválido.' });
    }
    const success = (0, userService_1.modifyUserChips)(username, numAmount);
    if (!success) {
        return res.status(400).json({ success: false, message: 'Usuario no encontrado.' });
    }
    const currentChips = (0, userService_1.getUserChips)(username);
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
    const success = (0, userService_1.modifyUserChips)(username, -numAmount);
    if (!success) {
        return res.status(400).json({ success: false, message: 'Usuario no encontrado o saldo insuficiente para descontar.' });
    }
    const currentChips = (0, userService_1.getUserChips)(username);
    return res.json({
        success: true,
        message: `¡Se descontaron $${new Intl.NumberFormat('es-AR').format(numAmount)} fichas a @${username}!`,
        chips: currentChips
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
app.get('/api/admin/pending-deposits', requireAdminAuth, (req, res) => {
    return res.json((0, userService_1.getPendingDeposits)());
});
app.post('/api/admin/approve-deposit', requireAdminAuth, (req, res) => {
    const { depositId } = req.body;
    const result = (0, userService_1.approveDeposit)(depositId);
    return res.status(result.success ? 200 : 400).json(result);
});
(0, gameSocket_1.setupSocketEvents)(io);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Servidor de Truco corriendo en http://localhost:${PORT}`);
});
