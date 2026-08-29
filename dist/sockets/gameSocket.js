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
    }
    function clearDisconnectTimer(room) {
        if (room.disconnectInterval) {
            clearInterval(room.disconnectInterval);
            room.disconnectInterval = undefined;
        }
        room.disconnectedUser = null;
    }
    function getAuthenticatedUserId(room, socketId) {
        if (room.creatorSocketId === socketId)
            return room.creatorId;
        if (room.guestSocketId === socketId)
            return room.guestId || null;
        return null;
    }
    function checkMatchEnd(room) {
        if (room.scoreP1 >= room.targetPoints || room.scoreP2 >= room.targetPoints) {
            clearTurnTimer(room);
            clearDisconnectTimer(room);
            const matchWinner = room.scoreP1 >= room.targetPoints ? room.creatorId : room.guestId;
            const grossPot = room.betAmount > 0 ? room.betAmount * 2 : 0;
            const netPot = grossPot * 0.9;
            const rake = grossPot * 0.1;
            if (netPot > 0) {
                (0, userService_1.modifyUserChips)(matchWinner, netPot);
                (0, userService_1.recordTransaction)('COMMISSION_RAKE', matchWinner, rake, `Comisión mesa ${room.roomId} ($${room.betAmount} c/u)`);
            }
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
        if (room.disconnectedUser)
            return;
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
        if (!room.gameRound || room.disconnectedUser)
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
            }
            else {
                clearDisconnectTimer(room);
                const isP1 = room.creatorId.toLowerCase() === disconnectedUser.toLowerCase();
                const winnerId = isP1 ? room.guestId : room.creatorId;
                const grossPot = room.betAmount > 0 ? room.betAmount * 2 : 0;
                const netPot = grossPot * 0.9;
                const rake = grossPot * 0.1;
                if (netPot > 0) {
                    (0, userService_1.modifyUserChips)(winnerId, netPot);
                    (0, userService_1.recordTransaction)('COMMISSION_RAKE', winnerId, rake, `Comisión abandono mesa ${room.roomId} ($${room.betAmount} c/u)`);
                }
                io.to(room.roomId).emit('player_surrendered', {
                    surrenderedUser: disconnectedUser,
                    winnerId,
                    pot: netPot,
                    scores: getScoreMap(room),
                    winnerBalance: (0, userService_1.getUserChips)(winnerId),
                    reason: 'DISCONNECT_TIMEOUT'
                });
                rooms.delete(room.roomId);
                broadcastTables();
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
    function resolveFlorAccepted(room, answeringUserId) {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        room.gameRound.florResolved = true;
        room.gameRound.envidoResolved = true; // La flor anula envido
        room.gameRound.awaitingResponseFrom = null;
        room.florPendingCaller = null;
        const p1Cards = room.gameRound.p1.cards.concat(room.gameRound.p1.cardsPlayed.filter(Boolean));
        const p2Cards = room.gameRound.p2.cards.concat(room.gameRound.p2.cardsPlayed.filter(Boolean));
        const p1FlorPts = (0, trucoEngine_1.calculateFlor)(p1Cards);
        const p2FlorPts = (0, trucoEngine_1.calculateFlor)(p2Cards);
        let winnerId = room.creatorId;
        let winnerPts = p1FlorPts;
        let winnerCards = p1Cards;
        if (p2FlorPts > p1FlorPts) {
            winnerId = room.guestId;
            winnerPts = p2FlorPts;
            winnerCards = p2Cards;
        }
        else if (p2FlorPts === p1FlorPts) {
            winnerId = room.manoId;
            winnerPts = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? p1FlorPts : p2FlorPts;
            winnerCards = room.manoId.toLowerCase() === room.creatorId.toLowerCase() ? p1Cards : p2Cards;
        }
        const pointsAwarded = room.gameRound.calculateFlorPoints(room.florChain, true, room.scoreP1, room.scoreP2);
        if (winnerId.toLowerCase() === room.creatorId.toLowerCase())
            room.scoreP1 += pointsAwarded;
        else
            room.scoreP2 += pointsAwarded;
        room.envidoWinnerRecord = { winnerId, score: winnerPts, cards: winnerCards, pointsAwarded };
        io.to(room.roomId).emit('flor_declared', {
            winnerId, score: winnerPts, cards: winnerCards,
            pointsAwarded, scores: getScoreMap(room), trucoLevel: room.trucoLevel, trucoOwner: room.trucoOwner,
            currentTurn: room.gameRound.currentTurn
        });
        if (checkMatchEnd(room))
            return;
        if (checkAndResumePendingTruco(room))
            return;
        startTurnTimer(room, 25);
    }
    function resolveFlorDeclined(room, answeringUserId) {
        if (!room.gameRound)
            return;
        clearTurnTimer(room);
        room.gameRound.florResolved = true;
        room.gameRound.envidoResolved = true; // La flor anula envido
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
        if (checkMatchEnd(room))
            return;
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
        const p1PlayedInTrick0 = room.gameRound.p1.cardsPlayed[0] !== null;
        const p2PlayedInTrick0 = room.gameRound.p2.cardsPlayed[0] !== null;
        const totalCardsPlayedInTrick0 = (p1PlayedInTrick0 ? 1 : 0) + (p2PlayedInTrick0 ? 1 : 0);
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
            room.gameRound.florResolved = true;
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
            myAvatar: (0, userService_1.getUserAvatar)(userId),
            rivalAvatar: rivalUsername ? (0, userService_1.getUserAvatar)(rivalUsername) : 'gaucho'
        });
    }
    io.on('connection', (socket) => {
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
                }
                else if (room.guestId && room.guestId.toLowerCase() === userId.toLowerCase()) {
                    room.guestSocketId = socket.id;
                }
                if (room.disconnectedUser && room.disconnectedUser.toLowerCase() === userId.toLowerCase()) {
                    clearDisconnectTimer(room);
                    io.to(roomId).emit('player_reconnected', { reconnectedUser: userId });
                    startTurnTimer(room, 25);
                }
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
                    newBalance: (0, userService_1.getUserChips)(userId),
                    targetPoints: pts,
                    withFlor: flor,
                    betAmount: bet,
                    avatar: (0, userService_1.getUserAvatar)(userId)
                });
                broadcastTables();
            }
            catch (err) {
                console.error('Error creando mesa:', err);
            }
        });
        socket.on('cancel_waiting_table', ({ roomId }) => {
            const room = rooms.get(roomId);
            if (room && !room.guestId && room.creatorSocketId === socket.id) {
                if (room.betAmount > 0) {
                    (0, userService_1.modifyUserChips)(room.creatorId, room.betAmount);
                }
                rooms.delete(roomId);
                socket.emit('table_cancelled_ok', { newBalance: (0, userService_1.getUserChips)(room.creatorId) });
                broadcastTables();
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
            clearTurnTimer(room);
            clearDisconnectTimer(room);
            const winnerId = isP1 ? room.guestId : room.creatorId;
            const grossPot = room.betAmount > 0 ? room.betAmount * 2 : 0;
            const netPot = grossPot * 0.9;
            const rake = grossPot * 0.1;
            if (netPot > 0) {
                (0, userService_1.modifyUserChips)(winnerId, netPot);
                (0, userService_1.recordTransaction)('COMMISSION_RAKE', winnerId, rake, `Comisión rendición mesa ${room.roomId} ($${room.betAmount} c/u)`);
            }
            io.to(roomId).emit('player_surrendered', {
                surrenderedUser: authUser,
                winnerId,
                pot: netPot,
                scores: getScoreMap(room),
                winnerBalance: (0, userService_1.getUserChips)(winnerId),
                reason: 'SURRENDER'
            });
            rooms.delete(room.roomId);
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
                room.guestSocketId = socket.id;
                socket.join(roomId);
                io.to(roomId).emit('game_ready', {
                    roomId: room.roomId,
                    creatorId: room.creatorId,
                    creatorAvatar: (0, userService_1.getUserAvatar)(room.creatorId),
                    guestId: room.guestId,
                    guestAvatar: (0, userService_1.getUserAvatar)(userId),
                    pot: room.betAmount > 0 ? room.betAmount * 2 * 0.9 : 0,
                    targetPoints: room.targetPoints,
                    withFlor: room.withFlor,
                    betAmount: room.betAmount
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
                if (!room.guestId && room.creatorSocketId === socket.id) {
                    if (room.betAmount > 0)
                        (0, userService_1.modifyUserChips)(room.creatorId, room.betAmount);
                    rooms.delete(roomId);
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
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (!authUser)
                return socket.emit('error_action', { message: 'No perteneces a esta partida.' });
            if (room.gameRound.currentTurn.toLowerCase() !== authUser.toLowerCase()) {
                return socket.emit('error_action', { message: 'No es tu turno de jugar carta.' });
            }
            executePlayCard(room, authUser, cardId);
        });
        socket.on('declare_envido_points', ({ roomId, points }) => {
            const room = rooms.get(roomId);
            if (!room || room.disconnectedUser)
                return;
            const authUser = getAuthenticatedUserId(room, socket.id);
            if (authUser)
                executeDeclareEnvido(room, authUser, points);
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
                // Si hay Envido o Flor pendientes de responder, se bloquean los cantos de Truco.
                if ((room.envidoPendingCaller || room.florPendingCaller) && ['TRUCO', 'RETRUCO', 'VALE_4'].includes(callType)) {
                    return socket.emit('error_action', { message: 'Debes responder primero a los tantos/flor.' });
                }
                // --- LÓGICA DE FLOR (Casos A, B y C integrados) ---
                if (['FLOR', 'CONTRAFLOR', 'CONTRAFLOR_AL_JUEGO'].includes(callType)) {
                    if (!room.withFlor)
                        return socket.emit('error_action', { message: 'Partida SIN FLOR.' });
                    if (currentTrick > 0 || room.gameRound.florResolved)
                        return socket.emit('error_action', { message: 'El tiempo para cantar Flor ya cerró.' });
                    const rivalHand = rivalId.toLowerCase() === room.creatorId.toLowerCase() ? room.gameRound.p1 : room.gameRound.p2;
                    const rivalCards = rivalHand.cards.concat(rivalHand.cardsPlayed.filter(Boolean));
                    const rivalHasFlor = (0, trucoEngine_1.hasFlor)(rivalCards);
                    // Si canta FLOR inicial y el rival NO tiene flor, ganamos automáticamente los 3 puntos
                    if (callType === 'FLOR' && !rivalHasFlor) {
                        room.gameRound.envidoResolved = true; // La flor anula el envido
                        room.gameRound.florResolved = true;
                        room.gameRound.awaitingResponseFrom = null;
                        room.florPendingCaller = null;
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
                        if (checkMatchEnd(room))
                            return;
                        if (checkAndResumePendingTruco(room))
                            return;
                        return startTurnTimer(room, 25);
                    }
                    // Si el rival TIENE flor, o es una Contraflor / Contraflor al Juego
                    room.gameRound.envidoResolved = true; // Anula el Envido
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
                    return startTurnTimer(room, 25);
                }
                if (callType === 'QUIERO_FLOR')
                    return resolveFlorAccepted(room, authUser);
                if (callType === 'NO_QUIERO_FLOR')
                    return resolveFlorDeclined(room, authUser);
                // --------------------------------------------------
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
                    return startTurnTimer(room, 25);
                }
                if (callType === 'QUIERO_ENVIDO')
                    return startEnvidoDeclarationPhase(room);
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
                        room.gameRound.florResolved = true; // Por las dudas
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
                    return startTurnTimer(room, 25);
                }
                if (callType === 'RETRUCO') {
                    room.gameRound.envidoResolved = true;
                    room.gameRound.florResolved = true;
                    room.pendingTrucoAfterEnvido = null;
                    room.gameRound.trucoPointsAtStake = 3;
                    room.gameRound.awaitingResponseFrom = rivalId;
                    io.to(roomId).emit('call_received', { userId: authUser, callType: 'RETRUCO', category: 'TRUCO', awaitingResponseFrom: rivalId, canCallEnvido: false });
                    return startTurnTimer(room, 25);
                }
                if (callType === 'VALE_4') {
                    room.gameRound.envidoResolved = true;
                    room.gameRound.florResolved = true;
                    room.pendingTrucoAfterEnvido = null;
                    room.gameRound.trucoPointsAtStake = 4;
                    room.gameRound.awaitingResponseFrom = rivalId;
                    io.to(roomId).emit('call_received', { userId: authUser, callType: 'VALE_4', category: 'TRUCO', awaitingResponseFrom: rivalId, canCallEnvido: false });
                    return startTurnTimer(room, 25);
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
                    return startTurnTimer(room, 25);
                }
                if (callType === 'NO_QUIERO_TRUCO' || callType === 'ME_VOY_AL_MAZO') {
                    room.pendingTrucoAfterEnvido = null;
                    return resolveTrucoFold(room, authUser, callType);
                }
            }
            catch (err) {
                console.error('Error en send_call:', err);
            }
        });
    });
}
