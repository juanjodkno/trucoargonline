"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrucoRound = void 0;
// src/game/trucoGame.ts
const trucoEngine_1 = require("./trucoEngine");
class TrucoRound {
    p1;
    p2;
    manoId;
    currentTurn;
    currentTrickIndex = 0;
    trickWinners = [null, null, null];
    isFinished = false;
    winnerId = null;
    targetPoints;
    withFlor;
    envidoResolved = false;
    florResolved = false; // <-- AGREGADO PARA LA FLOR
    trucoPointsAtStake = 1;
    awaitingResponseFrom = null;
    constructor(p1Id, p2Id, manoId, targetPoints = 30, withFlor = true) {
        this.manoId = manoId;
        this.currentTurn = manoId;
        this.targetPoints = Number(targetPoints) === 15 ? 15 : 30;
        this.withFlor = (withFlor === true || withFlor === 'true');
        const deck = (0, trucoEngine_1.shuffleDeck)((0, trucoEngine_1.createDeck)());
        this.p1 = {
            userId: p1Id,
            cards: [deck[0], deck[2], deck[4]],
            cardsPlayed: [null, null, null]
        };
        this.p2 = {
            userId: p2Id,
            cards: [deck[1], deck[3], deck[5]],
            cardsPlayed: [null, null, null]
        };
    }
    // --- LÓGICA DE PUNTOS PARA LA FLOR (Casos A, B y C) ---
    calculateFlorPoints(callChain, accepted, p1TotalScore, p2TotalScore) {
        const lastCall = callChain[callChain.length - 1];
        if (!accepted) {
            // Si el rival dice "No quiero" a una Contraflor
            if (lastCall === 'CONTRAFLOR')
                return 4; // Caso A: 4 puntos para el que cantó
            if (lastCall === 'CONTRAFLOR_AL_JUEGO')
                return 7; // Caso B: 7 puntos para el que cantó
            return 3; // Por defecto, si no quiere una flor y se achica.
        }
        else {
            // Si el rival dice "Quiero"
            if (lastCall === 'CONTRAFLOR_AL_JUEGO') {
                // Caso C: Contraflor al juego aceptada -> puntos que le faltan al puntero para ganar
                const leaderScore = Math.max(p1TotalScore, p2TotalScore);
                return this.targetPoints - leaderScore;
            }
            if (lastCall === 'CONTRAFLOR')
                return 6; // Flor -> Contraflor -> Quiero = 6 puntos
            return 3; // Flor vs Flor normal = 3 puntos
        }
    }
    playCard(userId, cardId) {
        if (this.isFinished) {
            return { success: false, message: 'La mano ya ha finalizado.' };
        }
        if (this.currentTurn.toLowerCase() !== (userId || '').toLowerCase()) {
            return { success: false, message: 'No es tu turno.' };
        }
        const hand = userId.toLowerCase() === this.p1.userId.toLowerCase() ? this.p1 : this.p2;
        const cardIdx = hand.cards.findIndex(c => c.id === cardId);
        if (cardIdx === -1) {
            return { success: false, message: 'No posees esa carta.' };
        }
        const [playedCard] = hand.cards.splice(cardIdx, 1);
        hand.cardsPlayed[this.currentTrickIndex] = playedCard;
        const p1Played = this.p1.cardsPlayed[this.currentTrickIndex];
        const p2Played = this.p2.cardsPlayed[this.currentTrickIndex];
        const rivalId = userId.toLowerCase() === this.p1.userId.toLowerCase() ? this.p2.userId : this.p1.userId;
        if (!p1Played || !p2Played) {
            this.currentTurn = rivalId;
            return {
                success: true,
                trickIndex: this.currentTrickIndex,
                isTrickOver: false,
                nextTurn: this.currentTurn,
                roundOver: false
            };
        }
        const comp = (0, trucoEngine_1.compareCards)(p1Played, p2Played);
        let trickWinner = 'PARDA';
        if (comp > 0)
            trickWinner = this.p1.userId;
        else if (comp < 0)
            trickWinner = this.p2.userId;
        this.trickWinners[this.currentTrickIndex] = trickWinner;
        const roundStatus = this.checkRoundWinner();
        if (roundStatus.roundOver) {
            this.isFinished = true;
            this.winnerId = roundStatus.winnerId || null;
            return {
                success: true,
                trickIndex: this.currentTrickIndex,
                isTrickOver: true,
                trickWinnerId: trickWinner,
                roundOver: true,
                winnerId: this.winnerId || undefined,
                points: this.trucoPointsAtStake
            };
        }
        this.currentTrickIndex++;
        this.currentTurn = trickWinner === 'PARDA' ? this.manoId : trickWinner;
        return {
            success: true,
            trickIndex: this.currentTrickIndex - 1,
            isTrickOver: true,
            trickWinnerId: trickWinner,
            nextTurn: this.currentTurn,
            roundOver: false
        };
    }
    checkRoundWinner() {
        const t0 = this.trickWinners[0];
        const t1 = this.trickWinners[1];
        const t2 = this.trickWinners[2];
        const p1 = this.p1.userId;
        const p2 = this.p2.userId;
        let p1Wins = 0;
        let p2Wins = 0;
        if (t0 === p1)
            p1Wins++;
        if (t0 === p2)
            p2Wins++;
        if (t1 === p1)
            p1Wins++;
        if (t1 === p2)
            p2Wins++;
        if (t2 === p1)
            p1Wins++;
        if (t2 === p2)
            p2Wins++;
        if (p1Wins >= 2)
            return { roundOver: true, winnerId: p1 };
        if (p2Wins >= 2)
            return { roundOver: true, winnerId: p2 };
        // Si la 1era es parda (t0 === 'PARDA')
        if (t0 === 'PARDA') {
            // Si la 2da la gana alguien (t1), ese gana la mano de inmediato
            if (t1 && t1 !== 'PARDA')
                return { roundOver: true, winnerId: t1 };
            // Si la 2da también es parda y se jugó la 3ra, decide la 3ra
            if (t1 === 'PARDA' && t2 && t2 !== 'PARDA')
                return { roundOver: true, winnerId: t2 };
            // Si las tres son pardas, gana la mano (manoId)
            if (t1 === 'PARDA' && t2 === 'PARDA')
                return { roundOver: true, winnerId: this.manoId };
        }
        // Si la 1era la ganó alguien (t0) y la 2da es parda (t1 === 'PARDA'), 
        // SE DEBE JUGAR LA TERCERA CARTA (por eso quitamos el cierre prematuro de acá).
        // Si ya se jugaron las 3 bazas y nadie ganó 2, se define por quién ganó la primera (o mano)
        if (this.currentTrickIndex === 2 && t0 && t1 && t2) {
            if (t0 !== 'PARDA')
                return { roundOver: true, winnerId: t0 };
            return { roundOver: true, winnerId: this.manoId };
        }
        return { roundOver: false };
    }
}
exports.TrucoRound = TrucoRound;
