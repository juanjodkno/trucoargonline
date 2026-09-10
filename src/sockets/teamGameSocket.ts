import { Server, Socket } from 'socket.io';
import crypto from 'crypto';
import { TeamTrucoRound, TeamId, teamForSeat } from '../game/teamTrucoGame';
import { Card, calculateEnvido, calculateFlor, hasFlor } from '../game/trucoEngine';
import {
  calculateTeamMatchPayout,
  debitTeamRoomEntry,
  refundTeamRoomEntry,
  settleTeamMatchOnce,
  userExistsFresh
} from '../auth/userService';
import {
  claimActiveGame,
  getActiveGamePresence,
  releaseActiveGame
} from './activeGameRegistry';

type TeamPhase = 'WAITING' | 'PLAYING' | 'MATCH_OVER';
type TeamCallKind = 'TRUCO' | 'ENVIDO' | 'FLOR';

type TrucoCall = 'TRUCO' | 'RETRUCO' | 'VALE_4';
type EnvidoCall = 'ENVIDO' | 'REAL_ENVIDO' | 'FALTA_ENVIDO';
type FlorCall = 'FLOR' | 'CONTRAFLOR' | 'CONTRAFLOR_AL_JUEGO';

interface TeamSeat {
  seat: number;
  userId: string;
  socketId?: string;
  connected: boolean;
  team: TeamId;
  entryToken: string;
}

interface TeamChatMessage {
  id: string;
  fromSeat: number;
  fromUserId: string;
  team: TeamId;
  text: string;
  at: number;
}

interface TrucoPending {
  kind: 'TRUCO';
  callType: TrucoCall;
  callerSeat: number;
  callerTeam: TeamId;
  responderTeam: TeamId;
  proposedStake: number;
  previousStake: number;
}

interface EnvidoPending {
  kind: 'ENVIDO';
  callType: EnvidoCall;
  callerSeat: number;
  callerTeam: TeamId;
  responderTeam: TeamId;
}

interface FlorPending {
  kind: 'FLOR';
  callType: FlorCall;
  callerSeat: number;
  callerTeam: TeamId;
  responderTeam: TeamId;
}

type PendingCall = TrucoPending | EnvidoPending | FlorPending;

interface TeamRoom {
  roomId: string;
  creatorId: string;
  players: TeamSeat[];
  targetPoints: number;
  withFlor: boolean;
  betAmount: number;
  settlementInProgress: boolean;
  settlementComplete: boolean;
  settlementSummary?: {
    winnerTeam: TeamId;
    grossPot: number;
    rakeAmount: number;
    winnerPrizeTotal: number;
    winnerPrizes: number[];
    winnerUsernames: string[];
  } | null;
  matchWinnerTeam?: TeamId | null;
  turnInterval?: NodeJS.Timeout;
  turnDeadline?: number;
  turnTimerContext?: string | null;
  pausedTurnMs?: number;
  disconnectInterval?: NodeJS.Timeout;
  disconnectDeadlines: Record<number, number>;
  scoreA: number;
  scoreB: number;
  manoSeat: number;
  phase: TeamPhase;
  round?: TeamTrucoRound;
  transitioning: boolean;
  pendingCall: PendingCall | null;
  suspendedTruco: TrucoPending | null;
  trucoStake: number;
  trucoLastRaiserTeam: TeamId | null;
  envidoChain: EnvidoCall[];
  envidoDeclarationActive: boolean;
  envidoDeclarationOrder: number[];
  envidoDeclarationIndex: number;
  envidoAcceptedPoints: number;
  envidoWinningSeat: number | null;
  envidoWinningScore: number | null;
  envidoSonBuenasSeat: number | null;
  envidoDeclarations: Array<{ seat: number; userId: string; score: number | null; sonBuenas: boolean }>;
  florChain: FlorCall[];
  logs: string[];
  teamChats: Record<TeamId, TeamChatMessage[]>;
  createdAt: number;
  transitionTimer?: NodeJS.Timeout;
  finishLobbyTimer?: NodeJS.Timeout;
}

const teamRooms = new Map<string, TeamRoom>();
const pendingTeamCreations = new Set<string>();
const pendingTeamJoins = new Set<string>();

const otherTeam = (team: TeamId): TeamId => team === 'A' ? 'B' : 'A';
const scoreFor = (room: TeamRoom, team: TeamId) => team === 'A' ? room.scoreA : room.scoreB;

function addScore(room: TeamRoom, team: TeamId, points: number) {
  if (team === 'A') room.scoreA += points;
  else room.scoreB += points;
}

function formatCall(call: string): string {
  return call
    .replace('VALE_4', 'VALE 4')
    .replace('REAL_ENVIDO', 'REAL ENVIDO')
    .replace('FALTA_ENVIDO', 'FALTA ENVIDO')
    .replace('CONTRAFLOR_AL_JUEGO', 'CONTRAFLOR AL JUEGO')
    .replaceAll('_', ' ');
}

function roomLog(room: TeamRoom, text: string) {
  room.logs.push(text);
  if (room.logs.length > 200) room.logs.splice(0, room.logs.length - 200);
}

function pushTeamChat(room: TeamRoom, team: TeamId, fromSeat: number, fromUserId: string, text: string) {
  const list = room.teamChats[team] || (room.teamChats[team] = []);
  list.push({
    id: crypto.randomBytes(6).toString('hex'),
    fromSeat,
    fromUserId,
    team,
    text,
    at: Date.now()
  });
  if (list.length > 40) list.splice(0, list.length - 40);
}

function seatOrderFrom(manoSeat: number): number[] {
  return [0, 1, 2, 3].map(i => (manoSeat + i) % 4);
}

function getSeat(room: TeamRoom, seat: number): TeamSeat | undefined {
  return room.players.find(p => p.seat === seat);
}

function getSeatBySocket(room: TeamRoom, socketId: string): TeamSeat | undefined {
  return room.players.find(p => p.socketId === socketId);
}

function getSeatByUser(room: TeamRoom, userId: string): TeamSeat | undefined {
  const key = String(userId || '').trim().toLowerCase();
  return room.players.find(p => p.userId.toLowerCase() === key);
}

function releaseTeamRoomPresence(room: TeamRoom) {
  for (const player of room.players) {
    releaseActiveGame(player.userId, '2v2', room.roomId);
  }
}

function makeRoomId(): string {
  return `2v2_${crypto.randomBytes(4).toString('hex')}`;
}

function makeEntryToken(): string {
  return crypto.randomBytes(6).toString('hex');
}

function getRoundCards(room: TeamRoom, seat: number): Card[] {
  return room.round?.getAllCardsForSeat(seat) || [];
}

function seatHasFlor(room: TeamRoom, seat: number): boolean {
  return !!room.round && hasFlor(getRoundCards(room, seat));
}

function teamHasFlor(room: TeamRoom, team: TeamId): boolean {
  return room.players.some(p => p.team === team && seatHasFlor(room, p.seat));
}

function envidoPoints(room: TeamRoom): { accepted: number; declined: number } {
  const chain = room.envidoChain;
  if (!chain.length) return { accepted: 0, declined: 1 };

  const value = (call: EnvidoCall) => call === 'ENVIDO' ? 2 : call === 'REAL_ENVIDO' ? 3 : 0;
  const last = chain[chain.length - 1];

  let accepted = 0;
  if (last === 'FALTA_ENVIDO') {
    accepted = Math.max(1, room.targetPoints - Math.max(room.scoreA, room.scoreB));
  } else {
    accepted = chain.reduce((sum, call) => sum + value(call), 0);
  }

  let declined = 1;
  if (chain.length > 1) {
    declined = chain.slice(0, -1).reduce((sum, call) => sum + value(call), 0) || 1;
  }

  return { accepted, declined };
}

function florPoints(room: TeamRoom, accepted: boolean): number {
  const chain = room.florChain;
  const last = chain[chain.length - 1] || 'FLOR';

  if (!accepted) {
    if (last === 'CONTRAFLOR') return 4;
    if (last === 'CONTRAFLOR_AL_JUEGO') {
      return chain.includes('CONTRAFLOR') ? 7 : 4;
    }
    return 3;
  }

  if (last === 'CONTRAFLOR_AL_JUEGO') {
    return Math.max(1, room.targetPoints - Math.max(room.scoreA, room.scoreB));
  }
  if (last === 'CONTRAFLOR') return 6;
  return 3;
}

function bestEnvidoForTeam(room: TeamRoom, team: TeamId) {
  const order = seatOrderFrom(room.manoSeat);
  const candidates = room.players
    .filter(p => p.team === team)
    .map(p => ({ seat: p.seat, userId: p.userId, score: calculateEnvido(getRoundCards(room, p.seat)) }));
  candidates.sort((a, b) => b.score - a.score || order.indexOf(a.seat) - order.indexOf(b.seat));
  return candidates[0];
}

function bestFlorForTeam(room: TeamRoom, team: TeamId) {
  const order = seatOrderFrom(room.manoSeat);
  const candidates = room.players
    .filter(p => p.team === team && seatHasFlor(room, p.seat))
    .map(p => ({ seat: p.seat, userId: p.userId, score: calculateFlor(getRoundCards(room, p.seat)) }));
  candidates.sort((a, b) => b.score - a.score || order.indexOf(a.seat) - order.indexOf(b.seat));
  return candidates[0] || null;
}

