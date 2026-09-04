// src/sockets/gameSocket.ts
import { Server, Socket } from 'socket.io';
import crypto from 'crypto';
import { TrucoRound } from '../game/trucoGame';
import { getEnvidoDetails, hasFlor, calculateFlor, Card } from '../game/trucoEngine';
import { 
  modifyUserChips, 
  getUserChips, 
  getUserAvatar,
  recordTransaction 
} from '../auth/userService';

interface EnvidoWinnerRecord {
  winnerId: string;
  score: number;
  cards: Card[];
  pointsAwarded: number;
}

interface ActiveRoom {
  roomId: string;
  creatorId: string;
  creatorSocketId?: string;
  guestId?: string;
  guestSocketId?: string;
  betAmount: number;
  targetPoints: number;
  withFlor: boolean;
  scoreP1: number;
  scoreP2: number;
  gameRound?: TrucoRound;
  manoId: string;
  
  waitingTimeout?: NodeJS.Timeout;
  
  envidoChain: string[];
  envidoPendingCaller: string | null;
  envidoWinnerRecord?: EnvidoWinnerRecord | null;

  florChain: string[];
  florPendingCaller: string | null;

  turnInterval?: NodeJS.Timeout;
  disconnectInterval?: NodeJS.Timeout;
  disconnectedUser?: string | null;

  isDeclaringEnvido: boolean;
  isFlorDeclaration?: boolean;
  envidoDeclarer: string | null;
  highestEnvidoScore: number;
  highestEnvidoUser: string | null;

  trucoLevel: number;
  trucoOwner: string | null;

  pendingTrucoAfterEnvido?: {
    callerId: string;
    responderId: string;
    trucoPointsAtStake: number;
    callType: string;
  } | null;
}

const rooms = new Map<string, ActiveRoom>();

