// src/auth/userService.ts
import { Pool } from 'pg';
import crypto from 'crypto';

export interface User {
  id: string;
  fullName: string;
  email: string;
  username: string;
  passwordHash?: string;
  salt?: string;
  password?: string;
  chips: number;
  avatar: string;
  createdAt: string;
}

export interface DepositRequest {
  id: string;
  username: string;
  amount: number;
  reference: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}

export interface Transaction {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAW' | 'COMMISSION_RAKE';
  username: string;
  amount: number;
  details?: string;
  createdAt: string;
}

export const ALLOWED_AVATARS = [
  'gaucho',
  'mate',
  'asado',
  'sol_mayo',
  'gardel',
  'diego',
  'messi',
  'tango'
];

const DATABASE_URL = process.env.DATABASE_URL || '';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

let usersCache: User[] = [];
let depositsCache: DepositRequest[] = [];
let transactionsCache: Transaction[] = [];

export async function initDatabase() {
  if (!DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL no configurada.');
    return;
  }

  try {
    const client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        salt VARCHAR(100) NOT NULL,
        chips BIGINT DEFAULT 0,
        avatar VARCHAR(50) DEFAULT 'gaucho',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migración automática por si la tabla ya existía sin la columna avatar
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar VARCHAR(50) DEFAULT 'gaucho';
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        type VARCHAR(30) NOT NULL,
        username VARCHAR(100) NOT NULL,
        amount BIGINT NOT NULL,
        details VARCHAR(255),
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
      avatar: r.avatar || 'gaucho',
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

    const tRes = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200');
    transactionsCache = tRes.rows.map(r => ({
      id: r.id,
      type: r.type,
      username: r.username,
      amount: Number(r.amount) || 0,
      details: r.details || '',
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
    }));

    client.release();
    console.log(`✅ Base de datos conectada. ${usersCache.length} usuarios y ${transactionsCache.length} transacciones sincronizadas.`);
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err);
  }
}

initDatabase();