function chooseByMano(room: TeamRoom, a: { seat: number; score: number }, b: { seat: number; score: number }): TeamId {
  if (a.score > b.score) return teamForSeat(a.seat);
  if (b.score > a.score) return teamForSeat(b.seat);
  const order = seatOrderFrom(room.manoSeat);
  return order.indexOf(a.seat) < order.indexOf(b.seat) ? teamForSeat(a.seat) : teamForSeat(b.seat);
}

function canRaiseEnvido(room: TeamRoom, callType: EnvidoCall): boolean {
  const chain = room.envidoChain;
  if (chain.includes('FALTA_ENVIDO')) return false;
  if (callType === 'FALTA_ENVIDO') return true;
  if (callType === 'REAL_ENVIDO') return !chain.includes('REAL_ENVIDO');
  if (callType === 'ENVIDO') {
    return !chain.includes('REAL_ENVIDO') && chain.filter(c => c === 'ENVIDO').length < 2;
  }
  return false;
}

function canInitiateTantos(room: TeamRoom, seat: TeamSeat): boolean {
  if (!room.round || room.round.currentTrickIndex !== 0) return false;
  if (room.round.envidoResolved || room.round.florResolved) return false;
  return !room.round.hasSeatPlayedAnyCard(seat.seat);
}

// Si un equipo se va al mazo durante la primera baza, el punto extra de Envido
// corresponde cuando el equipo rival todavía tenía al menos un jugador que
// conservaba su oportunidad real de cantar Envido (aún no había jugado carta).
// Ej.: J1 juega, J2 juega, J3 se va al mazo -> J4 todavía podía cantar Envido,
// por lo que el equipo rival recibe Truco (1) + Envido no cantado (1) = 2.
function opponentStillHadEnvidoOpportunity(room: TeamRoom, foldingTeam: TeamId): boolean {
  if (!room.round || room.round.currentTrickIndex !== 0) return false;
  if (room.round.envidoResolved || room.round.florResolved) return false;

  const winningTeam = otherTeam(foldingTeam);
  return room.players.some(player => {
    if (player.team !== winningTeam) return false;
    if (room.round!.hasSeatPlayedAnyCard(player.seat)) return false;

    // Con Flor habilitada, un jugador con Flor no tiene Envido disponible.
    if (room.withFlor && seatHasFlor(room, player.seat)) return false;
    return true;
  });
}

interface TeamTimerContext {
  key: string;
  seat: number | null;
  team: TeamId | null;
  label: string;
}

function disconnectedPlayers(room: TeamRoom): TeamSeat[] {
  return room.players.filter(player => !player.connected);
}

function getTeamTimerContext(room: TeamRoom): TeamTimerContext | null {
  if (room.phase !== 'PLAYING' || !room.round || room.transitioning || room.round.isFinished) return null;

  if (room.envidoDeclarationActive) {
    const seat = room.envidoSonBuenasSeat ?? room.envidoDeclarationOrder[room.envidoDeclarationIndex] ?? null;
    if (seat == null) return null;
    const player = getSeat(room, seat);
    return {
      key: `ENVIDO_DECL:${seat}:${room.envidoDeclarationIndex}:${room.envidoSonBuenasSeat ?? 'N'}`,
      seat,
      team: player?.team ?? teamForSeat(seat),
      label: player ? `Envido: ${player.userId}` : `Envido: J${seat + 1}`
    };
  }

  if (room.pendingCall) {
    return {
      key: `CALL:${room.pendingCall.kind}:${room.pendingCall.callType}:${room.pendingCall.callerSeat}:${room.pendingCall.responderTeam}`,
      seat: null,
      team: room.pendingCall.responderTeam,
      label: `Responde Equipo ${room.pendingCall.responderTeam}`
    };
  }

  const seat = room.round.currentTurnSeat;
  const player = getSeat(room, seat);
  return {
    key: `TURN:${seat}:${room.round.currentTrickIndex}:${room.round.players.reduce((n, p) => n + p.cardsPlayed.filter(Boolean).length, 0)}`,
    seat,
    team: player?.team ?? teamForSeat(seat),
    label: player ? `Turno: ${player.userId}` : `Turno: J${seat + 1}`
  };
}

function stopTeamTurnInterval(room: TeamRoom) {
  if (room.turnInterval) {
    clearInterval(room.turnInterval);
    room.turnInterval = undefined;
  }
}

function clearTeamTurnTimer(room: TeamRoom) {
  stopTeamTurnInterval(room);
  room.turnDeadline = undefined;
  room.turnTimerContext = null;
  room.pausedTurnMs = undefined;
}

function pauseTeamTurnTimer(room: TeamRoom) {
  const context = getTeamTimerContext(room);
  if (room.turnDeadline) {
    room.pausedTurnMs = Math.max(1000, room.turnDeadline - Date.now());
  } else if (room.pausedTurnMs == null) {
    room.pausedTurnMs = 30000;
  }
  if (context) room.turnTimerContext = context.key;
  stopTeamTurnInterval(room);
  room.turnDeadline = undefined;
}

function teamDisconnectSnapshot(room: TeamRoom) {
  const now = Date.now();
  return room.players
    .filter(player => !player.connected && room.disconnectDeadlines[player.seat])
    .map(player => ({
      seat: player.seat,
      userId: player.userId,
      team: player.team,
      deadline: room.disconnectDeadlines[player.seat],
      secondsLeft: Math.max(0, Math.ceil((room.disconnectDeadlines[player.seat] - now) / 1000))
    }))
    .sort((a, b) => a.deadline - b.deadline);
}

function emitTeamTimer(io: Server, room: TeamRoom) {
  const context = getTeamTimerContext(room);
  if (!context || !room.turnDeadline) return;
  io.to(room.roomId).emit('team_timer_tick', {
    roomId: room.roomId,
    contextKey: context.key,
    seat: context.seat,
    team: context.team,
    label: context.label,
    deadline: room.turnDeadline,
    secondsLeft: Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000))
  });
}

function startTeamTurnTimer(io: Server, room: TeamRoom, milliseconds: number = 30000) {
  const context = getTeamTimerContext(room);
  if (!context || disconnectedPlayers(room).length) return;

  stopTeamTurnInterval(room);
  const duration = Math.max(1000, Math.min(30000, Math.round(milliseconds)));
  room.turnTimerContext = context.key;
  room.turnDeadline = Date.now() + duration;
  room.pausedTurnMs = undefined;
  emitTeamTimer(io, room);

  room.turnInterval = setInterval(() => {
    if (room.phase !== 'PLAYING' || disconnectedPlayers(room).length) {
      pauseTeamTurnTimer(room);
      return;
    }

    const liveContext = getTeamTimerContext(room);
    if (!liveContext || liveContext.key !== room.turnTimerContext) {
      stopTeamTurnInterval(room);
      room.turnDeadline = undefined;
      return;
    }

    const remaining = room.turnDeadline ? room.turnDeadline - Date.now() : 0;
    if (remaining > 0) {
      emitTeamTimer(io, room);
      return;
    }

    const expiredContext = room.turnTimerContext;
    stopTeamTurnInterval(room);
    room.turnDeadline = undefined;
    io.to(room.roomId).emit('team_timer_tick', {
      roomId: room.roomId,
      contextKey: expiredContext,
      seat: liveContext.seat,
      team: liveContext.team,
      label: liveContext.label,
      deadline: Date.now(),
      secondsLeft: 0
    });
    handleTeamTimeout(io, room, expiredContext || '');
  }, 1000);
}

function syncTeamTurnTimer(io: Server, room: TeamRoom) {
  const context = getTeamTimerContext(room);
  if (!context) {
    clearTeamTurnTimer(room);
    return;
  }
  if (disconnectedPlayers(room).length) return;

  if (room.turnTimerContext === context.key && room.turnDeadline && room.turnDeadline > Date.now() && room.turnInterval) {
    return;
  }

  startTeamTurnTimer(io, room, 30000);
}

function resumeTeamTurnTimer(io: Server, room: TeamRoom) {
  if (disconnectedPlayers(room).length) return;
  const context = getTeamTimerContext(room);
  if (!context) {
    clearTeamTurnTimer(room);
    return;
  }
  const sameContext = room.turnTimerContext === context.key;
  const remaining = sameContext && room.pausedTurnMs != null ? room.pausedTurnMs : 30000;
  startTeamTurnTimer(io, room, remaining);
}

function clearTeamDisconnectTimer(room: TeamRoom) {
  if (room.disconnectInterval) {
    clearInterval(room.disconnectInterval);
    room.disconnectInterval = undefined;
  }
  room.disconnectDeadlines = {};
}

function finishTeamMatchByForfeit(io: Server, room: TeamRoom, loser: TeamSeat, reason: 'ABANDON' | 'DISCONNECT_TIMEOUT') {
  if (room.phase !== 'PLAYING') return;
  const winnerTeam = otherTeam(loser.team);

  clearTeamTurnTimer(room);
  clearTeamDisconnectTimer(room);
  if (room.transitionTimer) {
    clearTimeout(room.transitionTimer);
    room.transitionTimer = undefined;
  }

  room.phase = 'MATCH_OVER';
  room.transitioning = false;
  room.matchWinnerTeam = winnerTeam;
  room.pendingCall = null;
  room.suspendedTruco = null;
  if (room.round) {
    room.round.isFinished = true;
    room.round.winnerTeam = winnerTeam;
  }

  if (reason === 'ABANDON') {
    roomLog(room, `🏳️ ${loser.userId} abandonó la partida. Equipo ${winnerTeam} gana el partido.`);
  } else {
    roomLog(room, `📡 ${loser.userId} no volvió dentro de 45 segundos. Equipo ${winnerTeam} gana por desconexión.`);
  }
  sendRoomState(io, room);
  void settleTeamFinancials(io, room, winnerTeam, reason);
}

