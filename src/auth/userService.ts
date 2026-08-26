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

const DATABASE_URL = process.env.DATABASE_URL || '';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

let usersCache: User[] = [];
let depositsCache: DepositRequest[] = [];

export async function initDatabase() {
  if (!DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL no configurada.');
    return;
  }

  try {
    const client = await pool.connect();
    
    // Cargar usuarios a memoria
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

    // Cargar depósitos a memoria
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
    console.log(`✅ Base de datos conectada. ${usersCache.length} usuarios cargados.`);
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err);
  }
}

initDatabase();

function hashPbkdf2(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

export function registerUser(fullName: string, email: string, username: string, password: string): { success: boolean; message: string; user?: User } {
  const cleanUser = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();

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
    fullName: fullName.trim(),
    email: cleanEmail,
    username: cleanUser,
    passwordHash,
    salt,
    chips: 0,
    createdAt: new Date().toISOString()
  };

  usersCache.push(newUser);

  if (DATABASE_URL) {
    pool.query(
      'INSERT INTO users (id, full_name, email, username, password_hash, salt, chips) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [newUser.id, newUser.fullName, newUser.email, newUser.username, newUser.passwordHash, newUser.salt, newUser.chips]
    )
    .then(() => console.log(`💾 Usuario @${newUser.username} guardado en PostgreSQL.`))
    .catch(err => console.error('Error insertando usuario en BD:', err));
  }

  return { success: true, message: 'Registro exitoso.', user: newUser };
}

export function loginUser(usernameOrEmail: string, password: string): { success: boolean; message: string; user?: User } {
  const target = (usernameOrEmail || '').trim().toLowerCase();

  const user = usersCache.find(u =>
    (u.username && u.username.toLowerCase() === target) ||
    (u.email && u.email.toLowerCase() === target)
  );

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

export function getAllUsersList() {
  return usersCache.map(u => ({
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    chips: u.chips || 0
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

export function approveDeposit(depositId: string): { success: boolean; message: string } {
  const dep = depositsCache.find(d => d.id === depositId);
  if (!dep || dep.status !== 'PENDING') {
    return { success: false, message: 'Solicitud no válida o ya procesada.' };
  }

  dep.status = 'APPROVED';
  modifyUserChips(dep.username, dep.amount);

  if (DATABASE_URL) {
    pool.query(
      'UPDATE deposits SET status = $1 WHERE id = $2',
      ['APPROVED', dep.id]
    ).catch(err => console.error('Error aprobando depósito en BD:', err));
  }

  return { success: true, message: `Acreditados $${dep.amount} a ${dep.username}.` };
}