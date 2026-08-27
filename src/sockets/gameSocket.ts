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
  winnerTeam: 'TEAM_1' | 'TEAM_2';
  score: number;
  cards: Card[];
  pointsAwarded: number;
}

interface PlayerSlot {
  userId: string;
  socketId: string;
  team: 'TEAM_1' | 'TEAM_2';
  avatar: string;
}

interface ActiveRoom {
  roomId: string;
  mode: '1v1' | '2v2';
  maxPlayers: number;
  creatorId: string;
  players: PlayerSlot[];
  betAmount: number;
  targetPoints: number;
  withFlor: boolean;
  scoreP1: number; // Puntos Equipo 1
  scoreP2: number; // Puntos Equipo 2
  gameRound?: TrucoRound;
  manoIndex: number;
  manoId: string;
  envidoChain: string[];
  envidoPendingCaller: string | null;
  envidoWinnerRecord?: EnvidoWinnerRecord | null;
  turnInterval?: NodeJS.Timeout;

  // Manejo de Desconexión y Gracia
  disconnectInterval?: NodeJS.Timeout;
  disconnectedUser?: string | null;

  isDeclaringEnvido: boolean;
  envidoDeclarer: string | null;
  highestEnvidoScore: number;
  highestEnvidoUser: string | null;
  highestEnvidoTeam: 'TEAM_1' | 'TEAM_2' | null;