function ensureTeamDisconnectInterval(io: Server, room: TeamRoom) {
  if (room.disconnectInterval) return;
  room.disconnectInterval = setInterval(() => {
    const snapshot = teamDisconnectSnapshot(room);
    if (!snapshot.length) {
      clearTeamDisconnectTimer(room);
      return;
    }

    io.to(room.roomId).emit('team_disconnect_tick', { roomId: room.roomId, players: snapshot });
    const expired = snapshot.find(item => item.secondsLeft <= 0);
    if (!expired) return;

    const loser = getSeat(room, expired.seat);
    if (loser) finishTeamMatchByForfeit(io, room, loser, 'DISCONNECT_TIMEOUT');
  }, 1000);
}

function startTeamDisconnectGrace(io: Server, room: TeamRoom, seat: TeamSeat) {
  if (room.phase !== 'PLAYING') return;
  const firstDisconnect = disconnectedPlayers(room).length === 1;
  if (firstDisconnect) pauseTeamTurnTimer(room);

  if (!room.disconnectDeadlines[seat.seat]) {
    room.disconnectDeadlines[seat.seat] = Date.now() + 45000;
    roomLog(room, `📡 ${seat.userId} perdió la conexión. Esperando 45 segundos para que vuelva.`);
  }
  ensureTeamDisconnectInterval(io, room);
  io.to(room.roomId).emit('team_disconnect_tick', { roomId: room.roomId, players: teamDisconnectSnapshot(room) });
}

function restoreTeamSeatConnection(io: Server, socket: Socket, room: TeamRoom, seat: TeamSeat) {
  const wasDisconnected = !seat.connected || !!room.disconnectDeadlines[seat.seat];
  seat.socketId = socket.id;
  seat.connected = true;
  socket.join(room.roomId);

  if (room.disconnectDeadlines[seat.seat]) delete room.disconnectDeadlines[seat.seat];
  if (wasDisconnected) roomLog(room, `🔌 ${seat.userId} se reconectó.`);

  const remainingDisconnected = disconnectedPlayers(room);
  if (!remainingDisconnected.length) {
    if (room.disconnectInterval) {
      clearInterval(room.disconnectInterval);
      room.disconnectInterval = undefined;
    }
    room.disconnectDeadlines = {};
    if (room.phase === 'PLAYING') resumeTeamTurnTimer(io, room);
  } else {
    io.to(room.roomId).emit('team_disconnect_tick', { roomId: room.roomId, players: teamDisconnectSnapshot(room) });
  }
}

function handleTeamTimeout(io: Server, room: TeamRoom, expiredContext: string) {
  if (room.phase !== 'PLAYING' || !room.round || disconnectedPlayers(room).length) return;
  const context = getTeamTimerContext(room);
  if (!context || context.key !== expiredContext) {
    syncTeamTurnTimer(io, room);
    return;
  }

  if (room.envidoDeclarationActive) {
    const currentSeat = room.envidoSonBuenasSeat ?? room.envidoDeclarationOrder[room.envidoDeclarationIndex];
    const seat = getSeat(room, currentSeat);
    if (!seat) return;
    const score = calculateEnvido(getRoundCards(room, seat.seat));
    const best = room.envidoWinningScore;
    const canBeat = best == null || score > best;

    if (!canBeat) {
      room.envidoDeclarations.push({ seat: seat.seat, userId: seat.userId, score: null, sonBuenas: true });
      roomLog(room, `⏱️ Tiempo agotado: ${seat.userId} dice SON BUENAS automáticamente.`);
      return finishEnvidoDeclarations(io, room);
    }

    room.envidoWinningScore = score;
    room.envidoWinningSeat = seat.seat;
    room.envidoDeclarations.push({ seat: seat.seat, userId: seat.userId, score, sonBuenas: false });
    roomLog(room, `⏱️ Tiempo agotado: ${seat.userId} canta ${score} de Envido automáticamente.`);
    if (room.envidoDeclarationIndex === 0) {
      room.envidoDeclarationIndex = 1;
      return sendRoomState(io, room);
    }
    return finishEnvidoDeclarations(io, room);
  }

  if (room.pendingCall) {
    const pending = room.pendingCall;
    roomLog(room, `⏱️ Tiempo agotado para Equipo ${pending.responderTeam}: se toma como NO QUIERO.`);
    if (pending.kind === 'TRUCO') {
      room.pendingCall = null;
      return finishMatchOrScheduleNext(io, room, pending.callerTeam, pending.previousStake, `${formatCall(pending.callType)} no querido por tiempo`);
    }
    if (pending.kind === 'ENVIDO') return resolveEnvido(io, room, false);
    return resolveFlor(io, room, false);
  }

  const seat = getSeat(room, room.round.currentTurnSeat);
  if (!seat) return;
  const hand = room.round.getPlayerBySeat(seat.seat)?.cards || [];
  const autoCard = hand[0];
  if (!autoCard) return;

  const result = room.round.playCard(seat.seat, autoCard.id);
  if (!result.success) return;
  roomLog(room, `⏱️ Tiempo agotado: ${seat.userId} jugó ${String(autoCard.id).replace('_', ' ')} automáticamente.`);
  if (result.isTrickOver) {
    const label = result.trickWinnerTeam === 'PARDA' ? 'Parda' : `Equipo ${result.trickWinnerTeam}`;
    roomLog(room, `✋ Baza: ${label}.`);
  }
  if (result.roundOver && result.winnerTeam) {
    return finishMatchOrScheduleNext(io, room, result.winnerTeam, room.trucoStake, 'bazas');
  }
  const nextSeat = room.round.currentTurnSeat;
  const nextPlayer = getSeat(room, nextSeat);
  if (nextPlayer) {
    roomLog(room, result.isTrickOver ? `➡️ Nueva baza. Sale ${nextPlayer.userId}.` : `➡️ Turno de ${nextPlayer.userId}.`);
  }
  sendRoomState(io, room);
}

function availableActions(room: TeamRoom, seat: TeamSeat): string[] {
  if (disconnectedPlayers(room).length) return [];
  if (room.phase !== 'PLAYING' || !room.round || room.transitioning || room.round.isFinished) return [];
  const actions: string[] = [];

  if (room.envidoDeclarationActive) {
    if (room.envidoSonBuenasSeat != null) {
      if (seat.seat === room.envidoSonBuenasSeat) actions.push('SON_BUENAS_ENVIDO');
      return actions;
    }

    const currentSeat = room.envidoDeclarationOrder[room.envidoDeclarationIndex];
    if (seat.seat !== currentSeat) return actions;
    const myScore = calculateEnvido(getRoundCards(room, seat.seat));
    const best = room.envidoWinningScore;
    if (best == null || myScore > best) actions.push('CANTAR_ENVIDO');
    else actions.push('SON_BUENAS_ENVIDO');
    return actions;
  }

  const pending = room.pendingCall;

  if (pending) {
    if (seat.team !== pending.responderTeam) return actions;

    if (pending.kind === 'TRUCO') {
      actions.push('QUIERO_TRUCO', 'NO_QUIERO_TRUCO');
      if (pending.proposedStake === 2) actions.push('RETRUCO');
      if (pending.proposedStake === 3) actions.push('VALE_4');

      if (pending.proposedStake === 2 && canInitiateTantos(room, seat)) {
        actions.push('ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO');
        if (room.withFlor && seatHasFlor(room, seat.seat)) actions.push('FLOR');
      }
      return actions;
    }

    if (pending.kind === 'ENVIDO') {
      actions.push('QUIERO_ENVIDO', 'NO_QUIERO_ENVIDO');
      for (const call of ['ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO'] as EnvidoCall[]) {
        if (canRaiseEnvido(room, call)) actions.push(call);
      }
      if (room.withFlor && canInitiateTantos(room, seat) && seatHasFlor(room, seat.seat)) actions.push('FLOR');
      return [...new Set(actions)];
    }

    actions.push('QUIERO_FLOR', 'NO_QUIERO_FLOR');
    const last = room.florChain[room.florChain.length - 1];
    if (last === 'FLOR') actions.push('CONTRAFLOR', 'CONTRAFLOR_AL_JUEGO');
    else if (last === 'CONTRAFLOR') actions.push('CONTRAFLOR_AL_JUEGO');
    return actions;
  }

  if (seat.seat !== room.round.currentTurnSeat) return actions;

  actions.push('ME_VOY_AL_MAZO');
  actions.push('PLAY_CARD');

  if (canInitiateTantos(room, seat)) {
    if (!room.withFlor || !seatHasFlor(room, seat.seat)) {
      actions.push('ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO');
    }
    if (room.withFlor && seatHasFlor(room, seat.seat)) actions.push('FLOR');
  }

  if (room.trucoStake === 1 && room.trucoLastRaiserTeam == null) actions.push('TRUCO');
  else if (room.trucoStake === 2 && room.trucoLastRaiserTeam !== seat.team) actions.push('RETRUCO');
  else if (room.trucoStake === 3 && room.trucoLastRaiserTeam !== seat.team) actions.push('VALE_4');

  return actions;
}

function serializePending(room: TeamRoom) {
  if (!room.pendingCall) return null;
  return {
    kind: room.pendingCall.kind,
    callType: room.pendingCall.callType,
    callerTeam: room.pendingCall.callerTeam,
    responderTeam: room.pendingCall.responderTeam,
    callerSeat: room.pendingCall.callerSeat
  };
}

