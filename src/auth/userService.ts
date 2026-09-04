// src/auth/userService.ts
import { Pool, PoolClient } from 'pg';
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
  type: 'DEPOSIT' | 'WITHDRAW' | 'COMMISSION_RAKE' | 'MATCH_SETTLEMENT';
  username: string;
  amount: number;
  details?: string;
  createdAt: string;
  roomId?: string;
  winnerUsername?: string;
  loserUsername?: string;
  winnerBalanceAfter?: number;
  loserBalanceAfter?: number;
  rakePercentage?: number;
  winnerPrize?: number;
  grossPot?: number;
  finishReason?: string;
}

export interface MatchSettlement {
  roomId: string;
  winnerUsername: string;
  loserUsername: string;
  betPerPlayer: number;
  grossPot: number;
  winnerPrize: number;
  rakePercentage: number;
  rakeAmount: number;
  winnerBalanceAfter: number;
  loserBalanceAfter: number;
  finishReason: string;
  createdAt: string;
}

export interface WalletOperationResult {
  success: boolean;
  alreadyProcessed?: boolean;
  balance?: number;
  message?: string;
}

export interface MatchSettlementResult {
  success: boolean;
  alreadySettled?: boolean;
  settlement?: MatchSettlement;
  message?: string;
}

export const RAKE_PERCENTAGE = 7;
export const RAKE_RATE = RAKE_PERCENTAGE / 100;

