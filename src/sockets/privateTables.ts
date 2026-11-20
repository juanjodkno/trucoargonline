import crypto from 'crypto';
import type { Socket } from 'socket.io';

// Solo acceso a mesas privadas; no contiene reglas ni movimientos de fichas.
export interface PrivateTableAccess { salt: string; digest: string; }
const failures = new Map<string, { count: number; until: number }>();
const SESSION_MESSAGE = 'Volvé a iniciar sesión con tu cuenta para acceder a esta mesa privada.';

export function readTablePassword(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw Error('La contraseña de la mesa debe ser un texto.');
  const password = value.trim();
  if (!password) return '';
  if (password.length < 6 || password.length > 32 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw Error('La contraseña de la mesa debe tener entre 6 y 32 caracteres.');
  }
  return password;
}

export function privateTableIdentity(access: PrivateTableAccess | undefined, socket: Socket, user: string): boolean {
  return !access || (!!socket.data.tournamentUser &&
    String(socket.data.tournamentUser).toLowerCase() === String(user || '').trim().toLowerCase());
}

export function createTableAccess(value: unknown, socket: Socket, user: string): PrivateTableAccess | undefined {
  const password = readTablePassword(value);
  if (!password) return undefined;
  if (!privateTableIdentity({ salt: '', digest: '' }, socket, user)) throw Error(SESSION_MESSAGE);
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, digest: crypto.scryptSync(password, salt, 32).toString('hex') };
}

export function tableEntryError(access: PrivateTableAccess | undefined, socket: Socket, user: string, roomId: string, value: unknown): string | null {
  if (!access) return null;
  if (!privateTableIdentity(access, socket, user)) return SESSION_MESSAGE;
  const now = Date.now(), key = String(socket.data.tournamentUser).toLowerCase() + ':' + roomId;
  const previous = failures.get(key);
  if (previous && previous.until > now && previous.count >= 5) return 'Demasiados intentos. Esperá un minuto para volver a intentar.';
  let password = '';
  try { password = readTablePassword(value); } catch { /* Una entrada inválida también cuenta como intento. */ }
  if (password && crypto.timingSafeEqual(crypto.scryptSync(password, access.salt, 32), Buffer.from(access.digest, 'hex'))) {
    failures.delete(key); return null;
  }
  if (failures.size >= 5000) {
    for (const [id, attempt] of failures) if (attempt.until <= now) failures.delete(id);
    if (failures.size >= 5000) failures.delete(failures.keys().next().value!);
  }
  failures.set(key, { count: previous && previous.until > now ? previous.count + 1 : 1, until: previous && previous.until > now ? previous.until : now + 60000 });
  return 'Contraseña de la mesa incorrecta.';
}