function buildState(room: TeamRoom, mySeat: TeamSeat) {
  const round = room.round;
  return {
    roomId: room.roomId,
    phase: room.phase,
    targetPoints: room.targetPoints,
    withFlor: room.withFlor,
    betAmount: room.betAmount,
    payout: calculateTeamMatchPayout(room.betAmount),
    settlement: room.settlementSummary || null,
    matchWinnerTeam: room.matchWinnerTeam || null,
    turnTimer: (() => {
      const context = getTeamTimerContext(room);
      if (!context) return null;
      const secondsLeft = room.turnDeadline
        ? Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000))
        : (room.pausedTurnMs != null ? Math.max(0, Math.ceil(room.pausedTurnMs / 1000)) : 30);
      return {
        contextKey: context.key,
        seat: context.seat,
        team: context.team,
        label: context.label,
        deadline: room.turnDeadline || null,
        secondsLeft,
        paused: disconnectedPlayers(room).length > 0
      };
    })(),
    disconnectGrace: teamDisconnectSnapshot(room),
    scores: { A: room.scoreA, B: room.scoreB },
    manoSeat: room.manoSeat,
    mySeat: mySeat.seat,
    myTeam: mySeat.team,
    transitioning: room.transitioning,
    pendingCall: serializePending(room),
    trucoStake: room.trucoStake,
    envidoChain: room.envidoChain,
    florChain: room.florChain,
    envidoDeclaration: room.envidoDeclarationActive ? {
      active: true,
      order: room.envidoDeclarationOrder,
      index: room.envidoDeclarationIndex,
      currentSeat: room.envidoSonBuenasSeat ?? room.envidoDeclarationOrder[room.envidoDeclarationIndex] ?? null,
      bestScore: room.envidoWinningScore,
      bestSeat: room.envidoWinningSeat,
      sonBuenasSeat: room.envidoSonBuenasSeat,
      acceptedPoints: room.envidoAcceptedPoints,
      declarations: room.envidoDeclarations
    } : null,
    players: room.players.map(p => ({
      seat: p.seat,
      userId: p.userId,
      team: p.team,
      connected: p.connected,
      avatar: null
    })),
    round: round ? {
      currentTurnSeat: round.currentTurnSeat,
      currentTrickIndex: round.currentTrickIndex,
      trickWinners: round.trickWinners,
      trickWinnerSeats: round.trickWinnerSeats,
      myCards: round.getPlayerBySeat(mySeat.seat)?.cards || [],
      myEnvidoScore: calculateEnvido(getRoundCards(room, mySeat.seat)),
      cardCounts: round.players.map(p => ({ seat: p.seat, count: p.cards.length })),
      cardsPlayed: round.players.map(p => ({ seat: p.seat, cards: p.cardsPlayed })),
      envidoResolved: round.envidoResolved,
      florResolved: round.florResolved,
      isFinished: round.isFinished,
      winnerTeam: round.winnerTeam
    } : null,
    availableActions: availableActions(room, mySeat),
    logs: room.logs.slice(-120),
    teamChat: (room.teamChats[mySeat.team] || []).slice(-30).map(msg => ({
      id: msg.id,
      fromSeat: msg.fromSeat,
      fromUserId: msg.fromUserId,
      text: msg.text,
      at: msg.at,
      mine: msg.fromSeat === mySeat.seat
    }))
  };
}

function sendRoomState(io: Server, room: TeamRoom) {
  syncTeamTurnTimer(io, room);
  for (const player of room.players) {
    if (player.socketId && player.connected) {
      io.to(player.socketId).emit('team_state', buildState(room, player));
    }
  }
}

function scheduleReturnAllToTeamLobby(io: Server, room: TeamRoom) {
  if (room.finishLobbyTimer) return;
  room.finishLobbyTimer = setTimeout(() => {
    room.finishLobbyTimer = undefined;
    if (teamRooms.get(room.roomId) !== room || room.phase !== 'MATCH_OVER' || !room.settlementComplete) return;

    io.to(room.roomId).emit('team_match_return_to_lobby', {
      roomId: room.roomId,
      winnerTeam: room.matchWinnerTeam || null
    });

    teamRooms.delete(room.roomId);
    io.in(room.roomId).socketsLeave(room.roomId);
    broadcastTables(io);
  }, 1800);
}

async function settleTeamFinancials(io: Server, room: TeamRoom, winnerTeam: TeamId, reason: string) {
  if (room.settlementComplete || room.settlementInProgress) return;

  const payout = calculateTeamMatchPayout(room.betAmount);
  if (room.betAmount <= 0) {
    room.settlementComplete = true;
    room.settlementSummary = {
      winnerTeam,
      grossPot: 0,
      rakeAmount: 0,
      winnerPrizeTotal: 0,
      winnerPrizes: [0, 0],
      winnerUsernames: room.players.filter(p => p.team === winnerTeam).map(p => p.userId)
    };
    releaseTeamRoomPresence(room);
    sendRoomState(io, room);
    scheduleReturnAllToTeamLobby(io, room);
    return;
  }

  if (room.players.length !== 4) {
    roomLog(room, '⚠️ No se pudo liquidar la mesa: faltan jugadores.');
    io.to(room.roomId).emit('team_error', { message: 'La liquidación quedó protegida porque faltan jugadores en la mesa.' });
    return;
  }

  room.settlementInProgress = true;
  const winners = room.players.filter(p => p.team === winnerTeam).sort((a, b) => a.seat - b.seat);
  const losers = room.players.filter(p => p.team !== winnerTeam).sort((a, b) => a.seat - b.seat);

  const result = await settleTeamMatchOnce({
    roomId: room.roomId,
    winnerTeam,
    winnerUsernames: winners.map(p => p.userId),
    loserUsernames: losers.map(p => p.userId),
    entries: room.players.map(p => ({ username: p.userId, entryToken: p.entryToken })),
    betPerPlayer: room.betAmount,
    finishReason: reason
  });

  room.settlementInProgress = false;
  if (!result.success || !result.settlement) {
    roomLog(room, `⚠️ Liquidación 2v2 pendiente: ${result.message || 'error desconocido'}`);
    io.to(room.roomId).emit('team_error', {
      message: result.message || 'No se pudo liquidar la partida 2v2. El pago quedó protegido.'
    });
    sendRoomState(io, room);
    return;
  }

  const settlement = result.settlement;
  room.settlementComplete = true;
  room.settlementSummary = {
    winnerTeam,
    grossPot: settlement.grossPot,
    rakeAmount: settlement.rakeAmount,
    winnerPrizeTotal: settlement.winnerPrizeTotal,
    winnerPrizes: settlement.winnerPrizes,
    winnerUsernames: settlement.winnerUsernames
  };
  releaseTeamRoomPresence(room);
  const prizesText = settlement.winnerPrizes[0] === settlement.winnerPrizes[1]
    ? `${settlement.winnerPrizes[0]} fichas para cada ganador`
    : `${settlement.winnerPrizes[0]} y ${settlement.winnerPrizes[1]} fichas`;
  roomLog(room, `💰 Pozo ${settlement.grossPot} · Rake 7%: ${settlement.rakeAmount} · ${prizesText}.`);
  sendRoomState(io, room);
  scheduleReturnAllToTeamLobby(io, room);
}

function availableRooms() {
  return Array.from(teamRooms.values())
    .filter(room => room.phase === 'WAITING' && room.players.length < 4)
    .map(room => ({
      roomId: room.roomId,
      creatorId: room.creatorId,
      players: room.players.map(p => ({ seat: p.seat, userId: p.userId, team: p.team })),
      playerCount: room.players.length,
      targetPoints: room.targetPoints,
      withFlor: room.withFlor,
      betAmount: room.betAmount,
      payout: calculateTeamMatchPayout(room.betAmount)
    }));
}

function broadcastTables(io: Server) {
  io.emit('team_update_tables', availableRooms());
}

function resetBids(room: TeamRoom) {
  room.pendingCall = null;
  room.suspendedTruco = null;
  room.trucoStake = 1;
  room.trucoLastRaiserTeam = null;
  room.envidoChain = [];
  room.envidoDeclarationActive = false;
  room.envidoDeclarationOrder = [];
  room.envidoDeclarationIndex = 0;
  room.envidoAcceptedPoints = 0;
  room.envidoWinningSeat = null;
  room.envidoWinningScore = null;
  room.envidoSonBuenasSeat = null;
  room.envidoDeclarations = [];
  room.florChain = [];
}

function startRound(io: Server, room: TeamRoom) {
  if (room.players.length !== 4) return;
  if (room.transitionTimer) clearTimeout(room.transitionTimer);

  room.transitioning = false;
  resetBids(room);
  const ids = [0, 1, 2, 3].map(seat => getSeat(room, seat)!.userId);
  room.round = new TeamTrucoRound(ids, room.manoSeat, room.targetPoints, room.withFlor);
  roomLog(room, `🃏 Nueva mano. Mano: ${getSeat(room, room.manoSeat)?.userId}.`);
  roomLog(room, `➡️ Turno inicial: ${getSeat(room, room.round.currentTurnSeat)?.userId}.`);
  roomLog(room, `📊 Marcador: Equipo A ${room.scoreA} - ${room.scoreB} Equipo B.`);
  sendRoomState(io, room);
}

