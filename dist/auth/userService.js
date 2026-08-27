"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.initDatabase = initDatabase;
exports.registerUser = registerUser;
exports.loginUser = loginUser;
exports.resetUserPassword = resetUserPassword;
exports.getUserChips = getUserChips;
exports.modifyUserChips = modifyUserChips;
exports.getAllUsersList = getAllUsersList;
exports.requestDeposit = requestDeposit;
exports.getPendingDeposits = getPendingDeposits;
exports.approveDeposit = approveDeposit;
exports.deleteUser = deleteUser;
// src/auth/userService.ts
const pg_1 = require("pg");
const crypto_1 = __importDefault(require("crypto"));
const DATABASE_URL = process.env.DATABASE_URL || '';
exports.pool = new pg_1.Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});
let usersCache = [];
let depositsCache = [];
async function initDatabase() {
    if (!DATABASE_URL) {
        console.warn('⚠️ DATABASE_URL no configurada.');
        return;
    }
    try {
        const client = await exports.pool.connect();
        await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        salt VARCHAR(100) NOT NULL,
        chips BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        await client.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        amount BIGINT NOT NULL,
        reference VARCHAR(255),
        status VARCHAR(20) DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        const uRes = await client.query('SELECT * FROM users');
        usersCache = uRes.rows.map(r => ({
            id: r.id,
            fullName: r.full_name,
            email: r.email,
            username: r.username,
            passwordHash: r.password_hash,
            salt: r.salt,
            chips: Number(r.chips) || 0,
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        }));
        const dRes = await client.query('SELECT * FROM deposits');
        depositsCache = dRes.rows.map(r => ({
            id: r.id,
            username: r.username,
            amount: Number(r.amount) || 0,
            reference: r.reference || '',
            status: r.status,
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        }));
        client.release();
        console.log(`✅ Base de datos conectada. ${usersCache.length} usuarios sincronizados.`);
    }
    catch (err) {
        console.error('❌ Error conectando a PostgreSQL:', err);
    }
}
initDatabase();
function hashPbkdf2(password, salt) {
    return crypto_1.default.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}
