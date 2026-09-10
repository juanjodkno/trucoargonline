"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocketEvents = setupSocketEvents;
const crypto_1 = __importDefault(require("crypto"));
const trucoGame_1 = require("../game/trucoGame");
const trucoEngine_1 = require("../game/trucoEngine");
const userService_1 = require("../auth/userService");
const activeGameRegistry_1 = require("./activeGameRegistry");
const rooms = new Map();
const pendingRoomCreations = new Set();
const BOT_DEFAULT_ID = 'La_Maquina';
function setupSocketEvents(io) {
    function getAvailableRooms() {
        return Array.from(rooms.values())
            .filter(r => !r.guestId)
            .map(r => ({
            roomId: r.roomId,
            creatorId: r.creatorId,
            creatorAvatar: (0, userService_1.getUserAvatar)(r.creatorId),
            betAmount: r.betAmount,
            targetPoints: r.targetPoints,
            withFlor: r.withFlor
        }));
    }
    function broadcastTables() {
        io.emit('update_tables', getAvailableRooms());
    }
    function getScoreMap(room) {
        const map = { [room.creatorId]: room.scoreP1 };
        if (room.guestId)
            map[room.guestId] = room.scoreP2;
        return map;
    }
    function clearTurnTimer(room) {
        if (room.turnInterval) {
            clearInterval(room.turnInterval);
            room.turnInterval = undefined;
        }
        if (room.botThinkingTimeout) {
            clearTimeout(room.botThinkingTimeout);
            room.botThinkingTimeout = undefined;
        }
        room.turnDeadline = undefined;
    }
    function clearDisconnectTimer(room) {
        if (room.disconnectInterval) {
            clearInterval(room.disconnectInterval);
            room.disconnectInterval = undefined;
        }
        room.disconnectedUser = null;
        room.disconnectDeadline = undefined;
    }
    function getAuthenticatedUserId(room, socketId) {
        if (room.creatorSocketId === socketId)
            return room.creatorId;
        if (room.guestSocketId === socketId)
            return room.guestId || null;
        return null;
    }
    function releaseRoomPresence(room) {
        if (room.isBotGame)
            return;
        (0, activeGameRegistry_1.releaseActiveGame)(room.creatorId, '1v1', room.roomId);
        if (room.guestId)
            (0, activeGameRegistry_1.releaseActiveGame)(room.guestId, '1v1', room.roomId);
    }
    function isBotPlayer(room, userId) {
        return !!room.isBotGame && !!room.botId && !!userId && room.botId.toLowerCase() === userId.toLowerCase();
    }
    function getAllCardsForUser(room, userId) {
        if (!room.gameRound)
            return [];
        const hand = userId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        return hand.cards.concat(hand.cardsPlayed.filter(Boolean));
    }
    function getBotHand(room) {
        if (!room.gameRound || !room.botId)
            return null;
        return room.botId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
    }
    function getHumanId(room) {
        if (!room.botId)
            return room.creatorId;
        return room.creatorId.toLowerCase() === room.botId.toLowerCase() ? (room.guestId || room.creatorId) : room.creatorId;
    }
    function getBotPower(room) {
        const hand = getBotHand(room);
        if (!hand || hand.cards.length === 0)
            return 0;
        // 0..1 aprox. Jerarquía menor = carta más fuerte.
        const values = hand.cards.map(c => Math.max(0, Math.min(1, (15 - c.hierarchy) / 14)));
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const strongBonus = hand.cards.filter(c => c.hierarchy <= 6).length * 0.10;
        return Math.min(1, avg + strongBonus);
    }
    function isBotActionPending(room) {
        if (!room.isBotGame || !room.botId || !room.gameRound || room.disconnectedUser)
            return false;
        // IMPORTANTE: durante la declaración de tantos/flor, el turno de cartas queda congelado.
        // Si declara el humano, la máquina NO debe usar currentTurn para tirar una carta.
        if (room.isDeclaringEnvido) {
            return isBotPlayer(room, room.envidoDeclarer);
        }
        // Mientras haya un canto esperando respuesta, tampoco existe turno de carta.
        if (room.gameRound.awaitingResponseFrom) {
            return isBotPlayer(room, room.gameRound.awaitingResponseFrom);
        }
        return isBotPlayer(room, room.gameRound.currentTurn);
    }
    function scheduleBotAction(room) {
        if (!isBotActionPending(room))
            return;
        if (room.botThinkingTimeout)
            clearTimeout(room.botThinkingTimeout);
        const delay = 700 + Math.floor(Math.random() * 650);
        room.turnDeadline = Date.now() + delay;
        io.to(room.roomId).emit('timer_tick', {
            secondsLeft: Math.max(1, Math.ceil(delay / 1000)),
            turnDeadline: room.turnDeadline
        });
        room.botThinkingTimeout = setTimeout(() => {
            room.botThinkingTimeout = undefined;
            room.turnDeadline = undefined;
            if (rooms.get(room.roomId) !== room)
                return;
            runBotAction(room);
        }, delay);
    }
    function emitBotCall(room, callType, category, awaitingResponseFrom, extra = {}) {
        io.to(room.roomId).emit('call_received', {
            userId: room.botId,
            callType,
            category,
            awaitingResponseFrom,
            ...extra
        });
    }
    function botRaiseEnvido(room, callType) {
        if (!room.gameRound || !room.botId)
            return;
        const humanId = getHumanId(room);
        room.envidoChain.push(callType);
        room.envidoPendingCaller = room.botId;
        room.gameRound.awaitingResponseFrom = humanId;
        emitBotCall(room, callType, 'ENVIDO', humanId, { chain: room.envidoChain });
        startTurnTimer(room, 30);
    }
    function botRespondToEnvido(room) {
        if (!room.gameRound || !room.botId)
            return;
        const score = (0, trucoEngine_1.getEnvidoDetails)(getAllCardsForUser(room, room.botId)).score;
        const lastCall = room.envidoChain[room.envidoChain.length - 1] || 'ENVIDO';
        const roll = Math.random();
        if (lastCall === 'ENVIDO' && score >= 31 && roll < 0.32)
            return botRaiseEnvido(room, 'REAL_ENVIDO');
        if (lastCall === 'ENVIDO' && score >= 29 && roll < 0.52)
            return botRaiseEnvido(room, 'ENVIDO_ENVIDO');
        if (lastCall === 'ENVIDO_ENVIDO' && score >= 31 && roll < 0.40)
            return botRaiseEnvido(room, 'REAL_ENVIDO');
        if (lastCall === 'REAL_ENVIDO' && score >= 32 && roll < 0.22)
            return botRaiseEnvido(room, 'FALTA_ENVIDO');
        const acceptThreshold = lastCall === 'FALTA_ENVIDO' ? 29 : lastCall === 'REAL_ENVIDO' ? 27 : lastCall === 'ENVIDO_ENVIDO' ? 26 : 24;
        if (score >= acceptThreshold || (score >= acceptThreshold - 2 && Math.random() < 0.22)) {
            room.gameRound.awaitingResponseFrom = null;
            room.envidoPendingCaller = null;
            return startEnvidoDeclarationPhase(room, false, room.botId);
        }
        resolveEnvidoDeclined(room, room.botId);
    }
    function botRaiseFlor(room, callType) {
        if (!room.gameRound || !room.botId)
            return;
        const humanId = getHumanId(room);
        room.gameRound.envidoResolved = true;
        room.envidoPendingCaller = null;
        room.florChain.push(callType);
        room.florPendingCaller = room.botId;
        room.gameRound.awaitingResponseFrom = humanId;
        emitBotCall(room, callType, 'FLOR', humanId, { chain: room.florChain });
        startTurnTimer(room, 30);
    }
    function botRespondToFlor(room) {
        if (!room.gameRound || !room.botId)
            return;
        const cards = getAllCardsForUser(room, room.botId);
        if (!(0, trucoEngine_1.hasFlor)(cards))
            return resolveFlorDeclined(room, room.botId);
        const florScore = (0, trucoEngine_1.calculateFlor)(cards);
        const lastCall = room.florChain[room.florChain.length - 1] || 'FLOR';
        if (lastCall === 'FLOR') {
            if (florScore >= 35 && Math.random() < 0.35)
                return botRaiseFlor(room, 'CONTRAFLOR_AL_JUEGO');
            if (florScore >= 30 && Math.random() < 0.55)
                return botRaiseFlor(room, 'CONTRAFLOR');
            room.gameRound.awaitingResponseFrom = null;
            room.florPendingCaller = null;
            return startEnvidoDeclarationPhase(room, true);
        }
        if (lastCall === 'CONTRAFLOR') {
            if (florScore >= 34 && Math.random() < 0.40)
                return botRaiseFlor(room, 'CONTRAFLOR_AL_JUEGO');
            if (florScore >= 27) {
                room.gameRound.awaitingResponseFrom = null;
                room.florPendingCaller = null;
                return startEnvidoDeclarationPhase(room, true);
            }
            return resolveFlorDeclined(room, room.botId);
        }
        if (florScore >= 30) {
            room.gameRound.awaitingResponseFrom = null;
            room.florPendingCaller = null;
            return startEnvidoDeclarationPhase(room, true);
        }
        resolveFlorDeclined(room, room.botId);
    }
    function botRespondToTruco(room) {
        if (!room.gameRound || !room.botId)
            return;
        const humanId = getHumanId(room);
        const stake = room.gameRound.trucoPointsAtStake || 2;
        const power = getBotPower(room);
        // Ante el primer Truco, si todavía corresponde cantar tantos, la máquina puede hacerlo antes de responder.
        if (stake === 2 && room.pendingTrucoAfterEnvido && !room.gameRound.envidoResolved) {
            const envidoScore = (0, trucoEngine_1.getEnvidoDetails)(getAllCardsForUser(room, room.botId)).score;
            const botHasFlor = room.withFlor && (0, trucoEngine_1.hasFlor)(getAllCardsForUser(room, room.botId));
            if (botHasFlor)
                return botInitiateFlor(room);
            if (envidoScore >= 28 && Math.random() < 0.55)
                return botRaiseEnvido(room, envidoScore >= 32 ? 'REAL_ENVIDO' : 'ENVIDO');
        }
        // Puede subir el canto directamente, igual que un jugador real.
        if (stake === 2 && power >= 0.72 && Math.random() < 0.42) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.pendingTrucoAfterEnvido = null;
            room.gameRound.trucoPointsAtStake = 3;
            room.gameRound.awaitingResponseFrom = humanId;
            emitBotCall(room, 'RETRUCO', 'TRUCO', humanId, { canCallEnvido: false });
            return startTurnTimer(room, 30);
        }
        if (stake === 3 && power >= 0.82 && Math.random() < 0.36) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.pendingTrucoAfterEnvido = null;
            room.gameRound.trucoPointsAtStake = 4;
            room.gameRound.awaitingResponseFrom = humanId;
            emitBotCall(room, 'VALE_4', 'TRUCO', humanId, { canCallEnvido: false });
            return startTurnTimer(room, 30);
        }
        const acceptThreshold = stake >= 4 ? 0.60 : stake === 3 ? 0.46 : 0.30;
        if (power >= acceptThreshold || Math.random() < 0.14) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.pendingTrucoAfterEnvido = null;
            room.gameRound.awaitingResponseFrom = null;
            room.trucoLevel = stake;
            room.trucoOwner = room.botId;
            io.to(room.roomId).emit('truco_accepted', {
                acceptedBy: room.botId,
                trucoLevel: room.trucoLevel,
                trucoOwner: room.trucoOwner
            });
            return startTurnTimer(room, 30);
        }
        resolveTrucoFold(room, room.botId, 'NO_QUIERO_TRUCO');
    }
    function botInitiateFlor(room) {
        if (!room.gameRound || !room.botId || !room.withFlor)
            return false;
        const botCards = getAllCardsForUser(room, room.botId);
        if (!(0, trucoEngine_1.hasFlor)(botCards))
            return false;
        const humanId = getHumanId(room);
        const humanCards = getAllCardsForUser(room, humanId);
        const humanHasFlor = (0, trucoEngine_1.hasFlor)(humanCards);
        if (!humanHasFlor) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.gameRound.awaitingResponseFrom = null;
            room.florPendingCaller = null;
            room.envidoPendingCaller = null;
            room.scoreP2 += 3;
            const florPoints = (0, trucoEngine_1.calculateFlor)(botCards);
            room.envidoWinnerRecord = { winnerId: room.botId, score: florPoints, cards: botCards, pointsAwarded: 3 };
            io.to(room.roomId).emit('flor_declared', {
                winnerId: room.botId,
                score: florPoints,
                cards: botCards,
                pointsAwarded: 3,
                scores: getScoreMap(room),
                trucoLevel: room.trucoLevel,
                trucoOwner: room.trucoOwner,
                currentTurn: room.gameRound.currentTurn
            });
            if (room.scoreP2 >= room.targetPoints) {
                io.to(room.roomId).emit('show_envido_winner', {
                    winnerId: room.botId, score: florPoints, cards: botCards, durationMs: 3500
                });
                setTimeout(() => checkMatchEnd(room), 3500);
            }
            else if (!checkAndResumePendingTruco(room)) {
                startTurnTimer(room, 30);
            }
            return true;
        }
        room.gameRound.envidoResolved = true;
        room.envidoPendingCaller = null;
        room.florChain.push('FLOR');
        room.florPendingCaller = room.botId;
        room.gameRound.awaitingResponseFrom = humanId;
        emitBotCall(room, 'FLOR', 'FLOR', humanId, { chain: room.florChain });
        startTurnTimer(room, 30);
        return true;
    }
    function botInitiateEnvido(room) {
        if (!room.gameRound || !room.botId)
            return false;
        if (room.gameRound.currentTrickIndex !== 0 || room.gameRound.envidoResolved || room.gameRound.florResolved)
            return false;
        const hand = getBotHand(room);
        if (!hand || hand.cardsPlayed.filter(Boolean).length > 0)
            return false;
        if (room.envidoChain.length > 0 || room.florChain.length > 0)
            return false;
        if (room.withFlor && (0, trucoEngine_1.hasFlor)(getAllCardsForUser(room, room.botId)))
            return false;
        const score = (0, trucoEngine_1.getEnvidoDetails)(getAllCardsForUser(room, room.botId)).score;
        if (score < 28 && Math.random() > 0.08)
            return false;
        const callType = score >= 32 && Math.random() < 0.30 ? 'REAL_ENVIDO' : 'ENVIDO';
        botRaiseEnvido(room, callType);
        return true;
    }
    function botInitiateTruco(room) {
        if (!room.gameRound || !room.botId || room.gameRound.awaitingResponseFrom)
            return false;
        const humanId = getHumanId(room);
        const power = getBotPower(room);
        if (room.trucoLevel === 1) {
            if (power < 0.55 && Math.random() > 0.10)
                return false;
            const responderHand = humanId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
            const responderCardsPlayed = responderHand.cardsPlayed.filter(Boolean).length;
            const canEnvido = room.gameRound.currentTrickIndex === 0 && !room.gameRound.envidoResolved && responderCardsPlayed === 0;
            if (canEnvido) {
                room.pendingTrucoAfterEnvido = {
                    callerId: room.botId,
                    responderId: humanId,
                    trucoPointsAtStake: 2,
                    callType: 'TRUCO'
                };
            }
            else {
                room.gameRound.envidoResolved = true;
                room.gameRound.florResolved = true;
                room.pendingTrucoAfterEnvido = null;
            }
            room.gameRound.trucoPointsAtStake = 2;
            room.gameRound.awaitingResponseFrom = humanId;
            emitBotCall(room, 'TRUCO', 'TRUCO', humanId, { canCallEnvido: canEnvido });
            startTurnTimer(room, 30);
            return true;
        }
        if (room.trucoOwner && isBotPlayer(room, room.trucoOwner) && room.trucoLevel === 2 && power >= 0.68 && Math.random() < 0.35) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.gameRound.trucoPointsAtStake = 3;
            room.gameRound.awaitingResponseFrom = humanId;
            emitBotCall(room, 'RETRUCO', 'TRUCO', humanId, { canCallEnvido: false });
            startTurnTimer(room, 30);
            return true;
        }
        if (room.trucoOwner && isBotPlayer(room, room.trucoOwner) && room.trucoLevel === 3 && power >= 0.80 && Math.random() < 0.30) {
            room.gameRound.envidoResolved = true;
            room.gameRound.florResolved = true;
            room.gameRound.trucoPointsAtStake = 4;
            room.gameRound.awaitingResponseFrom = humanId;
            emitBotCall(room, 'VALE_4', 'TRUCO', humanId, { canCallEnvido: false });
            startTurnTimer(room, 30);
            return true;
        }
        return false;
    }
    function chooseBotCard(room) {
        if (!room.gameRound || !room.botId)
            return null;
        const hand = getBotHand(room);
        if (!hand || hand.cards.length === 0)
            return null;
        const idx = room.gameRound.currentTrickIndex;
        const humanId = getHumanId(room);
        const humanHand = humanId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const rivalPlayed = humanHand.cardsPlayed[idx];
        const weakestFirst = [...hand.cards].sort((a, b) => b.hierarchy - a.hierarchy);
        if (rivalPlayed) {
            const winning = weakestFirst.filter(c => c.hierarchy < rivalPlayed.hierarchy);
            if (winning.length > 0)
                return winning[0]; // gana gastando la carta menos fuerte posible
            return weakestFirst[0];
        }
        // Al salir, conserva las mejores cartas salvo cuando el partido o el canto está muy jugado.
        if (hand.cards.length === 1)
            return hand.cards[0];
        if (room.trucoLevel >= 3 || idx >= 1) {
            const strongestFirst = [...hand.cards].sort((a, b) => a.hierarchy - b.hierarchy);
            return Math.random() < 0.50 ? strongestFirst[0] : weakestFirst[0];
        }
        return weakestFirst[0];
    }
    function runBotAction(room) {
        if (!room.isBotGame || !room.botId || !room.gameRound || room.disconnectedUser)
            return;
        const botId = room.botId;
        // La fase de declaración de tantos/flor tiene prioridad absoluta sobre las cartas.
        // Si le toca declarar al humano, la máquina simplemente espera.
        if (room.isDeclaringEnvido) {
            if (isBotPlayer(room, room.envidoDeclarer)) {
                const cards = getAllCardsForUser(room, botId);
                const score = room.isFlorDeclaration ? (0, trucoEngine_1.calculateFlor)(cards) : (0, trucoEngine_1.getEnvidoDetails)(cards).score;
                if (room.highestEnvidoScore === 0 || score > room.highestEnvidoScore)
                    executeDeclareEnvido(room, botId, score);
                else
                    executeSonBuenas(room, botId);
            }
            return;
        }
        // Igual criterio para cualquier canto pendiente: hasta resolverlo no se juega carta.
        if (room.gameRound.awaitingResponseFrom) {
            if (isBotPlayer(room, room.gameRound.awaitingResponseFrom)) {
                if (room.envidoPendingCaller)
                    return botRespondToEnvido(room);
                if (room.florPendingCaller)
                    return botRespondToFlor(room);
                return botRespondToTruco(room);
            }
            return;
        }
        if (!isBotPlayer(room, room.gameRound.currentTurn))
            return;
        const botHand = getBotHand(room);
        if (!botHand)
            return;
        const canStillCallTantos = room.gameRound.currentTrickIndex === 0 && botHand.cardsPlayed.filter(Boolean).length === 0;
        if (canStillCallTantos && !room.gameRound.envidoResolved && !room.gameRound.florResolved) {
            if (room.withFlor && (0, trucoEngine_1.hasFlor)(getAllCardsForUser(room, botId)) && botInitiateFlor(room))
                return;
            if (botInitiateEnvido(room))
                return;
        }
        if (botInitiateTruco(room))
            return;
        const card = chooseBotCard(room);
        if (card)
            executePlayCard(room, botId, card.id);
    }
    async function settleAndCloseMatch(room, winnerId, loserId, finishReason, eventType, surrenderedUser) {
        if (room.isBotGame) {
            clearTurnTimer(room);
            clearDisconnectTimer(room);
            io.to(room.roomId).emit(eventType === 'player_surrendered' ? 'player_surrendered' : 'match_finished', {
                winnerId,
                surrenderedUser: surrenderedUser || loserId,
                scores: getScoreMap(room),
                pot: 0,
                isBotGame: true,
                reason: finishReason
            });
            if (rooms.get(room.roomId) === room)
                rooms.delete(room.roomId);
            return;
        }
        // Candado rápido en RAM. La garantía definitiva está en PostgreSQL:
        // match_settlements.room_id es PRIMARY KEY y bloquea el doble premio.
        if (room.settlementInProgress) {
            console.warn(`[SETTLEMENT IN PROGRESS] ${room.roomId}: segunda liquidación ignorada.`);
            return;
        }
        room.settlementInProgress = true;
        clearTurnTimer(room);
        clearDisconnectTimer(room);
        const result = await (0, userService_1.settleMatchOnce)({
            roomId: room.roomId,
            winnerUsername: winnerId,
            loserUsername: loserId,
            betPerPlayer: room.betAmount,
            finishReason
        });
        if (!result.success || !result.settlement) {
            room.settlementInProgress = false;
            console.error(`[SETTLEMENT FAILED] ${room.roomId}: ${result.message || 'error desconocido'}`);
            io.to(room.roomId).emit('error_action', {
                message: 'No se pudo liquidar la partida. El saldo quedó protegido y no se duplicó el pago.'
            });
            return;
        }
        const settlement = result.settlement;
        if (eventType === 'player_surrendered') {
            io.to(room.roomId).emit('player_surrendered', {
                surrenderedUser: surrenderedUser || loserId,
                winnerId,
                pot: settlement.winnerPrize,
                scores: getScoreMap(room),
                winnerBalance: settlement.winnerBalanceAfter,
                reason: finishReason
            });
        }
        else {
            io.to(room.roomId).emit('match_finished', {
                winnerId,
                scores: getScoreMap(room),
                pot: settlement.winnerPrize,
                winnerBalance: settlement.winnerBalanceAfter
            });
        }
        releaseRoomPresence(room);
        if (rooms.get(room.roomId) === room)
            rooms.delete(room.roomId);
        broadcastTables();
    }
    function checkMatchEnd(room) {
        if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
            const matchWinner = room.scoreP1 >= room.targetPoints ? room.creatorId : room.guestId;
            const matchLoser = matchWinner.toLowerCase() === room.creatorId.toLowerCase()
                ? room.guestId
                : room.creatorId;
            if (room.isBotGame) {
                clearTurnTimer(room);
                clearDisconnectTimer(room);
                io.to(room.roomId).emit('match_finished', {
                    winnerId: matchWinner,
                    scores: getScoreMap(room),
                    pot: 0,
                    isBotGame: true
                });
                if (rooms.get(room.roomId) === room)
                    rooms.delete(room.roomId);
            }
            else {
                void settleAndCloseMatch(room, matchWinner, matchLoser, 'SCORE', 'match_finished');
            }
            return true;
        }
        return false;
    }
    function startTurnTimer(room, seconds = 30) {
        clearTurnTimer(room);
        if (room.disconnectedUser)
            return;
        if (isBotActionPending(room)) {
            scheduleBotAction(room);
            return;
        }
        let timeLeft = seconds;
        room.turnDeadline = Date.now() + (seconds * 1000);
        io.to(room.roomId).emit('timer_tick', {
            secondsLeft: timeLeft,
            turnDeadline: room.turnDeadline
        });
        room.turnInterval = setInterval(() => {
            timeLeft--;
            if (timeLeft > 0) {
                io.to(room.roomId).emit('timer_tick', {
                    secondsLeft: timeLeft,
                    turnDeadline: room.turnDeadline
                });
            }
            else {
                io.to(room.roomId).emit('timer_tick', { secondsLeft: 0, turnDeadline: room.turnDeadline });
                clearTurnTimer(room);
                handleTimeout(room);
            }
        }, 1000);
    }
    function handleTimeout(room) {
        if (!room.gameRound || room.disconnectedUser)
            return;
        if (room.isDeclaringEnvido && room.envidoDeclarer) {
            const activeUser = room.envidoDeclarer;
            const hand = activeUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
            const allCards = hand.cards.concat(hand.cardsPlayed.filter(Boolean));
            let score = 0;
            if (room.isFlorDeclaration) {
                score = (0, trucoEngine_1.calculateFlor)(allCards);
            }
            else {
                score = (0, trucoEngine_1.getEnvidoDetails)(allCards).score;
            }
            if (room.highestEnvidoScore === 0) {
                executeDeclareEnvido(room, activeUser, score);
            }
            else {
                if (score > room.highestEnvidoScore) {
                    executeDeclareEnvido(room, activeUser, score);
                }
                else {
                    executeSonBuenas(room, activeUser);
                }
            }
            return;
        }
        if (room.gameRound.awaitingResponseFrom) {
            const responderId = room.gameRound.awaitingResponseFrom;
            if (room.envidoPendingCaller) {
                resolveEnvidoDeclined(room, responderId);
            }
            else if (room.florPendingCaller) {
                resolveFlorDeclined(room, responderId);
            }
            else {
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
    function startDisconnectGracePeriod(room, disconnectedUser) {
        // Guardamos el tiempo REAL que quedaba en el turno antes de pausarlo.
        // Así una actualización/reconexión no vuelve a regalar 30 segundos.
        room.pausedTurnSeconds = room.turnDeadline
            ? Math.max(1, Math.floor((room.turnDeadline - Date.now()) / 1000))
            : undefined;
        clearTurnTimer(room);
        clearDisconnectTimer(room);
        room.disconnectedUser = disconnectedUser;
        let graceLeft = 45;
        room.disconnectDeadline = Date.now() + (graceLeft * 1000);
        io.to(room.roomId).emit('player_disconnected_grace', {
            disconnectedUser,
            secondsLeft: graceLeft,
            disconnectDeadline: room.disconnectDeadline
        });
        room.disconnectInterval = setInterval(() => {
            graceLeft--;
            if (graceLeft > 0) {
                io.to(room.roomId).emit('disconnect_timer_tick', {
                    disconnectedUser,
                    secondsLeft: graceLeft,
                    disconnectDeadline: room.disconnectDeadline
                });
            }
            else {
                clearDisconnectTimer(room);
                if (!rooms.has(room.roomId))
                    return;
                const isP1 = room.creatorId.toLowerCase() === disconnectedUser.toLowerCase();
                const winnerId = isP1 ? room.guestId : room.creatorId;
                if (room.isBotGame) {
                    clearTurnTimer(room);
                    if (rooms.get(room.roomId) === room)
                        rooms.delete(room.roomId);
                    return;
                }
                void settleAndCloseMatch(room, winnerId, disconnectedUser, 'DISCONNECT_TIMEOUT', 'player_surrendered', disconnectedUser);
            }
        }, 1000);
    }
    function dealAutoHand(room) {
        if (!room.guestId || room.disconnectedUser)
            return;
        clearTurnTimer(room);
        const round = new trucoGame_1.TrucoRound(room.creatorId, room.guestId, room.manoId, room.targetPoints, room.withFlor);
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
    function calculateEnvidoPoints(chain, room) {
        if (!chain || chain.length === 0)
            return { acceptedPts: 0, declinedPts: 1 };
        const getCallValue = (call) => {
            if (call === 'ENVIDO' || call === 'ENVIDO_ENVIDO')
                return 2;
            if (call === 'REAL_ENVIDO')
                return 3;
            return 0;
        };
        const lastCall = chain[chain.length - 1];
        let declined = 1;
        if (chain.length > 1) {
            declined = 0;
            for (let i = 0; i < chain.length - 1; i++) {
                declined += getCallValue(chain[i]);
            }
            if (declined === 0)
                declined = 1;
        }
        let accepted = 0;
        if (lastCall === 'FALTA_ENVIDO') {
            if (room) {
                const highestScore = Math.max(room.scoreP1, room.scoreP2);
                accepted = Math.max(1, room.targetPoints - highestScore);
            }
            else {
                accepted = 15;
            }
        }
        else {
            for (const call of chain) {
                accepted += getCallValue(call);
            }
        }
        return { acceptedPts: accepted, declinedPts: declined };
    }
    function startEnvidoDeclarationPhase(room, isFlor = false, acceptedBy) {
        clearTurnTimer(room);
        room.isDeclaringEnvido = true;
        room.isFlorDeclaration = isFlor;
        room.envidoDeclarer = room.manoId;
        room.highestEnvidoScore = 0;
        room.highestEnvidoUser = null;
        io.to(room.roomId).emit('start_envido_declaration', {
            firstDeclarer: room.manoId,
            chain: isFlor ? room.florChain : room.envidoChain,
            isFlor,
            acceptedBy
        });
        startTurnTimer(room, 30);
    }
    function executeDeclareEnvido(room, userId, declaredPoints) {
        // FLUJO ESTRICTO: Si no pasó por el "Quiero" (isDeclaringEnvido es falso), bloqueamos y exigimos la aceptación previa.
        if (!room.gameRound || !room.isDeclaringEnvido)
            return;
        if (room.envidoDeclarer && room.envidoDeclarer.toLowerCase() !== userId.toLowerCase())
            return;
        if (room.highestEnvidoScore === 0) {
            room.highestEnvidoScore = declaredPoints;
            room.highestEnvidoUser = userId;
            const rivalId = userId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
            room.envidoDeclarer = rivalId;
            io.to(room.roomId).emit('envido_points_announced', {
                userId, points: declaredPoints, nextDeclarer: rivalId,
                highestScore: declaredPoints, highestUser: userId, isFinal: false,
            });
            startTurnTimer(room, 30);
        }
        else {
            io.to(room.roomId).emit('envido_points_announced', {
                userId, points: declaredPoints, nextDeclarer: null,
                highestScore: declaredPoints, highestUser: userId, isFinal: true,
            });
            finalizeEnvido(room, userId);
        }
    }
    function executeSonBuenas(room, userId) {
        if (!room.gameRound || !room.isDeclaringEnvido || (room.envidoDeclarer && room.envidoDeclarer.toLowerCase() !== userId.toLowerCase()))
            return;
        const winnerId = room.highestEnvidoUser;
        io.to(room.roomId).emit('son_buenas_said', { userId, winnerId });
        finalizeEnvido(room, winnerId);
    }
    function checkAndResumePendingTruco(room) {
        if (room.pendingTrucoAfterEnvido) {
            const pending = room.pendingTrucoAfterEnvido;
            room.pendingTrucoAfterEnvido = null;
            room.gameRound.trucoPointsAtStake = pending.trucoPointsAtStake;
            room.gameRound.awaitingResponseFrom = pending.responderId;
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
    function finalizeEnvido(room, winnerId) {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        room.isDeclaringEnvido = false;
        room.envidoDeclarer = null;
        room.gameRound.envidoResolved = true;
        room.gameRound.awaitingResponseFrom = null;
        const isFlor = room.isFlorDeclaration;
        let pts = 0;
        let finalScore = 0;
        let winnerCards = [];
        const winnerHand = winnerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const allCards = winnerHand.cards.concat(winnerHand.cardsPlayed.filter(Boolean));
        if (isFlor) {
            room.gameRound.florResolved = true;
            room.florPendingCaller = null;
            pts = room.gameRound.calculateFlorPoints(room.florChain, true, room.scoreP1, room.scoreP2);
            finalScore = (0, trucoEngine_1.calculateFlor)(allCards);
            winnerCards = allCards;
        }
        else {
            room.envidoPendingCaller = null;
            const { acceptedPts } = calculateEnvidoPoints(room.envidoChain, room);
            pts = acceptedPts;
            const details = (0, trucoEngine_1.getEnvidoDetails)(allCards);
            finalScore = details.score;
            winnerCards = details.envidoCards;
        }
        if (winnerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += pts;
        else
            room.scoreP2 += pts;
        room.envidoWinnerRecord = { winnerId, score: finalScore, cards: winnerCards, pointsAwarded: pts };
        if (isFlor) {
            io.to(room.roomId).emit('flor_declared', {
                winnerId, pointsAwarded: pts, scores: getScoreMap(room),
                score: finalScore, cards: winnerCards,
                trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
                currentTurn: room.gameRound.currentTurn
            });
        }
        else {
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
        if (checkAndResumePendingTruco(room))
            return;
        startTurnTimer(room, 30);
    }
    function resolveEnvidoDeclined(room, answeringUserId) {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        room.gameRound.envidoResolved = true;
        room.gameRound.awaitingResponseFrom = null;
        const rivalId = answeringUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
        const callerId = room.envidoPendingCaller || rivalId;
        room.envidoPendingCaller = null;
        const { declinedPts } = calculateEnvidoPoints(room.envidoChain, room);
        if (callerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += declinedPts;
        else
            room.scoreP2 += declinedPts;
        io.to(room.roomId).emit('envido_resolved', {
            winnerId: callerId, pointsAwarded: declinedPts, scores: getScoreMap(room),
            declined: true, trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
            currentTurn: room.gameRound.currentTurn
        });
        if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
            setTimeout(() => { checkMatchEnd(room); }, 500);
            return;
        }
        if (checkAndResumePendingTruco(room))
            return;
        startTurnTimer(room, 30);
    }
    function resolveFlorDeclined(room, answeringUserId) {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        room.gameRound.florResolved = true;
        room.gameRound.envidoResolved = true;
        room.gameRound.awaitingResponseFrom = null;
        const rivalId = answeringUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
        const callerId = room.florPendingCaller || rivalId;
        room.florPendingCaller = null;
        const pointsAwarded = room.gameRound.calculateFlorPoints(room.florChain, false, room.scoreP1, room.scoreP2);
        if (callerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += pointsAwarded;
        else
            room.scoreP2 += pointsAwarded;
        const callerHand = callerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const callerCards = callerHand.cards.concat(callerHand.cardsPlayed.filter(Boolean));
        const score = (0, trucoEngine_1.calculateFlor)(callerCards);
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
        if (checkAndResumePendingTruco(room))
            return;
        startTurnTimer(room, 30);
    }
    function resolveTrucoFold(room, folderUserId, reason = 'NO_QUIERO_TRUCO') {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        const winnerId = folderUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
        // Caso especial validado para este proyecto:
        // J1 canta TRUCO y el rival interrumpe con tantos. Si J1 se va al mazo,
        // entrega los 2 puntos del Truco ya cantado. La parte de Envido se calcula
        // según lo ya aceptado: si la última subida quedó pendiente usa declinedPts;
        // si ya se dijo Quiero y comenzó la declaración usa acceptedPts.
        const pendingTrucoAtFold = room.pendingTrucoAfterEnvido;
        const foldedTrucoCallerDuringPendingEnvido = !!(reason === 'ME_VOY_AL_MAZO' &&
            pendingTrucoAtFold &&
            pendingTrucoAtFold.callType === 'TRUCO' &&
            pendingTrucoAtFold.callerId.toLowerCase() === folderUserId.toLowerCase() &&
            room.envidoChain.length > 0 &&
            !room.gameRound.envidoResolved);
        // 1. Puntos del Truco base
        let trucoPts = 1;
        if (foldedTrucoCallerDuringPendingEnvido) {
            // Regla del proyecto: quien ya cantó Truco y se va al mazo después de que
            // el rival interrumpe con tantos entrega los 2 puntos del Truco cantado.
            trucoPts = 2;
        }
        else if (room.gameRound.awaitingResponseFrom) {
            if (room.gameRound.trucoPointsAtStake === 2)
                trucoPts = 1;
            else if (room.gameRound.trucoPointsAtStake === 3)
                trucoPts = 2;
            else if (room.gameRound.trucoPointsAtStake === 4)
                trucoPts = 3;
        }
        else {
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
            // IMPORTANTE: irse al mazo NO equivale a aceptar la última subida de Envido.
            // Si todavía hay un canto esperando respuesta (envidoPendingCaller), se cobra
            // solamente lo ya comprometido ANTES de esa subida: declinedPts.
            // Ejemplos del proyecto:
            //   ENVIDO -> ENVIDO -> MAZO       = 2 de tantos + 1 de la mano = 3
            //   ENVIDO -> REAL ENVIDO -> MAZO  = 2 de tantos + 1 de la mano = 3
            //   ENVIDO -> FALTA ENVIDO -> MAZO = 2 de tantos + 1 de la mano = 3
            const pendingUnansweredEnvidoAtFold = !!(reason === 'ME_VOY_AL_MAZO' &&
                room.envidoPendingCaller &&
                room.gameRound.awaitingResponseFrom &&
                room.gameRound.awaitingResponseFrom.toLowerCase() === folderUserId.toLowerCase());
            if (pendingUnansweredEnvidoAtFold) {
                extraPts = envidoCalc.declinedPts;
                room.envidoPendingCaller = null;
                room.isDeclaringEnvido = false;
                room.envidoDeclarer = null;
            }
            else if (room.isDeclaringEnvido) {
                // Acá el Envido sí fue querido y ya se estaba declarando: conserva el valor aceptado.
                extraPts = envidoCalc.acceptedPts;
            }
            else {
                extraPts = envidoCalc.declinedPts;
            }
            room.gameRound.envidoResolved = true;
        }
        // Si nadie cantó nada, pero se van al mazo SIN tirar la primera carta, regalan 1 pt de Envido + 1 de Truco.
        else if (reason === 'ME_VOY_AL_MAZO' &&
            room.envidoChain.length === 0 &&
            room.florChain.length === 0 &&
            totalCardsPlayedInTrick0 === 0 &&
            !room.gameRound.envidoResolved) {
            extraPts = 1;
            room.gameRound.envidoResolved = true;
        }
        const totalPts = trucoPts + extraPts;
        // La mano termina acá: no debe quedar un Truco suspendido para la próxima mano.
        room.pendingTrucoAfterEnvido = null;
        if (winnerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += totalPts;
        else
            room.scoreP2 += totalPts;
        io.to(room.roomId).emit('round_ended', {
            winnerId,
            pointsAwarded: totalPts,
            scores: getScoreMap(room),
            reason,
            folderUserId
        });
        handleRoundTransition(room);
    }
    function handleRoundTransition(room, lastCardRevealDelayMs = 0) {
        clearTurnTimer(room);
        if (room.envidoWinnerRecord) {
            // Si la mano terminó por una carta, dejamos esa última carta visible antes
            // de tapar la mesa con el cartel que muestra los tantos del Envido/Flor.
            const winnerRecord = room.envidoWinnerRecord;
            room.envidoWinnerRecord = null;
            setTimeout(() => {
                io.to(room.roomId).emit('show_envido_winner', {
                    winnerId: winnerRecord.winnerId, score: winnerRecord.score,
                    cards: winnerRecord.cards, durationMs: 3500,
                });
            }, lastCardRevealDelayMs);
            setTimeout(() => {
                if (checkMatchEnd(room))
                    return;
                room.manoId = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? (room.guestId || room.creatorId) : room.creatorId;
                dealAutoHand(room);
            }, lastCardRevealDelayMs + 3800);
            return;
        }
        if (checkMatchEnd(room))
            return;
        room.manoId = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? (room.guestId || room.creatorId) : room.creatorId;
        setTimeout(() => { dealAutoHand(room); }, 3000);
    }
    function executePlayCard(room, userId, cardId) {
        if (!room.gameRound)
            return;
        // Candado exclusivo del modo máquina: nunca permitir una carta mientras se
        // declaran tantos/flor o existe un canto esperando respuesta. Esto evita que
        // un timeout/acción del bot se cuele entre un "Quiero" y la declaración.
        if (room.isBotGame && (room.isDeclaringEnvido || room.gameRound.awaitingResponseFrom)) {
            return;
        }
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
            }
            else {
                room.scoreP2 += finalTrucoPoints;
            }
            io.to(room.roomId).emit('round_ended', {
                winnerId: result.winnerId, pointsAwarded: finalTrucoPoints, scores: getScoreMap(room),
            });
            // LIMPIEZA ESTRICTA: Reseteamos el nivel del truco a 1 para que la próxima mano nazca limpia
            room.trucoLevel = 1;
            // La última carta queda visible 2 segundos antes de mostrar los tantos pendientes.
            handleRoundTransition(room, 2000);
        }
        else {
            startTurnTimer(room, 30);
        }
    }
    function sendFullSync(socket, room, userId) {
        if (!room.gameRound)
            return;
        const isP1 = userId.toLowerCase() === room.creatorId.toLowerCase();
        const myHand = isP1 ? room.gameRound.p1 : room.gameRound.p2;
        const rivalHand = isP1 ? room.gameRound.p2 : room.gameRound.p1;
        const rivalUsername = isP1 ? (room.guestId || '') : room.creatorId;
        const tricksData = { 0: [], 1: [], 2: [] };
        for (let i = 0; i < 3; i++) {
            const p1Card = room.gameRound.p1.cardsPlayed[i];
            const p2Card = room.gameRound.p2.cardsPlayed[i];
            if (p1Card)
                tricksData[i].push({ userId: room.creatorId, cardId: p1Card.id });
            if (p2Card && room.guestId)
                tricksData[i].push({ userId: room.guestId, cardId: p2Card.id });
        }
        const secondsLeft = room.turnDeadline
            ? Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000))
            : undefined;
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
            myOriginalCards: getAllCardsForUser(room, userId),
            oppCardsCount: rivalHand.cards.length,
            tricks: tricksData,
            trickWinners: room.gameRound.trickWinners,
            envidoResolved: room.gameRound.envidoResolved,
            trucoLevel: room.trucoLevel,
            trucoOwner: room.trucoOwner,
            awaitingResponseFrom: room.gameRound.awaitingResponseFrom,
            isDeclaringEnvido: room.isDeclaringEnvido,
            isFlorDeclaration: !!room.isFlorDeclaration,
            envidoDeclarer: room.envidoDeclarer,
            highestEnvidoScore: room.highestEnvidoScore,
            highestEnvidoUser: room.highestEnvidoUser,
            envidoChain: room.envidoChain,
            florChain: room.florChain,
            secondsLeft,
            turnDeadline: room.turnDeadline,
            disconnectedUser: room.disconnectedUser || null,
            disconnectSecondsLeft: room.disconnectDeadline
                ? Math.max(0, Math.ceil((room.disconnectDeadline - Date.now()) / 1000))
                : undefined,
            disconnectDeadline: room.disconnectDeadline,
            isBotGame: !!room.isBotGame,
            logs: room.logs.slice(),
            myAvatar: (0, userService_1.getUserAvatar)(userId),
            rivalAvatar: room.isBotGame ? 'gaucho' : (rivalUsername ? (0, userService_1.getUserAvatar)(rivalUsername) : 'gaucho')
        });
    }
    // Reconstruye únicamente los controles/cantos que estén pendientes.
    // silentSync evita repetir audios y líneas del log al volver desde otra app.
    function sendPendingInteractionSync(socket, room) {
        if (!room.gameRound)
            return;
        if (room.isDeclaringEnvido && room.envidoDeclarer) {
            const isFlor = !!room.isFlorDeclaration;
            const chain = isFlor ? room.florChain : room.envidoChain;
            // Primero dejamos la interfaz en el modo de declaración.
            // Si ya hubo un primer canto, el evento siguiente reconstruye exactamente
            // si corresponde CANTAR o SON BUENAS al segundo declarante.
            socket.emit('start_envido_declaration', {
                firstDeclarer: room.highestEnvidoUser ? '__sync_wait__' : room.envidoDeclarer,
                chain,
                isFlor,
                silentSync: true
            });
            if (room.highestEnvidoUser) {
                socket.emit('envido_points_announced', {
                    userId: room.highestEnvidoUser,
                    points: room.highestEnvidoScore,
                    nextDeclarer: room.envidoDeclarer,
                    highestScore: room.highestEnvidoScore,
                    highestUser: room.highestEnvidoUser,
                    isFinal: false,
                    silentSync: true
                });
            }
            return;
        }
        const awaitingResponseFrom = room.gameRound.awaitingResponseFrom;
        if (!awaitingResponseFrom)
            return;
        if (room.envidoPendingCaller) {
            const callType = room.envidoChain[room.envidoChain.length - 1] || 'ENVIDO';
            socket.emit('call_received', {
                userId: room.envidoPendingCaller,
                callType,
                category: 'ENVIDO',
                awaitingResponseFrom,
                chain: room.envidoChain,
                silentSync: true
            });
            return;
        }
        if (room.florPendingCaller) {
            const callType = room.florChain[room.florChain.length - 1] || 'FLOR';
            socket.emit('call_received', {
                userId: room.florPendingCaller,
                callType,
                category: 'FLOR',
                awaitingResponseFrom,
                chain: room.florChain,
                silentSync: true
            });
            return;
        }
        const trucoPointsAtStake = room.gameRound.trucoPointsAtStake || 2;
        const callType = trucoPointsAtStake >= 4
            ? 'VALE_4'
            : trucoPointsAtStake === 3
                ? 'RETRUCO'
                : 'TRUCO';
        const callerId = awaitingResponseFrom.toLowerCase() === room.creatorId.toLowerCase()
            ? room.guestId
            : room.creatorId;
        socket.emit('call_received', {
            userId: callerId,
            callType,
            category: 'TRUCO',
            awaitingResponseFrom,
            canCallEnvido: callType === 'TRUCO' && !!room.pendingTrucoAfterEnvido,
            silentSync: true
        });
    }
    function sendCompleteGameSync(socket, room, userId) {
        sendFullSync(socket, room, userId);
        sendPendingInteractionSync(socket, room);
    }
    io.on('connection', (socket) => {
        socket.emit('update_tables', getAvailableRooms());
        socket.on('request_tables', () => {
            socket.emit('update_tables', getAvailableRooms());
        });
        // El navegador informa exactamente la línea que mostró; la sala del servidor la conserva.
        // Dos clientes reciben los mismos eventos, por eso se elimina sólo el duplicado consecutivo.
        socket.on('game_log_line', ({ roomId, message }) => {
            const room = rooms.get(String(roomId || ''));
            if (!room)
                return;
            if (!getAuthenticatedUserId(room, socket.id))
                return;
            const line = String(message ?? '').trim().slice(0, 1200);
            if (!line)
                return;
            if (room.logs[room.logs.length - 1] === line)
                return;
            room.logs.push(line);
            if (room.logs.length > 500)
                room.logs.splice(0, room.logs.length - 500);
        });
        socket.on('reconnect_game', async ({ roomId, userId }) => {
            const room = rooms.get(roomId);
            const cleanUser = (userId || '').trim().toLowerCase();
            if (!cleanUser)
                return socket.emit('reconnect_failed');
            if (!room?.isBotGame) {
                try {
                    if (!(await (0, userService_1.userExistsFresh)(cleanUser))) {
                        socket.emit('session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
                        return;
                    }
                }
                catch {
                    return socket.emit('error_action', { message: 'No se pudo validar tu cuenta. Intentá nuevamente.' });
                }
            }
            const canReconnect = !!room && (room.creatorId.toLowerCase() === cleanUser ||
                (!room.isBotGame && !!room.guestId && room.guestId.toLowerCase() === cleanUser));
            if (room && canReconnect) {
                socket.join(roomId);
                if (room.creatorId.toLowerCase() === userId.toLowerCase()) {
                    room.creatorSocketId = socket.id;
                }
                else if (room.guestId && room.guestId.toLowerCase() === userId.toLowerCase()) {
                    room.guestSocketId = socket.id;
                }
                if (room.disconnectedUser && room.disconnectedUser.toLowerCase() === userId.toLowerCase()) {
                    const resumeSeconds = room.pausedTurnSeconds && room.pausedTurnSeconds > 0
                        ? room.pausedTurnSeconds
                        : 30;
                    clearDisconnectTimer(room);
                    room.pausedTurnSeconds = undefined;
                    io.to(roomId).emit('player_reconnected', { reconnectedUser: userId });
                    startTurnTimer(room, resumeSeconds);
                }
                sendCompleteGameSync(socket, room, userId);
            }
            else {
                socket.emit('reconnect_failed');
            }
        });
        socket.on('request_game_state', async ({ roomId, userId }) => {
            const room = rooms.get(roomId);
            if (!room || !room.gameRound || !userId)
                return;
            const cleanUser = String(userId).trim().toLowerCase();
            if (!room.isBotGame) {
                try {
                    if (!(await (0, userService_1.userExistsFresh)(cleanUser))) {
                        socket.emit('session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
                        return;
                    }
                }
                catch {
                    return;
                }
            }
            const isCreator = room.creatorId.toLowerCase() === cleanUser;
            const isGuest = !room.isBotGame && !!room.guestId && room.guestId.toLowerCase() === cleanUser;
            if (!isCreator && !isGuest)
                return;
            // Si el socket sigue siendo el de la partida, sólo resincronizamos.
            // Si Socket.IO ya reconectó y cambió el id, volvemos a vincularlo al mismo asiento.
            socket.join(roomId);
            if (isCreator)
                room.creatorSocketId = socket.id;
            else
                room.guestSocketId = socket.id;
            sendCompleteGameSync(socket, room, userId);
        });
        socket.on('check_active_game', async ({ userId }) => {
            if (!userId)
                return;
            const cleanUser = String(userId).trim().toLowerCase();
            // El modo práctica puede usar invitado temporal sin cuenta registrada.
            for (const [roomId, room] of rooms.entries()) {
                if (room.isBotGame && room.creatorId.toLowerCase() === cleanUser) {
                    socket.emit('active_game_found', { roomId, userId });
                    return;
                }
            }
            try {
                if (!(await (0, userService_1.userExistsFresh)(cleanUser))) {
                    socket.emit('session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
                    return;
                }
            }
            catch {
                return;
            }
            for (const [roomId, room] of rooms.entries()) {
                if (room.guestId && (room.creatorId.toLowerCase() === userId.toLowerCase() || (!room.isBotGame && room.guestId.toLowerCase() === userId.toLowerCase()))) {
                    socket.emit('active_game_found', { roomId, userId });
                    return;
                }
            }
        });
        // Chat temporal 1 vs 1. No se guarda en la base de datos ni altera el estado del juego.
        socket.on('send_chat_message', ({ roomId, message }) => {
            const room = rooms.get(roomId);
            if (!room || !room.guestId) {
                return socket.emit('chat_error', { message: 'La partida ya no está disponible.' });
            }
            if (room.isBotGame) {
                return socket.emit('chat_error', { message: 'El chat no está disponible contra la máquina.' });
            }
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (!authUser) {
                return socket.emit('chat_error', { message: 'No perteneces a esta partida.' });
            }
            const cleanMessage = String(message ?? '').trim().slice(0, 300);
            if (!cleanMessage)
                return;
            io.to(room.roomId).emit('chat_message', {
                roomId: room.roomId,
                userId: authUser,
                message: cleanMessage,
                sentAt: Date.now()
            });
        });
        socket.on('start_bot_game', ({ userId }) => {
            const cleanUser = String(userId || '').trim().slice(0, 40);
            if (!cleanUser)
                return socket.emit('error_action', { message: 'No se pudo iniciar el modo de prueba.' });
            // Cierra una prueba anterior asociada a este mismo socket, si quedó abierta.
            for (const [existingId, existingRoom] of rooms.entries()) {
                if (existingRoom.isBotGame && existingRoom.creatorSocketId === socket.id) {
                    clearTurnTimer(existingRoom);
                    clearDisconnectTimer(existingRoom);
                    rooms.delete(existingId);
                }
            }
            const roomId = 'prueba_' + crypto_1.default.randomBytes(3).toString('hex');
            const botId = BOT_DEFAULT_ID;
            const room = {
                roomId,
                creatorId: cleanUser,
                creatorSocketId: socket.id,
                guestId: botId,
                betAmount: 0,
                targetPoints: 15,
                withFlor: true,
                scoreP1: 0,
                scoreP2: 0,
                manoId: Math.random() < 0.5 ? cleanUser : botId,
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
                pendingTrucoAfterEnvido: null,
                settlementInProgress: false,
                joiningUser: null,
                isBotGame: true,
                botId,
                logs: []
            };
            rooms.set(roomId, room);
            socket.join(roomId);
            socket.emit('game_ready', {
                roomId,
                creatorId: cleanUser,
                creatorAvatar: (0, userService_1.getUserAvatar)(cleanUser),
                guestId: botId,
                guestAvatar: 'gaucho',
                pot: 0,
                targetPoints: 15,
                withFlor: true,
                betAmount: 0,
                isBotGame: true
            });
            setTimeout(() => {
                if (rooms.get(roomId) === room)
                    dealAutoHand(room);
            }, 650);
        });
        socket.on('create_room', async ({ userId, betAmount, targetPoints, withFlor }) => {
            const cleanUser = (userId || '').trim().toLowerCase();
            if (!cleanUser)
                return socket.emit('error_action', { message: 'Usuario inválido.' });
            try {
                if (!(await (0, userService_1.userExistsFresh)(cleanUser))) {
                    socket.emit('session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
                    return;
                }
            }
            catch {
                return socket.emit('error_action', { message: 'No se pudo validar tu cuenta. Intentá nuevamente.' });
            }
            if (pendingRoomCreations.has(cleanUser)) {
                return socket.emit('error_action', { message: 'Ya se está creando tu mesa. Esperá un instante.' });
            }
            pendingRoomCreations.add(cleanUser);
            let claimedRoomId = null;
            let debitSucceeded = false;
            let roomStored = false;
            try {
                for (const [existingRoomId, existingRoom] of rooms.entries()) {
                    if (existingRoom.creatorId.toLowerCase() === cleanUser && !existingRoom.guestId) {
                        existingRoom.creatorSocketId = socket.id;
                        if (existingRoom.waitingTimeout) {
                            clearTimeout(existingRoom.waitingTimeout);
                            existingRoom.waitingTimeout = undefined;
                        }
                        socket.join(existingRoomId);
                        return socket.emit('error_action', { message: 'Ya tenés una mesa creada esperando rival.' });
                    }
                }
                const activePresence = (0, activeGameRegistry_1.getActiveGamePresence)(cleanUser);
                if (activePresence) {
                    return socket.emit('error_action', {
                        message: activePresence.mode === '2v2'
                            ? 'Ya estás en una mesa 2 vs 2. Salí de esa mesa antes de crear una 1 vs 1.'
                            : 'Ya estás en otra mesa 1 vs 1.'
                    });
                }
                const bet = Number(betAmount) >= 0 ? Math.round(Number(betAmount)) : 0;
                const pts = Number(targetPoints) === 15 ? 15 : 30;
                const flor = (withFlor === true || withFlor === 'true' || withFlor === undefined);
                // El roomId se genera ANTES del débito para que la entrada tenga una
                // clave idempotente única asociada a esta mesa.
                const roomId = 'mesa_' + crypto_1.default.randomBytes(3).toString('hex');
                if (!(0, activeGameRegistry_1.claimActiveGame)(cleanUser, '1v1', roomId)) {
                    return socket.emit('error_action', { message: 'Ya estás participando en otra mesa.' });
                }
                claimedRoomId = roomId;
                const debit = await (0, userService_1.debitRoomEntry)(roomId, cleanUser, bet, 'CREATOR');
                if (!debit.success) {
                    (0, activeGameRegistry_1.releaseActiveGame)(cleanUser, '1v1', roomId);
                    claimedRoomId = null;
                    return socket.emit('error_action', { message: debit.message || 'Saldo insuficiente.' });
                }
                debitSucceeded = true;
                const room = {
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
                    pendingTrucoAfterEnvido: null,
                    settlementInProgress: false,
                    joiningUser: null,
                    logs: []
                };
                rooms.set(roomId, room);
                roomStored = true;
                socket.join(roomId);
                socket.emit('room_created', {
                    roomId,
                    newBalance: debit.balance ?? await (0, userService_1.getUserChipsFresh)(cleanUser),
                    targetPoints: pts,
                    withFlor: flor,
                    betAmount: bet,
                    avatar: (0, userService_1.getUserAvatar)(userId)
                });
                broadcastTables();
            }
            catch (err) {
                if (debitSucceeded && claimedRoomId && !roomStored) {
                    try {
                        await (0, userService_1.refundRoomEntry)(claimedRoomId, cleanUser, Number(betAmount) || 0);
                    }
                    catch { }
                }
                if (claimedRoomId && !roomStored)
                    (0, activeGameRegistry_1.releaseActiveGame)(cleanUser, '1v1', claimedRoomId);
                console.error('Error creando mesa:', err);
                socket.emit('error_action', { message: 'No se pudo crear la mesa.' });
            }
            finally {
                pendingRoomCreations.delete(cleanUser);
            }
        });
        socket.on('cancel_waiting_table', async ({ roomId, userId }) => {
            try {
                const room = rooms.get(roomId);
                if (room && !room.guestId && (room.creatorSocketId === socket.id || (userId && room.creatorId.toLowerCase() === userId.toLowerCase()))) {
                    if (room.waitingTimeout) {
                        clearTimeout(room.waitingTimeout);
                        room.waitingTimeout = undefined;
                    }
                    let newBalance = await (0, userService_1.getUserChipsFresh)(room.creatorId);
                    if (room.betAmount > 0) {
                        const refund = await (0, userService_1.refundRoomEntry)(room.roomId, room.creatorId, Number(room.betAmount));
                        if (!refund.success) {
                            return socket.emit('error_action', {
                                message: 'No se pudo devolver la entrada. La mesa permanece abierta para evitar perder fichas.'
                            });
                        }
                        newBalance = refund.balance ?? await (0, userService_1.getUserChipsFresh)(room.creatorId);
                    }
                    rooms.delete(roomId);
                    (0, activeGameRegistry_1.releaseActiveGame)(room.creatorId, '1v1', room.roomId);
                    socket.emit('table_cancelled_ok', { newBalance });
                    broadcastTables();
                }
            }
            catch (err) {
                console.error('Error al cancelar la mesa:', err);
            }
        });
        socket.on('surrender_match', ({ roomId }) => {
            const room = rooms.get(roomId);
            if (!room || !room.guestId)
                return;
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (!authUser)
                return;
            const isP1 = room.creatorId.toLowerCase() === authUser.toLowerCase();
            const winnerId = isP1 ? room.guestId : room.creatorId;
            if (room.isBotGame) {
                clearTurnTimer(room);
                clearDisconnectTimer(room);
                rooms.delete(roomId);
                socket.emit('bot_game_closed', { roomId });
                return;
            }
            void settleAndCloseMatch(room, winnerId, authUser, 'SURRENDER', 'player_surrendered', authUser);
        });
        socket.on('join_room', async ({ roomId, userId }) => {
            const cleanUser = (userId || '').trim().toLowerCase();
            let claimedTarget = false;
            let debitSucceeded = false;
            let seated = false;
            let debitBet = 0;
            try {
                const room = rooms.get(roomId);
                if (!room)
                    return socket.emit('error_action', { message: 'La mesa no existe.' });
                if (room.guestId)
                    return socket.emit('error_action', { message: 'La mesa ya está completa.' });
                if (!cleanUser)
                    return socket.emit('error_action', { message: 'Usuario inválido.' });
                try {
                    if (!(await (0, userService_1.userExistsFresh)(cleanUser))) {
                        socket.emit('session_invalid', { message: 'Tu cuenta ya no existe. Volvé a iniciar sesión.' });
                        return;
                    }
                }
                catch {
                    return socket.emit('error_action', { message: 'No se pudo validar tu cuenta. Intentá nuevamente.' });
                }
                if (room.joiningUser) {
                    return socket.emit('error_action', { message: 'Otro jugador está entrando a la mesa. Intentá nuevamente.' });
                }
                const activePresence = (0, activeGameRegistry_1.getActiveGamePresence)(cleanUser);
                if (activePresence?.mode === '2v2') {
                    return socket.emit('error_action', {
                        message: 'Ya estás en una mesa 2 vs 2. Salí de esa mesa antes de entrar a una 1 vs 1.'
                    });
                }
                if (activePresence?.mode === '1v1' && activePresence.roomId === roomId) {
                    return socket.emit('error_action', { message: 'Ya estás en esta mesa.' });
                }
                if (activePresence?.mode === '1v1' && activePresence.roomId !== roomId) {
                    const previousRoom = rooms.get(activePresence.roomId);
                    const canReplaceOwnWaitingRoom = !!previousRoom &&
                        !previousRoom.guestId &&
                        previousRoom.creatorId.toLowerCase() === cleanUser;
                    if (!canReplaceOwnWaitingRoom) {
                        return socket.emit('error_action', { message: 'Ya estás participando en otra mesa 1 vs 1.' });
                    }
                }
                // Evita dos JOIN simultáneos mientras se espera la confirmación de Supabase.
                room.joiningUser = cleanUser;
                // Limpiamos mesas huérfanas del jugador y devolvemos sus fichas
                // únicamente si PostgreSQL confirma que existió el débito original.
                for (const [pendingRoomId, pendingRoom] of rooms.entries()) {
                    if (pendingRoomId === roomId)
                        continue;
                    if (pendingRoom.creatorId.toLowerCase() === cleanUser && !pendingRoom.guestId) {
                        if (pendingRoom.betAmount > 0) {
                            const refund = await (0, userService_1.refundRoomEntry)(pendingRoom.roomId, cleanUser, Number(pendingRoom.betAmount));
                            if (!refund.success) {
                                room.joiningUser = null;
                                return socket.emit('error_action', {
                                    message: 'No se pudo devolver el saldo de tu mesa anterior. No se realizó ningún nuevo débito.'
                                });
                            }
                        }
                        rooms.delete(pendingRoomId);
                        (0, activeGameRegistry_1.releaseActiveGame)(cleanUser, '1v1', pendingRoomId);
                    }
                }
                if (!(0, activeGameRegistry_1.claimActiveGame)(cleanUser, '1v1', room.roomId)) {
                    room.joiningUser = null;
                    return socket.emit('error_action', { message: 'Ya estás participando en otra mesa.' });
                }
                claimedTarget = true;
                debitBet = Number(room.betAmount);
                const debit = await (0, userService_1.debitRoomEntry)(room.roomId, cleanUser, Number(room.betAmount), 'GUEST');
                if (!debit.success) {
                    room.joiningUser = null;
                    (0, activeGameRegistry_1.releaseActiveGame)(cleanUser, '1v1', room.roomId);
                    claimedTarget = false;
                    return socket.emit('error_action', { message: debit.message || 'Saldo insuficiente.' });
                }
                debitSucceeded = true;
                // La mesa pudo cancelarse mientras PostgreSQL procesaba el débito.
                // En ese caso la devolución también es idempotente.
                if (rooms.get(roomId) !== room || room.guestId) {
                    if (room.betAmount > 0) {
                        await (0, userService_1.refundRoomEntry)(room.roomId, cleanUser, Number(room.betAmount));
                    }
                    (0, activeGameRegistry_1.releaseActiveGame)(cleanUser, '1v1', room.roomId);
                    claimedTarget = false;
                    room.joiningUser = null;
                    return socket.emit('error_action', { message: 'La mesa ya no está disponible.' });
                }
                room.guestId = userId;
                room.guestSocketId = socket.id;
                room.joiningUser = null;
                seated = true;
                socket.join(roomId);
                const payout = (0, userService_1.calculateMatchPayout)(room.betAmount);
                io.to(roomId).emit('game_ready', {
                    roomId: room.roomId,
                    creatorId: room.creatorId,
                    creatorAvatar: (0, userService_1.getUserAvatar)(room.creatorId),
                    guestId: room.guestId,
                    guestAvatar: (0, userService_1.getUserAvatar)(userId),
                    pot: payout.winnerPrize,
                    targetPoints: room.targetPoints,
                    withFlor: room.withFlor,
                    betAmount: room.betAmount,
                    isBotGame: false
                });
                broadcastTables();
                setTimeout(() => { dealAutoHand(room); }, 1200);
            }
            catch (err) {
                const room = rooms.get(roomId);
                if (room && room.joiningUser === cleanUser)
                    room.joiningUser = null;
                if (debitSucceeded && !seated) {
                    try {
                        await (0, userService_1.refundRoomEntry)(String(roomId || ''), cleanUser, debitBet);
                    }
                    catch { }
                }
                if (claimedTarget && !seated)
                    (0, activeGameRegistry_1.releaseActiveGame)(cleanUser, '1v1', String(roomId || ''));
                console.error('Error uniéndose a mesa:', err);
            }
        });
        socket.on('disconnect', () => {
            for (const [roomId, room] of rooms.entries()) {
                if (!room.guestId && room.creatorSocketId === socket.id) {
                    if (room.waitingTimeout) {
                        clearTimeout(room.waitingTimeout);
                    }
                    room.creatorSocketId = undefined;
                    room.waitingTimeout = setTimeout(async () => {
                        const activeRoom = rooms.get(roomId);
                        if (activeRoom && !activeRoom.guestId) {
                            if (activeRoom.betAmount > 0) {
                                const refund = await (0, userService_1.refundRoomEntry)(activeRoom.roomId, activeRoom.creatorId, activeRoom.betAmount);
                                if (!refund.success) {
                                    console.error(`[REFUND FAILED] ${activeRoom.roomId}: la mesa no se elimina hasta poder devolver la entrada.`);
                                    return;
                                }
                            }
                            rooms.delete(roomId);
                            (0, activeGameRegistry_1.releaseActiveGame)(activeRoom.creatorId, '1v1', activeRoom.roomId);
                            broadcastTables();
                        }
                    }, 30 * 60 * 1000);
                    broadcastTables();
                    continue;
                }
                if (room.guestId) {
                    if (room.creatorSocketId === socket.id) {
                        startDisconnectGracePeriod(room, room.creatorId);
                    }
                    else if (room.guestSocketId === socket.id) {
                        startDisconnectGracePeriod(room, room.guestId);
                    }
                }
            }
        });
        socket.on('play_card', ({ roomId, cardId }) => {
            const room = rooms.get(roomId);
            if (!room || !room.gameRound || room.disconnectedUser)
                return;
            // NUEVO: Candado anti-spam para evitar la "Condición de Carrera" (doble clic)
            if (room['isProcessingPlay'])
                return;
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (!authUser)
                return socket.emit('error_action', { message: 'No perteneces a esta partida.' });
            // Verificar que sea su turno
            if (room.gameRound.currentTurn.toLowerCase() !== authUser.toLowerCase()) {
                return socket.emit('error_action', { message: 'No es tu turno de jugar carta.' });
            }
            // Bloqueo estricto si hay un Envido, Flor o Truco esperando respuesta.
            if (room.gameRound.awaitingResponseFrom) {
                return socket.emit('error_action', { message: 'Hay un canto pendiente de respuesta.' });
            }
            // En el modo máquina, una vez aceptado Envido/Flor se debe completar la
            // declaración de tantos antes de que cualquiera pueda tirar una carta.
            if (room.isBotGame && room.isDeclaringEnvido) {
                return socket.emit('error_action', { message: 'Primero hay que terminar la declaración de tantos.' });
            }
            // Activamos el candado antes de procesar la carta
            room['isProcessingPlay'] = true;
            try {
                executePlayCard(room, authUser, cardId);
            }
            finally {
                // Soltamos el candado inmediatamente después de que se procesó todo
                room['isProcessingPlay'] = false;
            }
        });
        socket.on('declare_envido_points', ({ roomId }) => {
            const room = rooms.get(roomId);
            if (!room || room.disconnectedUser)
                return;
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (!authUser)
                return;
            // El servidor calcula los tantos con las 3 cartas originales de la mano,
            // incluso si una ya fue jugada. No se confía en el valor enviado por el cliente.
            const allCards = getAllCardsForUser(room, authUser);
            const actualPoints = room.isFlorDeclaration
                ? (0, trucoEngine_1.calculateFlor)(allCards)
                : (0, trucoEngine_1.getEnvidoDetails)(allCards).score;
            executeDeclareEnvido(room, authUser, actualPoints);
        });
        socket.on('say_son_buenas', ({ roomId }) => {
            const room = rooms.get(roomId);
            if (!room || room.disconnectedUser)
                return;
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (authUser)
                executeSonBuenas(room, authUser);
        });
        socket.on('send_call', ({ roomId, callType }) => {
            try {
                const room = rooms.get(roomId);
                if (!room || !room.gameRound || room.disconnectedUser)
                    return;
                const authUser = getAuthenticatedUserId(room, socket.id);
                if (!authUser)
                    return socket.emit('error_action', { message: 'No perteneces a esta mesa.' });
                const rivalId = authUser.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
                const currentTrick = room.gameRound.currentTrickIndex;
                const callerHand = authUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
                const callerCardsPlayed = callerHand.cardsPlayed.filter(Boolean).length;
                // En una partida contra la máquina, una declaración de tantos ya iniciada
                // debe resolverse por declare_envido_points / say_son_buenas. No dejamos
                // reiniciar Envido ni lanzar otro canto por un control visual que haya
                // quedado desactualizado.
                if (room.isBotGame && room.isDeclaringEnvido) {
                    return socket.emit('error_action', { message: 'Primero hay que terminar la declaración de tantos.' });
                }
                if (room.gameRound.awaitingResponseFrom) {
                    if (room.gameRound.awaitingResponseFrom.toLowerCase() !== authUser.toLowerCase()) {
                        return socket.emit('error_action', { message: 'No es tu turno de responder.' });
                    }
                }
                else {
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
                    if (!room.withFlor)
                        return socket.emit('error_action', { message: 'Partida SIN FLOR.' });
                    if (currentTrick > 0 || room.gameRound.florResolved)
                        return socket.emit('error_action', { message: 'El tiempo para cantar Flor ya cerró.' });
                    // Validación estricta: No se puede cantar Contraflor ni Contraflor al juego ante un Envido
                    if (['CONTRAFLOR', 'CONTRAFLOR_AL_JUEGO'].includes(callType) && room.envidoPendingCaller) {
                        return socket.emit('error_action', { message: 'No se puede cantar Contraflor a un Envido.' });
                    }
                    const rivalHand = rivalId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
                    const rivalCards = rivalHand.cards.concat(rivalHand.cardsPlayed.filter(Boolean));
                    const rivalHasFlor = (0, trucoEngine_1.hasFlor)(rivalCards);
                    if (callType === 'FLOR' && !rivalHasFlor) {
                        room.gameRound.envidoResolved = true;
                        room.gameRound.florResolved = true;
                        room.gameRound.awaitingResponseFrom = null;
                        room.florPendingCaller = null;
                        room.envidoPendingCaller = null; // NUEVO: La flor elimina cualquier envido pendiente
                        if (authUser.toLowerCase() === room.creatorId.toLowerCase())
                            room.scoreP1 += 3;
                        else
                            room.scoreP2 += 3;
                        const callerHand = authUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
                        const callerCards = callerHand.cards.concat(callerHand.cardsPlayed.filter(Boolean));
                        const florPoints = (0, trucoEngine_1.calculateFlor)(callerCards);
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
                        if (checkAndResumePendingTruco(room))
                            return;
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
                if (callType === 'QUIERO_FLOR')
                    return startEnvidoDeclarationPhase(room, true);
                if (callType === 'NO_QUIERO_FLOR')
                    return resolveFlorDeclined(room, authUser);
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
                    return startEnvidoDeclarationPhase(room, false, authUser);
                }
                if (callType === 'NO_QUIERO_ENVIDO')
                    return resolveEnvidoDeclined(room, authUser);
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
                    }
                    else {
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
                    // resolveTrucoFold necesita ver pendingTrucoAfterEnvido para distinguir
                    // correctamente TRUCO -> ENVIDO/REAL/FALTA -> ME VOY AL MAZO.
                    return resolveTrucoFold(room, authUser, callType);
                }
            }
            catch (err) {
                console.error('Error en send_call:', err);
            }
        });
    });
}
