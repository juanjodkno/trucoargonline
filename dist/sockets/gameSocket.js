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
const rooms = new Map();
function setupSocketEvents(io) {
    function getAvailableRooms() {
        return Array.from(rooms.values())
            .filter(r => !r.guestId)
            .map(r => ({
            roomId: r.roomId,
            creatorId: r.creatorId,
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
    }
    function checkMatchEnd(room) {
        if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
            clearTurnTimer(room);
            const matchWinner = room.scoreP1 >= room.targetPoints ? room.creatorId : room.guestId;
            const netPot = room.betAmount > 0 ? room.betAmount * 2 * 0.9 : 0;
            if (netPot > 0)
                (0, userService_1.modifyUserChips)(matchWinner, netPot);
            io.to(room.roomId).emit('match_finished', {
                winnerId: matchWinner,
                scores: getScoreMap(room),
                pot: netPot,
                winnerBalance: (0, userService_1.getUserChips)(matchWinner)
            });
            rooms.delete(room.roomId);
            broadcastTables();
            return true;
        }
        return false;
    }
    function startTurnTimer(room, seconds = 25) {
        clearTurnTimer(room);
        let timeLeft = seconds;
        io.to(room.roomId).emit('timer_tick', { secondsLeft: timeLeft });
        room.turnInterval = setInterval(() => {
            timeLeft--;
            if (timeLeft > 0) {
                io.to(room.roomId).emit('timer_tick', { secondsLeft: timeLeft });
            }
            else {
                io.to(room.roomId).emit('timer_tick', { secondsLeft: 0 });
                clearTurnTimer(room);
                handleTimeout(room);
            }
        }, 1000);
    }
    function handleTimeout(room) {
        if (!room.gameRound)
            return;
        if (room.isDeclaringEnvido && room.envidoDeclarer) {
            const activeUser = room.envidoDeclarer;
            const hand = activeUser.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
            const allCards = hand.cards.concat(hand.cardsPlayed.filter(Boolean));
            const details = (0, trucoEngine_1.getEnvidoDetails)(allCards);
            if (room.highestEnvidoScore === 0) {
                executeDeclareEnvido(room, activeUser, details.score);
            }
            else {
                if (details.score > room.highestEnvidoScore) {
                    executeDeclareEnvido(room, activeUser, details.score);
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
    function dealAutoHand(room) {
        if (!room.guestId)
            return;
        clearTurnTimer(room);
        const round = new trucoGame_1.TrucoRound(room.creatorId, room.guestId, room.manoId, room.targetPoints, room.withFlor);
        room.gameRound = round;
        room.gameRound.envidoResolved = false;
        room.envidoChain = [];
        room.envidoPendingCaller = null;
        room.envidoWinnerRecord = null;
        room.isDeclaringEnvido = false;
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
        io.to(room.roomId).emit('cards_dealt', {
            p1Id: room.creatorId, p1Cards: round.p1.cards,
            p2Id: room.guestId, p2Cards: round.p2.cards,
            withFlor: room.withFlor
        });
        startTurnTimer(room, 25);
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
    function startEnvidoDeclarationPhase(room) {
        clearTurnTimer(room);
        room.isDeclaringEnvido = true;
        room.envidoDeclarer = room.manoId;
        room.highestEnvidoScore = 0;
        room.highestEnvidoUser = null;
        io.to(room.roomId).emit('start_envido_declaration', {
            firstDeclarer: room.manoId,
            chain: room.envidoChain,
        });
        startTurnTimer(room, 25);
    }
    function executeDeclareEnvido(room, userId, declaredPoints) {
        if (!room.gameRound || !room.isDeclaringEnvido || room.envidoDeclarer !== userId)
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
            startTurnTimer(room, 25);
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
        if (!room.gameRound || !room.isDeclaringEnvido || room.envidoDeclarer !== userId)
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
            startTurnTimer(room, 25);
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
        room.envidoPendingCaller = null;
        const { acceptedPts } = calculateEnvidoPoints(room.envidoChain, room);
        const pts = acceptedPts;
        if (winnerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += pts;
        else
            room.scoreP2 += pts;
        const winnerHand = winnerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const winnerAllCards = winnerHand.cards.concat(winnerHand.cardsPlayed.filter(Boolean));
        const details = (0, trucoEngine_1.getEnvidoDetails)(winnerAllCards);
        room.envidoWinnerRecord = { winnerId, score: details.score, cards: details.envidoCards, pointsAwarded: pts };
        io.to(room.roomId).emit('envido_resolved', {
            winnerId, pointsAwarded: pts, scores: getScoreMap(room),
            declined: false, trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
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
        startTurnTimer(room, 25);
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
        if (checkMatchEnd(room))
            return;
        if (checkAndResumePendingTruco(room))
            return;
        startTurnTimer(room, 25);
    }
    function resolveFlor(room, callerId) {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        room.gameRound.envidoResolved = true;
        room.envidoPendingCaller = null;
        room.gameRound.awaitingResponseFrom = null;
        const callerHand = callerId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const callerAllCards = callerHand.cards.concat(callerHand.cardsPlayed.filter(Boolean));
        const florPoints = (0, trucoEngine_1.calculateFlor)(callerAllCards);
        const rivalId = callerId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
        const rivalHand = rivalId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
        const rivalAllCards = rivalHand.cards.concat(rivalHand.cardsPlayed.filter(Boolean));
        const rivalHasFlor = (0, trucoEngine_1.hasFlor)(rivalAllCards);
        if (!rivalHasFlor) {
            if (callerId.toLowerCase() === room.creatorId.toLowerCase())
                room.scoreP1 += 3;
            else
                room.scoreP2 += 3;
            room.envidoWinnerRecord = { winnerId: callerId, score: florPoints, cards: callerAllCards, pointsAwarded: 3 };
            io.to(room.roomId).emit('flor_declared', {
                winnerId: callerId, score: florPoints, cards: callerAllCards,
                pointsAwarded: 3, scores: getScoreMap(room), trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
                currentTurn: room.gameRound.currentTurn
            });
            if (checkMatchEnd(room))
                return;
        }
        else {
            const rivalFlorPts = (0, trucoEngine_1.calculateFlor)(rivalAllCards);
            let winnerId = callerId;
            let winnerPts = florPoints;
            let winnerCards = callerAllCards;
            if (rivalFlorPts > florPoints) {
                winnerId = rivalId;
                winnerPts = rivalFlorPts;
                winnerCards = rivalAllCards;
            }
            else if (rivalFlorPts === florPoints) {
                winnerId = room.manoId;
                winnerPts = florPoints;
                winnerCards = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? callerAllCards : rivalAllCards;
            }
            if (winnerId.toLowerCase() === room.creatorId.toLowerCase())
                room.scoreP1 += 6;
            else
                room.scoreP2 += 6;
            room.envidoWinnerRecord = { winnerId, score: winnerPts, cards: winnerCards, pointsAwarded: 6 };
            io.to(room.roomId).emit('flor_declared', {
                winnerId, score: winnerPts, cards: winnerCards,
                pointsAwarded: 6, scores: getScoreMap(room), trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
                currentTurn: room.gameRound.currentTurn
            });
            if (checkMatchEnd(room))
                return;
        }
        if (checkAndResumePendingTruco(room))
            return;
        startTurnTimer(room, 25);
    }
    function resolveTrucoFold(room, folderUserId, reason = 'NO_QUIERO_TRUCO') {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        const winnerId = folderUserId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
        let trucoPts = 1;
        if (room.gameRound.awaitingResponseFrom) {
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
        let pts = trucoPts;
        // Verificar si alguien tiró alguna carta en la primera mano
        const p1PlayedInTrick0 = room.gameRound.p1.cardsPlayed[0] !== null;
        const p2PlayedInTrick0 = room.gameRound.p2.cardsPlayed[0] !== null;
        const totalCardsPlayedInTrick0 = (p1PlayedInTrick0 ? 1 : 0) + (p2PlayedInTrick0 ? 1 : 0);
        // Solo se penaliza con el punto extra de Envido si el mano se va al mazo directamente al empezar (0 cartas en la mesa)
        if (reason === 'ME_VOY_AL_MAZO' && !room.gameRound.envidoResolved && room.gameRound.currentTrickIndex === 0 && totalCardsPlayedInTrick0 === 0) {
            pts = trucoPts + 1;
        }
        if (winnerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += pts;
        else
            room.scoreP2 += pts;
        io.to(room.roomId).emit('round_ended', {
            winnerId,
            pointsAwarded: pts,
            scores: getScoreMap(room),
            reason,
            folderUserId
        });
        handleRoundTransition(room);
    }
    function handleRoundTransition(room) {
        clearTurnTimer(room);
        if (room.envidoWinnerRecord) {
            io.to(room.roomId).emit('show_envido_winner', {
                winnerId: room.envidoWinnerRecord.winnerId, score: room.envidoWinnerRecord.score,
                cards: room.envidoWinnerRecord.cards, durationMs: 3500,
            });
            room.envidoWinnerRecord = null;
            setTimeout(() => {
                if (checkMatchEnd(room))
                    return;
                room.manoId = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? (room.guestId || room.creatorId) : room.creatorId;
                dealAutoHand(room);
            }, 3800);
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
            userId, cardId, trickIndex: result.trickIndex, isTrickOver: result.isTrickOver,
            trickWinnerId: result.trickWinnerId || null, nextTurn: result.nextTurn,
            currentTrick: room.gameRound.currentTrickIndex,
        });
        if (result.roundOver && result.winnerId) {
            const finalTrucoPoints = room.trucoLevel > 1 ? room.trucoLevel : (result.points || 1);
            if (result.winnerId.toLowerCase() === room.creatorId.toLowerCase())
                room.scoreP1 += finalTrucoPoints;
            else
                room.scoreP2 += finalTrucoPoints;
            io.to(room.roomId).emit('round_ended', {
                winnerId: result.winnerId, pointsAwarded: finalTrucoPoints, scores: getScoreMap(room),
            });
            handleRoundTransition(room);
        }
        else {
            startTurnTimer(room, 25);
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
        });
    }
    io.on('connection', (socket) => {
        socket.emit('update_tables', getAvailableRooms());
        socket.on('request_tables', () => {
            socket.emit('update_tables', getAvailableRooms());
        });
        socket.on('reconnect_game', ({ roomId, userId }) => {
            const room = rooms.get(roomId);
            if (room && (room.creatorId.toLowerCase() === userId.toLowerCase() || (room.guestId && room.guestId.toLowerCase() === userId.toLowerCase()))) {
                socket.join(roomId);
                sendFullSync(socket, room, userId);
            }
            else {
                socket.emit('reconnect_failed');
            }
        });
        socket.on('create_room', ({ userId, betAmount, targetPoints, withFlor }) => {
            try {
                const bet = Number(betAmount) >= 0 ? Number(betAmount) : 0;
                const pts = Number(targetPoints) === 15 ? 15 : 30;
                const flor = (withFlor === true || withFlor === 'true' || withFlor === undefined);
                if (bet > 0) {
                    const successDeduct = (0, userService_1.modifyUserChips)(userId, -bet);
                    if (!successDeduct)
                        return socket.emit('error_action', { message: 'Saldo insuficiente.' });
                }
                const roomId = 'mesa_' + crypto_1.default.randomBytes(3).toString('hex');
                const room = {
                    roomId, creatorId: userId, betAmount: bet, targetPoints: pts, withFlor: flor,
                    scoreP1: 0, scoreP2: 0, manoId: userId, envidoChain: [], envidoPendingCaller: null,
                    isDeclaringEnvido: false, envidoDeclarer: null, highestEnvidoScore: 0, highestEnvidoUser: null,
                    trucoLevel: 1, trucoOwner: null, pendingTrucoAfterEnvido: null
                };
                rooms.set(roomId, room);
                socket.join(roomId);
                socket.emit('room_created', {
                    roomId, newBalance: (0, userService_1.getUserChips)(userId), targetPoints: pts, withFlor: flor, betAmount: bet
                });
                broadcastTables();
            }
            catch (err) {
                console.error('Error creando mesa:', err);
            }
        });
        socket.on('cancel_waiting_table', ({ roomId, userId }) => {
            const room = rooms.get(roomId);
            if (room && !room.guestId && room.creatorId.toLowerCase() === userId.toLowerCase()) {
                if (room.betAmount > 0) {
                    (0, userService_1.modifyUserChips)(room.creatorId, room.betAmount);
                }
                rooms.delete(roomId);
                socket.emit('table_cancelled_ok', { newBalance: (0, userService_1.getUserChips)(userId) });
                broadcastTables();
            }
        });
        socket.on('surrender_match', ({ roomId, userId }) => {
            const room = rooms.get(roomId);
            if (!room || !room.guestId)
                return;
            const isP1 = room.creatorId.toLowerCase() === userId.toLowerCase();
            const isP2 = room.guestId.toLowerCase() === userId.toLowerCase();
            if (!isP1 && !isP2)
                return;
            clearTurnTimer(room);
            const winnerId = isP1 ? room.guestId : room.creatorId;
            const netPot = room.betAmount > 0 ? room.betAmount * 2 * 0.9 : 0;
            if (netPot > 0) {
                (0, userService_1.modifyUserChips)(winnerId, netPot);
            }
            io.to(roomId).emit('player_surrendered', {
                surrenderedUser: userId,
                winnerId,
                pot: netPot,
                scores: getScoreMap(room),
                winnerBalance: (0, userService_1.getUserChips)(winnerId)
            });
            rooms.delete(roomId);
            broadcastTables();
        });
        socket.on('join_room', ({ roomId, userId }) => {
            try {
                const room = rooms.get(roomId);
                if (!room)
                    return socket.emit('error_action', { message: 'La mesa no existe.' });
                if (room.guestId)
                    return socket.emit('error_action', { message: 'La mesa ya está completa.' });
                if (room.betAmount > 0) {
                    const successDeduct = (0, userService_1.modifyUserChips)(userId, -room.betAmount);
                    if (!successDeduct)
                        return socket.emit('error_action', { message: 'Saldo insuficiente.' });
                }
                room.guestId = userId;
                socket.join(roomId);
                io.to(roomId).emit('game_ready', {
                    roomId: room.roomId, creatorId: room.creatorId, guestId: room.guestId,
                    pot: room.betAmount > 0 ? room.betAmount * 2 * 0.9 : 0,
                    targetPoints: room.targetPoints, withFlor: room.withFlor, betAmount: room.betAmount
                });
                broadcastTables();
                setTimeout(() => { dealAutoHand(room); }, 1200);
            }
            catch (err) {
                console.error('Error uniéndose a mesa:', err);
            }
        });
        socket.on('disconnect', () => {
            for (const [roomId, room] of rooms.entries()) {
                if (!room.guestId) {
                    if (room.betAmount > 0)
                        (0, userService_1.modifyUserChips)(room.creatorId, room.betAmount);
                    rooms.delete(roomId);
                    broadcastTables();
                }
            }
        });
        socket.on('play_card', ({ roomId, userId, cardId }) => {
            const room = rooms.get(roomId);
            if (!room || !room.gameRound)
                return;
            if (room.gameRound.currentTurn.toLowerCase() !== userId.toLowerCase()) {
                return socket.emit('error_action', { message: 'No es tu turno de jugar carta.' });
            }
            executePlayCard(room, userId, cardId);
        });
        socket.on('declare_envido_points', ({ roomId, userId, points }) => {
            const room = rooms.get(roomId);
            if (room)
                executeDeclareEnvido(room, userId, points);
        });
        socket.on('say_son_buenas', ({ roomId, userId }) => {
            const room = rooms.get(roomId);
            if (room)
                executeSonBuenas(room, userId);
        });
        socket.on('send_call', ({ roomId, userId, callType }) => {
            try {
                const room = rooms.get(roomId);
                if (!room || !room.gameRound)
                    return;
                const rivalId = userId.toLowerCase() === room.creatorId.toLowerCase() ? room.guestId : room.creatorId;
                const currentTrick = room.gameRound.currentTrickIndex;
                const callerHand = userId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
                const callerCardsPlayed = callerHand.cardsPlayed.filter(Boolean).length;
                if (room.gameRound.awaitingResponseFrom) {
                    if (room.gameRound.awaitingResponseFrom.toLowerCase() !== userId.toLowerCase()) {
                        return socket.emit('error_action', { message: 'No es tu turno de responder.' });
                    }
                }
                else {
                    if (room.gameRound.currentTurn.toLowerCase() !== userId.toLowerCase()) {
                        return socket.emit('error_action', { message: 'No es tu turno para cantar o jugar.' });
                    }
                }
                if (room.envidoPendingCaller && ['TRUCO', 'RETRUCO', 'VALE_4'].includes(callType)) {
                    return socket.emit('error_action', { message: '¡El Envido está primero!' });
                }
                if (callType === 'FLOR') {
                    if (!room.withFlor)
                        return socket.emit('error_action', { message: 'Partida SIN FLOR.' });
                    if (currentTrick > 0 || room.gameRound.envidoResolved)
                        return socket.emit('error_action', { message: 'El tiempo para cantar Flor ya cerró.' });
                    return resolveFlor(room, userId);
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
                    room.envidoPendingCaller = userId;
                    room.gameRound.awaitingResponseFrom = rivalId;
                    io.to(roomId).emit('call_received', { userId, callType, category: 'ENVIDO', awaitingResponseFrom: rivalId, chain: room.envidoChain });
                    return startTurnTimer(room, 25);
                }
                if (callType === 'QUIERO_ENVIDO')
                    return startEnvidoDeclarationPhase(room);
                if (callType === 'NO_QUIERO_ENVIDO')
                    return resolveEnvidoDeclined(room, userId);
                if (callType === 'TRUCO') {
                    const responderHand = rivalId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
                    const responderCardsPlayed = responderHand.cardsPlayed.filter(Boolean).length;
                    const canEnvido = (currentTrick === 0 && !room.gameRound.envidoResolved && responderCardsPlayed === 0);
                    if (canEnvido) {
                        room.pendingTrucoAfterEnvido = {
                            callerId: userId,
                            responderId: rivalId,
                            trucoPointsAtStake: 2,
                            callType: 'TRUCO'
                        };
                    }
                    else {
                        room.gameRound.envidoResolved = true;
                        room.pendingTrucoAfterEnvido = null;
                    }
                    room.gameRound.trucoPointsAtStake = 2;
                    room.gameRound.awaitingResponseFrom = rivalId;
                    io.to(roomId).emit('call_received', {
                        userId,
                        callType: 'TRUCO',
                        category: 'TRUCO',
                        awaitingResponseFrom: rivalId,
                        canCallEnvido: canEnvido
                    });
                    return startTurnTimer(room, 25);
                }
                if (callType === 'RETRUCO') {
                    room.gameRound.envidoResolved = true;
                    room.pendingTrucoAfterEnvido = null;
                    room.gameRound.trucoPointsAtStake = 3;
                    room.gameRound.awaitingResponseFrom = rivalId;
                    io.to(roomId).emit('call_received', { userId, callType: 'RETRUCO', category: 'TRUCO', awaitingResponseFrom: rivalId, canCallEnvido: false });
                    return startTurnTimer(room, 25);
                }
                if (callType === 'VALE_4') {
                    room.gameRound.envidoResolved = true;
                    room.pendingTrucoAfterEnvido = null;
                    room.gameRound.trucoPointsAtStake = 4;
                    room.gameRound.awaitingResponseFrom = rivalId;
                    io.to(roomId).emit('call_received', { userId, callType: 'VALE_4', category: 'TRUCO', awaitingResponseFrom: rivalId, canCallEnvido: false });
                    return startTurnTimer(room, 25);
                }
                if (callType === 'QUIERO_TRUCO') {
                    room.gameRound.envidoResolved = true;
                    room.pendingTrucoAfterEnvido = null;
                    room.gameRound.awaitingResponseFrom = null;
                    room.trucoLevel = room.gameRound.trucoPointsAtStake;
                    room.trucoOwner = userId;
                    io.to(roomId).emit('truco_accepted', {
                        acceptedBy: userId,
                        trucoLevel: room.trucoLevel,
                        trucoOwner: room.trucoOwner
                    });
                    return startTurnTimer(room, 25);
                }
                if (callType === 'NO_QUIERO_TRUCO' || callType === 'ME_VOY_AL_MAZO') {
                    room.pendingTrucoAfterEnvido = null;
                    return resolveTrucoFold(room, userId, callType);
                }
            }
            catch (err) {
                console.error('Error en send_call:', err);
            }
        });
    });
}
