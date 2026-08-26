// src/auth/userService.ts
import fs from 'fs';
import path from 'path';
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

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.json');

function ensureFilesExist() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
  if (!fs.existsSync(DEPOSITS_FILE)) {
    fs.writeFileSync(DEPOSITS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

export function readUsers(): User[] {
  ensureFilesExist();
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function writeUsers(users: User[]) {
  ensureFilesExist();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

export function readDeposits(): DepositRequest[] {
  ensureFilesExist();
  try {
    const raw = fs.readFileSync(DEPOSITS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function writeDeposits(deposits: DepositRequest[]) {
  ensureFilesExist();
  fs.writeFileSync(DEPOSITS_FILE, JSON.stringify(deposits, null, 2), 'utf-8');
}

function hashPbkdf2(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function hashSha256(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function registerUser(fullName: string, email: string, username: string, password: string): { success: boolean; message: string; user?: User } {
  const users = readUsers();
  const cleanUser = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();

  if (users.some(u => (u.username || '').toLowerCase() === cleanUser)) {
    return { success: false, message: 'El nombre de usuario ya está registrado.' };
  }
  if (users.some(u => (u.email || '').toLowerCase() === cleanEmail)) {
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

  users.push(newUser);
  writeUsers(users);

  return { success: true, message: 'Registro exitoso.', user: newUser };
}

export function loginUser(usernameOrEmail: string, password: string): { success: boolean; message: string; user?: User } {
  const users = readUsers();
  const target = (usernameOrEmail || '').trim().toLowerCase();

  const userIndex = users.findIndex(u =>
    (u.username && u.username.toLowerCase() === target) ||
    (u.email && u.email.toLowerCase() === target)
  );

  if (userIndex === -1) {
    return { success: false, message: 'Usuario o correo no encontrado.' };
  }

  const user = users[userIndex];
  let isValid = false;

  // Validación 1: Hash PBKDF2 + Salt (Nuevo formato)
  if (user.passwordHash && user.salt) {
    if (hashPbkdf2(password, user.salt) === user.passwordHash) {
      isValid = true;
    }
  }

  // Validación 2: Texto plano en campo password (Cuentas viejas)
  if (!isValid && user.password && user.password === password) {
    isValid = true;
  }

  // Validación 3: Texto plano guardado directamente en passwordHash
  if (!isValid && user.passwordHash && user.passwordHash === password) {
    isValid = true;
  }

  // Validación 4: Hash SHA-256 (Versiones intermedias)
  if (!isValid && user.passwordHash && hashSha256(password) === user.passwordHash) {
    isValid = true;
  }

  if (!isValid) {
    return { success: false, message: 'Contraseña incorrecta.' };
  }

  // Si entró por compatibilidad vieja, migramos su cuenta al formato seguro automáticamente
  if (!user.salt || user.password) {
    user.salt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = hashPbkdf2(password, user.salt);
    delete user.password;
    writeUsers(users);
  }

  return { success: true, message: 'Inicio de sesión exitoso.', user };
}

export function resetUserPassword(username: string, newPass: string): boolean {
  const users = readUsers();
  const clean = username.trim().toLowerCase();
  const user = users.find(u => (u.username || '').toLowerCase() === clean);
  if (!user) return false;

  user.salt = crypto.randomBytes(16).toString('hex');
  user.passwordHash = hashPbkdf2(newPass, user.salt);
  delete user.password;
  writeUsers(users);
  return true;
}

export function getUserChips(username: string): number {
  const users = readUsers();
  const clean = (username || '').trim().toLowerCase();
  const user = users.find(u => (u.username || '').toLowerCase() === clean);
  return user ? (user.chips || 0) : 0;
}

export function modifyUserChips(username: string, amount: number): boolean {
  const users = readUsers();
  const clean = (username || '').trim().toLowerCase();
  const user = users.find(u => (u.username || '').toLowerCase() === clean);
  if (!user) return false;

  const current = user.chips || 0;
  if (current + amount < 0) return false;

  user.chips = current + amount;
  writeUsers(users);
  return true;
}

export function getAllUsersList() {
  const users = readUsers();
  return users.map(u => ({
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    chips: u.chips || 0
  }));
}

export function requestDeposit(username: string, amount: number, reference: string): { success: boolean; message: string } {
  const deposits = readDeposits();
  const newDep: DepositRequest = {
    id: 'dep_' + crypto.randomBytes(4).toString('hex'),
    username: (username || '').trim().toLowerCase(),
    amount,
    reference: reference || 'WhatsApp',
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };
  deposits.push(newDep);
  writeDeposits(deposits);
  return { success: true, message: 'Solicitud enviada correctamente.' };
}

export function getPendingDeposits(): DepositRequest[] {
  const deposits = readDeposits();
  return deposits.filter(d => d.status === 'PENDING');
}

export function approveDeposit(depositId: string): { success: boolean; message: string } {
  const deposits = readDeposits();
  const dep = deposits.find(d => d.id === depositId);
  if (!dep || dep.status !== 'PENDING') {
    return { success: false, message: 'Solicitud no válida o ya procesada.' };
  }
  dep.status = 'APPROVED';
  writeDeposits(deposits);
  modifyUserChips(dep.username, dep.amount);
  return { success: true, message: `Acreditados $${dep.amount} a ${dep.username}.` };
}