function finishMatchOrScheduleNext(io: Server, room: TeamRoom, winnerTeam: TeamId, points: number, reason: string) {
  if (!room.round || room.transitioning) return;

  room.round.isFinished = true;
  room.round.winnerTeam = winnerTeam;
  addScore(room, winnerTeam, Math.max(1, points));
  room.pendingCall = null;
  room.suspendedTruco = null;
  roomLog(room, `🏆 Equipo ${winnerTeam} gana ${Math.max(1, points)} punto(s) (${reason}).`);
  roomLog(room, `📊 Marcador: Equipo A ${room.scoreA} - ${room.scoreB} Equipo B.`);

  if (scoreFor(room, winnerTeam) >= room.targetPoints) {
    room.phase = 'MATCH_OVER';
    room.transitioning = false;
    room.matchWinnerTeam = winnerTeam;
    roomLog(room, `🎉 Equipo ${winnerTeam} ganó el partido ${room.scoreA} a ${room.scoreB}.`);
    sendRoomState(io, room);
    void settleTeamFinancials(io, room, winnerTeam, `SCORE_${reason}`);
    return;
  }

  room.transitioning = true;
  sendRoomState(io, room);
  room.manoSeat = (room.manoSeat + 1) % 4;
  room.transitionTimer = setTimeout(() => startRound(io, room), 1800);
}

function resumeSuspendedTruco(room: TeamRoom) {
  if (room.suspendedTruco && room.phase === 'PLAYING' && !room.transitioning) {
    room.pendingCall = room.suspendedTruco;
    room.suspendedTruco = null;
    roomLog(room, `↩️ Se retoma ${formatCall(room.pendingCall.callType)}.`);
  }
}

function emitRoomAudio(io: Server, room: TeamRoom, file: string) {
  io.to(room.roomId).emit('team_audio', { file });
}

function emitCallAudio(io: Server, room: TeamRoom, callType: string) {
  const audioByCall: Record<string, string> = {
    TRUCO: 'truco.mp3',
    RETRUCO: 'retruco.mp3',
    VALE_4: 'vale 4.mp3',
    ENVIDO: 'envido.mp3',
    REAL_ENVIDO: 'real envido.mp3',
    FALTA_ENVIDO: 'falta envido.mp3',
    FLOR: 'flor.mp3',
    CONTRAFLOR: 'contraflor.mp3',
    CONTRAFLOR_AL_JUEGO: 'contraflor al juego.mp3',
    QUIERO_TRUCO: 'quiero.mp3',
    QUIERO_ENVIDO: 'quiero.mp3',
    QUIERO_FLOR: 'quiero.mp3',
    NO_QUIERO_TRUCO: 'no quiero.mp3',
    NO_QUIERO_ENVIDO: 'no quiero.mp3',
    NO_QUIERO_FLOR: 'no quiero.mp3',
    ME_VOY_AL_MAZO: 'me voy al mazo.mp3',
    SON_BUENAS_ENVIDO: 'son buenas.mp3'
  };
  const file = audioByCall[callType];
  if (file) emitRoomAudio(io, room, file);
}

function startEnvidoDeclarations(io: Server, room: TeamRoom) {
  if (!room.round || !room.pendingCall || room.pendingCall.kind !== 'ENVIDO') return;

  const points = envidoPoints(room);
  const bestA = bestEnvidoForTeam(room, 'A');
  const bestB = bestEnvidoForTeam(room, 'B');
  const manoOrder = seatOrderFrom(room.manoSeat);
  const declarationOrder = [bestA.seat, bestB.seat]
    .sort((a, b) => manoOrder.indexOf(a) - manoOrder.indexOf(b));

  room.pendingCall = null;
  room.envidoDeclarationActive = true;
  room.envidoDeclarationOrder = declarationOrder;
  room.envidoDeclarationIndex = 0;
  room.envidoAcceptedPoints = points.accepted;
  room.envidoWinningSeat = null;
  room.envidoWinningScore = null;
  room.envidoSonBuenasSeat = null;
  room.envidoDeclarations = [];

  const firstSeat = declarationOrder[0];
  const secondSeat = declarationOrder[1];
  roomLog(room, `✅ Envido querido. Solo canta el mejor Envido de cada equipo.`);
  roomLog(room, `🪙 Equipo A: ${bestA.userId} (${bestA.score}) · Equipo B: ${bestB.userId} (${bestB.score}).`);
  roomLog(room, `🗣️ Orden por mano: primero ${getSeat(room, firstSeat)?.userId || `J${firstSeat + 1}`}, luego ${getSeat(room, secondSeat)?.userId || `J${secondSeat + 1}`}.`);
  sendRoomState(io, room);
}

function finishEnvidoDeclarations(io: Server, room: TeamRoom) {
  if (!room.round || room.envidoWinningSeat == null || room.envidoWinningScore == null) return;

  const winnerSeat = getSeat(room, room.envidoWinningSeat);
  if (!winnerSeat) return;
  const winnerTeam = winnerSeat.team;
  const points = Math.max(1, room.envidoAcceptedPoints);

  addScore(room, winnerTeam, points);
  room.round.envidoResolved = true;
  room.envidoDeclarationActive = false;
  room.envidoSonBuenasSeat = null;
  roomLog(room, `🪙 ${winnerSeat.userId} ganó el Envido con ${room.envidoWinningScore}. Equipo ${winnerTeam} +${points}.`);
  roomLog(room, `📊 Marcador: Equipo A ${room.scoreA} - ${room.scoreB} Equipo B.`);

  if (scoreFor(room, winnerTeam) >= room.targetPoints) {
    room.phase = 'MATCH_OVER';
    room.matchWinnerTeam = winnerTeam;
    roomLog(room, `🎉 Equipo ${winnerTeam} ganó el partido por tantos.`);
    sendRoomState(io, room);
    void settleTeamFinancials(io, room, winnerTeam, 'SCORE_ENVIDO');
    return;
  }

  resumeSuspendedTruco(room);
  sendRoomState(io, room);
}

function handleEnvidoDeclaration(io: Server, socket: Socket, room: TeamRoom, seat: TeamSeat, callType: string) {
  if (!room.round || !room.envidoDeclarationActive) return;

  const currentSeat = room.envidoDeclarationOrder[room.envidoDeclarationIndex];
  if (seat.seat !== currentSeat) {
    return socket.emit('team_error', { message: 'Todavía no es tu turno para cantar los puntos.' });
  }

  const score = calculateEnvido(getRoundCards(room, seat.seat));
  const best = room.envidoWinningScore;
  const canBeat = best == null || score > best;

  if (canBeat && callType !== 'CANTAR_ENVIDO') {
    return socket.emit('team_error', { message: `Tenés ${score}. Debés cantar tus puntos.` });
  }
  if (!canBeat && callType !== 'SON_BUENAS_ENVIDO') {
    return socket.emit('team_error', { message: `Ya cantaron ${best}. Corresponde Son buenas.` });
  }

  // Si el segundo mejor Envido no supera al primero, él mismo dice "Son buenas".
  if (callType === 'SON_BUENAS_ENVIDO') {
    room.envidoDeclarations.push({ seat: seat.seat, userId: seat.userId, score: null, sonBuenas: true });
    roomLog(room, `🤝 ${seat.userId}: SON BUENAS.`);
    emitCallAudio(io, room, 'SON_BUENAS_ENVIDO');
    return finishEnvidoDeclarations(io, room);
  }

  room.envidoWinningScore = score;
  room.envidoWinningSeat = seat.seat;
  room.envidoDeclarations.push({ seat: seat.seat, userId: seat.userId, score, sonBuenas: false });
  roomLog(room, `🗣️ ${seat.userId} cantó ${score} de Envido.`);
  if (score >= 1 && score <= 38) emitRoomAudio(io, room, `${score}.mp3`);

  if (room.envidoDeclarationIndex === 0) {
    room.envidoDeclarationIndex = 1;
    const nextSeat = room.envidoDeclarationOrder[1];
    roomLog(room, `➡️ Ahora responde ${getSeat(room, nextSeat)?.userId || `J${nextSeat + 1}`}, mejor Envido del otro equipo.`);
    return sendRoomState(io, room);
  }

  // Si el segundo jugador supera al primero, el Envido termina inmediatamente.
  // No se vuelve a pedir "Son buenas" al jugador que ya había cantado.
  roomLog(room, `✅ ${seat.userId} superó el canto anterior con ${score}. Se resuelve el Envido.`);
  return finishEnvidoDeclarations(io, room);
}

function resolveEnvido(io: Server, room: TeamRoom, accepted: boolean) {
  if (!room.round || !room.pendingCall || room.pendingCall.kind !== 'ENVIDO') return;
  const pending = room.pendingCall;
  const points = envidoPoints(room);

  if (accepted) {
    return startEnvidoDeclarations(io, room);
  }

  const winnerTeam = pending.callerTeam;
  addScore(room, winnerTeam, points.declined);
  room.round.envidoResolved = true;
  room.pendingCall = null;
  roomLog(room, `❌ Envido no querido. Equipo ${winnerTeam} +${points.declined}.`);
  roomLog(room, `📊 Marcador: Equipo A ${room.scoreA} - ${room.scoreB} Equipo B.`);

  if (scoreFor(room, winnerTeam) >= room.targetPoints) {
    room.phase = 'MATCH_OVER';
    room.matchWinnerTeam = winnerTeam;
    roomLog(room, `🎉 Equipo ${winnerTeam} ganó el partido por tantos.`);
    sendRoomState(io, room);
    void settleTeamFinancials(io, room, winnerTeam, 'SCORE_ENVIDO');
    return;
  }

  resumeSuspendedTruco(room);
  sendRoomState(io, room);
}

