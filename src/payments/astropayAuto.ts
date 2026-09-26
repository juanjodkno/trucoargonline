import crypto from 'crypto';
import { pool, adjustUserChipsAndRecord } from '../auth/userService';

export type AstroPayAutoStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'CREDITED'
  | 'EXPIRED'
  | 'ERROR';

export interface AstroPayAutoRequest {
  id: string;
  username: string;
  holderName: string;
  holderNameNormalized: string;
  amount: number;
  amountCents: number;
  status: AstroPayAutoStatus;
  source: 'ASTROPAY_AUTO';
  createdAt: string;
  expiresAt: string;
  processingAt?: string;
  creditedAt?: string;
  matchedNotificationText?: string;
  transactionId?: string;
  errorMessage?: string;
}

export interface ParsedAstroPayNotification {
  success: boolean;
  raw: string;
  amount: number | null;
  amountCents: number | null;
  holderName: string | null;
  holderNameNormalized: string | null;
  reason?: string;
}

export interface ProcessAstroPayResult {
  success: boolean;
  matched: boolean;
  status:
    | 'CREDITED'
    | 'NO_MATCH'
    | 'PARSE_ERROR'
    | 'DUPLICATE_RECENT'
    | 'CREDIT_ERROR';
  parsed: ParsedAstroPayNotification;
  request?: AstroPayAutoRequest;
  message?: string;
}

export const ASTROPAY_AUTO_REQUEST_TTL_MS = 10 * 60 * 1000;
const PROCESSING_STALE_MS = 60 * 1000;
const SOURCE = 'ASTROPAY_AUTO' as const;
const IDEMPOTENCY_PREFIX = 'ASTROPAY_AUTO:';
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();

function hasPersistentStorage(): boolean {
  return !!DATABASE_URL;
}

export function getAstroPayAutoStorageMode(): 'DATABASE' | 'DISABLED' {
  return hasPersistentStorage() ? 'DATABASE' : 'DISABLED';
}

function rowToRequest(row: any): AstroPayAutoRequest {
  return {
    id: String(row.id),
    username: String(row.username),
    holderName: String(row.holder_name),
    holderNameNormalized: String(row.holder_name_normalized),
    amount: Number(row.amount_cents) / 100,
    amountCents: Number(row.amount_cents),
    status: String(row.status) as AstroPayAutoStatus,
    source: SOURCE,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(row.processing_at
      ? { processingAt: new Date(row.processing_at).toISOString() }
      : {}),
    ...(row.credited_at
      ? { creditedAt: new Date(row.credited_at).toISOString() }
      : {}),
    ...(row.matched_notification_text
      ? { matchedNotificationText: String(row.matched_notification_text) }
      : {}),
    ...(row.transaction_id
      ? { transactionId: String(row.transaction_id) }
      : {}),
    ...(row.error_message
      ? { errorMessage: String(row.error_message) }
      : {})
  };
}