export function setupSocketEvents(io: Server) {

  function getAvailableRooms() {
    return Array.from(rooms.values())
      .filter(r => !r.guestId)
      .map(r => ({
        roomId: r.roomId,
        creatorId: r.creatorId,
        creatorAvatar: getUserAvatar(r.creatorId),
        betAmount: r.betAmount,
        targetPoints: r.targetPoints,
        withFlor: r.withFlor
      }));
  }

  function broadcastTables() {
    io.emit('update_tables', getAvailableRooms());
  }

  function getScoreMap(room: ActiveRoom) {
    const map: { [userId: string]: number } = { [room.creatorId]: room.scoreP1 };
    if (room.guestId) map[room.guestId] = room.scoreP2;
    return map;
  }

  function clearTurnTimer(room: ActiveRoom) {
    if (room.turnInterval) {
      clearInterval(room.turnInterval);
      room.turnInterval = undefined;
    }
  }

  function clearDisconnectTimer(room: ActiveRoom) {
    if (room.disconnectInterval) {
      clearInterval(room.disconnectInterval);
      room.disconnectInterval = undefined;
    }
    room.disconnectedUser = null;
  }

  function getAuthenticatedUserId(room: ActiveRoom, socketId: string): string | null {
    if (room.creatorSocketId === socketId) return room.creatorId;
    if (room.guestSocketId === socketId) return room.guestId || null;
    return null;
  }

  function checkMatchEnd(room: ActiveRoom): boolean {
    // NUEVO CANDADO: Si la mesa ya fue borrada del mapa, evitamos pagar dos veces.
    if (!rooms.has(room.roomId)) return true;
    if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
      clearTurnTimer(room);
      clearDisconnectTimer(room);
      const matchWinner = room.scoreP1 >= room.targetPoints ? room.creatorId : room.guestId!;
      const grossPot = room.betAmount > 0 ? room.betAmount * 2 : 0;
      const netPot = grossPot * 0.93;
      const rake = grossPot * 0.07;

      if (netPot > 0) {
        const matchLoser = matchWinner.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId! : room.creatorId;
        modifyUserChips(matchWinner, netPot);
        const bWinner = getUserChips(matchWinner);
        const bLoser = getUserChips(matchLoser);
        const detalle = `Fin normal. Ganó: ${matchWinner} (Saldo: $${bWinner}). Perdió: ${matchLoser} (Saldo: $${bLoser}). Premio entregado: $${netPot} (Comisión 7%: $${rake}). Mesa: ${room.roomId}`;
        recordTransaction('COMMISSION_RAKE', matchWinner, rake, detalle);
      }

      io.to(room.roomId).emit('match_finished', {
        winnerId: matchWinner,
        scores: getScoreMap(room),
        pot: netPot,
        winnerBalance: getUserChips(matchWinner)
      });
      rooms.delete(room.roomId);
      broadcastTables();
      return true;
    }
    return false;
  }

  function startTurnTimer(room: ActiveRoom, seconds: number = 30) {
    clearTurnTimer(room);
    if (room.disconnectedUser) return;

    let timeLeft = seconds;
    io.to(room.roomId).emit('timer_tick', { secondsLeft: timeLeft });

    room.turnInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft > 0) {
        io.to(room.roomId).emit('timer_tick', { secondsLeft: timeLeft });
      } else {
        io.to(room.roomId).emit('timer_tick', { secondsLeft: 0 });
        clearTurnTimer(room);
        handleTimeout(room);
      }
    }, 1000);
  }

  function handleTimeout(room: ActiveRoom) {
    if (!room.gameRound || room.disconnectedUser) return;

    if (room.isDeclaringEnvido && room.envidoDeclarer) {
      const activeUser = room.envidoDeclarer;
      const hand = activeUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
      const allCards = hand.cards.concat(hand.cardsPlayed.filter(Boolean) as Card[]);
      
      let score = 0;
      if (room.isFlorDeclaration) {
        score = calculateFlor(allCards);
      } else {
        score = getEnvidoDetails(allCards).score;
      }

      if (room.highestEnvidoScore === 0) {
        executeDeclareEnvido(room, activeUser, score);
      } else {
        if (score > room.highestEnvidoScore) {
          executeDeclareEnvido(room, activeUser, score);
        } else {
          executeSonBuenas(room, activeUser);
        }
      }
      return;
    }

    if (room.gameRound.awaitingResponseFrom) {
      const responderId = room.gameRound.awaitingResponseFrom;
      if (room.envidoPendingCaller) {
        resolveEnvidoDeclined(room, responderId);
      } else if (room.florPendingCaller) {
        resolveFlorDeclined(room, responderId);
      } else {
        resolveTrucoFold(room, responderId, 'NO_QUIERO_TRUCO');
      }
      return;
    }

    const activePlayerId = room.gameRound.currentTurn;
    const playerHand = activePlayerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
    if (playerHand.cards.length > 0) {
      const autoCard = playerHand.cards[0];
      executePlayCard(room, activePlayerId, autoCard.id);
    }
  }

  function startDisconnectGracePeriod(room: ActiveRoom, disconnectedUser: string) {
    clearTurnTimer(room);
    clearDisconnectTimer(room);

    room.disconnectedUser = disconnectedUser;
    let graceLeft = 45;

    io.to(room.roomId).emit('player_disconnected_grace', {
      disconnectedUser,
      secondsLeft: graceLeft
    });

    room.disconnectInterval = setInterval(() => {
      graceLeft--;
      if (graceLeft > 0) {
        io.to(room.roomId).emit('disconnect_timer_tick', { secondsLeft: graceLeft });
      } else {
        clearDisconnectTimer(room);
        // NUEVO CANDADO: Evita doble pago si la mesa ya cerró por otro motivo
        if (!rooms.has(room.roomId)) return;

        const isP1 = room.creatorId.toLowerCase() === disconnectedUser.toLowerCase();
        const winnerId = isP1 ? room.guestId! : room.creatorId;
        const grossPot = room.betAmount > 0 ? room.betAmount * 2 : 0;
        const netPot = grossPot * 0.93;
        const rake = grossPot * 0.07;

        if (netPot > 0) {
          const loserId = disconnectedUser;
          modifyUserChips(winnerId, netPot);
          const bWinner = getUserChips(winnerId);
          const bLoser = getUserChips(loserId);
          const detalle = `Victoria x Desconexión. Ganó: ${winnerId} (Saldo: $${bWinner}). Perdió: ${loserId} (Saldo: $${bLoser}). Premio entregado: $${netPot} (Comisión 7%: $${rake}). Mesa: ${room.roomId}`;
          recordTransaction('COMMISSION_RAKE', winnerId, rake, detalle);
        }

        io.to(room.roomId).emit('player_surrendered', {
          surrenderedUser: disconnectedUser,
          winnerId,
          pot: netPot,
          scores: getScoreMap(room),
          winnerBalance: getUserChips(winnerId),
          reason: 'DISCONNECT_TIMEOUT'
        });

        rooms.delete(room.roomId);
        broadcastTables();
      }
    }, 1000);
  }

  function dealAutoHand(room: ActiveRoom) {
    if (!room.guestId || room.disconnectedUser) return;
    clearTurnTimer(room);

    const round = new TrucoRound(
      room.creatorId, room.guestId, room.manoId, room.targetPoints, room.withFlor
    );
    room.gameRound = round;
    room.gameRound.envidoResolved = false;
    room.gameRound.florResolved = false;
    room.envidoChain = [];
    room.florChain = [];
    room.envidoPendingCaller = null;
    room.florPendingCaller = null;
    room.envidoWinnerRecord = null;
    room.isDeclaringEnvido = false;
    room.isFlorDeclaration = false;
    room.envidoDeclarer = null;
    room.highestEnvidoScore = 0;
    room.highestEnvidoUser = null;
    room.trucoLevel = 1;
    room.trucoOwner = null;
    room.pendingTrucoAfterEnvido = null;

    io.to(room.roomId).emit('hand_started', {
      manoId: room.manoId,
      currentTurn: round.currentTurn,
      scores: getScoreMap(room),
      withFlor: room.withFlor,
      targetPoints: room.targetPoints
    });

    if (room.creatorSocketId) {
      io.to(room.creatorSocketId).emit('cards_dealt', {
        p1Id: room.creatorId,
        p1Cards: round.p1.cards,
        p2Id: room.guestId,
        p2Cards: [],
        withFlor: room.withFlor
      });
    }

    if (room.guestSocketId) {
      io.to(room.guestSocketId).emit('cards_dealt', {
        p1Id: room.creatorId,
        p1Cards: [],
        p2Id: room.guestId,
        p2Cards: round.p2.cards,
        withFlor: room.withFlor
      });
    }

    startTurnTimer(room, 30);
  }

  function calculateEnvidoPoints(chain: string[], room?: ActiveRoom): { acceptedPts: number; declinedPts: number } {
    if (!chain || chain.length === 0) return { acceptedPts: 0, declinedPts: 1 };

    const getCallValue = (call: string): number => {
      if (call === 'ENVIDO' || call === 'ENVIDO_ENVIDO') return 2;
      if (call === 'REAL_ENVIDO') return 3;
      return 0;
    };

    const lastCall = chain[chain.length - 1];

    let declined = 1;
    if (chain.length > 1) {
      declined = 0;
      for (let i = 0; i < chain.length - 1; i++) {
        declined += getCallValue(chain[i]);
      }
      if (declined === 0) declined = 1;
    }

    let accepted = 0;
    if (lastCall === 'FALTA_ENVIDO') {
      if (room) {
        const highestScore = Math.max(room.scoreP1, room.scoreP2);
        accepted = Math.max(1, room.targetPoints - highestScore);
      } else {
        accepted = 15;
      }
    } else {
      for (const call of chain) {
        accepted += getCallValue(call);
      }
    }

    return { acceptedPts: accepted, declinedPts: declined };
  }

  function startEnvidoDeclarationPhase(room: ActiveRoom, isFlor: boolean = false) {
    clearTurnTimer(room);
    room.isDeclaringEnvido = true;
    room.isFlorDeclaration = isFlor;
    room.envidoDeclarer = room.manoId;
    room.highestEnvidoScore = 0;
    room.highestEnvidoUser = null;

    io.to(room.roomId).emit('start_envido_declaration', {
      firstDeclarer: room.manoId,
      chain: isFlor ? room.florChain : room.envidoChain,
      isFlor
    });
    startTurnTimer(room, 30);
  }

  function executeDeclareEnvido(room: ActiveRoom, userId: string, declaredPoints: number) {
    // FLUJO ESTRICTO: Si no pasó por el "Quiero" (isDeclaringEnvido es falso), bloqueamos y exigimos la aceptación previa.
    if (!room.gameRound || !room.isDeclaringEnvido) return;
    if (room.envidoDeclarer && room.envidoDeclarer.toLowerCase() !== userId.toLowerCase()) return;

    if (room.highestEnvidoScore === 0) {
      room.highestEnvidoScore = declaredPoints;
      room.highestEnvidoUser = userId;
      const rivalId = userId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId! : room.creatorId;
      room.envidoDeclarer = rivalId;

      io.to(room.roomId).emit('envido_points_announced', {
        userId, points: declaredPoints, nextDeclarer: rivalId,
        highestScore: declaredPoints, highestUser: userId, isFinal: false,
      });
      startTurnTimer(room, 30);
    } else {
      io.to(room.roomId).emit('envido_points_announced', {
        userId, points: declaredPoints, nextDeclarer: null,
        highestScore: declaredPoints, highestUser: userId, isFinal: true,
      });
      finalizeEnvido(room, userId);
    }
  }

  function executeSonBuenas(room: ActiveRoom, userId: string) {
    if (!room.gameRound || !room.isDeclaringEnvido || (room.envidoDeclarer && room.envidoDeclarer.toLowerCase() !== userId.toLowerCase())) return;
    const winnerId = room.highestEnvidoUser!;
    io.to(room.roomId).emit('son_buenas_said', { userId, winnerId });
    finalizeEnvido(room, winnerId);
  }

  function checkAndResumePendingTruco(room: ActiveRoom): boolean {
    if (room.pendingTrucoAfterEnvido) {
      const pending = room.pendingTrucoAfterEnvido;
      room.pendingTrucoAfterEnvido = null;
      room.gameRound!.trucoPointsAtStake = pending.trucoPointsAtStake;
      room.gameRound!.awaitingResponseFrom = pending.responderId;

      io.to(room.roomId).emit('call_received', {
        userId: pending.callerId,
        callType: pending.callType,
        category: 'TRUCO',
        awaitingResponseFrom: pending.responderId,
        canCallEnvido: false,
        isResumedTruco: true
      });

      startTurnTimer(room, 30);
      return true;
    }
    return false;
  }

  function finalizeEnvido(room: ActiveRoom, winnerId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    room.isDeclaringEnvido = false;
    room.envidoDeclarer = null;
    room.gameRound.envidoResolved = true;
    room.gameRound.awaitingResponseFrom = null;

    const isFlor = room.isFlorDeclaration;
    
    let pts = 0;
    let finalScore = 0;
    let winnerCards: Card[] = [];

    const winnerHand = winnerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
    const allCards = winnerHand.cards.concat(winnerHand.cardsPlayed.filter(Boolean) as Card[]);

    if (isFlor) {
      room.gameRound.florResolved = true;
      room.florPendingCaller = null;
      pts = room.gameRound.calculateFlorPoints(room.florChain, true, room.scoreP1, room.scoreP2);
      finalScore = calculateFlor(allCards);
      winnerCards = allCards;
    } else {
      room.envidoPendingCaller = null;
      const { acceptedPts } = calculateEnvidoPoints(room.envidoChain, room);
      pts = acceptedPts;
      const details = getEnvidoDetails(allCards);
      finalScore = details.score;
      winnerCards = details.envidoCards;
    }

    if (winnerId.toLowerCase() === room.creatorId.toLowerCase()) room.scoreP1 += pts;
    else room.scoreP2 += pts;

    room.envidoWinnerRecord = { winnerId, score: finalScore, cards: winnerCards, pointsAwarded: pts };

    if (isFlor) {
      io.to(room.roomId).emit('flor_declared', {
        winnerId, pointsAwarded: pts, scores: getScoreMap(room),
        score: finalScore, cards: winnerCards,
        trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
        currentTurn: room.gameRound.currentTurn
      });
    } else {
      io.to(room.roomId).emit('envido_resolved', {
        winnerId, pointsAwarded: pts, scores: getScoreMap(room),
        declined: false, trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
        currentTurn: room.gameRound.currentTurn
      });
    }

    if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
      io.to(room.roomId).emit('show_envido_winner', {
        winnerId: room.envidoWinnerRecord.winnerId, score: room.envidoWinnerRecord.score,
        cards: room.envidoWinnerRecord.cards, durationMs: 3500,
      });
      setTimeout(() => { checkMatchEnd(room); }, 3500);
      return;
    }

    if (checkAndResumePendingTruco(room)) return;
    startTurnTimer(room, 30);
  }

  function resolveEnvidoDeclined(room: ActiveRoom, answeringUserId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    room.gameRound.envidoResolved = true;
    room.gameRound.awaitingResponseFrom = null;
    const rivalId = answeringUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId! : room.creatorId;
    const callerId = room.envidoPendingCaller || rivalId;
    room.envidoPendingCaller = null;

    const { declinedPts } = calculateEnvidoPoints(room.envidoChain, room);

    if (callerId.toLowerCase() === room.creatorId.toLowerCase()) room.scoreP1 += declinedPts;
    else room.scoreP2 += declinedPts;

    io.to(room.roomId).emit('envido_resolved', {
      winnerId: callerId, pointsAwarded: declinedPts, scores: getScoreMap(room),
      declined: true, trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
      currentTurn: room.gameRound.currentTurn
    });

    if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
      setTimeout(() => { checkMatchEnd(room); }, 500);
      return;
    }

    if (checkAndResumePendingTruco(room)) return;
    startTurnTimer(room, 30);
  }

  function resolveFlorDeclined(room: ActiveRoom, answeringUserId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    room.gameRound.florResolved = true;
    room.gameRound.envidoResolved = true;
    room.gameRound.awaitingResponseFrom = null;
    
    const rivalId = answeringUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId! : room.creatorId;
    const callerId = room.florPendingCaller || rivalId;
    room.florPendingCaller = null;

    const pointsAwarded = room.gameRound.calculateFlorPoints(room.florChain, false, room.scoreP1, room.scoreP2);

    if (callerId.toLowerCase() === room.creatorId.toLowerCase()) room.scoreP1 += pointsAwarded;
    else room.scoreP2 += pointsAwarded;

    const callerHand = callerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
    const callerCards = callerHand.cards.concat(callerHand.cardsPlayed.filter(Boolean) as Card[]);
    const score = calculateFlor(callerCards);

    room.envidoWinnerRecord = { winnerId: callerId, score, cards: callerCards, pointsAwarded };

    io.to(room.roomId).emit('flor_declared', {
      winnerId: callerId, score, cards: callerCards,
      pointsAwarded, scores: getScoreMap(room), trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
      currentTurn: room.gameRound.currentTurn
    });

    if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
      io.to(room.roomId).emit('show_envido_winner', {
        winnerId: room.envidoWinnerRecord.winnerId, score: room.envidoWinnerRecord.score,
        cards: room.envidoWinnerRecord.cards, durationMs: 3500,
      });
      setTimeout(() => { checkMatchEnd(room); }, 3500);
      return;
    }

    if (checkAndResumePendingTruco(room)) return;
    startTurnTimer(room, 30);
  }

  function resolveTrucoFold(room: ActiveRoom, folderUserId: string, reason: string = 'NO_QUIERO_TRUCO') {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    const winnerId = folderUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId! : room.creatorId;

    // 1. Puntos del Truco base
    let trucoPts = 1;
    if (room.gameRound.awaitingResponseFrom) {
      if (room.gameRound.trucoPointsAtStake === 2) trucoPts = 1;
      else if (room.gameRound.trucoPointsAtStake === 3) trucoPts = 2;
      else if (room.gameRound.trucoPointsAtStake === 4) trucoPts = 3;
    } else {
      trucoPts = room.trucoLevel || 1;
    }

    // 2. Revisamos cuántas cartas se jugaron en la primera baza
    const p1PlayedInTrick0 = room.gameRound.p1.cardsPlayed[0] !== null;
    const p2PlayedInTrick0 = room.gameRound.p2.cardsPlayed[0] !== null;
    const totalCardsPlayedInTrick0 = (p1PlayedInTrick0 ? 1 : 0) + (p2PlayedInTrick0 ? 1 : 0);

    // 3. Puntos pendientes de Envido / Flor
    let extraPts = 0;

    if (room.florChain.length > 0 && !room.gameRound.florResolved) {
      extraPts = room.gameRound.calculateFlorPoints(room.florChain, false, room.scoreP1, room.scoreP2);
      room.gameRound.florResolved = true;
      room.gameRound.envidoResolved = true;
    } 
    else if (room.envidoChain.length > 0 && !room.gameRound.envidoResolved) {
      const envidoCalc = calculateEnvidoPoints(room.envidoChain, room);
      
      if (room.isDeclaringEnvido) {
        extraPts = envidoCalc.acceptedPts;
      } else {
        extraPts = envidoCalc.declinedPts;
      }
      room.gameRound.envidoResolved = true;
    }
    // Si nadie cantó nada, pero se van al mazo SIN tirar la primera carta, regalan 1 pt de Envido + 1 de Truco.
    else if (room.envidoChain.length === 0 && room.florChain.length === 0 && totalCardsPlayedInTrick0 === 0 && !room.gameRound.envidoResolved) {
      extraPts = 1;
      room.gameRound.envidoResolved = true;
    }

    const totalPts = trucoPts + extraPts;

    if (winnerId.toLowerCase() === room.creatorId.toLowerCase()) room.scoreP1 += totalPts;
    else room.scoreP2 += totalPts;

    io.to(room.roomId).emit('round_ended', {
      winnerId, 
      pointsAwarded: totalPts, 
      scores: getScoreMap(room),
      reason,
      folderUserId
    });
    handleRoundTransition(room);
  }

  function handleRoundTransition(room: ActiveRoom) {
    clearTurnTimer(room);

    if (room.envidoWinnerRecord) {
      io.to(room.roomId).emit('show_envido_winner', {
        winnerId: room.envidoWinnerRecord.winnerId, score: room.envidoWinnerRecord.score,
        cards: room.envidoWinnerRecord.cards, durationMs: 3500,
      });
      room.envidoWinnerRecord = null;
      setTimeout(() => {
        if (checkMatchEnd(room)) return;
        room.manoId = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? (room.guestId || room.creatorId) : room.creatorId;
        dealAutoHand(room);
      }, 3800);
      return;
    }

    if (checkMatchEnd(room)) return;
    room.manoId = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? (room.guestId || room.creatorId) : room.creatorId;
    setTimeout(() => { dealAutoHand(room); }, 3000);
  }

  function executePlayCard(room: ActiveRoom, userId: string, cardId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    const result = room.gameRound.playCard(userId, cardId);
    if (!result.success) {
      io.to(room.roomId).emit('error_action_player', { targetUser: userId, message: result.message });
      startTurnTimer(room, 30);
      return;
    }

    if (result.trickIndex === 0 && result.isTrickOver) {
      room.gameRound.envidoResolved = true;
      room.gameRound.florResolved = true;
    }

    io.to(room.roomId).emit('card_played', {
      userId, cardId, trickIndex: result.trickIndex, isTrickOver: result.isTrickOver,
      trickWinnerId: result.trickWinnerId || null, nextTurn: result.nextTurn,
      currentTrick: room.gameRound.currentTrickIndex,
    });

    if (result.roundOver && result.winnerId) {
      // Cálculo de puntos
      const finalTrucoPoints = room.trucoLevel > 1 ? room.trucoLevel : (result.points || 1);
      
      if (result.winnerId.toLowerCase() === room.creatorId.toLowerCase()) {
        room.scoreP1 += finalTrucoPoints;
      } else {
        room.scoreP2 += finalTrucoPoints;
      }

      io.to(room.roomId).emit('round_ended', {
        winnerId: result.winnerId, pointsAwarded: finalTrucoPoints, scores: getScoreMap(room),
      });
      
      // LIMPIEZA ESTRICTA: Reseteamos el nivel del truco a 1 para que la próxima mano nazca limpia
      room.trucoLevel = 1;
      
      handleRoundTransition(room);
    } else {
      startTurnTimer(room, 30);
    }
  }

  function sendFullSync(socket: Socket, room: ActiveRoom, userId: string) {
    if (!room.gameRound) return;

    const isP1 = userId.toLowerCase() === room.creatorId.toLowerCase();
    const myHand = isP1 ? room.gameRound.p1 : room.gameRound.p2;
    const rivalHand = isP1 ? room.gameRound.p2 : room.gameRound.p1;
    const rivalUsername = isP1 ? (room.guestId || '') : room.creatorId;

    const tricksData: { [trickIdx: number]: { userId: string; cardId: string }[] } = { 0: [], 1: [], 2: [] };
    for (let i = 0; i < 3; i++) {
      const p1Card = room.gameRound.p1.cardsPlayed[i];
      const p2Card = room.gameRound.p2.cardsPlayed[i];
      if (p1Card) tricksData[i].push({ userId: room.creatorId, cardId: p1Card.id });
      if (p2Card && room.guestId) tricksData[i].push({ userId: room.guestId, cardId: p2Card.id });
    }

    socket.emit('sync_game_state', {
      roomId: room.roomId,
      creatorId: room.creatorId,
      guestId: room.guestId,
      rivalUsername,
      manoId: room.manoId,
      scores: getScoreMap(room),
      targetPoints: room.targetPoints,
      withFlor: room.withFlor,
      betAmount: room.betAmount,
      currentTurn: room.gameRound.currentTurn,
      currentTrick: room.gameRound.currentTrickIndex,
      myCards: myHand.cards,
      oppCardsCount: rivalHand.cards.length,
      tricks: tricksData,
      envidoResolved: room.gameRound.envidoResolved,
      trucoLevel: room.trucoLevel,
      trucoOwner: room.trucoOwner,
      awaitingResponseFrom: room.gameRound.awaitingResponseFrom,
      myAvatar: getUserAvatar(userId),
      rivalAvatar: rivalUsername ? getUserAvatar(rivalUsername) : 'gaucho'
    });
  }

  io.on('connection', (socket: Socket) => {

    socket.emit('update_tables', getAvailableRooms());

    socket.on('request_tables', () => {
      socket.emit('update_tables', getAvailableRooms());
    });

    socket.on('reconnect_game', ({ roomId, userId }) => {
      const room = rooms.get(roomId);
      if (room && (room.creatorId.toLowerCase() === (userId || '').toLowerCase() || (room.guestId && room.guestId.toLowerCase() === (userId || '').toLowerCase()))) {
        socket.join(roomId);
        if (room.creatorId.toLowerCase() === userId.toLowerCase()) {
          room.creatorSocketId = socket.id;
        } else if (room.guestId && room.guestId.toLowerCase() === userId.toLowerCase()) {
          room.guestSocketId = socket.id;
        }

        if (room.disconnectedUser && room.disconnectedUser.toLowerCase() === userId.toLowerCase()) {
          clearDisconnectTimer(room);
          io.to(roomId).emit('player_reconnected', { reconnectedUser: userId });
          startTurnTimer(room, 30);
        }

        sendFullSync(socket, room, userId);
      } else {
        socket.emit('reconnect_failed');
      }
    });

    socket.on('check_active_game', ({ userId }) => {
      if (!userId) return;
      for (const [roomId, room] of rooms.entries()) {
        if (room.guestId && (room.creatorId.toLowerCase() === userId.toLowerCase() || room.guestId.toLowerCase() === userId.toLowerCase())) {
          socket.emit('active_game_found', { roomId, userId });
          return;
        }
      }
    });

    socket.on('create_room', ({ userId, betAmount, targetPoints, withFlor }) => {
      try {
        for (const [existingRoomId, existingRoom] of rooms.entries()) {
          if (existingRoom.creatorId.toLowerCase() === userId.toLowerCase() && !existingRoom.guestId) {
            existingRoom.creatorSocketId = socket.id;
            if (existingRoom.waitingTimeout) {
              clearTimeout(existingRoom.waitingTimeout);
              existingRoom.waitingTimeout = undefined;
            }
            socket.join(existingRoomId);
            return socket.emit('error_action', { message: 'Ya tenés una mesa creada esperando rival.' });
          }
        }
        const bet = Number(betAmount) >= 0 ? Number(betAmount) : 0;
        const pts = Number(targetPoints) === 15 ? 15 : 30;
        const flor = (withFlor === true || withFlor === 'true' || withFlor === undefined);

        if (bet > 0) {
          const successDeduct = modifyUserChips(userId, -bet);
          if (!successDeduct) return socket.emit('error_action', { message: 'Saldo insuficiente.' });
        }

        const roomId = 'mesa_' + crypto.randomBytes(3).toString('hex');
        const room: ActiveRoom = {
          roomId, 
          creatorId: userId, 
          creatorSocketId: socket.id,
          betAmount: bet, 
          targetPoints: pts, 
          withFlor: flor,
          scoreP1: 0, 
          scoreP2: 0, 
          manoId: userId, 
          envidoChain: [], 
          florChain: [],
          envidoPendingCaller: null,
          florPendingCaller: null,
          isDeclaringEnvido: false, 
          isFlorDeclaration: false,
          envidoDeclarer: null, 
          highestEnvidoScore: 0, 
          highestEnvidoUser: null,
          trucoLevel: 1, 
          trucoOwner: null, 
          pendingTrucoAfterEnvido: null
        };
        rooms.set(roomId, room);
        socket.join(roomId);
        
        socket.emit('room_created', { 
          roomId, 
          newBalance: getUserChips(userId), 
          targetPoints: pts, 
          withFlor: flor, 
          betAmount: bet,
          avatar: getUserAvatar(userId)
        });
        broadcastTables();
      } catch (err) { console.error('Error creando mesa:', err); }
    });

    socket.on('cancel_waiting_table', ({ roomId, userId }) => {
      try {
        const room = rooms.get(roomId);
        
        // Validamos que la mesa exista y que el jugador sea realmente el creador
        if (room && !room.guestId && (room.creatorSocketId === socket.id || (userId && room.creatorId.toLowerCase() === userId.toLowerCase()))) {
          
          if (room.waitingTimeout) {
            clearTimeout(room.waitingTimeout);
          }
          
          if (room.betAmount > 0) {
            // Clave: Number() para evitar la concatenación de texto y el crasheo
            modifyUserChips(room.creatorId, Number(room.betAmount));
          }
          
          rooms.delete(roomId);
          
          socket.emit('table_cancelled_ok', { newBalance: getUserChips(room.creatorId) });
          broadcastTables();
        }
      } catch (err) {
        console.error('Error al cancelar la mesa:', err);
      }
    });

    socket.on('surrender_match', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || !room.guestId) return;

      const authUser = getAuthenticatedUserId(room, socket.id);
      if (!authUser) return;

      const isP1 = room.creatorId.toLowerCase() === authUser.toLowerCase();
      clearTurnTimer(room);
      clearDisconnectTimer(room);

      const winnerId = isP1 ? room.guestId : room.creatorId;
      const grossPot = room.betAmount > 0 ? room.betAmount * 2 : 0;
      const netPot = grossPot * 0.93;
      const rake = grossPot * 0.07;

      if (netPot > 0) {
        const loserId = authUser;
        modifyUserChips(winnerId, netPot);
        const bWinner = getUserChips(winnerId);
        const bLoser = getUserChips(loserId);
        const detalle = `Victoria x Rendición. Ganó: ${winnerId} (Saldo: $${bWinner}). Perdió: ${loserId} (Saldo: $${bLoser}). Premio entregado: $${netPot} (Comisión 7%: $${rake}). Mesa: ${room.roomId}`;
        recordTransaction('COMMISSION_RAKE', winnerId, rake, detalle);
      }

      io.to(roomId).emit('player_surrendered', {
        surrenderedUser: authUser,
        winnerId,
        pot: netPot,
        scores: getScoreMap(room),
        winnerBalance: getUserChips(winnerId),
        reason: 'SURRENDER'
      });

      rooms.delete(room.roomId);
      broadcastTables();
    });

    socket.on('join_room', ({ roomId, userId }) => {
      try {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error_action', { message: 'La mesa no existe.' });
        if (room.guestId) return socket.emit('error_action', { message: 'La mesa ya está completa.' });
        
        // Limpiamos mesas huérfanas del jugador y devolvemos las fichas
        for (const [pendingRoomId, pendingRoom] of rooms.entries()) {
          if (pendingRoom.creatorId.toLowerCase() === (userId || '').toLowerCase() && !pendingRoom.guestId) {
            if (pendingRoom.betAmount > 0) {
              // Envolver en Number() evita la concatenación de strings
              modifyUserChips(userId, Number(pendingRoom.betAmount));
            }
            rooms.delete(pendingRoomId);
          }
        }

        if (room.betAmount > 0) {
          // Aplicamos Number() también acá por coherencia en el código
          const successDeduct = modifyUserChips(userId, -Number(room.betAmount));
          if (!successDeduct) return socket.emit('error_action', { message: 'Saldo insuficiente.' });
        }

        room.guestId = userId;
        room.guestSocketId = socket.id;
        socket.join(roomId);

        io.to(roomId).emit('game_ready', {
          roomId: room.roomId, 
          creatorId: room.creatorId, 
          creatorAvatar: getUserAvatar(room.creatorId),
          guestId: room.guestId,
          guestAvatar: getUserAvatar(userId),
          pot: room.betAmount > 0 ? room.betAmount * 2 * 0.93 : 0,
          targetPoints: room.targetPoints, 
          withFlor: room.withFlor, 
          betAmount: room.betAmount
        });

        broadcastTables();
        setTimeout(() => { dealAutoHand(room); }, 1200);
      } catch (err) { console.error('Error uniéndose a mesa:', err); }
    });

    socket.on('disconnect', () => {
      for (const [roomId, room] of rooms.entries()) {
        if (!room.guestId && room.creatorSocketId === socket.id) {
          if (room.waitingTimeout) {
            clearTimeout(room.waitingTimeout);
          }

          room.creatorSocketId = undefined;

          room.waitingTimeout = setTimeout(() => {
            const activeRoom = rooms.get(roomId);
            if (activeRoom && !activeRoom.guestId) {
              if (activeRoom.betAmount > 0) {
                modifyUserChips(activeRoom.creatorId, activeRoom.betAmount);
              }
              rooms.delete(roomId);
              broadcastTables();
            }
          }, 30 * 60 * 1000);

          broadcastTables();
          continue;
        }

        if (room.guestId) {
          if (room.creatorSocketId === socket.id) {
            startDisconnectGracePeriod(room, room.creatorId);
          } else if (room.guestSocketId === socket.id) {
            startDisconnectGracePeriod(room, room.guestId);
          }
        }
      }
    });

    socket.on('play_card', ({ roomId, cardId }) => {
      const room = rooms.get(roomId);
      if (!room || !room.gameRound || room.disconnectedUser) return;

      // NUEVO: Candado anti-spam para evitar la "Condición de Carrera" (doble clic)
      if (room['isProcessingPlay']) return;

      const authUser = getAuthenticatedUserId(room, socket.id);
      if (!authUser) return socket.emit('error_action', { message: 'No perteneces a esta partida.' });

      // Verificar que sea su turno
      if (room.gameRound.currentTurn.toLowerCase() !== authUser.toLowerCase()) {
        return socket.emit('error_action', { message: 'No es tu turno de jugar carta.' });
      }

      // NUEVO: Bloqueo estricto si hay un Envido, Flor o Truco esperando respuesta
      if (room.gameRound.awaitingResponseFrom) {
        return socket.emit('error_action', { message: 'Hay un canto pendiente de respuesta.' });
      }

      // Activamos el candado antes de procesar la carta
        room['isProcessingPlay'] = true;

      try {
        executePlayCard(room, authUser, cardId);
      } finally {
        // Soltamos el candado inmediatamente después de que se procesó todo
        room['isProcessingPlay'] = false;
      }
    });
    socket.on('declare_envido_points', ({ roomId, points }) => {
      const room = rooms.get(roomId);
      if (!room || room.disconnectedUser) return;
      const authUser = getAuthenticatedUserId(room, socket.id);
      if (authUser) executeDeclareEnvido(room, authUser, points);
    });

    socket.on('say_son_buenas', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.disconnectedUser) return;
      const authUser = getAuthenticatedUserId(room, socket.id);
      if (authUser) executeSonBuenas(room, authUser);
    });

    socket.on('send_call', ({ roomId, callType }) => {
      try {
        const room = rooms.get(roomId);
        if (!room || !room.gameRound || room.disconnectedUser) return;

        const authUser = getAuthenticatedUserId(room, socket.id);
        if (!authUser) return socket.emit('error_action', { message: 'No perteneces a esta mesa.' });

        const rivalId = authUser.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId! : room.creatorId;
        const currentTrick = room.gameRound.currentTrickIndex;

        const callerHand = authUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const callerCardsPlayed = callerHand.cardsPlayed.filter(Boolean).length;

        if (room.gameRound.awaitingResponseFrom) {
          if (room.gameRound.awaitingResponseFrom.toLowerCase() !== authUser.toLowerCase()) {
            return socket.emit('error_action', { message: 'No es tu turno de responder.' });
          }
        } else {
          if (room.gameRound.currentTurn.toLowerCase() !== authUser.toLowerCase()) {
            return socket.emit('error_action', { message: 'No es tu turno para cantar o jugar.' });
          }
        }

        const isFirstTrick = room.gameRound && room.gameRound.currentTrickIndex === 0;
        const envidoActive = room.envidoPendingCaller && !room.gameRound.envidoResolved;
        const florActive = room.florPendingCaller && !room.gameRound.florResolved;

        if (isFirstTrick && (envidoActive || florActive) && ['TRUCO', 'RETRUCO', 'VALE_4'].includes(callType)) {
            return socket.emit('error_action', { message: 'Debes responder primero a los tantos/flor.' });
        }

        if (['FLOR', 'CONTRAFLOR', 'CONTRAFLOR_AL_JUEGO'].includes(callType)) {
          if (!room.withFlor) return socket.emit('error_action', { message: 'Partida SIN FLOR.' });
          if (currentTrick > 0 || room.gameRound.florResolved) return socket.emit('error_action', { message: 'El tiempo para cantar Flor ya cerró.' });

          // Validación estricta: No se puede cantar Contraflor ni Contraflor al juego ante un Envido
          if (['CONTRAFLOR', 'CONTRAFLOR_AL_JUEGO'].includes(callType) && room.envidoPendingCaller) {
            return socket.emit('error_action', { message: 'No se puede cantar Contraflor a un Envido.' });
          }

          const rivalHand = rivalId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
          const rivalCards = rivalHand.cards.concat(rivalHand.cardsPlayed.filter(Boolean) as Card[]);
          const rivalHasFlor = hasFlor(rivalCards);

          if (callType === 'FLOR' && !rivalHasFlor) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.gameRound.awaitingResponseFrom = null;
            room.florPendingCaller = null;
            room.envidoPendingCaller = null; // NUEVO: La flor elimina cualquier envido pendiente

            if (authUser.toLowerCase() === room.creatorId.toLowerCase()) room.scoreP1 += 3;
            else room.scoreP2 += 3;

            const callerHand = authUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
            const callerCards = callerHand.cards.concat(callerHand.cardsPlayed.filter(Boolean) as Card[]);
            const florPoints = calculateFlor(callerCards);

            room.envidoWinnerRecord = { winnerId: authUser, score: florPoints, cards: callerCards, pointsAwarded: 3 };
            
            io.to(roomId).emit('flor_declared', {
              winnerId: authUser, score: florPoints, cards: callerCards,
              pointsAwarded: 3, scores: getScoreMap(room), trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
              currentTurn: room.gameRound.currentTurn
            });

            if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
              io.to(room.roomId).emit('show_envido_winner', {
                winnerId: room.envidoWinnerRecord.winnerId, score: room.envidoWinnerRecord.score,
                cards: room.envidoWinnerRecord.cards, durationMs: 3500,
              });
              setTimeout(() => { checkMatchEnd(room); }, 3500);
              return;
            }

            if (checkAndResumePendingTruco(room)) return;
            return startTurnTimer(room, 30);
          }

          room.gameRound.envidoResolved = true;
          room.envidoPendingCaller = null; // NUEVO: La flor elimina cualquier envido pendiente
          room.florChain.push(callType);
          room.florPendingCaller = authUser;
          room.gameRound.awaitingResponseFrom = rivalId;
          io.to(roomId).emit('call_received', { 
            userId: authUser, 
            callType, 
            category: 'FLOR', 
            awaitingResponseFrom: rivalId, 
            chain: room.florChain 
          });
          return startTurnTimer(room, 30);
        }

        if (callType === 'QUIERO_FLOR') return startEnvidoDeclarationPhase(room, true);
        if (callType === 'NO_QUIERO_FLOR') return resolveFlorDeclined(room, authUser);

        if (['ENVIDO', 'ENVIDO_ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO'].includes(callType)) {
          if (currentTrick > 0 || room.gameRound.envidoResolved || room.gameRound.florResolved) {
            return socket.emit('error_action', { message: 'El tiempo de los tantos ya cerró.' });
          }

          if (room.envidoChain.length === 0) {
            if (callerCardsPlayed > 0 && !room.gameRound.awaitingResponseFrom) {
              return socket.emit('error_action', { message: 'Ya jugaste tu carta, no podés iniciar el Envido.' });
            }
          }

          room.envidoChain.push(callType);
          room.envidoPendingCaller = authUser;
          room.gameRound.awaitingResponseFrom = rivalId;

          io.to(roomId).emit('call_received', { userId: authUser, callType, category: 'ENVIDO', awaitingResponseFrom: rivalId, chain: room.envidoChain });
          return startTurnTimer(room, 30);
        }

        // FLUJO ESTRICTO: QUIERO_ENVIDO activa obligatoriamente la fase de declaración de puntos
        if (callType === 'QUIERO_ENVIDO') {
          room.gameRound.awaitingResponseFrom = null;
          room.envidoPendingCaller = null;
          return startEnvidoDeclarationPhase(room, false);
        }

        if (callType === 'NO_QUIERO_ENVIDO') return resolveEnvidoDeclined(room, authUser);

        if (callType === 'TRUCO') {
          const responderHand = rivalId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
          const responderCardsPlayed = responderHand.cardsPlayed.filter(Boolean).length;

          const canEnvido = (currentTrick === 0 && !room.gameRound.envidoResolved && responderCardsPlayed === 0);

          if (canEnvido) {
            room.pendingTrucoAfterEnvido = {
              callerId: authUser,
              responderId: rivalId,
              trucoPointsAtStake: 2,
              callType: 'TRUCO'
            };
          } else {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.pendingTrucoAfterEnvido = null;
          }

          room.gameRound.trucoPointsAtStake = 2;
          room.gameRound.awaitingResponseFrom = rivalId;
          io.to(roomId).emit('call_received', { 
            userId: authUser, 
            callType: 'TRUCO', 
            category: 'TRUCO', 
            awaitingResponseFrom: rivalId, 
            canCallEnvido: canEnvido 
          });
          return startTurnTimer(room, 30);
        }

        if (callType === 'RETRUCO') {
          room.gameRound.envidoResolved = true;
          room.gameRound.florResolved = true;
          room.pendingTrucoAfterEnvido = null;
          room.gameRound.trucoPointsAtStake = 3;
          room.gameRound.awaitingResponseFrom = rivalId;
          io.to(roomId).emit('call_received', { userId: authUser, callType: 'RETRUCO', category: 'TRUCO', awaitingResponseFrom: rivalId, canCallEnvido: false });
          return startTurnTimer(room, 30);
        }

        if (callType === 'VALE_4') {
          room.gameRound.envidoResolved = true;
          room.gameRound.florResolved = true;
          room.pendingTrucoAfterEnvido = null;
          room.gameRound.trucoPointsAtStake = 4;
          room.gameRound.awaitingResponseFrom = rivalId;
          io.to(roomId).emit('call_received', { userId: authUser, callType: 'VALE_4', category: 'TRUCO', awaitingResponseFrom: rivalId, canCallEnvido: false });
          return startTurnTimer(room, 30);
        }

        if (callType === 'QUIERO_TRUCO') {
          room.gameRound.envidoResolved = true;
          room.gameRound.florResolved = true;
          room.pendingTrucoAfterEnvido = null;
          room.gameRound.awaitingResponseFrom = null;
          room.trucoLevel = room.gameRound.trucoPointsAtStake;
          room.trucoOwner = authUser;
          io.to(roomId).emit('truco_accepted', { 
            acceptedBy: authUser, 
            trucoLevel: room.trucoLevel, 
            trucoOwner: room.trucoOwner 
          });
          return startTurnTimer(room, 30);
        }

        if (callType === 'NO_QUIERO_TRUCO' || callType === 'ME_VOY_AL_MAZO') {
          room.pendingTrucoAfterEnvido = null;
          return resolveTrucoFold(room, authUser, callType);
        }

      } catch (err) { console.error('Error en send_call:', err); }
    });
  });
}