function hashPbkdf2(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

export async function registerUser(fullName: string, email: string, username: string, password: string): Promise<{ success: boolean; message: string; user?: User }> {
  const cleanUser = (username || '').trim().toLowerCase();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanFullName = (fullName || '').trim();

  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(cleanUser)) {
    return { 
      success: false, 
      message: 'El nombre de usuario debe tener entre 3 y 20 caracteres y solo contener letras, números o guion bajo (_).' 
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return { success: false, message: 'Ingresá un correo electrónico válido.' };
  }

  if (!password || password.length < 6) {
    return { success: false, message: 'La contraseña debe tener al menos 6 caracteres.' };
  }

  if (usersCache.some(u => (u.username || '').toLowerCase() === cleanUser)) {
    return { success: false, message: 'El nombre de usuario ya está registrado.' };
  }
  if (usersCache.some(u => (u.email || '').toLowerCase() === cleanEmail)) {
    return { success: false, message: 'El correo electrónico ya está registrado.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPbkdf2(password, salt);

  const newUser: User = {
    id: 'usr_' + crypto.randomBytes(4).toString('hex'),
    fullName: cleanFullName,
    email: cleanEmail,
    username: cleanUser,
    passwordHash,
    salt,
    chips: 0,
    avatar: 'gaucho',
    createdAt: new Date().toISOString()
  };

  if (DATABASE_URL) {
    try {
      await pool.query(
        'INSERT INTO users (id, full_name, email, username, password_hash, salt, chips, avatar) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [newUser.id, newUser.fullName, newUser.email, newUser.username, newUser.passwordHash, newUser.salt, newUser.chips, newUser.avatar]
      );
      console.log(`💾 Usuario @${newUser.username} guardado exitosamente en Supabase.`);
    } catch (dbErr) {
      console.error('❌ Error guardando en Supabase:', dbErr);
      return { success: false, message: 'Error al conectar con la base de datos.' };
    }
  }

  usersCache.push(newUser);
  return { success: true, message: 'Registro exitoso.', user: newUser };
}

export async function loginUser(usernameOrEmail: string, password: string): Promise<{ success: boolean; message: string; user?: User }> {
  const target = (usernameOrEmail || '').trim().toLowerCase();

  let user = usersCache.find(u =>
    (u.username && u.username.toLowerCase() === target) ||
    (u.email && u.email.toLowerCase() === target)
  );

  if (!user && DATABASE_URL) {
    try {
      const res = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1', [target]);
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
          avatar: r.avatar || 'gaucho',
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
        };
        usersCache.push(user);
      }
    } catch (err) {
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
  } else {
    return { success: false, message: 'Contraseña incorrecta.' };
  }

  return { success: true, message: 'Inicio de sesión exitoso.', user };
}

export function resetUserPassword(username: string, newPass: string): boolean {
  const clean = username.trim().toLowerCase();
  const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
  if (!user) return false;

  user.salt = crypto.randomBytes(16).toString('hex');
  user.passwordHash = hashPbkdf2(newPass, user.salt);

  if (DATABASE_URL) {
    pool.query(
      'UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3',
      [user.passwordHash, user.salt, user.id]
    ).catch(err => console.error('Error actualizando password en BD:', err));
  }

  return true;
}

export function getUserChips(username: string): number {
  const clean = (username || '').trim().toLowerCase();
  const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
  return user ? (user.chips || 0) : 0;
}

export function modifyUserChips(username: string, amount: number): boolean {
  const clean = (username || '').trim().toLowerCase();
  const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
  if (!user) return false;

  const current = user.chips || 0;
  if (current + amount < 0) return false;

  user.chips = current + amount;

  if (DATABASE_URL) {
    pool.query(
      'UPDATE users SET chips = $1 WHERE id = $2',
      [user.chips, user.id]
    ).catch(err => console.error('Error actualizando fichas en BD:', err));
  }

  return true;
}

export function getUserAvatar(username: string): string {
  const clean = (username || '').trim().toLowerCase();
  const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
  return user?.avatar || 'gaucho';
}

export function updateUserAvatar(username: string, avatarId: string): boolean {
  const clean = (username || '').trim().toLowerCase();
  if (!ALLOWED_AVATARS.includes(avatarId)) return false;

  const user = usersCache.find(u => (u.username || '').toLowerCase() === clean);
  if (!user) return false;

  user.avatar = avatarId;

  if (DATABASE_URL) {
    pool.query(
      'UPDATE users SET avatar = $1 WHERE id = $2',
      [avatarId, user.id]
    ).catch(err => console.error('Error actualizando avatar en BD:', err));
  }

  return true;
}

export function getAllUsersList() {
  return usersCache.map(u => ({
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    chips: u.chips || 0,
    avatar: u.avatar || 'gaucho'
  }));
}

export function requestDeposit(username: string, amount: number, reference: string): { success: boolean; message: string } {
  const newDep: DepositRequest = {
    id: 'dep_' + crypto.randomBytes(4).toString('hex'),
    username: (username || '').trim().toLowerCase(),
    amount,
    reference: reference || 'WhatsApp',
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };

  depositsCache.push(newDep);

  if (DATABASE_URL) {
    pool.query(
      'INSERT INTO deposits (id, username, amount, reference, status) VALUES ($1, $2, $3, $4, $5)',
      [newDep.id, newDep.username, newDep.amount, newDep.reference, newDep.status]
    ).catch(err => console.error('Error guardando depósito en BD:', err));
  }

  return { success: true, message: 'Solicitud enviada correctamente.' };
}

export function getPendingDeposits(): DepositRequest[] {
  return depositsCache.filter(d => d.status === 'PENDING');
}

export function recordTransaction(type: 'DEPOSIT' | 'WITHDRAW' | 'COMMISSION_RAKE', username: string, amount: number, details: string = ''): Transaction {
  const tx: Transaction = {
    id: 'tx_' + crypto.randomBytes(4).toString('hex'),
    type,
    username: (username || '').trim().toLowerCase(),
    amount: Number(amount) || 0,
    details,
    createdAt: new Date().toISOString()
  };

  transactionsCache.unshift(tx);

  if (DATABASE_URL) {
    pool.query(
      'INSERT INTO transactions (id, type, username, amount, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [tx.id, tx.type, tx.username, tx.amount, tx.details, tx.createdAt]
    ).catch(err => console.error('Error guardando transacción en BD:', err));
  }

  return tx;
}

export function approveDeposit(depositId: string): { success: boolean; message: string } {
  const dep = depositsCache.find(d => d.id === depositId);
  if (!dep || dep.status !== 'PENDING') {
    return { success: false, message: 'Solicitud no válida o ya procesada.' };
  }

  dep.status = 'APPROVED';
  modifyUserChips(dep.username, dep.amount);
  recordTransaction('DEPOSIT', dep.username, dep.amount, `Depósito aprobado (${dep.reference})`);

  if (DATABASE_URL) {
    pool.query(
      'UPDATE deposits SET status = $1 WHERE id = $2',
      ['APPROVED', dep.id]
    ).catch(err => console.error('Error aprobando depósito en BD:', err));
  }

  return { success: true, message: `Acreditados $${dep.amount} a ${dep.username}.` };
}

export function rejectDeposit(depositId: string): { success: boolean; message: string } {
  const dep = depositsCache.find(d => d.id === depositId);
  if (!dep || dep.status !== 'PENDING') {
    return { success: false, message: 'Solicitud no válida o ya procesada.' };
  }

  dep.status = 'REJECTED';

  if (DATABASE_URL) {
    pool.query(
      'UPDATE deposits SET status = $1 WHERE id = $2',
      ['REJECTED', dep.id]
    ).catch(err => console.error('Error rechazando depósito en BD:', err));
  }

  return { success: true, message: `Depósito de @${dep.username} rechazado.` };
}

export function getAllTransactions(limit: number = 60): Transaction[] {
  return transactionsCache.slice(0, limit);
}

export function getAdminMetrics() {
  const totalUsers = usersCache.length;
  const totalChipsInCirculation = usersCache.reduce((sum, u) => sum + (u.chips || 0), 0);
  
  const pendingDeposits = depositsCache.filter(d => d.status === 'PENDING');
  const pendingDepositsCount = pendingDeposits.length;
  const pendingDepositsAmount = pendingDeposits.reduce((sum, d) => sum + (d.amount || 0), 0);

  const totalRakeEarned = transactionsCache
    .filter(t => t.type === 'COMMISSION_RAKE')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  const totalDepositsApproved = transactionsCache
    .filter(t => t.type === 'DEPOSIT')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  const totalWithdrawals = transactionsCache
    .filter(t => t.type === 'WITHDRAW')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  return {
    totalUsers,
    totalChipsInCirculation,
    pendingDepositsCount,
    pendingDepositsAmount,
    totalRakeEarned,
    totalDepositsApproved,
    totalWithdrawals
  };
}

export async function deleteUser(username: string): Promise<boolean> {
  const clean = (username || '').trim().toLowerCase();
  const index = usersCache.findIndex(u => (u.username || '').toLowerCase() === clean);
  if (index === -1) return false;

  const userToDelete = usersCache[index];
  usersCache.splice(index, 1);

  if (DATABASE_URL) {
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [userToDelete.id]);
      console.log(`🗑️ Usuario @${clean} eliminado de Supabase.`);
    } catch (err) {
      console.error('Error eliminando usuario de BD:', err);
    }
  }

  return true;
}