  trucoLevel: number;
  trucoOwnerTeam: 'TEAM_1' | 'TEAM_2' | null;

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
      .filter(r => r.players.length < r.maxPlayers)
      .map(r => ({
        roomId: r.roomId,
        mode: r.mode,
        creatorId: r.creatorId,
        creatorAvatar: getUserAvatar(r.creatorId),
        betAmount: r.betAmount,
        targetPoints: r.targetPoints,
        withFlor: r.withFlor,
        playersCount: r.players.length,
        maxPlayers: r.maxPlayers,
        players: r.players.map(p => ({ userId: p.userId, avatar: p.avatar, team: p.team }))
      }));
  }

  function broadcastTables() {
    io.emit('update_tables', getAvailableRooms());
  }

  function getScoreMap(room: ActiveRoom) {
    const map: { [key: string]: number } = {
      TEAM_1: room.scoreP1,
      TEAM_2: room.scoreP2
    };
    room.players.forEach(p => {
      map[p.userId] = p.team === 'TEAM_1' ? room.scoreP1 : room.scoreP2;
    });
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

  function getAuthenticatedPlayer(room: ActiveRoom, socketId: string): PlayerSlot | null {
    return room.players.find(p => p.socketId === socketId) || null;
  }

  function checkMatchEnd(room: ActiveRoom): boolean {
    if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
      clearTurnTimer(room);
      clearDisconnectTimer(room);

      const winningTeam: 'TEAM_1' | 'TEAM_2' = room.scoreP1 >= room.targetPoints ? 'TEAM_1' : 'TEAM_2';
      const winners = room.players.filter(p => p.team === winningTeam);
      const grossPot = room.betAmount > 0 ? room.betAmount * room.maxPlayers : 0;
      const netPot = grossPot * 0.9;
      const rake = grossPot * 0.1;

      if (netPot > 0 && winners.length > 0) {
        const prizePerWinner = netPot / winners.length;
        winners.forEach(w => {
          modifyUserChips(w.userId, prizePerWinner);
        });
        recordTransaction('COMMISSION_RAKE', winners[0].userId, rake, `Comisión mesa ${room.mode} ${room.roomId} ($${room.betAmount} c/u)`);
      }

      io.to(room.roomId).emit('match_finished', {
        winningTeam,
        winnerIds: winners.map(w => w.userId),
        winnerId: winners[0]?.userId || '',
        scores: getScoreMap(room),
        pot: netPot,
        is2v2: room.mode === '2v2'
      });

      rooms.delete(room.roomId);
      broadcastTables();
      return true;
    }
    return false;
  }

  function startTurnTimer(room: ActiveRoom, seconds: number = 25) {
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
      const hand = room.gameRound.getPlayerHand(activeUser);
      if (hand) {
        const allCards = hand.cards.concat(hand.cardsPlayed.filter(Boolean) as Card[]);
        const details = getEnvidoDetails(allCards);

        if (room.highestEnvidoScore === 0) {
          executeDeclareEnvido(room, activeUser, details.score);
        } else {
          if (details.score > room.highestEnvidoScore) {
            executeDeclareEnvido(room, activeUser, details.score);
          } else {
            executeSonBuenas(room, activeUser);
          }
        }
        return;
      }
    }

    if (room.gameRound.awaitingResponseFrom) {
      const responderId = room.gameRound.awaitingResponseFrom;
      if (room.envidoPendingCaller) {
        resolveEnvidoDeclined(room, responderId);
      } else {
        resolveTrucoFold(room, responderId, 'NO_QUIERO_TRUCO');
      }
      return;
    }

    const activePlayerId = room.gameRound.currentTurn;
    const playerHand = room.gameRound.getPlayerHand(activePlayerId);
    if (playerHand && playerHand.cards.length > 0) {
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

        const discPlayer = room.players.find(p => p.userId.toLowerCase() === disconnectedUser.toLowerCase());
        const winningTeam: 'TEAM_1' | 'TEAM_2' = discPlayer?.team === 'TEAM_1' ? 'TEAM_2' : 'TEAM_1';
        const winners = room.players.filter(p => p.team === winningTeam);

        const grossPot = room.betAmount > 0 ? room.betAmount * room.maxPlayers : 0;
        const netPot = grossPot * 0.9;
        const rake = grossPot * 0.1;

        if (netPot > 0 && winners.length > 0) {
          const prizePerWinner = netPot / winners.length;
          winners.forEach(w => modifyUserChips(w.userId, prizePerWinner));
          recordTransaction('COMMISSION_RAKE', winners[0].userId, rake, `Comisión abandono mesa ${room.mode} ${room.roomId} ($${room.betAmount} c/u)`);
        }

        io.to(room.roomId).emit('player_surrendered', {
          surrenderedUser: disconnectedUser,
          winningTeam,
          winnerIds: winners.map(w => w.userId),
          winnerId: winners[0]?.userId || '',
          pot: netPot,
          scores: getScoreMap(room),
          reason: 'DISCONNECT_TIMEOUT',
          is2v2: room.mode === '2v2'
        });

        rooms.delete(room.roomId);
        broadcastTables();
      }
    }, 1000);
  }

  function dealAutoHand(room: ActiveRoom) {
    if (room.players.length < room.maxPlayers || room.disconnectedUser) return;
    clearTurnTimer(room);

    const playerIds = room.players.map(p => p.userId);
    const round = new TrucoRound(playerIds, room.manoId, room.targetPoints, room.withFlor);

    room.gameRound = round;
    room.gameRound.envidoResolved = false;
    room.envidoChain = [];
    room.envidoPendingCaller = null;
    room.envidoWinnerRecord = null;
    room.isDeclaringEnvido = false;
    room.envidoDeclarer = null;
    room.highestEnvidoScore = 0;
    room.highestEnvidoUser = null;
    room.highestEnvidoTeam = null;
    room.trucoLevel = 1;
    room.trucoOwnerTeam = null;
    room.pendingTrucoAfterEnvido = null;

    io.to(room.roomId).emit('hand_started', {
      manoId: room.manoId,
      currentTurn: round.currentTurn,
      scores: getScoreMap(room),
      withFlor: room.withFlor,
      targetPoints: room.targetPoints,
      mode: room.mode
    });

    room.players.forEach(p => {
      const hand = round.getPlayerHand(p.userId);
      if (hand && p.socketId) {
        io.to(p.socketId).emit('cards_dealt', {
          myCards: hand.cards,
          withFlor: room.withFlor,
          manoId: room.manoId,
          mode: room.mode
        });
      }
    });

    startTurnTimer(room, 25);
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

  function startEnvidoDeclarationPhase(room: ActiveRoom) {
    clearTurnTimer(room);
    room.isDeclaringEnvido = true;
    room.envidoDeclarer = room.manoId;
    room.highestEnvidoScore = 0;
    room.highestEnvidoUser = null;
    room.highestEnvidoTeam = null;

    io.to(room.roomId).emit('start_envido_declaration', {
      firstDeclarer: room.manoId,
      chain: room.envidoChain,
    });
    startTurnTimer(room, 25);
  }

  function executeDeclareEnvido(room: ActiveRoom, userId: string, declaredPoints: number) {
    if (!room.gameRound || !room.isDeclaringEnvido || room.envidoDeclarer !== userId) return;

    const team = room.gameRound.getTeam(userId);

    if (room.highestEnvidoScore === 0) {
      room.highestEnvidoScore = declaredPoints;
      room.highestEnvidoUser = userId;
      room.highestEnvidoTeam = team;

      const rivals = room.gameRound.getRivals(userId);
      const nextDeclarer = rivals[0] || userId;
      room.envidoDeclarer = nextDeclarer;

      io.to(room.roomId).emit('envido_points_announced', {
        userId, points: declaredPoints, nextDeclarer,
        highestScore: declaredPoints, highestUser: userId, isFinal: false,
      });
      startTurnTimer(room, 25);
    } else {
      io.to(room.roomId).emit('envido_points_announced', {
        userId, points: declaredPoints, nextDeclarer: null,
        highestScore: declaredPoints, highestUser: userId, isFinal: true,
      });
      finalizeEnvido(room, userId, team);
    }
  }

  function executeSonBuenas(room: ActiveRoom, userId: string) {
    if (!room.gameRound || !room.isDeclaringEnvido || room.envidoDeclarer !== userId) return;
    const winnerId = room.highestEnvidoUser!;
    const winnerTeam = room.highestEnvidoTeam!;
    io.to(room.roomId).emit('son_buenas_said', { userId, winnerId });
    finalizeEnvido(room, winnerId, winnerTeam);
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

      startTurnTimer(room, 25);
      return true;
    }
    return false;
  }

  function finalizeEnvido(room: ActiveRoom, winnerId: string, winnerTeam: 'TEAM_1' | 'TEAM_2') {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    room.isDeclaringEnvido = false;
    room.envidoDeclarer = null;
    room.gameRound.envidoResolved = true;
    room.gameRound.awaitingResponseFrom = null;
    room.envidoPendingCaller = null;

    const { acceptedPts } = calculateEnvidoPoints(room.envidoChain, room);
    const pts = acceptedPts;

    if (winnerTeam === 'TEAM_1') room.scoreP1 += pts;
    else room.scoreP2 += pts;

    const winnerHand = room.gameRound.getPlayerHand(winnerId);
    const winnerAllCards = winnerHand ? winnerHand.cards.concat(winnerHand.cardsPlayed.filter(Boolean) as Card[]) : [];
    const details = getEnvidoDetails(winnerAllCards);

    room.envidoWinnerRecord = { winnerId, winnerTeam, score: details.score, cards: details.envidoCards, pointsAwarded: pts };

    io.to(room.roomId).emit('envido_resolved', {
      winnerId, winnerTeam, pointsAwarded: pts, scores: getScoreMap(room),
      declined: false, trucoLevel: room.trucoLevel,
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

    startTurnTimer(room, 25);
  }

  function resolveEnvidoDeclined(room: ActiveRoom, answeringUserId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    room.gameRound.envidoResolved = true;
    room.gameRound.awaitingResponseFrom = null;

    const answeringTeam = room.gameRound.getTeam(answeringUserId);
    const winningTeam: 'TEAM_1' | 'TEAM_2' = answeringTeam === 'TEAM_1' ? 'TEAM_2' : 'TEAM_1';
    const callerId = room.envidoPendingCaller || room.gameRound.getTeamPlayers(winningTeam)[0];
    room.envidoPendingCaller = null;

    const { declinedPts } = calculateEnvidoPoints(room.envidoChain, room);

    if (winningTeam === 'TEAM_1') room.scoreP1 += declinedPts;
    else room.scoreP2 += declinedPts;

    io.to(room.roomId).emit('envido_resolved', {
      winnerId: callerId, winnerTeam: winningTeam, pointsAwarded: declinedPts, scores: getScoreMap(room),
      declined: true, trucoLevel: room.trucoLevel,
      currentTurn: room.gameRound.currentTurn
    });

    if (checkMatchEnd(room)) return;
    if (checkAndResumePendingTruco(room)) return;

    startTurnTimer(room, 25);
  }

  function resolveFlor(room: ActiveRoom, callerId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    room.gameRound.envidoResolved = true;
    room.envidoPendingCaller = null;
    room.gameRound.awaitingResponseFrom = null;

    const callerHand = room.gameRound.getPlayerHand(callerId);
    const callerAllCards = callerHand ? callerHand.cards.concat(callerHand.cardsPlayed.filter(Boolean) as Card[]) : [];
    const florPoints = calculateFlor(callerAllCards);
    const callerTeam = room.gameRound.getTeam(callerId);

    const rivals = room.gameRound.getRivals(callerId);
    let bestRivalFlorPts = 0;
    let bestRivalId = '';
    let bestRivalCards: Card[] = [];

    rivals.forEach(rId => {
      const rHand = room.gameRound!.getPlayerHand(rId);
      const rCards = rHand ? rHand.cards.concat(rHand.cardsPlayed.filter(Boolean) as Card[]) : [];
      if (hasFlor(rCards)) {
        const pts = calculateFlor(rCards);
        if (pts > bestRivalFlorPts) {
          bestRivalFlorPts = pts;
          bestRivalId = rId;
          bestRivalCards = rCards;
        }
      }
    });

    if (bestRivalFlorPts === 0) {
      if (callerTeam === 'TEAM_1') room.scoreP1 += 3;
      else room.scoreP2 += 3;

      room.envidoWinnerRecord = { winnerId: callerId, winnerTeam: callerTeam, score: florPoints, cards: callerAllCards, pointsAwarded: 3 };
      io.to(room.roomId).emit('flor_declared', {
        winnerId: callerId, score: florPoints, cards: callerAllCards,
        pointsAwarded: 3, scores: getScoreMap(room), trucoLevel: room.trucoLevel,
        currentTurn: room.gameRound.currentTurn
      });
      if (checkMatchEnd(room)) return;
    } else {
      let winnerId = callerId;
      let winnerTeam = callerTeam;
      let winnerPts = florPoints;
      let winnerCards = callerAllCards;

      if (bestRivalFlorPts > florPoints) {
        winnerId = bestRivalId;
        winnerTeam = room.gameRound.getTeam(bestRivalId);
        winnerPts = bestRivalFlorPts;
        winnerCards = bestRivalCards;
      } else if (bestRivalFlorPts === florPoints) {
        const manoTeam = room.gameRound.getTeam(room.manoId);
        winnerTeam = manoTeam;
        winnerId = manoTeam === callerTeam ? callerId : bestRivalId;
        winnerCards = manoTeam === callerTeam ? callerAllCards : bestRivalCards;
      }

      if (winnerTeam === 'TEAM_1') room.scoreP1 += 6;
      else room.scoreP2 += 6;

      room.envidoWinnerRecord = { winnerId, winnerTeam, score: winnerPts, cards: winnerCards, pointsAwarded: 6 };
      io.to(room.roomId).emit('flor_declared', {
        winnerId, score: winnerPts, cards: winnerCards,
        pointsAwarded: 6, scores: getScoreMap(room), trucoLevel: room.trucoLevel,
        currentTurn: room.gameRound.currentTurn
      });
      if (checkMatchEnd(room)) return;
    }

    if (checkAndResumePendingTruco(room)) return;

    startTurnTimer(room, 25);
  }

  function resolveTrucoFold(room: ActiveRoom, folderUserId: string, reason: string = 'NO_QUIERO_TRUCO') {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    const folderTeam = room.gameRound.getTeam(folderUserId);
    const winningTeam: 'TEAM_1' | 'TEAM_2' = folderTeam === 'TEAM_1' ? 'TEAM_2' : 'TEAM_1';
    const winners = room.gameRound.getTeamPlayers(winningTeam);
    const winnerId = winners[0] || '';

    let trucoPts = 1;
    if (room.gameRound.awaitingResponseFrom) {
      if (room.gameRound.trucoPointsAtStake === 2) trucoPts = 1;
      else if (room.gameRound.trucoPointsAtStake === 3) trucoPts = 2;
      else if (room.gameRound.trucoPointsAtStake === 4) trucoPts = 3;
    } else {
      trucoPts = room.trucoLevel || 1;
    }

    let pts = trucoPts;

    const cardsPlayedInTrick0 = room.gameRound.players.reduce((acc, p) => acc + (p.cardsPlayed[0] ? 1 : 0), 0);

    if (reason === 'ME_VOY_AL_MAZO' && !room.gameRound.envidoResolved && room.gameRound.currentTrickIndex === 0 && cardsPlayedInTrick0 === 0) {
      pts = trucoPts + 1;
    }

    if (winningTeam === 'TEAM_1') room.scoreP1 += pts;
    else room.scoreP2 += pts;

    io.to(room.roomId).emit('round_ended', {
      winnerId, 
      winningTeam,
      pointsAwarded: pts, 
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
        room.manoIndex = (room.manoIndex + 1) % room.players.length;
        room.manoId = room.players[room.manoIndex].userId;
        dealAutoHand(room);
      }, 3800);
      return;
    }

    if (checkMatchEnd(room)) return;
    room.manoIndex = (room.manoIndex + 1) % room.players.length;
    room.manoId = room.players[room.manoIndex].userId;
    setTimeout(() => { dealAutoHand(room); }, 3000);
  }

  function executePlayCard(room: ActiveRoom, userId: string, cardId: string) {
    if (!room.gameRound) return;
    clearTurnTimer(room);

    const result = room.gameRound.playCard(userId, cardId);
    if (!result.success) {
      io.to(room.roomId).emit('error_action_player', { targetUser: userId, message: result.message });
      startTurnTimer(room, 25);
      return;
    }

    if (result.trickIndex === 0 && result.isTrickOver) {
      room.gameRound.envidoResolved = true;
    }

    io.to(room.roomId).emit('card_played', {
      userId, 
      cardId, 
      trickIndex: result.trickIndex, 
      isTrickOver: result.isTrickOver,
      trickWinnerId: result.trickWinnerId || null, 
      trickWinnerTeam: result.trickWinnerTeam || null,
      nextTurn: result.nextTurn,
      currentTrick: room.gameRound.currentTrickIndex,
    });

    if (result.roundOver && result.winnerTeam) {
      const finalTrucoPoints = room.trucoLevel > 1 ? room.trucoLevel : (result.points || 1);
      if (result.winnerTeam === 'TEAM_1') room.scoreP1 += finalTrucoPoints;
      else room.scoreP2 += finalTrucoPoints;

      io.to(room.roomId).emit('round_ended', {
        winnerId: result.winnerId,
        winningTeam: result.winnerTeam,
        pointsAwarded: finalTrucoPoints, 
        scores: getScoreMap(room),
      });
      handleRoundTransition(room);
    } else {
      startTurnTimer(room, 25);
    }
  }

  function sendFullSync(socket: Socket, room: ActiveRoom, userId: string) {
    if (!room.gameRound) return;

    const myHand = room.gameRound.getPlayerHand(userId);
    const myTeam = room.gameRound.getTeam(userId);

    const tricksData: { [trickIdx: number]: { userId: string; cardId: string; team: string }[] } = { 0: [], 1: [], 2: [] };
    for (let i = 0; i < 3; i++) {
      room.gameRound.players.forEach(p => {
        const c = p.cardsPlayed[i];
        if (c) tricksData[i].push({ userId: p.userId, cardId: c.id, team: p.team });
      });
    }

    socket.emit('sync_game_state', {
      roomId: room.roomId,
      mode: room.mode,
      players: room.players.map(p => ({
        userId: p.userId,
        avatar: p.avatar,
        team: p.team,
        cardsCount: room.gameRound?.getPlayerHand(p.userId)?.cards.length || 0
      })),
      myTeam,
      manoId: room.manoId,
      scores: getScoreMap(room),
      targetPoints: room.targetPoints,
      withFlor: room.withFlor,
      betAmount: room.betAmount,
      currentTurn: room.gameRound.currentTurn,
      currentTrick: room.gameRound.currentTrickIndex,
      myCards: myHand?.cards || [],
      tricks: tricksData,
      envidoResolved: room.gameRound.envidoResolved,
      trucoLevel: room.trucoLevel,
      trucoOwnerTeam: room.trucoOwnerTeam,
      awaitingResponseFrom: room.gameRound.awaitingResponseFrom,
      myAvatar: getUserAvatar(userId)
    });
  }

  io.on('connection', (socket: Socket) => {

    socket.emit('update_tables', getAvailableRooms());

    socket.on('request_tables', () => {
      socket.emit('update_tables', getAvailableRooms());
    });

    socket.on('reconnect_game', ({ roomId, userId }) => {
      const room = rooms.get(roomId);
      if (room) {
        const player = room.players.find(p => p.userId.toLowerCase() === (userId || '').toLowerCase());
        if (player) {
          player.socketId = socket.id;
          socket.join(roomId);

          if (room.disconnectedUser && room.disconnectedUser.toLowerCase() === userId.toLowerCase()) {
            clearDisconnectTimer(room);
            io.to(roomId).emit('player_reconnected', { reconnectedUser: userId });
            startTurnTimer(room, 25);
          }

          sendFullSync(socket, room, userId);
          return;
        }
      }
      socket.emit('reconnect_failed');
    });

    socket.on('create_room', ({ userId, betAmount, targetPoints, withFlor, mode }) => {
      try {
        const gameMode: '1v1' | '2v2' = mode === '2v2' ? '2v2' : '1v1';
        const maxPlayers = gameMode === '2v2' ? 4 : 2;
        const bet = Number(betAmount) >= 0 ? Number(betAmount) : 0;
        const pts = Number(targetPoints) === 15 ? 15 : 30;
        const flor = (withFlor === true || withFlor === 'true' || withFlor === undefined);

        if (bet > 0) {
          const successDeduct = modifyUserChips(userId, -bet);
          if (!successDeduct) return socket.emit('error_action', { message: 'Saldo insuficiente.' });
        }

        const roomId = 'mesa_' + crypto.randomBytes(3).toString('hex');
        const creatorSlot: PlayerSlot = {
          userId,
          socketId: socket.id,
          team: 'TEAM_1',
          avatar: getUserAvatar(userId)
        };

        const room: ActiveRoom = {
          roomId, 
          mode: gameMode,
          maxPlayers,
          creatorId: userId, 
          players: [creatorSlot],
          betAmount: bet, 
          targetPoints: pts, 
          withFlor: flor,
          scoreP1: 0, 
          scoreP2: 0, 
          manoIndex: 0,
          manoId: userId, 
          envidoChain: [], 
          envidoPendingCaller: null,
          isDeclaringEnvido: false, 
          envidoDeclarer: null, 
          highestEnvidoScore: 0, 
          highestEnvidoUser: null,
          highestEnvidoTeam: null,
          trucoLevel: 1, 
          trucoOwnerTeam: null, 
          pendingTrucoAfterEnvido: null
        };
        rooms.set(roomId, room);
        socket.join(roomId);
        
        socket.emit('room_created', { 
          roomId, 
          mode: gameMode,
          newBalance: getUserChips(userId), 
          targetPoints: pts, 
          withFlor: flor, 
          betAmount: bet,
          avatar: creatorSlot.avatar
        });
        broadcastTables();
      } catch (err) { console.error('Error creando mesa:', err); }
    });

    socket.on('cancel_waiting_table', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (room && room.players.length < room.maxPlayers && room.creatorId.toLowerCase() === getAuthenticatedPlayer(room, socket.id)?.userId.toLowerCase()) {
        room.players.forEach(p => {
          if (room.betAmount > 0) modifyUserChips(p.userId, room.betAmount);
        });
        rooms.delete(roomId);
        socket.emit('table_cancelled_ok', { newBalance: getUserChips(room.creatorId) });
        broadcastTables();
      }
    });

    socket.on('surrender_match', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.players.length < room.maxPlayers) return;

      const authUser = getAuthenticatedPlayer(room, socket.id);
      if (!authUser) return;

      clearTurnTimer(room);
      clearDisconnectTimer(room);

      const winningTeam: 'TEAM_1' | 'TEAM_2' = authUser.team === 'TEAM_1' ? 'TEAM_2' : 'TEAM_1';
      const winners = room.players.filter(p => p.team === winningTeam);
      const grossPot = room.betAmount > 0 ? room.betAmount * room.maxPlayers : 0;
      const netPot = grossPot * 0.9;
      const rake = grossPot * 0.1;

      if (netPot > 0 && winners.length > 0) {
        const prizePerWinner = netPot / winners.length;
        winners.forEach(w => modifyUserChips(w.userId, prizePerWinner));
        recordTransaction('COMMISSION_RAKE', winners[0].userId, rake, `Comisión rendición mesa ${room.mode} ${room.roomId} ($${room.betAmount} c/u)`);
      }

      io.to(roomId).emit('player_surrendered', {
        surrenderedUser: authUser.userId,
        winningTeam,
        winnerIds: winners.map(w => w.userId),
        winnerId: winners[0]?.userId || '',
        pot: netPot,
        scores: getScoreMap(room),
        reason: 'SURRENDER',
        is2v2: room.mode === '2v2'
      });

      rooms.delete(roomId);
      broadcastTables();
    });

    socket.on('join_room', ({ roomId, userId }) => {
      try {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error_action', { message: 'La mesa no existe.' });
        if (room.players.length >= room.maxPlayers) return socket.emit('error_action', { message: 'La mesa ya está completa.' });
        if (room.players.some(p => p.userId.toLowerCase() === userId.toLowerCase())) {
          return socket.emit('error_action', { message: 'Ya estás en esta mesa.' });
        }
        
        if (room.betAmount > 0) {
          const successDeduct = modifyUserChips(userId, -room.betAmount);
          if (!successDeduct) return socket.emit('error_action', { message: 'Saldo insuficiente.' });
        }

        const nextTeam: 'TEAM_1' | 'TEAM_2' = (room.players.length % 2 === 0) ? 'TEAM_1' : 'TEAM_2';
        const newPlayer: PlayerSlot = {
          userId,
          socketId: socket.id,
          team: nextTeam,
          avatar: getUserAvatar(userId)
        };

        room.players.push(newPlayer);
        socket.join(roomId);

        broadcastTables();

        if (room.players.length === room.maxPlayers) {
          const grossPot = room.betAmount > 0 ? room.betAmount * room.maxPlayers : 0;
          const netPot = grossPot * 0.9;

          io.to(roomId).emit('game_ready', {
            roomId: room.roomId,
            mode: room.mode,
            players: room.players.map(p => ({ userId: p.userId, avatar: p.avatar, team: p.team })),
            pot: netPot,
            targetPoints: room.targetPoints, 
            withFlor: room.withFlor, 
            betAmount: room.betAmount
          });

          setTimeout(() => { dealAutoHand(room); }, 1200);
        } else {
          io.to(roomId).emit('player_joined_waiting', {
            roomId: room.roomId,
            playersCount: room.players.length,
            maxPlayers: room.maxPlayers,
            players: room.players.map(p => ({ userId: p.userId, avatar: p.avatar, team: p.team }))
          });
        }
      } catch (err) { console.error('Error uniéndose a mesa:', err); }
    });

    socket.on('disconnect', () => {
      for (const [roomId, room] of rooms.entries()) {
        const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex === -1) continue;

        const player = room.players[playerIndex];

        if (room.players.length < room.maxPlayers) {
          if (room.betAmount > 0) modifyUserChips(player.userId, room.betAmount);
          room.players.splice(playerIndex, 1);

          if (room.players.length === 0 || player.userId === room.creatorId) {
            room.players.forEach(p => {
              if (room.betAmount > 0) modifyUserChips(p.userId, room.betAmount);
            });
            rooms.delete(roomId);
          }
          broadcastTables();
          continue;
        }

        startDisconnectGracePeriod(room, player.userId);
      }
    });

    // CHAT PRIVADO EXCLUSIVO PARA COMPAÑEROS DE EQUIPO (2 vs 2)
    socket.on('send_team_chat', ({ roomId, message }) => {
      try {
        const room = rooms.get(roomId);
        if (!room || !message) return;

        const authUser = getAuthenticatedPlayer(room, socket.id);
        if (!authUser) return;

        const cleanMsg = String(message).trim().slice(0, 100);
        if (!cleanMsg) return;

        // Enviar solo a los integrantes del mismo equipo
        const teammates = room.players.filter(p => p.team === authUser.team);
        teammates.forEach(tm => {
          if (tm.socketId) {
            io.to(tm.socketId).emit('team_chat_received', {
              sender: authUser.userId,
              message: cleanMsg,
              avatar: authUser.avatar,
              team: authUser.team
            });
          }
        });
      } catch (err) {
        console.error('Error en send_team_chat:', err);
      }
    });

    socket.on('play_card', ({ roomId, cardId }) => {
      const room = rooms.get(roomId);
      if (!room || !room.gameRound || room.disconnectedUser) return;

      const authUser = getAuthenticatedPlayer(room, socket.id);
      if (!authUser) return socket.emit('error_action', { message: 'No perteneces a esta partida.' });

      if (room.gameRound.currentTurn.toLowerCase() !== authUser.userId.toLowerCase()) {
        return socket.emit('error_action', { message: 'No es tu turno de jugar carta.' });
      }
      executePlayCard(room, authUser.userId, cardId);
    });

    socket.on('declare_envido_points', ({ roomId, points }) => {
      const room = rooms.get(roomId);
      if (!room || room.disconnectedUser) return;
      const authUser = getAuthenticatedPlayer(room, socket.id);
      if (authUser) executeDeclareEnvido(room, authUser.userId, points);
    });

    socket.on('say_son_buenas', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room || room.disconnectedUser) return;
      const authUser = getAuthenticatedPlayer(room, socket.id);
      if (authUser) executeSonBuenas(room, authUser.userId);
    });

    socket.on('send_call', ({ roomId, callType }) => {
      try {
        const room = rooms.get(roomId);
        if (!room || !room.gameRound || room.disconnectedUser) return;

        const authUser = getAuthenticatedPlayer(room, socket.id);
        if (!authUser) return socket.emit('error_action', { message: 'No perteneces a esta mesa.' });

        const myTeam = authUser.team;
        const rivals = room.gameRound.getRivals(authUser.userId);
        const nextRivalInTurn = rivals[0] || '';
        const currentTrick = room.gameRound.currentTrickIndex;

        const callerHand = room.gameRound.getPlayerHand(authUser.userId);
        const callerCardsPlayed = callerHand ? callerHand.cardsPlayed.filter(Boolean).length : 0;

        if (room.gameRound.awaitingResponseFrom) {
          const awaitingPlayer = room.gameRound.getPlayerHand(room.gameRound.awaitingResponseFrom);
          if (awaitingPlayer?.team === myTeam) {
            return socket.emit('error_action', { message: 'Tu equipo no tiene que responder a este canto.' });
          }
        } else {
          if (room.gameRound.currentTurn.toLowerCase() !== authUser.userId.toLowerCase()) {
            return socket.emit('error_action', { message: 'No es tu turno para cantar o jugar.' });
          }
        }

        if (room.envidoPendingCaller && ['TRUCO', 'RETRUCO', 'VALE_4'].includes(callType)) {
          return socket.emit('error_action', { message: '¡El Envido está primero!' });
        }

        if (callType === 'FLOR') {
          if (!room.withFlor) return socket.emit('error_action', { message: 'Partida SIN FLOR.' });
          if (currentTrick > 0 || room.gameRound.envidoResolved) return socket.emit('error_action', { message: 'El tiempo para cantar Flor ya cerró.' });
          return resolveFlor(room, authUser.userId);
        }

        if (['ENVIDO', 'ENVIDO_ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO'].includes(callType)) {
          if (currentTrick > 0 || room.gameRound.envidoResolved) {
            return socket.emit('error_action', { message: 'El Envido ya cerró.' });
          }

          if (room.envidoChain.length === 0) {
            if (callerCardsPlayed > 0 && !room.gameRound.awaitingResponseFrom) {
              return socket.emit('error_action', { message: 'Ya jugaste tu carta, no podés iniciar el Envido.' });
            }
          }

          room.envidoChain.push(callType);
          room.envidoPendingCaller = authUser.userId;
          room.gameRound.awaitingResponseFrom = nextRivalInTurn;

          io.to(roomId).emit('call_received', { 
            userId: authUser.userId, 
            team: myTeam,
            callType, 
            category: 'ENVIDO', 
            awaitingResponseFrom: nextRivalInTurn, 
            chain: room.envidoChain 
          });
          return startTurnTimer(room, 25);
        }

        if (callType === 'QUIERO_ENVIDO') return startEnvidoDeclarationPhase(room);
        if (callType === 'NO_QUIERO_ENVIDO') return resolveEnvidoDeclined(room, authUser.userId);

        if (callType === 'TRUCO') {
          const responderHand = room.gameRound.getPlayerHand(nextRivalInTurn);
          const responderCardsPlayed = responderHand ? responderHand.cardsPlayed.filter(Boolean).length : 0;
          const canEnvido = (currentTrick === 0 && !room.gameRound.envidoResolved && responderCardsPlayed === 0);

          if (canEnvido) {
            room.pendingTrucoAfterEnvido = {
              callerId: authUser.userId,
              responderId: nextRivalInTurn,
              trucoPointsAtStake: 2,
              callType: 'TRUCO'
            };
          } else {
            room.gameRound.envidoResolved = true;
            room.pendingTrucoAfterEnvido = null;
          }

          room.gameRound.trucoPointsAtStake = 2;
          room.gameRound.awaitingResponseFrom = nextRivalInTurn;
          io.to(roomId).emit('call_received', { 
            userId: authUser.userId, 
            team: myTeam,
            callType: 'TRUCO', 
            category: 'TRUCO', 
            awaitingResponseFrom: nextRivalInTurn, 
            canCallEnvido: canEnvido 
          });
          return startTurnTimer(room, 25);
        }

        if (callType === 'RETRUCO') {
          room.gameRound.envidoResolved = true;
          room.pendingTrucoAfterEnvido = null;
          room.gameRound.trucoPointsAtStake = 3;
          room.gameRound.awaitingResponseFrom = nextRivalInTurn;
          io.to(roomId).emit('call_received', { userId: authUser.userId, team: myTeam, callType: 'RETRUCO', category: 'TRUCO', awaitingResponseFrom: nextRivalInTurn, canCallEnvido: false });
          return startTurnTimer(room, 25);
        }

        if (callType === 'VALE_4') {
          room.gameRound.envidoResolved = true;
          room.pendingTrucoAfterEnvido = null;
          room.gameRound.trucoPointsAtStake = 4;
          room.gameRound.awaitingResponseFrom = nextRivalInTurn;
          io.to(roomId).emit('call_received', { userId: authUser.userId, team: myTeam, callType: 'VALE_4', category: 'TRUCO', awaitingResponseFrom: nextRivalInTurn, canCallEnvido: false });
          return startTurnTimer(room, 25);
        }

        if (callType === 'QUIERO_TRUCO') {
          room.gameRound.envidoResolved = true;
          room.pendingTrucoAfterEnvido = null;
          room.gameRound.awaitingResponseFrom = null;
          room.trucoLevel = room.gameRound.trucoPointsAtStake;
          room.trucoOwnerTeam = myTeam;
          io.to(roomId).emit('truco_accepted', { 
            acceptedBy: authUser.userId, 
            acceptedTeam: myTeam,
            trucoLevel: room.trucoLevel 
          });
          return startTurnTimer(room, 25);
        }

        if (callType === 'NO_QUIERO_TRUCO' || callType === 'ME_VOY_AL_MAZO') {
          room.pendingTrucoAfterEnvido = null;
          return resolveTrucoFold(room, authUser.userId, callType);
        }

      } catch (err) { console.error('Error en send_call:', err); }
    });
  });
}