function resolveFlor(io: Server, room: TeamRoom, accepted: boolean) {
  if (!room.round || !room.pendingCall || room.pendingCall.kind !== 'FLOR') return;
  const pending = room.pendingCall;
  const points = florPoints(room, accepted);
  let winnerTeam: TeamId;
  let detail = '';

  if (!accepted) {
    winnerTeam = pending.callerTeam;
    detail = `no querida → Equipo ${winnerTeam} +${points}`;
  } else {
    const a = bestFlorForTeam(room, 'A');
    const b = bestFlorForTeam(room, 'B');
    if (!a || !b) {
      winnerTeam = a ? 'A' : 'B';
      detail = `única flor válida → Equipo ${winnerTeam} +${points}`;
    } else {
      winnerTeam = chooseByMano(room, a, b);
      detail = `${a.userId} ${a.score} / ${b.userId} ${b.score} → Equipo ${winnerTeam} +${points}`;
    }
  }

  addScore(room, winnerTeam, points);
  room.round.florResolved = true;
  room.round.envidoResolved = true;
  room.pendingCall = null;
  roomLog(room, `🌸 Flor ${detail}.`);

  if (scoreFor(room, winnerTeam) >= room.targetPoints) {
    room.phase = 'MATCH_OVER';
    room.matchWinnerTeam = winnerTeam;
    roomLog(room, `🎉 Equipo ${winnerTeam} ganó el partido por Flor.`);
    sendRoomState(io, room);
    void settleTeamFinancials(io, room, winnerTeam, 'SCORE_FLOR');
    return;
  }

  resumeSuspendedTruco(room);
  sendRoomState(io, room);
}

function startFlorCall(io: Server, room: TeamRoom, seat: TeamSeat) {
  if (!room.round || !seatHasFlor(room, seat.seat)) return;

  // La Flor puede interrumpir un Truco pendiente y anula cualquier Envido pendiente.
  // Si había Truco, se guarda para retomarlo cuando termine la Flor.
  if (room.pendingCall?.kind === 'TRUCO') {
    room.suspendedTruco = room.pendingCall;
    room.pendingCall = null;
  }
  if (room.pendingCall?.kind === 'ENVIDO') {
    room.pendingCall = null;
    room.envidoChain = [];
  }
  room.round.envidoResolved = true;
  room.florChain = ['FLOR'];

  if (!teamHasFlor(room, otherTeam(seat.team))) {
    room.round.florResolved = true;
    addScore(room, seat.team, 3);
    roomLog(room, `🌸 ${seat.userId} cantó Flor. Equipo ${seat.team} +3.`);
    emitCallAudio(io, room, 'FLOR');
    if (scoreFor(room, seat.team) >= room.targetPoints) {
      room.phase = 'MATCH_OVER';
      room.matchWinnerTeam = seat.team;
      roomLog(room, `🎉 Equipo ${seat.team} ganó el partido por Flor.`);
    }
    resumeSuspendedTruco(room);
    sendRoomState(io, room);
    if (room.phase === 'MATCH_OVER') void settleTeamFinancials(io, room, seat.team, 'SCORE_FLOR');
    return;
  }

  room.pendingCall = {
    kind: 'FLOR', callType: 'FLOR', callerSeat: seat.seat,
    callerTeam: seat.team, responderTeam: otherTeam(seat.team)
  };
  roomLog(room, `🌸 ${seat.userId} cantó FLOR.`);
  emitCallAudio(io, room, 'FLOR');
  sendRoomState(io, room);
}

function startEnvidoCall(io: Server, room: TeamRoom, seat: TeamSeat, callType: EnvidoCall) {
  if (!room.round) return;

  if (room.pendingCall?.kind === 'TRUCO') {
    room.suspendedTruco = room.pendingCall;
    room.pendingCall = null;
  }

  room.envidoChain.push(callType);
  room.pendingCall = {
    kind: 'ENVIDO', callType, callerSeat: seat.seat,
    callerTeam: seat.team, responderTeam: otherTeam(seat.team)
  };
  roomLog(room, `🗣️ ${seat.userId} cantó ${formatCall(callType)}.`);
  emitCallAudio(io, room, callType);
  sendRoomState(io, room);
}

function startTrucoCall(io: Server, room: TeamRoom, seat: TeamSeat, callType: TrucoCall) {
  const proposedStake = callType === 'TRUCO' ? 2 : callType === 'RETRUCO' ? 3 : 4;

  // Una subida como respuesta acepta implícitamente la anterior y vuelve a subir.
  if (room.pendingCall?.kind === 'TRUCO') {
    const previous = room.pendingCall;
    room.trucoStake = previous.proposedStake;
    room.trucoLastRaiserTeam = previous.callerTeam;
  }

  const previousStake = room.trucoStake;
  room.pendingCall = {
    kind: 'TRUCO', callType, callerSeat: seat.seat,
    callerTeam: seat.team, responderTeam: otherTeam(seat.team),
    proposedStake, previousStake
  };
  roomLog(room, `🔥 ${seat.userId} cantó ${formatCall(callType)}.`);
  emitCallAudio(io, room, callType);
  sendRoomState(io, room);
}

function handleCall(io: Server, socket: Socket, room: TeamRoom, seat: TeamSeat, callType: string) {
  if (!room.round) return;
  const allowed = availableActions(room, seat);
  if (!allowed.includes(callType)) {
    return socket.emit('team_error', { message: 'Esa acción no está habilitada en este momento.' });
  }

  if (callType === 'ME_VOY_AL_MAZO') {
    emitCallAudio(io, room, callType);

    // En 2 vs 2 no alcanza con mirar si ya se jugó alguna carta.
    // Si al irse al mazo el equipo rival todavía tenía un jugador que no había
    // jugado su primera carta, ese jugador conservaba la posibilidad de cantar
    // Envido. En ese caso se suma 1 punto de Envido no cantado al valor del Truco.
    const uncalledEnvidoPoint = opponentStillHadEnvidoOpportunity(room, seat.team) ? 1 : 0;
    const foldPoints = room.trucoStake + uncalledEnvidoPoint;

    return finishMatchOrScheduleNext(
      io,
      room,
      otherTeam(seat.team),
      foldPoints,
      `${seat.userId} se fue al mazo${uncalledEnvidoPoint ? ' con Envido todavía disponible para el equipo rival' : ''}`
    );
  }

  if (callType === 'CANTAR_ENVIDO' || callType === 'SON_BUENAS_ENVIDO') {
    return handleEnvidoDeclaration(io, socket, room, seat, callType);
  }

  if (callType === 'QUIERO_TRUCO' && room.pendingCall?.kind === 'TRUCO') {
    const pending = room.pendingCall;
    room.trucoStake = pending.proposedStake;
    room.trucoLastRaiserTeam = pending.callerTeam;
    room.round.trucoPointsAtStake = room.trucoStake;
    room.pendingCall = null;
    room.round.envidoResolved = true;
    room.round.florResolved = true;
    roomLog(room, `✅ Equipo ${seat.team} quiso ${formatCall(pending.callType)}. Vale ${room.trucoStake}.`);
    emitCallAudio(io, room, callType);
    return sendRoomState(io, room);
  }

  if (callType === 'NO_QUIERO_TRUCO' && room.pendingCall?.kind === 'TRUCO') {
    const pending = room.pendingCall;
    room.pendingCall = null;
    emitCallAudio(io, room, callType);
    return finishMatchOrScheduleNext(io, room, pending.callerTeam, pending.previousStake, `${formatCall(pending.callType)} no querido`);
  }

  if (callType === 'TRUCO' || callType === 'RETRUCO' || callType === 'VALE_4') {
    return startTrucoCall(io, room, seat, callType as TrucoCall);
  }

  if (callType === 'QUIERO_ENVIDO') {
    emitCallAudio(io, room, callType);
    return resolveEnvido(io, room, true);
  }
  if (callType === 'NO_QUIERO_ENVIDO') {
    emitCallAudio(io, room, callType);
    return resolveEnvido(io, room, false);
  }

  if (callType === 'ENVIDO' || callType === 'REAL_ENVIDO' || callType === 'FALTA_ENVIDO') {
    if (room.pendingCall?.kind === 'ENVIDO') {
      room.envidoChain.push(callType as EnvidoCall);
      room.pendingCall = {
        kind: 'ENVIDO', callType: callType as EnvidoCall, callerSeat: seat.seat,
        callerTeam: seat.team, responderTeam: otherTeam(seat.team)
      };
      roomLog(room, `🗣️ ${seat.userId} subió a ${formatCall(callType)}.`);
      emitCallAudio(io, room, callType);
      return sendRoomState(io, room);
    }
    return startEnvidoCall(io, room, seat, callType as EnvidoCall);
  }

  if (callType === 'FLOR') return startFlorCall(io, room, seat);
  if (callType === 'QUIERO_FLOR') {
    emitCallAudio(io, room, callType);
    return resolveFlor(io, room, true);
  }
  if (callType === 'NO_QUIERO_FLOR') {
    emitCallAudio(io, room, callType);
    return resolveFlor(io, room, false);
  }

  if ((callType === 'CONTRAFLOR' || callType === 'CONTRAFLOR_AL_JUEGO') && room.pendingCall?.kind === 'FLOR') {
    room.florChain.push(callType as FlorCall);
    room.pendingCall = {
      kind: 'FLOR', callType: callType as FlorCall, callerSeat: seat.seat,
      callerTeam: seat.team, responderTeam: otherTeam(seat.team)
    };
    roomLog(room, `🌸 ${seat.userId} cantó ${formatCall(callType)}.`);
    emitCallAudio(io, room, callType);
    return sendRoomState(io, room);
  }
}