export function normalizeAstroPayHolderName(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function getAstroPayHolderMatchKey(value: string): string {
  return normalizeAstroPayHolderName(value)
    .split(' ')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(' ');
}

function parseMoneyToken(token: string): number | null {
  let value = String(token || '').trim().replace(/\s/g, '');
  if (!value || !/^[0-9.,]+$/.test(value)) return null;

  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSeparator = lastDot > lastComma ? '.' : ',';
    const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
    value = value.split(thousandsSeparator).join('');
    if (decimalSeparator === ',') value = value.replace(',', '.');
  } else {
    const separator = lastDot !== -1 ? '.' : (lastComma !== -1 ? ',' : '');

    if (separator) {
      const parts = value.split(separator);
      const lastPart = parts[parts.length - 1] || '';

      if (parts.length > 2) {
        if (lastPart.length === 1 || lastPart.length === 2) {
          const decimal = lastPart;
          const whole = parts.slice(0, -1).join('');
          value = `${whole}.${decimal}`;
        } else {
          value = parts.join('');
        }
      } else if (lastPart.length === 3) {
        value = parts.join('');
      } else if (separator === ',') {
        value = value.replace(',', '.');
      }
    }
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parseAstroPayNotification(text: string): ParsedAstroPayNotification {
  const raw = String(text || '').trim();
  const match = raw.match(
    /^Has recibido\s+([0-9][0-9.,\s]*)\s+ARS\s+de\s+(.+?)\.?$/i
  );

  if (!match) {
    return {
      success: false,
      raw,
      amount: null,
      amountCents: null,
      holderName: null,
      holderNameNormalized: null,
      reason: 'Formato de notificación no reconocido.'
    };
  }

  const amount = parseMoneyToken(match[1]);
  const holderName = String(match[2] || '').trim().replace(/[.]+$/, '').trim();
  const holderNameNormalized = normalizeAstroPayHolderName(holderName);

  if (amount === null || !holderNameNormalized) {
    return {
      success: false,
      raw,
      amount: null,
      amountCents: null,
      holderName: holderName || null,
      holderNameNormalized: holderNameNormalized || null,
      reason: 'Monto o titular inválido.'
    };
  }

  return {
    success: true,
    raw,
    amount,
    amountCents: Math.round(amount * 100),
    holderName,
    holderNameNormalized
  };
}

async function expireOldRequests(): Promise<void> {
  if (!hasPersistentStorage()) return;
  await pool.query(`
    UPDATE astropay_auto_deposit_requests
       SET status = 'EXPIRED'
     WHERE status = 'PENDING'
       AND expires_at <= NOW();
  `);
}

async function recoverStaleProcessing(): Promise<void> {
  if (!hasPersistentStorage()) return;

  // Si la transacción de fichas existe, la solicitud queda consolidada como CREDITED.
  await pool.query(`
    UPDATE astropay_auto_deposit_requests r
       SET status = 'CREDITED',
           credited_at = COALESCE(r.credited_at, t.created_at),
           transaction_id = t.id,
           error_message = NULL
      FROM transactions t
     WHERE r.status = 'PROCESSING'
       AND t.idempotency_key = $1 || r.id;
  `, [IDEMPOTENCY_PREFIX]);

  // Si un proceso quedó interrumpido ANTES de acreditar, se libera de nuevo.
  // La idempotencia de transactions sigue siendo el blindaje final.
  await pool.query(`
    UPDATE astropay_auto_deposit_requests r
       SET status = CASE WHEN r.expires_at <= NOW() THEN 'EXPIRED' ELSE 'PENDING' END,
           processing_at = NULL,
           error_message = NULL
     WHERE r.status = 'PROCESSING'
       AND r.processing_at IS NOT NULL
       AND r.processing_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
       AND NOT EXISTS (
         SELECT 1
           FROM transactions t
          WHERE t.idempotency_key = $2 || r.id
       );
  `, [PROCESSING_STALE_MS, IDEMPOTENCY_PREFIX]);
}

export async function initAstroPayAutoStorage(): Promise<void> {
  if (!hasPersistentStorage()) {
    console.warn('⚠️ AstroPay AUTO desactivado: DATABASE_URL no configurada.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS astropay_auto_deposit_requests (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      holder_name VARCHAR(255) NOT NULL,
      holder_name_normalized VARCHAR(255) NOT NULL,
      holder_match_key VARCHAR(255) NOT NULL,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'CREDITED', 'EXPIRED', 'ERROR')),
      source VARCHAR(30) NOT NULL DEFAULT 'ASTROPAY_AUTO',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      processing_at TIMESTAMPTZ,
      credited_at TIMESTAMPTZ,
      matched_notification_text TEXT,
      transaction_id VARCHAR(50),
      error_message TEXT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_astropay_auto_username
      ON astropay_auto_deposit_requests (username);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_astropay_auto_status_expires
      ON astropay_auto_deposit_requests (status, expires_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_astropay_auto_transaction
      ON astropay_auto_deposit_requests (transaction_id)
      WHERE transaction_id IS NOT NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_astropay_auto_active_username
      ON astropay_auto_deposit_requests (username)
      WHERE status IN ('PENDING', 'PROCESSING');
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_astropay_auto_active_holder_amount
      ON astropay_auto_deposit_requests (holder_match_key, amount_cents)
      WHERE status IN ('PENDING', 'PROCESSING');
  `);

  await recoverStaleProcessing();
  await expireOldRequests();
  console.log('💳 AstroPay AUTO: almacenamiento persistente activo.');
}

export async function createAstroPayAutoRequest(input: {
  username: string;
  holderName: string;
  amount: number;
}): Promise<{ success: boolean; message: string; request?: AstroPayAutoRequest }> {
  if (!hasPersistentStorage()) {
    return { success: false, message: 'La carga automática no está disponible.' };
  }

  const username = String(input.username || '').trim().toLowerCase();
  const holderName = String(input.holderName || '').trim();
  const holderNameNormalized = normalizeAstroPayHolderName(holderName);
  const holderMatchKey = getAstroPayHolderMatchKey(holderName);
  const amount = Number(input.amount);

  if (!username) return { success: false, message: 'Usuario inválido.' };
  if (holderNameNormalized.length < 3) {
    return { success: false, message: 'Ingresá el nombre completo del titular.' };
  }
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    return { success: false, message: 'Ingresá un monto válido en pesos enteros.' };
  }

  const amountCents = amount * 100;
  const now = Date.now();
  const requestId = `autodep_${crypto.randomBytes(10).toString('hex')}`;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ASTROPAY_AUTO_REQUEST_TTL_MS).toISOString();

  await recoverStaleProcessing();
  await expireOldRequests();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userExists = await client.query(
      `SELECT 1 FROM users WHERE LOWER(username) = $1 LIMIT 1`,
      [username]
    );
    if (!userExists.rowCount) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Usuario no encontrado.' };
    }

    const activeForUser = await client.query(
      `SELECT id
         FROM astropay_auto_deposit_requests
        WHERE username = $1
          AND status IN ('PENDING', 'PROCESSING')
        LIMIT 1`,
      [username]
    );
    if (activeForUser.rowCount) {
      await client.query('ROLLBACK');
      return {
        success: false,
        message: 'Ya tenés una solicitud de carga en proceso. Esperá a que se complete o venza.'
      };
    }

    const duplicate = await client.query(
      `SELECT id
         FROM astropay_auto_deposit_requests
        WHERE holder_match_key = $1
          AND amount_cents = $2
          AND status IN ('PENDING', 'PROCESSING')
        LIMIT 1`,
      [holderMatchKey, amountCents]
    );
    if (duplicate.rowCount) {
      await client.query('ROLLBACK');
      return {
        success: false,
        message: 'Ya existe una solicitud en proceso con ese titular y monto.'
      };
    }

    const inserted = await client.query(
      `INSERT INTO astropay_auto_deposit_requests
       (id, username, holder_name, holder_name_normalized, holder_match_key,
        amount_cents, status, source, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9)
       RETURNING *`,
      [
        requestId,
        username,
        holderName,
        holderNameNormalized,
        holderMatchKey,
        amountCents,
        SOURCE,
        createdAt,
        expiresAt
      ]
    );

    await client.query('COMMIT');
    return {
      success: true,
      message: 'Carga solicitada. Estado: En proceso.',
      request: rowToRequest(inserted.rows[0])
    };
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch {}

    if (error?.code === '23505') {
      const constraint = String(error?.constraint || '');
      if (constraint.includes('active_username')) {
        return {
          success: false,
          message: 'Ya tenés una solicitud de carga en proceso. Esperá a que se complete o venza.'
        };
      }
      if (constraint.includes('active_holder_amount')) {
        return {
          success: false,
          message: 'Ya existe una solicitud en proceso con ese titular y monto.'
        };
      }
    }

    console.error('Error creando solicitud automática AstroPay:', error);
    return { success: false, message: 'No se pudo crear la solicitud de carga.' };
  } finally {
    client.release();
  }
}

export async function getActiveAstroPayAutoRequestForUser(
  username: string
): Promise<AstroPayAutoRequest | null> {
  if (!hasPersistentStorage()) return null;

  const clean = String(username || '').trim().toLowerCase();
  if (!clean) return null;

  await recoverStaleProcessing();
  await expireOldRequests();

  const result = await pool.query(
    `SELECT *
       FROM astropay_auto_deposit_requests
      WHERE username = $1
        AND status IN ('PENDING', 'PROCESSING')
      ORDER BY created_at DESC
      LIMIT 1`,
    [clean]
  );

  return result.rowCount ? rowToRequest(result.rows[0]) : null;
}

export async function getAstroPayAutoRequest(
  id: string,
  username?: string
): Promise<AstroPayAutoRequest | null> {
  if (!hasPersistentStorage()) return null;

  await recoverStaleProcessing();
  await expireOldRequests();

  const cleanId = String(id || '').trim();
  const cleanUsername = username ? String(username).trim().toLowerCase() : '';
  if (!cleanId) return null;

  const params: any[] = [cleanId];
  let sql = `SELECT * FROM astropay_auto_deposit_requests WHERE id = $1`;
  if (cleanUsername) {
    params.push(cleanUsername);
    sql += ` AND username = $2`;
  }
  sql += ` LIMIT 1`;

  const result = await pool.query(sql, params);
  return result.rowCount ? rowToRequest(result.rows[0]) : null;
}

async function findRecentProcessedDuplicate(
  holderMatchKey: string,
  amountCents: number,
  rawText: string
): Promise<AstroPayAutoRequest | null> {
  const result = await pool.query(
    `SELECT *
       FROM astropay_auto_deposit_requests
      WHERE holder_match_key = $1
        AND amount_cents = $2
        AND matched_notification_text = $3
        AND status IN ('PROCESSING', 'CREDITED')
        AND COALESCE(processing_at, credited_at, created_at) >= NOW() - INTERVAL '2 minutes'
      ORDER BY created_at DESC
      LIMIT 1`,
    [holderMatchKey, amountCents, rawText]
  );
  return result.rowCount ? rowToRequest(result.rows[0]) : null;
}

export async function processAstroPayAutoNotification(
  text: string
): Promise<ProcessAstroPayResult> {
  const parsed = parseAstroPayNotification(text);

  if (
    !parsed.success ||
    parsed.amountCents === null ||
    !parsed.holderNameNormalized
  ) {
    return {
      success: false,
      matched: false,
      status: 'PARSE_ERROR',
      parsed,
      message: parsed.reason || 'Notificación no reconocida.'
    };
  }

  if (!hasPersistentStorage()) {
    return {
      success: false,
      matched: false,
      status: 'CREDIT_ERROR',
      parsed,
      message: 'DATABASE_URL no configurada.'
    };
  }

  // Las fichas existentes son enteras. Una transferencia con centavos no se
  // acredita automáticamente para evitar redondeos silenciosos.
  if (parsed.amountCents % 100 !== 0) {
    return {
      success: true,
      matched: false,
      status: 'NO_MATCH',
      parsed,
      message: 'La carga automática solo procesa montos enteros en ARS.'
    };
  }

  let claimedRequest: AstroPayAutoRequest | undefined;

  try {
    await recoverStaleProcessing();
    await expireOldRequests();

    const matchKey = getAstroPayHolderMatchKey(parsed.holderNameNormalized);

    // Reclamo atómico: cambia PENDING -> PROCESSING antes de acreditar.
    // Así dos notificaciones concurrentes nunca procesan la misma solicitud.
    // No se mantiene una conexión tomada mientras se acredita, por lo que
    // varias transferencias simultáneas pueden avanzar sin agotar el pool.
    const claimed = await pool.query(
      `UPDATE astropay_auto_deposit_requests r
          SET status = 'PROCESSING',
              processing_at = NOW(),
              matched_notification_text = $3,
              error_message = NULL
        WHERE r.id = (
          SELECT id
            FROM astropay_auto_deposit_requests
           WHERE status = 'PENDING'
             AND expires_at > NOW()
             AND holder_match_key = $1
             AND amount_cents = $2
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING r.*`,
      [matchKey, parsed.amountCents, parsed.raw]
    );

    if (!claimed.rowCount) {
      const duplicate = await findRecentProcessedDuplicate(
        matchKey,
        parsed.amountCents,
        parsed.raw
      );

      if (duplicate) {
        return {
          success: true,
          matched: false,
          status: 'DUPLICATE_RECENT',
          parsed,
          request: duplicate,
          message: 'Notificación ya procesada recientemente.'
        };
      }

      return {
        success: true,
        matched: false,
        status: 'NO_MATCH',
        parsed
      };
    }

    claimedRequest = rowToRequest(claimed.rows[0]);
    const amountArs = claimedRequest.amountCents / 100;
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}${claimedRequest.id}`;

    // IMPORTANTE: se reutiliza la operación de billetera existente.
    // No se duplica ni se reescribe la lógica que acredita fichas.
    const credit = await adjustUserChipsAndRecord(
      claimedRequest.username,
      amountArs,
      'DEPOSIT',
      'Carga automática exitosa',
      idempotencyKey
    );

    if (!credit.success) {
      const failed = await pool.query(
        `UPDATE astropay_auto_deposit_requests
            SET status = 'ERROR',
                error_message = $2
          WHERE id = $1
          RETURNING *`,
        [
          claimedRequest.id,
          credit.message || 'No se pudo acreditar la carga automática.'
        ]
      );

      return {
        success: false,
        matched: true,
        status: 'CREDIT_ERROR',
        parsed,
        request: failed.rowCount
          ? rowToRequest(failed.rows[0])
          : claimedRequest,
        message: credit.message || 'No se pudo acreditar la carga automática.'
      };
    }

    const txResult = await pool.query(
      `SELECT id
         FROM transactions
        WHERE idempotency_key = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [idempotencyKey]
    );
    const transactionId = txResult.rows[0]?.id
      ? String(txResult.rows[0].id)
      : null;

    const completed = await pool.query(
      `UPDATE astropay_auto_deposit_requests
          SET status = 'CREDITED',
              credited_at = NOW(),
              transaction_id = $2,
              error_message = NULL
        WHERE id = $1
        RETURNING *`,
      [claimedRequest.id, transactionId]
    );

    return {
      success: true,
      matched: true,
      status: 'CREDITED',
      parsed,
      request: completed.rowCount
        ? rowToRequest(completed.rows[0])
        : claimedRequest,
      message: credit.alreadyProcessed
        ? 'La carga ya había sido acreditada anteriormente.'
        : 'Carga automática acreditada correctamente.'
    };
  } catch (error) {
    console.error('Error procesando notificación AstroPay AUTO:', error);

    // Si el crédito alcanzó a quedar confirmado pero falló el último UPDATE
    // de auditoría, la clave idempotente permite reconstruir el estado sin
    // volver a sumar fichas.
    if (claimedRequest) {
      try {
        await recoverStaleProcessing();
        const recovered = await getAstroPayAutoRequest(
          claimedRequest.id,
          claimedRequest.username
        );
        if (recovered?.status === 'CREDITED') {
          return {
            success: true,
            matched: true,
            status: 'CREDITED',
            parsed,
            request: recovered,
            message: 'Carga automática acreditada correctamente.'
          };
        }
      } catch (recoveryError) {
        console.error('Error recuperando estado AstroPay AUTO:', recoveryError);
      }
    }

    return {
      success: false,
      matched: !!claimedRequest,
      status: 'CREDIT_ERROR',
      parsed,
      ...(claimedRequest ? { request: claimedRequest } : {}),
      message: 'No se pudo completar el procesamiento automático.'
    };
  }
}
