"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TournamentService = exports.clock = void 0;
exports.calendar = calendar;
const crypto_1 = __importDefault(require("crypto"));
const userService_1 = require("../auth/userService");
exports.clock = { now: () => Date.now() };
function calendar(now) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, seconds: +p.hour * 3600 + +p.minute * 60 + +p.second };
}
const fresh = (day) => ({ day, status: 'open', entries: [], matches: [], receipts: {}, prizes: {} });
class TournamentService {
    bridge;
    tail = Promise.resolve();
    boot = true;
    cache = new Map();
    constructor(bridge) { this.bridge = bridge; }
    async init() {
        await userService_1.pool.query(`CREATE TABLE IF NOT EXISTS daily_tournaments (day TEXT PRIMARY KEY, state JSONB NOT NULL)`);
        const r = await userService_1.pool.query("SELECT day,state FROM daily_tournaments WHERE state->>'status' IN ('open','running') OR day=$1", [calendar(exports.clock.now()).day]);
        for (const row of r.rows)
            this.cache.set(row.day, row.state);
        // Completar el resumen de torneos ya finalizados, sin repetir premios ni mover fichas.
        const completed = await userService_1.pool.query(`SELECT day FROM daily_tournaments d
      WHERE state->>'status'='done' AND NOT EXISTS
      (SELECT 1 FROM transactions t WHERE t.idempotency_key='tour:'||d.day||':summary')`);
        for (const row of completed.rows)
            await this.tx(row.day, (s, c) => this.recordSummary(s, c));
    }
    serial(fn) {
        const next = this.tail.then(fn);
        this.tail = next.catch(() => { });
        return next;
    }
    tx(day, fn) {
        return this.serial(async () => {
            const c = await userService_1.pool.connect();
            try {
                await c.query('BEGIN');
                await c.query('INSERT INTO daily_tournaments(day,state) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [day, JSON.stringify(fresh(day))]);
                const r = await c.query('SELECT state FROM daily_tournaments WHERE day=$1 FOR UPDATE', [day]);
                const state = r.rows[0].state;
                const before = JSON.stringify(state);
                const result = await fn(state, c);
                if (before !== JSON.stringify(state))
                    await c.query('UPDATE daily_tournaments SET state=$2::jsonb WHERE day=$1', [day, JSON.stringify(state)]);
                await c.query('COMMIT');
                this.cache.set(day, state);
                return result;
            }
            catch (e) {
                await c.query('ROLLBACK');
                throw e;
            }
            finally {
                c.release();
            }
        });
    }
    async move(c, key, user, amount, details) {
        const prior = await c.query('SELECT id FROM transactions WHERE idempotency_key=$1', [key]);
        if (prior.rows.length)
            return;
        const r = await c.query('UPDATE users SET chips=chips+$1 WHERE LOWER(username)=$2 AND chips+$1>=0 RETURNING chips', [amount, user]);
        if (!r.rows.length)
            throw Error('Saldo insuficiente o usuario inexistente.');
        await c.query(`INSERT INTO transactions(id,type,username,amount,details,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)`, ['t_' + crypto_1.default.randomBytes(12).toString('hex'), amount < 0 ? 'TOURNAMENT_ENTRY' : details.includes('Devolución') ? 'TOURNAMENT_REFUND' : 'TOURNAMENT_PRIZE', user, Math.abs(amount), details, key]);
    }
    async register(user, requestId) {
        const { day } = calendar(exports.clock.now());
        user = user.toLowerCase();
        return this.tx(day, async (s, c) => {
            if (!requestId || requestId.length > 100)
                throw Error('Solicitud inválida.');
            if (s.receipts[`${user}:${requestId}`])
                return s.receipts[`${user}:${requestId}`];
            const t = calendar(exports.clock.now());
            if (t.day !== day || t.seconds < 18 * 3600 || t.seconds >= 22 * 3600 || s.status !== 'open')
                throw Error('Inscripciones de 18:00 a 22:00 (Argentina).');
            const active = s.entries.find(e => e.user === user && e.active);
            if (active)
                return active.id;
            if (s.entries.filter(e => e.active).length >= 8)
                throw Error('El cupo de 8 jugadores está completo.');
            const id = crypto_1.default.randomUUID();
            await this.move(c, `tour:${day}:entry:${id}`, user, -3000, `Inscripción torneo ${day}`);
            s.entries.push({ id, user, active: true, refunded: false });
            s.receipts[`${user}:${requestId}`] = id;
            return id;
        });
    }
    async cancel(user, id) {
        const { day } = calendar(exports.clock.now());
        return this.tx(day, async (s, c) => {
            const e = s.entries.find(e => e.user === user && e.id === id);
            if (!e || e.refunded || !e.active)
                return;
            const t = calendar(exports.clock.now());
            if (t.day !== day || t.seconds >= 21 * 3600 + 55 * 60 || s.status !== 'open')
                throw Error('La cancelación está disponible hasta antes de las 21:55.');
            await this.refund(s, c, e);
            e.active = false;
        });
    }
    async refund(s, c, e) {
        if (e.refunded)
            return;
        await this.move(c, `tour:${s.day}:refund:${e.id}`, e.user, 3000, `Devolución torneo ${s.day}`);
        e.refunded = true;
        e.active = false;
    }
    async state(day = calendar(exports.clock.now()).day) {
        if (!this.cache.has(day)) {
            const r = await userService_1.pool.query('SELECT state FROM daily_tournaments WHERE day=$1', [day]);
            this.cache.set(day, r.rows[0]?.state || fresh(day));
        }
        return JSON.parse(JSON.stringify(this.cache.get(day)));
    }
    match(s, id, stage, players) {
        const m = { id: `torneo_${s.day}_${id}`, stage, players, status: 'waiting', deadline: exports.clock.now() + 180000 };
        // Un puesto sin rival no elimina a quien sí está habilitado.
        if (players.filter(Boolean).length < 2) {
            m.status = 'done';
            m.winner = players.find(Boolean) || null;
            m.loser = null;
        }
        s.matches.push(m);
        return m;
    }
    async advance(s, c) {
        const stage = (n) => s.matches.filter(m => m.stage === n);
        const q = stage('Cuartos');
        if (q.length === 4) {
            for (let i = 0; i < 2; i++)
                if (!s.matches.some(m => m.id.endsWith(`_s${i}`)) && q.slice(i * 2, i * 2 + 2).every(m => m.status === 'done'))
                    this.match(s, `s${i}`, 'Semifinal', q.slice(i * 2, i * 2 + 2).map(m => m.winner || null));
        }
        const semis = stage('Semifinal');
        if (semis.length === 2 && semis.every(m => m.status === 'done') && !stage('Final').length) {
            this.match(s, 'f', 'Final', semis.map(m => m.winner || null));
            this.match(s, 'third', 'Tercer puesto', semis.map(m => m.loser || null));
        }
        const f = stage('Final')[0], third = stage('Tercer puesto')[0];
        const awards = [];
        if (f?.status === 'done')
            awards.push(['1', f.winner, 13000], ['2', f.loser, 5000]);
        if (third?.status === 'done')
            awards.push(['3', third.winner, 3000]);
        for (const [rank, user, amount] of awards)
            if (user && !s.prizes[rank]) {
                await this.move(c, `tour:${s.day}:prize:${rank}`, user, amount, `Premio ${rank}º torneo ${s.day}`);
                s.prizes[rank] = user;
            }
        if (f?.status === 'done' && third?.status === 'done') {
            s.status = 'done';
            await this.recordSummary(s, c);
        }
    }
    async recordSummary(s, c) {
        if (s.status !== 'done')
            return;
        const date = s.day.split('-').reverse();
        date[2] = date[2].slice(-2);
        const podium = [['1', 13000], ['2', 5000], ['3', 3000]];
        const winners = new Set(Object.values(s.prizes));
        const others = [...new Set(s.entries.filter(e => e.active).map(e => e.user))].filter(u => !winners.has(u));
        const details = `Torneo ${date.join('/')} | ` + podium.map(([rank, amount]) => s.prizes[rank] ? `${rank}º @${s.prizes[rank]}: ${amount.toLocaleString('es-AR')} fichas` : `${rank}º sin clasificado`).join(' | ') + ` | Participantes restantes: ${others.map(u => '@' + u).join(', ') || 'Ninguno'} | Comisión: 3.000 fichas`;
        // Solo registro contable: los saldos ya fueron liquidados mediante move().
        await c.query(`INSERT INTO transactions(id,type,username,amount,details,idempotency_key,created_at)
      VALUES($1,'TOURNAMENT_SETTLEMENT',$2,3000,$3,$4,
        COALESCE((SELECT MAX(created_at) FROM transactions WHERE idempotency_key LIKE $5),CURRENT_TIMESTAMP))
      ON CONFLICT DO NOTHING`, ['t_' + crypto_1.default.randomBytes(12).toString('hex'), s.prizes['1'] || 'torneo', details, `tour:${s.day}:summary`, `tour:${s.day}:%`]);
    }
    async finish(id, winner, loser) {
        const day = id.slice(7, 17);
        await this.tx(day, async (s, c) => {
            const m = s.matches.find(m => m.id === id);
            if (!m || m.status === 'done')
                return;
            if (m.status !== 'playing' || !m.players.includes(winner) || !m.players.includes(loser) || winner === loser)
                throw Error('Resultado inválido.');
            m.status = 'done';
            m.winner = winner;
            m.loser = loser;
            delete m.snapshot;
            await this.advance(s, c);
        });
    }
    async snapshot(id, snapshot) {
        await this.tx(id.slice(7, 17), async (s) => { const m = s.matches.find(m => m.id === id); if (m?.status === 'playing')
            m.snapshot = snapshot; });
    }
    async tick() {
        const now = exports.clock.now(), today = calendar(now);
        const boot = this.boot;
        const days = new Set([today.day, ...[...this.cache.values()].filter(s => s.status === 'open' || s.status === 'running').map(s => s.day)]);
        for (const day of days) {
            const launch = [], recover = [];
            let notify = await this.state(day);
            const due = day < today.day || (day === today.day && today.seconds >= 22 * 3600);
            const needsChange = (notify.status === 'open' && due) || (notify.status === 'running' && notify.matches.some(m => (m.status === 'playing' && !m.snapshot && !this.bridge.exists(m.id)) || (m.status === 'waiting' && (now >= m.deadline || m.players.every(u => u && this.bridge.available(u, m.deadline))))));
            if (needsChange)
                await this.tx(day, async (s, c) => {
                    const eligible = day < today.day || (day === today.day && today.seconds >= 22 * 3600);
                    if (s.status === 'open' && eligible) {
                        const active = s.entries.filter(e => e.active);
                        if (boot || day < today.day || active.length !== 8) {
                            for (const e of active)
                                await this.refund(s, c, e);
                            s.status = 'cancelled';
                        }
                        else {
                            // Fisher-Yates con fuente criptográfica: todos los inscriptos entran en un único sorteo persistido.
                            const users = active.map(e => e.user);
                            for (let i = users.length - 1; i > 0; i--) {
                                const j = crypto_1.default.randomInt(i + 1);
                                [users[i], users[j]] = [users[j], users[i]];
                            }
                            s.status = 'running';
                            for (let i = 0; i < 4; i++)
                                this.match(s, `q${i}`, 'Cuartos', users.slice(i * 2, i * 2 + 2));
                        }
                    }
                    if (s.status === 'running') {
                        await this.advance(s, c);
                        for (const m of s.matches) {
                            if (m.status === 'playing' && !m.snapshot && !this.bridge.exists(m.id))
                                m.status = 'waiting';
                            if (m.status === 'playing')
                                continue;
                            if (m.status !== 'waiting')
                                continue;
                            const present = m.players.filter(u => u && this.bridge.available(u, m.deadline));
                            if (present.length === 2) {
                                m.status = 'playing';
                                launch.push(m);
                            }
                            else if (now >= m.deadline) {
                                m.status = 'done';
                                m.winner = present.length === 1 ? present[0] : null;
                                // Ausencia inicial: ambos ausentes quedan descalificados; solo un ausente pierde contra el presente.
                                m.loser = null; // El ausente queda descalificado, sin acceso al tercer puesto ni a un premio.
                            }
                        }
                        await this.advance(s, c);
                    }
                    notify = JSON.parse(JSON.stringify(s));
                });
            for (const m of notify.matches)
                if (m.status === 'playing' && !this.bridge.exists(m.id))
                    recover.push(m);
            // Primero persistir la asignación; después abrir las cuatro mesas, sin esperar el fin de ninguna.
            for (const m of recover.filter(m => !launch.some(l => l.id === m.id))) {
                if (m.snapshot)
                    this.bridge.restore(m);
                else if (m.players.every(u => u && this.bridge.available(u))) {
                    const snapshot = this.bridge.start(m);
                    await this.snapshot(m.id, snapshot);
                    this.bridge.activate(m.id);
                }
            }
            for (const m of launch) {
                const snapshot = this.bridge.start(m);
                await this.snapshot(m.id, snapshot);
                this.bridge.activate(m.id);
            }
            // El proceso conserva torneos anteriores en curso, pero el panel diario solo recibe la fecha actual.
            if (day === calendar(exports.clock.now()).day)
                this.bridge.notify(notify.entries.map(e => e.user), 'tournament_state', this.publicState(notify));
        }
        this.boot = false;
    }
    playingMatchFor(user) {
        for (const state of this.cache.values()) {
            if (state.status !== 'running')
                continue;
            const match = state.matches.find(m => m.status === 'playing' && m.players.includes(user));
            if (match)
                return match;
        }
        return null;
    }
    publicState(s) {
        return { day: s.day, status: s.status, serverNow: exports.clock.now(), entries: s.entries.filter(e => e.active).map(e => ({ user: e.user, id: e.id })), matches: s.matches.map(({ snapshot, ...m }) => m), prizes: s.prizes };
    }
}
exports.TournamentService = TournamentService;