export function calculateMatchPayout(betPerPlayer: number) {
  const bet = Math.max(0, Math.round(Number(betPerPlayer) || 0));
  const grossPot = bet * 2;
  // Las fichas son enteras (BIGINT). Redondeamos el rake al entero más cercano
  // y el premio es el resto exacto para conservar el pozo sin crear/perder fichas.
  const rakeAmount = Math.round(grossPot * RAKE_RATE);
  const winnerPrize = grossPot - rakeAmount;
  return { betPerPlayer: bet, grossPot, rakeAmount, winnerPrize };
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
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

let usersCache: User[] = [];
let depositsCache: DepositRequest[] = [];
let transactionsCache: Transaction[] = [];
let settlementsCache: MatchSettlement[] = [];

// Fallback idempotente para localhost cuando no hay PostgreSQL configurado.
const localWalletOperations = new Map<string, WalletOperationResult>();
const localSettlements = new Map<string, MatchSettlement>();

function cleanUsername(username: string): string {
  return (username || '').trim().toLowerCase();
}

function integerAmount(amount: number): number {
  return Math.round(Number(amount) || 0);
}

function syncUserCacheBalance(username: string, balance: number) {
  const clean = cleanUsername(username);
  const user = usersCache.find(u => cleanUsername(u.username) === clean);
  if (user) user.chips = Number(balance) || 0;
}

function settlementFromRow(r: any): MatchSettlement {
  return {
    roomId: r.room_id,
    winnerUsername: r.winner_username,
    loserUsername: r.loser_username,
    betPerPlayer: Number(r.bet_per_player) || 0,
    grossPot: Number(r.gross_pot) || 0,
    winnerPrize: Number(r.winner_prize) || 0,
    rakePercentage: Number(r.rake_percentage) || RAKE_PERCENTAGE,
    rakeAmount: Number(r.rake_amount) || 0,
    winnerBalanceAfter: Number(r.winner_balance_after) || 0,
    loserBalanceAfter: Number(r.loser_balance_after) || 0,
    finishReason: r.finish_reason || 'SCORE',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
  };
}

function upsertSettlementCache(settlement: MatchSettlement) {
  const idx = settlementsCache.findIndex(s => s.roomId === settlement.roomId);
  if (idx >= 0) settlementsCache[idx] = settlement;
  else settlementsCache.unshift(settlement);
}

function settlementDetails(s: MatchSettlement): string {
  return `Mesa ${s.roomId} | Gana @${s.winnerUsername} saldo restante: $${s.winnerBalanceAfter} | Pierde @${s.loserUsername} saldo restante: $${s.loserBalanceAfter} | Apuesta: $${s.betPerPlayer} c/u | Pozo: $${s.grossPot} | Premio: $${s.winnerPrize} | Rake ${s.rakePercentage}%: $${s.rakeAmount} | Motivo: ${s.finishReason}`;
}

export async function initDatabase() {
  if (!DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL no configurada.');
    return;
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();

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
        details VARCHAR(1000),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Amplía instalaciones previas donde details era VARCHAR(255).
    await client.query(`
      ALTER TABLE transactions ALTER COLUMN details TYPE VARCHAR(1000);
    `);

    // Clave opcional para evitar duplicar movimientos administrativos/financieros
    // que tengan un identificador natural (por ejemplo, aprobación de depósito).
    await client.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency
      ON transactions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    // Cada débito/crédito de una mesa tiene una clave única. PostgreSQL impide
    // que CREATE/JOIN/REFUND se aplique dos veces aunque llegue el evento repetido.
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_operations (
        idempotency_key VARCHAR(255) PRIMARY KEY,
        room_id VARCHAR(100) NOT NULL,
        username VARCHAR(100) NOT NULL,
        operation_type VARCHAR(50) NOT NULL,
        amount BIGINT NOT NULL,
        balance_after BIGINT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallet_operations_room ON wallet_operations(room_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallet_operations_user ON wallet_operations(username);`);

    // room_id es PRIMARY KEY: una partida solo puede liquidarse una vez.
    await client.query(`
      CREATE TABLE IF NOT EXISTS match_settlements (
        room_id VARCHAR(100) PRIMARY KEY,
        winner_username VARCHAR(100) NOT NULL,
        loser_username VARCHAR(100) NOT NULL,
        bet_per_player BIGINT NOT NULL,
        gross_pot BIGINT NOT NULL,
        winner_prize BIGINT NOT NULL,
        rake_percentage INTEGER NOT NULL DEFAULT 7,
        rake_amount BIGINT NOT NULL,
        winner_balance_after BIGINT,
        loser_balance_after BIGINT,
        finish_reason VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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

    const tRes = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500');
    transactionsCache = tRes.rows.map(r => ({
      id: r.id,
      type: r.type,
      username: r.username,
      amount: Number(r.amount) || 0,
      details: r.details || '',
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
    }));

    const sRes = await client.query('SELECT * FROM match_settlements ORDER BY created_at DESC LIMIT 500');
    settlementsCache = sRes.rows.map(settlementFromRow);

    console.log(`✅ Base de datos conectada. ${usersCache.length} usuarios, ${transactionsCache.length} transacciones y ${settlementsCache.length} partidas liquidadas sincronizadas.`);
  } catch (err) {
    console.error('❌ Error conectando a PostgreSQL:', err);
    throw err;
  } finally {
    client?.release();
  }
}

function hashPbkdf2(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

export async function registerUser(fullName: string, email: string, username: string, password: string): Promise<{ success: boolean; message: string; user?: User }> {
  const cleanUser = cleanUsername(username);
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanFullName = (fullName || '').trim();

  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(cleanUser)) {
    return { success: false, message: 'El nombre de usuario debe tener entre 3 y 20 caracteres y solo contener letras, números o guion bajo (_).' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) return { success: false, message: 'Ingresá un correo electrónico válido.' };
  if (!password || password.length < 6) return { success: false, message: 'La contraseña debe tener al menos 6 caracteres.' };
  if (usersCache.some(u => cleanUsername(u.username) === cleanUser)) return { success: false, message: 'El nombre de usuario ya está registrado.' };
  if (usersCache.some(u => (u.email || '').toLowerCase() === cleanEmail)) return { success: false, message: 'El correo electrónico ya está registrado.' };

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPbkdf2(password, salt);
  const newUser: User = {
    id: 'usr_' + crypto.randomBytes(4).toString('hex'), fullName: cleanFullName, email: cleanEmail,
    username: cleanUser, passwordHash, salt, chips: 0, avatar: 'gaucho', createdAt: new Date().toISOString()
  };

  if (DATABASE_URL) {
    try {
      await pool.query(
        'INSERT INTO users (id, full_name, email, username, password_hash, salt, chips, avatar) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [newUser.id, newUser.fullName, newUser.email, newUser.username, newUser.passwordHash, newUser.salt, newUser.chips, newUser.avatar]
      );
      console.log(`💾 Usuario @${newUser.username} guardado exitosamente en PostgreSQL.`);
    } catch (dbErr) {
      console.error('❌ Error guardando usuario:', dbErr);
      return { success: false, message: 'Error al conectar con la base de datos.' };
    }
  }
  usersCache.push(newUser);
  return { success: true, message: 'Registro exitoso.', user: newUser };
}

export async function loginUser(usernameOrEmail: string, password: string): Promise<{ success: boolean; message: string; user?: User }> {
  const target = (usernameOrEmail || '').trim().toLowerCase();
  let user: User | undefined;

  if (DATABASE_URL) {
    try {
      const res = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1',
        [target]
      );
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

        const idx = usersCache.findIndex(u => cleanUsername(u.username) === cleanUsername(user!.username));
        if (idx >= 0) usersCache[idx] = user;
        else usersCache.push(user);
      }
    } catch (err) {
      console.error('Error buscando usuario en BD:', err);
      return { success: false, message: 'Error al conectar con la base de datos.' };
    }
  } else {
    user = usersCache.find(u =>
      cleanUsername(u.username) === target ||
      (u.email && u.email.toLowerCase() === target)
    );
  }

  if (!user) return { success: false, message: 'Usuario o correo no encontrado.' };
  if (!user.passwordHash || !user.salt || hashPbkdf2(password, user.salt) !== user.passwordHash) {
    return { success: false, message: 'Contraseña incorrecta.' };
  }

  return { success: true, message: 'Inicio de sesión exitoso.', user };
}

export function resetUserPassword(username: string, newPass: string): boolean {
  const clean = cleanUsername(username);
  const user = usersCache.find(u => cleanUsername(u.username) === clean);
  if (!user) return false;
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passwordHash = hashPbkdf2(newPass, user.salt);
  if (DATABASE_URL) {
    pool.query('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3', [user.passwordHash, user.salt, user.id])
      .catch(err => console.error('Error actualizando password en BD:', err));
  }
  return true;
}

export function getUserChips(username: string): number {
  const clean = cleanUsername(username);
  const user = usersCache.find(u => cleanUsername(u.username) === clean);
  return user ? (user.chips || 0) : 0;
}

/**
 * Saldo autoritativo. En producción consulta PostgreSQL/Supabase y recién después
 * sincroniza el cache local. Usar esta función para respuestas HTTP y eventos
 * donde el saldo mostrado deba ser necesariamente el persistido.
 */
export async function getUserChipsFresh(username: string): Promise<number> {
  const clean = cleanUsername(username);
  if (!clean) return 0;

  if (!DATABASE_URL) return getUserChips(clean);

  try {
    const res = await pool.query(
      'SELECT chips FROM users WHERE LOWER(username) = $1 LIMIT 1',
      [clean]
    );
    if (!res.rows.length) return 0;
    const balance = Number(res.rows[0].chips) || 0;
    syncUserCacheBalance(clean, balance);
    return balance;
  } catch (err) {
    console.error('Error leyendo saldo desde PostgreSQL:', err);
    throw err;
  }
}

/**
 * Compatibilidad con código antiguo/local. Para operaciones reales de saldo en
 * endpoints y mesas usar modifyUserChipsAtomic/debitRoomEntry/refundRoomEntry/
 * settleMatchOnce, que esperan confirmación de PostgreSQL.
 */
export function modifyUserChips(username: string, amount: number): boolean {
  const clean = cleanUsername(username);
  const delta = integerAmount(amount);
  const user = usersCache.find(u => cleanUsername(u.username) === clean);
  if (!user || user.chips + delta < 0) return false;
  user.chips += delta;

  if (DATABASE_URL) {
    pool.query(
      'UPDATE users SET chips = chips + $1 WHERE id = $2 AND chips + $1 >= 0 RETURNING chips',
      [delta, user.id]
    ).then(res => {
      if (res.rows[0]) syncUserCacheBalance(clean, Number(res.rows[0].chips));
    }).catch(err => console.error('Error actualizando fichas en BD:', err));
  }
  return true;
}

export async function modifyUserChipsAtomic(username: string, amount: number): Promise<WalletOperationResult> {
  const clean = cleanUsername(username);
  const delta = integerAmount(amount);
  if (!clean) return { success: false, message: 'Usuario inválido.' };

  if (!DATABASE_URL) {
    const ok = modifyUserChips(clean, delta);
    return ok ? { success: true, balance: getUserChips(clean) } : { success: false, message: 'Usuario inexistente o saldo insuficiente.' };
  }

  try {
    const res = await pool.query(
      `UPDATE users SET chips = chips + $1
       WHERE LOWER(username) = $2 AND chips + $1 >= 0
       RETURNING chips`,
      [delta, clean]
    );
    if (!res.rows.length) return { success: false, message: 'Usuario inexistente o saldo insuficiente.' };
    const balance = Number(res.rows[0].chips) || 0;
    syncUserCacheBalance(clean, balance);
    return { success: true, balance };
  } catch (err) {
    console.error('Error en modificación atómica de fichas:', err);
    return { success: false, message: 'No se pudo actualizar el saldo.' };
  }
}

async function applyRoomWalletOperation(
  idempotencyKey: string,
  roomId: string,
  username: string,
  operationType: string,
  amount: number
): Promise<WalletOperationResult> {
  const clean = cleanUsername(username);
  const delta = integerAmount(amount);

  if (!DATABASE_URL) {
    const previous = localWalletOperations.get(idempotencyKey);
    if (previous) return { ...previous, alreadyProcessed: true };
    const result = await modifyUserChipsAtomic(clean, delta);
    if (result.success) localWalletOperations.set(idempotencyKey, result);
    return result;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reserved = await client.query(
      `INSERT INTO wallet_operations
       (idempotency_key, room_id, username, operation_type, amount, balance_after)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [idempotencyKey, roomId, clean, operationType, delta]
    );

    if (!reserved.rows.length) {
      const previous = await client.query(
        'SELECT balance_after FROM wallet_operations WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      await client.query('COMMIT');
      const balance = Number(previous.rows[0]?.balance_after);
      if (Number.isFinite(balance)) syncUserCacheBalance(clean, balance);
      return { success: true, alreadyProcessed: true, balance: Number.isFinite(balance) ? balance : getUserChips(clean) };
    }

    const changed = await client.query(
      `UPDATE users SET chips = chips + $1
       WHERE LOWER(username) = $2 AND chips + $1 >= 0
       RETURNING chips`,
      [delta, clean]
    );
    if (!changed.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Usuario inexistente o saldo insuficiente.' };
    }

    const balance = Number(changed.rows[0].chips) || 0;
    await client.query(
      'UPDATE wallet_operations SET balance_after = $1 WHERE idempotency_key = $2',
      [balance, idempotencyKey]
    );
    await client.query('COMMIT');
    syncUserCacheBalance(clean, balance);
    return { success: true, balance };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`[WALLET] Error operación ${idempotencyKey}:`, err);
    return { success: false, message: 'Error de base de datos al actualizar saldo.' };
  } finally {
    client.release();
  }
}

export async function debitRoomEntry(roomId: string, username: string, amount: number, role: 'CREATOR' | 'GUEST'): Promise<WalletOperationResult> {
  const bet = Math.max(0, integerAmount(amount));
  if (bet === 0) return { success: true, balance: await getUserChipsFresh(username) };
  return applyRoomWalletOperation(
    `${roomId}:ENTRY:${cleanUsername(username)}`,
    roomId,
    username,
    `ENTRY_${role}`,
    -bet
  );
}

/**
 * Devuelve una entrada SOLO si PostgreSQL confirma que esa entrada fue debitada
 * anteriormente. Esto impide crear fichas por un REFUND sin ENTRY.
 */
export async function refundRoomEntry(roomId: string, username: string, amount: number): Promise<WalletOperationResult> {
  const clean = cleanUsername(username);
  const bet = Math.max(0, integerAmount(amount));
  if (bet === 0) return { success: true, balance: await getUserChipsFresh(clean) };

  const entryKey = `${roomId}:ENTRY:${clean}`;
  const refundKey = `${roomId}:REFUND:${clean}`;

  if (!DATABASE_URL) {
    const entry = localWalletOperations.get(entryKey);
    if (!entry?.success) return { success: false, message: 'No existe una entrada debitada para devolver.' };
    const previous = localWalletOperations.get(refundKey);
    if (previous) return { ...previous, alreadyProcessed: true };
    const result = await modifyUserChipsAtomic(clean, bet);
    if (result.success) localWalletOperations.set(refundKey, result);
    return result;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const entryRes = await client.query(
      `SELECT amount FROM wallet_operations
       WHERE idempotency_key = $1 AND room_id = $2 AND LOWER(username) = $3
       FOR UPDATE`,
      [entryKey, roomId, clean]
    );

    if (!entryRes.rows.length || Number(entryRes.rows[0].amount) !== -bet) {
      await client.query('ROLLBACK');
      return { success: false, message: 'No existe una entrada debitada válida para devolver.' };
    }

    const reserved = await client.query(
      `INSERT INTO wallet_operations
       (idempotency_key, room_id, username, operation_type, amount, balance_after)
       VALUES ($1, $2, $3, 'REFUND', $4, NULL)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [refundKey, roomId, clean, bet]
    );

    if (!reserved.rows.length) {
      const previous = await client.query(
        'SELECT balance_after FROM wallet_operations WHERE idempotency_key = $1',
        [refundKey]
      );
      await client.query('COMMIT');
      const balance = Number(previous.rows[0]?.balance_after) || await getUserChipsFresh(clean);
      syncUserCacheBalance(clean, balance);
      return { success: true, alreadyProcessed: true, balance };
    }

    const changed = await client.query(
      `UPDATE users
       SET chips = chips + $1
       WHERE LOWER(username) = $2
       RETURNING chips`,
      [bet, clean]
    );

    if (!changed.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Usuario inexistente.' };
    }

    const balance = Number(changed.rows[0].chips) || 0;
    await client.query(
      'UPDATE wallet_operations SET balance_after = $1 WHERE idempotency_key = $2',
      [balance, refundKey]
    );

    await client.query('COMMIT');
    syncUserCacheBalance(clean, balance);
    return { success: true, balance };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`[REFUND ERROR] ${roomId}/${clean}:`, err);
    return { success: false, message: 'Error de base de datos al devolver la entrada.' };
  } finally {
    client.release();
  }
}

export async function settleMatchOnce(params: {
  roomId: string;
  winnerUsername: string;
  loserUsername: string;
  betPerPlayer: number;
  finishReason: string;
}): Promise<MatchSettlementResult> {
  const winner = cleanUsername(params.winnerUsername);
  const loser = cleanUsername(params.loserUsername);
  const payout = calculateMatchPayout(params.betPerPlayer);

  if (!winner || !loser || winner === loser) return { success: false, message: 'Jugadores inválidos para liquidación.' };

  if (!DATABASE_URL) {
    const old = localSettlements.get(params.roomId);
    if (old) return { success: true, alreadySettled: true, settlement: old };
    if (payout.winnerPrize > 0) {
      const credit = await modifyUserChipsAtomic(winner, payout.winnerPrize);
      if (!credit.success) return { success: false, message: credit.message };
    }
    const settlement: MatchSettlement = {
      roomId: params.roomId, winnerUsername: winner, loserUsername: loser,
      betPerPlayer: payout.betPerPlayer, grossPot: payout.grossPot,
      winnerPrize: payout.winnerPrize, rakePercentage: RAKE_PERCENTAGE,
      rakeAmount: payout.rakeAmount, winnerBalanceAfter: getUserChips(winner),
      loserBalanceAfter: getUserChips(loser), finishReason: params.finishReason,
      createdAt: new Date().toISOString()
    };
    localSettlements.set(params.roomId, settlement);
    upsertSettlementCache(settlement);
    return { success: true, settlement };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO match_settlements
       (room_id, winner_username, loser_username, bet_per_player, gross_pot,
        winner_prize, rake_percentage, rake_amount, winner_balance_after,
        loser_balance_after, finish_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9)
       ON CONFLICT (room_id) DO NOTHING
       RETURNING created_at`,
      [params.roomId, winner, loser, payout.betPerPlayer, payout.grossPot,
       payout.winnerPrize, RAKE_PERCENTAGE, payout.rakeAmount, params.finishReason]
    );

    if (!inserted.rows.length) {
      const existingRes = await client.query('SELECT * FROM match_settlements WHERE room_id = $1', [params.roomId]);
      await client.query('COMMIT');
      if (!existingRes.rows.length) return { success: false, message: 'No se pudo recuperar la liquidación existente.' };
      const existing = settlementFromRow(existingRes.rows[0]);
      syncUserCacheBalance(existing.winnerUsername, existing.winnerBalanceAfter);
      syncUserCacheBalance(existing.loserUsername, existing.loserBalanceAfter);
      upsertSettlementCache(existing);
      console.warn(`[SETTLEMENT DUPLICATE BLOCKED] ${params.roomId}: la partida ya estaba liquidada.`);
      return { success: true, alreadySettled: true, settlement: existing };
    }

    // Para mesas con apuesta, el premio solo puede liquidarse si existen
    // las dos entradas debitadas y confirmadas en PostgreSQL.
    if (payout.betPerPlayer > 0) {
      const entries = await client.query(
        `SELECT LOWER(username) AS username, amount
         FROM wallet_operations
         WHERE room_id = $1
           AND operation_type IN ('ENTRY_CREATOR', 'ENTRY_GUEST')
           AND LOWER(username) = ANY($2::text[])`,
        [params.roomId, [winner, loser]]
      );

      const winnerEntry = entries.rows.find((r: any) =>
        cleanUsername(r.username) === winner && Number(r.amount) === -payout.betPerPlayer
      );
      const loserEntry = entries.rows.find((r: any) =>
        cleanUsername(r.username) === loser && Number(r.amount) === -payout.betPerPlayer
      );

      if (!winnerEntry || !loserEntry) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: 'La liquidación fue bloqueada porque no están confirmadas las dos entradas de la mesa.'
        };
      }
    }

    // Bloqueamos ambos saldos en orden estable para que el snapshot contable sea consistente.
    const players = [winner, loser].sort();
    const locked = await client.query(
      'SELECT username, chips FROM users WHERE LOWER(username) = ANY($1::text[]) ORDER BY LOWER(username) FOR UPDATE',
      [players]
    );
    if (locked.rows.length !== 2) {
      await client.query('ROLLBACK');
      return { success: false, message: 'No se encontraron ambos jugadores en la base de datos.' };
    }

    let winnerBalanceAfter = Number(locked.rows.find((r: any) => cleanUsername(r.username) === winner)?.chips) || 0;
    const loserBalanceAfter = Number(locked.rows.find((r: any) => cleanUsername(r.username) === loser)?.chips) || 0;

    if (payout.winnerPrize > 0) {
      const credit = await client.query(
        'UPDATE users SET chips = chips + $1 WHERE LOWER(username) = $2 RETURNING chips',
        [payout.winnerPrize, winner]
      );
      if (!credit.rows.length) {
        await client.query('ROLLBACK');
        return { success: false, message: 'No se pudo acreditar el premio al ganador.' };
      }
      winnerBalanceAfter = Number(credit.rows[0].chips) || 0;
    }

    const finalRes = await client.query(
      `UPDATE match_settlements
       SET winner_balance_after = $1, loser_balance_after = $2
       WHERE room_id = $3
       RETURNING *`,
      [winnerBalanceAfter, loserBalanceAfter, params.roomId]
    );

    await client.query('COMMIT');
    const settlement = settlementFromRow(finalRes.rows[0]);
    syncUserCacheBalance(winner, settlement.winnerBalanceAfter);
    syncUserCacheBalance(loser, settlement.loserBalanceAfter);
    upsertSettlementCache(settlement);
    console.log(`[SETTLEMENT OK] ${settlementDetails(settlement)}`);
    return { success: true, settlement };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`[SETTLEMENT ERROR] ${params.roomId}:`, err);
    return { success: false, message: 'No se pudo liquidar la partida. No se acreditó un segundo premio.' };
  } finally {
    client.release();
  }
}

export function getUserAvatar(username: string): string {
  const clean = cleanUsername(username);
  const user = usersCache.find(u => cleanUsername(u.username) === clean);
  return user?.avatar || 'gaucho';
}

export function updateUserAvatar(username: string, avatarId: string): boolean {
  const clean = cleanUsername(username);
  if (!ALLOWED_AVATARS.includes(avatarId)) return false;
  const user = usersCache.find(u => cleanUsername(u.username) === clean);
  if (!user) return false;
  user.avatar = avatarId;
  if (DATABASE_URL) {
    pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarId, user.id])
      .catch(err => console.error('Error actualizando avatar en BD:', err));
  }
  return true;
}

export function getAllUsersList() {
  // Compatibilidad local/legacy. El panel de producción usa getAllUsersListFresh().
  return usersCache.map(u => ({
    username: u.username,
    fullName: u.fullName,
    email: u.email,
    chips: u.chips || 0,
    avatar: u.avatar || 'gaucho'
  }));
}

export async function getAllUsersListFresh() {
  if (!DATABASE_URL) return getAllUsersList();

  const res = await pool.query(`
    SELECT username, full_name, email, chips, avatar
    FROM users
    ORDER BY LOWER(username)
  `);

  const rows = res.rows.map(r => ({
    username: r.username,
    fullName: r.full_name,
    email: r.email,
    chips: Number(r.chips) || 0,
    avatar: r.avatar || 'gaucho'
  }));

  for (const row of rows) syncUserCacheBalance(row.username, row.chips);
  return rows;
}

export function requestDeposit(username: string, amount: number, reference: string): { success: boolean; message: string } {
  // Compatibilidad local. En producción usar requestDepositPersistent().
  const newDep: DepositRequest = {
    id: 'dep_' + crypto.randomBytes(4).toString('hex'),
    username: cleanUsername(username),
    amount: integerAmount(amount),
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

export async function requestDepositPersistent(
  username: string,
  amount: number,
  reference: string
): Promise<{ success: boolean; message: string }> {
  const clean = cleanUsername(username);
  const value = Math.max(0, integerAmount(amount));
  if (!clean || value <= 0) return { success: false, message: 'Solicitud de depósito inválida.' };

  const newDep: DepositRequest = {
    id: 'dep_' + crypto.randomBytes(8).toString('hex'),
    username: clean,
    amount: value,
    reference: reference || 'WhatsApp',
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };

  if (!DATABASE_URL) {
    depositsCache.push(newDep);
    return { success: true, message: 'Solicitud enviada correctamente.' };
  }

  try {
    const userExists = await pool.query(
      'SELECT 1 FROM users WHERE LOWER(username) = $1 LIMIT 1',
      [clean]
    );
    if (!userExists.rows.length) return { success: false, message: 'Usuario no encontrado.' };

    await pool.query(
      `INSERT INTO deposits (id, username, amount, reference, status, created_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
      [newDep.id, newDep.username, newDep.amount, newDep.reference, newDep.createdAt]
    );

    depositsCache.unshift(newDep);
    return { success: true, message: 'Solicitud enviada correctamente.' };
  } catch (err) {
    console.error('Error guardando depósito en PostgreSQL:', err);
    return { success: false, message: 'No se pudo guardar la solicitud de depósito.' };
  }
}

export function getPendingDeposits(): DepositRequest[] {
  // Compatibilidad local/legacy. El panel de producción usa getPendingDepositsFresh().
  return depositsCache.filter(d => d.status === 'PENDING');
}

export async function getPendingDepositsFresh(): Promise<DepositRequest[]> {
  if (!DATABASE_URL) return getPendingDeposits();

  const res = await pool.query(`
    SELECT id, username, amount, reference, status, created_at
    FROM deposits
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
  `);

  return res.rows.map(r => ({
    id: r.id,
    username: r.username,
    amount: Number(r.amount) || 0,
    reference: r.reference || '',
    status: r.status,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
  }));
}

export function recordTransaction(
  type: 'DEPOSIT' | 'WITHDRAW' | 'COMMISSION_RAKE',
  username: string,
  amount: number,
  details: string = ''
): Transaction {
  // Compatibilidad local/legacy. Las operaciones reales usan funciones transaccionales.
  const tx: Transaction = {
    id: 'tx_' + crypto.randomBytes(4).toString('hex'),
    type,
    username: cleanUsername(username),
    amount: integerAmount(amount),
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

/**
 * Ajusta saldo + registra el movimiento en UNA sola transacción PostgreSQL.
 * Si la escritura del historial falla, el saldo también vuelve atrás.
 */
export async function adjustUserChipsAndRecord(
  username: string,
  amount: number,
  type: 'DEPOSIT' | 'WITHDRAW',
  details: string,
  idempotencyKey?: string
): Promise<WalletOperationResult> {
  const clean = cleanUsername(username);
  const delta = integerAmount(amount);
  if (!clean || delta === 0) return { success: false, message: 'Operación inválida.' };

  if (!DATABASE_URL) {
    const changed = await modifyUserChipsAtomic(clean, delta);
    if (!changed.success) return changed;
    recordTransaction(type, clean, Math.abs(delta), details);
    return changed;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (idempotencyKey) {
      const existing = await client.query(
        'SELECT id FROM transactions WHERE idempotency_key = $1 LIMIT 1',
        [idempotencyKey]
      );
      if (existing.rows.length) {
        const balance = await client.query(
          'SELECT chips FROM users WHERE LOWER(username) = $1 LIMIT 1',
          [clean]
        );
        await client.query('COMMIT');
        const current = Number(balance.rows[0]?.chips) || 0;
        syncUserCacheBalance(clean, current);
        return { success: true, alreadyProcessed: true, balance: current };
      }
    }

    const changed = await client.query(
      `UPDATE users
       SET chips = chips + $1
       WHERE LOWER(username) = $2
         AND chips + $1 >= 0
       RETURNING chips`,
      [delta, clean]
    );

    if (!changed.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Usuario inexistente o saldo insuficiente.' };
    }

    const txId = 'tx_' + crypto.randomBytes(8).toString('hex');
    await client.query(
      `INSERT INTO transactions
       (id, type, username, amount, details, created_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)`,
      [txId, type, clean, Math.abs(delta), details, idempotencyKey || null]
    );

    await client.query('COMMIT');

    const balance = Number(changed.rows[0].chips) || 0;
    syncUserCacheBalance(clean, balance);
    return { success: true, balance };
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch {}

    if (idempotencyKey && err?.code === '23505') {
      const balance = await getUserChipsFresh(clean);
      return { success: true, alreadyProcessed: true, balance };
    }

    console.error('Error ajustando saldo con historial:', err);
    return { success: false, message: 'No se pudo actualizar el saldo.' };
  } finally {
    client.release();
  }
}

export async function approveDeposit(depositId: string): Promise<{ success: boolean; message: string }> {
  if (!depositId) return { success: false, message: 'Solicitud no válida.' };

  if (!DATABASE_URL) {
    const dep = depositsCache.find(d => d.id === depositId);
    if (!dep || dep.status !== 'PENDING') {
      return { success: false, message: 'Solicitud no válida o ya procesada.' };
    }
    const credit = await modifyUserChipsAtomic(dep.username, dep.amount);
    if (!credit.success) return { success: false, message: credit.message || 'No se pudo acreditar.' };
    dep.status = 'APPROVED';
    recordTransaction('DEPOSIT', dep.username, dep.amount, `Depósito aprobado (${dep.reference})`);
    return { success: true, message: `Acreditados $${dep.amount} a ${dep.username}.` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const locked = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
      [depositId]
    );

    if (!locked.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Solicitud no válida.' };
    }

    const row = locked.rows[0];
    if (row.status === 'APPROVED') {
      await client.query('COMMIT');
      return { success: true, message: 'Este depósito ya había sido aprobado. No se acreditó nuevamente.' };
    }
    if (row.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return { success: false, message: 'Solicitud no válida o ya procesada.' };
    }

    const clean = cleanUsername(row.username);
    const value = Number(row.amount) || 0;

    const changed = await client.query(
      'UPDATE users SET chips = chips + $1 WHERE LOWER(username) = $2 RETURNING chips',
      [value, clean]
    );
    if (!changed.rows.length) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Usuario no encontrado.' };
    }

    await client.query(
      `UPDATE deposits SET status = 'APPROVED' WHERE id = $1`,
      [depositId]
    );

    await client.query(
      `INSERT INTO transactions
       (id, type, username, amount, details, created_at, idempotency_key)
       VALUES ($1, 'DEPOSIT', $2, $3, $4, CURRENT_TIMESTAMP, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        'tx_' + crypto.randomBytes(8).toString('hex'),
        clean,
        value,
        `Depósito aprobado (${row.reference || ''})`,
        `DEPOSIT_APPROVAL:${depositId}`
      ]
    );

    await client.query('COMMIT');

    const depCache = depositsCache.find(d => d.id === depositId);
    if (depCache) depCache.status = 'APPROVED';
    syncUserCacheBalance(clean, Number(changed.rows[0].chips));

    return { success: true, message: `Acreditados $${value} a ${clean}.` };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error aprobando depósito:', err);
    return { success: false, message: 'No se pudo aprobar el depósito.' };
  } finally {
    client.release();
  }
}

export async function rejectDeposit(depositId: string): Promise<{ success: boolean; message: string }> {
  if (!depositId) return { success: false, message: 'Solicitud no válida.' };

  if (!DATABASE_URL) {
    const dep = depositsCache.find(d => d.id === depositId);
    if (!dep || dep.status !== 'PENDING') {
      return { success: false, message: 'Solicitud no válida o ya procesada.' };
    }
    dep.status = 'REJECTED';
    return { success: true, message: `Depósito de @${dep.username} rechazado.` };
  }

  try {
    const res = await pool.query(
      `UPDATE deposits
       SET status = 'REJECTED'
       WHERE id = $1 AND status = 'PENDING'
       RETURNING username`,
      [depositId]
    );

    if (!res.rows.length) {
      return { success: false, message: 'Solicitud no válida o ya procesada.' };
    }

    const depCache = depositsCache.find(d => d.id === depositId);
    if (depCache) depCache.status = 'REJECTED';

    return { success: true, message: `Depósito de @${res.rows[0].username} rechazado.` };
  } catch (err) {
    console.error('Error rechazando depósito:', err);
    return { success: false, message: 'No se pudo rechazar el depósito.' };
  }
}

function settlementAsTransaction(s: MatchSettlement): Transaction {
  return {
    id: `match_${s.roomId}`,
    type: 'MATCH_SETTLEMENT',
    username: s.winnerUsername,
    amount: s.rakeAmount,
    details: settlementDetails(s),
    createdAt: s.createdAt,
    roomId: s.roomId,
    winnerUsername: s.winnerUsername,
    loserUsername: s.loserUsername,
    winnerBalanceAfter: s.winnerBalanceAfter,
    loserBalanceAfter: s.loserBalanceAfter,
    rakePercentage: s.rakePercentage,
    winnerPrize: s.winnerPrize,
    grossPot: s.grossPot,
    finishReason: s.finishReason
  };
}

export function getAllTransactions(limit: number = 60): Transaction[] {
  // Compatibilidad local/legacy. El panel de producción usa getAllTransactionsFresh().
  return [...transactionsCache, ...settlementsCache.map(settlementAsTransaction)]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export async function getAllTransactionsFresh(limit: number = 60): Promise<Transaction[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 60)));
  if (!DATABASE_URL) return getAllTransactions(safeLimit);

  const [txRes, settlementRes] = await Promise.all([
    pool.query(
      `SELECT id, type, username, amount, details, created_at
       FROM transactions
       ORDER BY created_at DESC
       LIMIT $1`,
      [safeLimit]
    ),
    pool.query(
      `SELECT *
       FROM match_settlements
       ORDER BY created_at DESC
       LIMIT $1`,
      [safeLimit]
    )
  ]);

  const normalTx: Transaction[] = txRes.rows.map(r => ({
    id: r.id,
    type: r.type,
    username: r.username,
    amount: Number(r.amount) || 0,
    details: r.details || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString()
  }));

  const matchTx = settlementRes.rows.map(r => settlementAsTransaction(settlementFromRow(r)));

  return [...normalTx, ...matchTx]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, safeLimit);
}

export function getAdminMetrics() {
  // Compatibilidad local/legacy. El panel de producción usa getAdminMetricsFresh().
  const totalUsers = usersCache.length;
  const totalChipsInCirculation = usersCache.reduce((sum, u) => sum + (u.chips || 0), 0);
  const pendingDeposits = depositsCache.filter(d => d.status === 'PENDING');
  const pendingDepositsCount = pendingDeposits.length;
  const pendingDepositsAmount = pendingDeposits.reduce((sum, d) => sum + (d.amount || 0), 0);

  const legacyRake = transactionsCache
    .filter(t => t.type === 'COMMISSION_RAKE')
    .reduce((sum, t) => sum + (t.amount || 0), 0);
  const settledRake = settlementsCache.reduce((sum, s) => sum + (s.rakeAmount || 0), 0);

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
    totalRakeEarned: legacyRake + settledRake,
    totalDepositsApproved,
    totalWithdrawals
  };
}

export async function getAdminMetricsFresh() {
  if (!DATABASE_URL) return getAdminMetrics();

  const res = await pool.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM users) AS total_users,
      (SELECT COALESCE(SUM(chips), 0)::bigint FROM users) AS total_chips,
      (SELECT COUNT(*)::bigint FROM deposits WHERE status = 'PENDING') AS pending_count,
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM deposits WHERE status = 'PENDING') AS pending_amount,
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions WHERE type = 'COMMISSION_RAKE') AS legacy_rake,
      (SELECT COALESCE(SUM(rake_amount), 0)::bigint FROM match_settlements) AS settled_rake,
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions WHERE type = 'DEPOSIT') AS total_deposits,
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions WHERE type = 'WITHDRAW') AS total_withdrawals
  `);

  const r = res.rows[0] || {};
  return {
    totalUsers: Number(r.total_users) || 0,
    totalChipsInCirculation: Number(r.total_chips) || 0,
    pendingDepositsCount: Number(r.pending_count) || 0,
    pendingDepositsAmount: Number(r.pending_amount) || 0,
    totalRakeEarned: (Number(r.legacy_rake) || 0) + (Number(r.settled_rake) || 0),
    totalDepositsApproved: Number(r.total_deposits) || 0,
    totalWithdrawals: Number(r.total_withdrawals) || 0
  };
}

export async function deleteUser(username: string): Promise<boolean> {
  const clean = cleanUsername(username);
  const index = usersCache.findIndex(u => cleanUsername(u.username) === clean);
  if (index === -1) return false;
  const userToDelete = usersCache[index];

  if (DATABASE_URL) {
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [userToDelete.id]);
      console.log(`🗑️ Usuario @${clean} eliminado de PostgreSQL.`);
    } catch (err) {
      console.error('Error eliminando usuario de BD:', err);
      return false;
    }
  }
  usersCache.splice(index, 1);
  return true;
}