async function registerUser(fullName, email, username, password) {
    const cleanUser = (username || '').trim().toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanFullName = (fullName || '').trim();
    // Validación de seguridad contra XSS y nombres inválidos
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!usernameRegex.test(cleanUser)) {
        return {
            success: false,
            message: 'El nombre de usuario debe tener entre 3 y 20 caracteres y solo contener letras, números o guion bajo (_).'
        };
    }
    // Validación de formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
        return { success: false, message: 'Ingresá un correo electrónico válido.' };
    }
    // Validación de contraseña
    if (!password || password.length < 6) {
        return { success: false, message: 'La contraseña debe tener al menos 6 caracteres.' };
    }
    if (usersCache.some(u => (u.username || '').toLowerCase() === cleanUser)) {
        return { success: false, message: 'El nombre de usuario ya está registrado.' };
    }
    if (usersCache.some(u => (u.email || '').toLowerCase() === cleanEmail)) {
        return { success: false, message: 'El correo electrónico ya está registrado.' };
    }
    const salt = crypto_1.default.randomBytes(16).toString('hex');
    const passwordHash = hashPbkdf2(password, salt);
    const newUser = {
        id: 'usr_' + crypto_1.default.randomBytes(4).toString('hex'),
        fullName: cleanFullName,
        email: cleanEmail,
        username: cleanUser,
        passwordHash,
        salt,
        chips: 0,
        createdAt: new Date().toISOString()
    };
    if (DATABASE_URL) {
        try {
            await exports.pool.query('INSERT INTO users (id, full_name, email, username, password_hash, salt, chips) VALUES ($1, $2, $3, $4, $5, $6, $7)', [newUser.id, newUser.fullName, newUser.email, newUser.username, newUser.passwordHash, newUser.salt, newUser.chips]);
            console.log(`💾 Usuario @${newUser.username} guardado exitosamente en Supabase.`);
        }
        catch (dbErr) {
            console.error('❌ Error guardando en Supabase:', dbErr);
            return { success: false, message: 'Error al conectar con la base de datos.' };
        }
    }
    usersCache.push(newUser);
    return { success: true, message: 'Registro exitoso.', user: newUser };
}
async function loginUser(usernameOrEmail, password) {
    const target = (usernameOrEmail || '').trim().toLowerCase();
    let user = usersCache.find(u => (u.username && u.username.toLowerCase() === target) ||
        (u.email && u.email.toLowerCase() === target));
    if (!user && DATABASE_URL) {
        try {
            const res = await exports.pool.query('SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1', [target]);
            if (res.rows.length > 0) {
                const r = res.rows[0];
                user = {
                    id: r.id,
                    fullName: r.full_name,
                    email: r.email,
                    username: r.username,
                    passwordHash: r.password_hash,
                    salt: r.salt,
                    chips: Number(r.chips) || 0,
                    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
                };
                usersCache.push(user);
            }
        }
        catch (err) {
            console.error('Error buscando usuario en BD:', err);
        }
    }
    if (!user) {
        return { success: false, message: 'Usuario o correo no encontrado.' };
    }
    if (user.passwordHash && user.salt) {
        if (hashPbkdf2(password, user.salt) !== user.passwordHash) {
            return { success: false, message: 'Contraseña incorrecta.' };
        }
    }
    else {
        return { success: false, message: 'Contraseña incorrecta.' };
    }
    return { success: true, message: 'Inicio de sesión exitoso.', user };
}
function resetUserPassword(username, newPass) {
    const clean = username.trim().toLowerCase();
    const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
    if (!user)
        return false;
    user.salt = crypto_1.default.randomBytes(16).toString('hex');
    user.passwordHash = hashPbkdf2(newPass, user.salt);
    if (DATABASE_URL) {
        exports.pool.query('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3', [user.passwordHash, user.salt, user.id]).catch(err => console.error('Error actualizando password en BD:', err));
    }
    return true;
}
function getUserChips(username) {
    const clean = (username || '').trim().toLowerCase();
    const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
    return user ? (user.chips || 0) : 0;
}
function modifyUserChips(username, amount) {
    const clean = (username || '').trim().toLowerCase();
    const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
    if (!user)
        return false;
    const current = user.chips || 0;
    if (current + amount < 0)
        return false;
    user.chips = current + amount;
    if (DATABASE_URL) {
        exports.pool.query('UPDATE users SET chips = $1 WHERE id = $2', [user.chips, user.id]).catch(err => console.error('Error actualizando fichas en BD:', err));
    }
    return true;
}
function getAllUsersList() {
    return usersCache.map(u => ({
        username: u.username,
        fullName: u.fullName,
        email: u.email,
        chips: u.chips || 0
    }));
}
function requestDeposit(username, amount, reference) {
    const newDep = {
        id: 'dep_' + crypto_1.default.randomBytes(4).toString('hex'),
        username: (username || '').trim().toLowerCase(),
        amount,
        reference: reference || 'WhatsApp',
        status: 'PENDING',
        createdAt: new Date().toISOString()
    };
    depositsCache.push(newDep);
    if (DATABASE_URL) {
        exports.pool.query('INSERT INTO deposits (id, username, amount, reference, status) VALUES ($1, $2, $3, $4, $5)', [newDep.id, newDep.username, newDep.amount, newDep.reference, newDep.status]).catch(err => console.error('Error guardando depósito en BD:', err));
    }
    return { success: true, message: 'Solicitud enviada correctamente.' };
}
function getPendingDeposits() {
    return depositsCache.filter(d => d.status === 'PENDING');
}
function approveDeposit(depositId) {
    const dep = depositsCache.find(d => d.id === depositId);
    if (!dep || dep.status !== 'PENDING') {
        return { success: false, message: 'Solicitud no válida o ya procesada.' };
    }
    dep.status = 'APPROVED';
    modifyUserChips(dep.username, dep.amount);
    if (DATABASE_URL) {
        exports.pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['APPROVED', dep.id]).catch(err => console.error('Error aprobando depósito en BD:', err));
    }
    return { success: true, message: `Acreditados $${dep.amount} a ${dep.username}.` };
}
async function deleteUser(username) {
    const clean = (username || '').trim().toLowerCase();
    const index = usersCache.findIndex(u => (u.username || '').toLowerCase() === clean);
    if (index === -1)
        return false;
    const userToDelete = usersCache[index];
    usersCache.splice(index, 1);
    if (DATABASE_URL) {
        try {
            await exports.pool.query('DELETE FROM users WHERE id = $1', [userToDelete.id]);
            console.log(`🗑️ Usuario @${clean} eliminado de Supabase.`);
        }
        catch (err) {
            console.error('Error eliminando usuario de BD:', err);
        }
    }
    return true;
}
