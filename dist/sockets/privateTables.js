"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTablePassword = readTablePassword;
exports.privateTableIdentity = privateTableIdentity;
exports.createTableAccess = createTableAccess;
exports.tableEntryError = tableEntryError;
const crypto_1 = __importDefault(require("crypto"));
const failures = new Map();
const SESSION_MESSAGE = 'Volvé a iniciar sesión con tu cuenta para acceder a esta mesa privada.';
function readTablePassword(value) {
    if (value === undefined || value === '')
        return '';
    if (typeof value !== 'string')
        throw Error('La contraseña de la mesa debe ser un texto.');
    const password = value.trim();
    if (!password)
        return '';
    if (password.length < 6 || password.length > 32 || /[\u0000-\u001f\u007f]/.test(password)) {
        throw Error('La contraseña de la mesa debe tener entre 6 y 32 caracteres.');
    }
    return password;
}
function privateTableIdentity(access, socket, user) {
    return !access || (!!socket.data.tournamentUser &&
        String(socket.data.tournamentUser).toLowerCase() === String(user || '').trim().toLowerCase());
}
function createTableAccess(value, socket, user) {
    const password = readTablePassword(value);
    if (!password)
        return undefined;
    if (!privateTableIdentity({ salt: '', digest: '' }, socket, user))
        throw Error(SESSION_MESSAGE);
    const salt = crypto_1.default.randomBytes(16).toString('hex');
    return { salt, digest: crypto_1.default.scryptSync(password, salt, 32).toString('hex') };
}
function tableEntryError(access, socket, user, roomId, value) {
    if (!access)
        return null;
    if (!privateTableIdentity(access, socket, user))
        return SESSION_MESSAGE;
    const now = Date.now(), key = String(socket.data.tournamentUser).toLowerCase() + ':' + roomId;
    const previous = failures.get(key);
    if (previous && previous.until > now && previous.count >= 5)
        return 'Demasiados intentos. Esperá un minuto para volver a intentar.';
    let password = '';
    try {
        password = readTablePassword(value);
    }
    catch { /* Una entrada inválida también cuenta como intento. */ }
    if (password && crypto_1.default.timingSafeEqual(crypto_1.default.scryptSync(password, access.salt, 32), Buffer.from(access.digest, 'hex'))) {
        failures.delete(key);
        return null;
    }
    if (failures.size >= 5000) {
        for (const [id, attempt] of failures)
            if (attempt.until <= now)
                failures.delete(id);
        if (failures.size >= 5000)
            failures.delete(failures.keys().next().value);
    }
    failures.set(key, { count: previous && previous.until > now ? previous.count + 1 : 1, until: previous && previous.until > now ? previous.until : now + 60000 });
    return 'Contraseña de la mesa incorrecta.';
}