export function setupTeamSocketEvents(io: Server) {
  io.on('connection', (socket: Socket) => {
    socket.on('team_request_tables', () => socket.emit('team_update_tables', availableRooms()));

    socket.on('team_create_room', async ({ userId, targetPoints, withFlor, betAmount }) => {
      const cleanUser = String(userId || '').trim();
      const userKey = cleanUser.toLowerCase();
      if (!cleanUser) return socket.emit('team_error', { message: 'Ingresá un usuario para crear la mesa.' });
      try {
        if (!(await userExistsFresh(cleanUser))) {
          socket.emit('team_session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
          return;
        }
      } catch {
        return socket.emit('team_error', { message: 'No se pudo validar tu cuenta. Intentá nuevamente.' });
      }
      if (pendingTeamCreations.has(userKey)) return socket.emit('team_error', { message: 'La mesa ya se está creando. Esperá un instante.' });

      const already = Array.from(teamRooms.values()).find(r => r.phase !== 'MATCH_OVER' && getSeatByUser(r, cleanUser));
      if (already) return socket.emit('team_error', { message: `Ya estás en la mesa ${already.roomId}.` });

      const activePresence = getActiveGamePresence(cleanUser);
      if (activePresence) {
        return socket.emit('team_error', {
          message: activePresence.mode === '1v1'
            ? 'Ya estás en una mesa 1 vs 1. Salí de esa mesa antes de crear una 2 vs 2.'
            : 'Ya estás participando en otra mesa 2 vs 2.'
        });
      }

      const bet = Math.max(0, Math.round(Number(betAmount) || 0));
      const roomId = makeRoomId();
      const entryToken = makeEntryToken();
      pendingTeamCreations.add(userKey);
      let claimed = false;
      let debitSucceeded = false;
      let roomStored = false;
      try {
        if (!claimActiveGame(cleanUser, '2v2', roomId)) {
          return socket.emit('team_error', { message: 'Ya estás participando en otra mesa.' });
        }
        claimed = true;

        const debit = await debitTeamRoomEntry(roomId, cleanUser, bet, entryToken);
        if (!debit.success) {
          releaseActiveGame(cleanUser, '2v2', roomId);
          claimed = false;
          return socket.emit('team_error', { message: debit.message || 'Saldo insuficiente para crear la mesa.' });
        }
        debitSucceeded = true;

        const room: TeamRoom = {
          roomId,
          creatorId: cleanUser,
          players: [{ seat: 0, userId: cleanUser, socketId: socket.id, connected: true, team: 'A', entryToken }],
          targetPoints: Number(targetPoints) === 30 ? 30 : 15,
          withFlor: withFlor === true || withFlor === 'true',
          betAmount: bet,
          settlementInProgress: false,
          settlementComplete: false,
          settlementSummary: null,
          matchWinnerTeam: null,
          turnTimerContext: null,
          disconnectDeadlines: {},
          scoreA: 0,
          scoreB: 0,
          manoSeat: 0,
          phase: 'WAITING',
          transitioning: false,
          pendingCall: null,
          suspendedTruco: null,
          trucoStake: 1,
          trucoLastRaiserTeam: null,
          envidoChain: [],
          envidoDeclarationActive: false,
          envidoDeclarationOrder: [],
          envidoDeclarationIndex: 0,
          envidoAcceptedPoints: 0,
          envidoWinningSeat: null,
          envidoWinningScore: null,
          envidoSonBuenasSeat: null,
          envidoDeclarations: [],
          florChain: [],
          logs: [],
          teamChats: { A: [], B: [] },
          createdAt: Date.now()
        };
        roomLog(room, bet > 0
          ? `🪑 ${cleanUser} creó la mesa 2 vs 2 por ${bet} fichas por jugador.`
          : `🪑 ${cleanUser} creó la mesa 2 vs 2 gratis.`);
        teamRooms.set(roomId, room);
        roomStored = true;
        socket.join(roomId);
        socket.emit('team_room_joined', { roomId, balance: debit.balance });
        sendRoomState(io, room);
        broadcastTables(io);
      } catch (err) {
        if (debitSucceeded && !roomStored) {
          try { await refundTeamRoomEntry(roomId, cleanUser, bet, entryToken); } catch {}
        }
        if (claimed && !roomStored) releaseActiveGame(cleanUser, '2v2', roomId);
        console.error('Error creando mesa 2v2:', err);
        socket.emit('team_error', { message: 'No se pudo crear la mesa 2v2.' });
      } finally {
        pendingTeamCreations.delete(userKey);
      }
    });

    socket.on('team_join_room', async ({ roomId, userId }) => {
      const room = teamRooms.get(String(roomId || ''));
      const cleanUser = String(userId || '').trim();
      if (!room || room.phase !== 'WAITING') return socket.emit('team_error', { message: 'La mesa ya no está disponible.' });
      if (!cleanUser) return socket.emit('team_error', { message: 'Usuario inválido.' });
      try {
        if (!(await userExistsFresh(cleanUser))) {
          socket.emit('team_session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
          return;
        }
      } catch {
        return socket.emit('team_error', { message: 'No se pudo validar tu cuenta. Intentá nuevamente.' });
      }
      if (room.players.length >= 4) return socket.emit('team_error', { message: 'La mesa ya está completa.' });
      if (getSeatByUser(room, cleanUser)) return socket.emit('team_error', { message: 'Ese usuario ya está sentado en la mesa.' });

      const elsewhere = Array.from(teamRooms.values()).find(r => r.roomId !== room.roomId && r.phase !== 'MATCH_OVER' && getSeatByUser(r, cleanUser));
      if (elsewhere) return socket.emit('team_error', { message: `Ese usuario ya está en ${elsewhere.roomId}.` });

      const activePresence = getActiveGamePresence(cleanUser);
      if (activePresence) {
        return socket.emit('team_error', {
          message: activePresence.mode === '1v1'
            ? 'Ya estás en una mesa 1 vs 1. Salí de esa mesa antes de entrar a una 2 vs 2.'
            : 'Ya estás participando en otra mesa 2 vs 2.'
        });
      }

      const joinKey = `${room.roomId}:${cleanUser.toLowerCase()}`;
      if (pendingTeamJoins.has(joinKey)) return socket.emit('team_error', { message: 'Ya se está procesando tu ingreso a esta mesa.' });
      pendingTeamJoins.add(joinKey);
      const entryToken = makeEntryToken();
      let claimed = false;
      let debitSucceeded = false;
      let seated = false;

      try {
        if (!claimActiveGame(cleanUser, '2v2', room.roomId)) {
          return socket.emit('team_error', { message: 'Ya estás participando en otra mesa.' });
        }
        claimed = true;

        const debit = await debitTeamRoomEntry(room.roomId, cleanUser, room.betAmount, entryToken);
        if (!debit.success) {
          releaseActiveGame(cleanUser, '2v2', room.roomId);
          claimed = false;
          return socket.emit('team_error', { message: debit.message || `Necesitás ${room.betAmount} fichas para entrar.` });
        }
        debitSucceeded = true;

        // Revalidamos después del débito por si otro jugador completó o cerró la mesa.
        const liveRoom = teamRooms.get(room.roomId);
        if (liveRoom !== room || room.phase !== 'WAITING' || room.players.length >= 4 || getSeatByUser(room, cleanUser)) {
          await refundTeamRoomEntry(room.roomId, cleanUser, room.betAmount, entryToken);
          releaseActiveGame(cleanUser, '2v2', room.roomId);
          claimed = false;
          return socket.emit('team_error', { message: 'La mesa dejó de estar disponible. Se devolvieron tus fichas.' });
        }

        const seatNumber = room.players.length;
        const player: TeamSeat = {
          seat: seatNumber,
          userId: cleanUser,
          socketId: socket.id,
          connected: true,
          team: teamForSeat(seatNumber),
          entryToken
        };
        room.players.push(player);
        seated = true;
        roomLog(room, `👤 ${cleanUser} se sentó en J${seatNumber + 1} · Equipo ${player.team}${room.betAmount > 0 ? ` · entrada ${room.betAmount} fichas` : ''}.`);
        socket.join(room.roomId);
        socket.emit('team_room_joined', { roomId: room.roomId, balance: debit.balance });

        if (room.players.length === 4) {
          room.phase = 'PLAYING';
          const payout = calculateTeamMatchPayout(room.betAmount);
          roomLog(room, room.betAmount > 0
            ? `🎮 Mesa completa. Pozo ${payout.grossPot} fichas · rake 7% ${payout.rakeAmount} · premio equipo ${payout.winnerPrizeTotal}.`
            : '🎮 Mesa completa. Comienza el partido 2 vs 2 gratis.');
          startRound(io, room);
        } else {
          sendRoomState(io, room);
        }
        broadcastTables(io);
      } catch (err) {
        if (debitSucceeded && !seated) {
          try { await refundTeamRoomEntry(room.roomId, cleanUser, room.betAmount, entryToken); } catch {}
        }
        if (claimed && !seated) releaseActiveGame(cleanUser, '2v2', room.roomId);
        console.error('Error entrando a mesa 2v2:', err);
        socket.emit('team_error', { message: 'No se pudo ingresar a la mesa 2v2.' });
      } finally {
        pendingTeamJoins.delete(joinKey);
      }
    });

    socket.on('team_leave_waiting_room', async ({ roomId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room || room.phase !== 'WAITING') return;
      const seat = getSeatBySocket(room, socket.id);
      if (!seat) return;

      const refund = await refundTeamRoomEntry(room.roomId, seat.userId, room.betAmount, seat.entryToken);
      if (!refund.success) {
        return socket.emit('team_error', { message: refund.message || 'No se pudo devolver la entrada. Seguís sentado para proteger tus fichas.' });
      }

      room.players = room.players.filter(p => p.socketId !== socket.id);
      releaseActiveGame(seat.userId, '2v2', room.roomId);
      room.players.forEach((p, index) => {
        p.seat = index;
        p.team = teamForSeat(index);
      });
      socket.leave(room.roomId);
      socket.emit('team_left_waiting_room', { roomId: room.roomId, balance: refund.balance });
      if (!room.players.length) teamRooms.delete(room.roomId);
      else {
        room.creatorId = room.players[0].userId;
        roomLog(room, `🚪 ${seat.userId} salió de la mesa${room.betAmount > 0 ? ' y recuperó su entrada' : ''}.`);
        sendRoomState(io, room);
      }
      broadcastTables(io);
    });

    socket.on('team_check_active_room', async ({ userId }) => {
      const cleanUser = String(userId || '').trim();
      if (!cleanUser) return;
      try {
        if (!(await userExistsFresh(cleanUser))) {
          socket.emit('team_session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
          return;
        }
      } catch { return; }
      const room = Array.from(teamRooms.values()).find(r => r.phase !== 'MATCH_OVER' && getSeatByUser(r, cleanUser));
      if (room) socket.emit('team_active_room_found', { roomId: room.roomId });
    });

    socket.on('team_reconnect_room', async ({ roomId, userId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room) return socket.emit('team_reconnect_failed');
      const reconnectUser = String(userId || '').trim();
      try {
        if (!(await userExistsFresh(reconnectUser))) {
          socket.emit('team_session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
          return;
        }
      } catch { return socket.emit('team_error', { message: 'No se pudo validar tu cuenta. Intentá nuevamente.' }); }
      const seat = getSeatByUser(room, reconnectUser);
      if (!seat) return socket.emit('team_reconnect_failed');

      restoreTeamSeatConnection(io, socket, room, seat);
      socket.emit('team_room_joined', { roomId: room.roomId });
      sendRoomState(io, room);
      if (room.phase === 'MATCH_OVER' && room.betAmount > 0 && !room.settlementComplete) {
        const winnerTeam: TeamId = room.matchWinnerTeam || (room.scoreA >= room.targetPoints ? 'A' : 'B');
        void settleTeamFinancials(io, room, winnerTeam, 'SCORE_RETRY');
      }
    });

    // Resincronización liviana al volver desde otra pestaña/app sin tocar fichas,
    // turnos ni lógica de juego. También re-vincula el socket si Socket.IO cambió su id.
    socket.on('team_request_room_state', async ({ roomId, userId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room) return socket.emit('team_reconnect_failed');
      const stateUser = String(userId || '').trim();
      try {
        if (!(await userExistsFresh(stateUser))) {
          socket.emit('team_session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
          return;
        }
      } catch { return; }
      const seat = getSeatByUser(room, stateUser);
      if (!seat) return socket.emit('team_reconnect_failed');

      restoreTeamSeatConnection(io, socket, room, seat);
      sendRoomState(io, room);
    });

    socket.on('team_play_card', ({ roomId, cardId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room || !room.round || room.phase !== 'PLAYING' || room.transitioning) return;
      const seat = getSeatBySocket(room, socket.id);
      if (!seat) return socket.emit('team_error', { message: 'No pertenecés a esta mesa.' });
      if (room.pendingCall) return socket.emit('team_error', { message: 'Primero hay que responder al canto pendiente.' });
      if (!availableActions(room, seat).includes('PLAY_CARD')) return socket.emit('team_error', { message: 'No es tu turno.' });

      const result = room.round.playCard(seat.seat, String(cardId || ''));
      if (!result.success) return socket.emit('team_error', { message: result.message || 'No se pudo jugar la carta.' });

      roomLog(room, `🃏 ${seat.userId} jugó ${String(cardId).replace('_', ' ')}.`);
      if (result.isTrickOver) {
        const label = result.trickWinnerTeam === 'PARDA'
          ? 'Parda'
          : `Equipo ${result.trickWinnerTeam}`;
        roomLog(room, `✋ Baza: ${label}.`);
      }

      if (result.roundOver && result.winnerTeam) {
        return finishMatchOrScheduleNext(io, room, result.winnerTeam, room.trucoStake, 'bazas');
      }

      const nextSeat = room.round.currentTurnSeat;
      const nextPlayer = getSeat(room, nextSeat);
      if (nextPlayer) {
        roomLog(room, result.isTrickOver
          ? `➡️ Nueva baza. Sale ${nextPlayer.userId}.`
          : `➡️ Turno de ${nextPlayer.userId}.`);
      }
      sendRoomState(io, room);
    });

    socket.on('team_send_call', ({ roomId, callType }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room || room.phase !== 'PLAYING' || room.transitioning) return;
      const seat = getSeatBySocket(room, socket.id);
      if (!seat) return socket.emit('team_error', { message: 'No pertenecés a esta mesa.' });
      handleCall(io, socket, room, seat, String(callType || ''));
    });

    socket.on('team_restart_match', ({ roomId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room || room.phase !== 'MATCH_OVER') return;
      if (room.finishLobbyTimer) {
        clearTimeout(room.finishLobbyTimer);
        room.finishLobbyTimer = undefined;
      }
      const seat = getSeatBySocket(room, socket.id);
      if (!seat || seat.seat !== 0) return socket.emit('team_error', { message: 'Solo J1 puede iniciar la revancha.' });
      if (room.betAmount > 0) return socket.emit('team_error', { message: 'Para una revancha con fichas deben crear una mesa nueva, así se debitan nuevamente las 4 entradas.' });

      const reclaimed: TeamSeat[] = [];
      for (const player of room.players) {
        if (!claimActiveGame(player.userId, '2v2', room.roomId)) {
          for (const claimed of reclaimed) releaseActiveGame(claimed.userId, '2v2', room.roomId);
          return socket.emit('team_error', {
            message: `${player.userId} ya está participando en otra mesa. No se puede iniciar la revancha.`
          });
        }
        reclaimed.push(player);
      }

      room.settlementInProgress = false;
      room.settlementComplete = false;
      room.settlementSummary = null;
      room.matchWinnerTeam = null;
      clearTeamTurnTimer(room);
      clearTeamDisconnectTimer(room);
      room.players.forEach(player => { player.connected = !!player.socketId; });
      room.scoreA = 0;
      room.scoreB = 0;
      room.manoSeat = 0;
      room.phase = 'PLAYING';
      roomLog(room, '🔁 Revancha iniciada.');
      startRound(io, room);
      broadcastTables(io);
    });

    socket.on('team_abandon_match', ({ roomId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room || room.phase !== 'PLAYING') return;
      const seat = getSeatBySocket(room, socket.id);
      if (!seat) return socket.emit('team_error', { message: 'No pertenecés a esta mesa.' });
      finishTeamMatchByForfeit(io, room, seat, 'ABANDON');
    });

    socket.on('team_show_cards_to_teammate', ({ roomId }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room || !room.round) return socket.emit('team_error', { message: 'No hay una mano activa para mostrar.' });
      const seat = getSeatBySocket(room, socket.id);
      if (!seat) return socket.emit('team_error', { message: 'No pertenecés a esta mesa.' });

      const teammate = room.players.find(p => p.team === seat.team && p.seat !== seat.seat);
      if (!teammate?.socketId || !teammate.connected) {
        return socket.emit('team_error', { message: 'Tu compañero no está conectado.' });
      }

      const cards = room.round.getPlayerBySeat(seat.seat)?.cards || [];
      if (!cards.length) return socket.emit('team_error', { message: 'Ya no tenés cartas en la mano para mostrar.' });

      io.to(teammate.socketId).emit('team_teammate_cards_reveal', {
        fromSeat: seat.seat,
        fromUserId: seat.userId,
        cards,
        durationMs: 3000
      });
      socket.emit('team_teammate_cards_sent', { toUserId: teammate.userId, durationMs: 3000 });
      sendRoomState(io, room);
    });

    socket.on('team_send_private_chat', ({ roomId, text }) => {
      const room = teamRooms.get(String(roomId || ''));
      if (!room) return;
      const seat = getSeatBySocket(room, socket.id);
      if (!seat) return socket.emit('team_error', { message: 'No pertenecés a esta mesa.' });

      const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
      if (!cleanText) return;
      if (cleanText.length > 160) return socket.emit('team_error', { message: 'El mensaje es demasiado largo.' });

      pushTeamChat(room, seat.team, seat.seat, seat.userId, cleanText);
      sendRoomState(io, room);
    });

    socket.on('disconnect', () => {
      for (const room of teamRooms.values()) {
        const seat = getSeatBySocket(room, socket.id);
        if (!seat) continue;

        // Si el socket ya fue reemplazado por una reconexión más nueva, no marcamos
        // al jugador como desconectado por el cierre del socket viejo.
        if (seat.socketId !== socket.id) continue;
        seat.connected = false;
        seat.socketId = undefined;

        if (room.phase === 'PLAYING') {
          startTeamDisconnectGrace(io, room, seat);
        } else {
          roomLog(room, `📡 ${seat.userId} se desconectó.`);
        }
        sendRoomState(io, room);
        break;
      }
    });
  });
}
