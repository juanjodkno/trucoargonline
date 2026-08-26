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
    trucoPointsAtStake = 1;
    awaitingResponseFrom = null;
    constructor(p1Id, p2Id, manoId, targetPoints = 30, withFlor = true) {
        this.manoId = manoId;
        this.currentTurn = manoId;
        this.targetPoints = targetPoints;
        this.withFlor = withFlor;
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
    playCard(userId, cardId) {
        if (this.isFinished) {
            return { success: false, message: 'La mano ya ha finalizado.' };
        }
        if (this.currentTurn !== userId) {
            return { success: false, message: 'No es tu turno.' };
        }
        const hand = userId === this.p1.userId ? this.p1 : this.p2;
        const cardIdx = hand.cards.findIndex(c => c.id === cardId);
        if (cardIdx === -1) {
            return { success: false, message: 'No posees esa carta.' };
        }
        const [playedCard] = hand.cards.splice(cardIdx, 1);
        hand.cardsPlayed[this.currentTrickIndex] = playedCard;
        const p1Played = this.p1.cardsPlayed[this.currentTrickIndex];
        const p2Played = this.p2.cardsPlayed[this.currentTrickIndex];
        const rivalId = userId === this.p1.userId ? this.p2.userId : this.p1.userId;
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
        if (t0 === 'PARDA') {
            if (t1 && t1 !== 'PARDA')
                return { roundOver: true, winnerId: t1 };
            if (t1 === 'PARDA' && t2 && t2 !== 'PARDA')
                return { roundOver: true, winnerId: t2 };
            if (t1 === 'PARDA' && t2 === 'PARDA')
                return { roundOver: true, winnerId: this.manoId };
        }
        if (t1 === 'PARDA' && t0 && t0 !== 'PARDA') {
            return { roundOver: true, winnerId: t0 };
        }
        if (t2 === 'PARDA' && t0 && t0 !== 'PARDA') {
            return { roundOver: true, winnerId: t0 };
        }
        if (this.currentTrickIndex === 2 && t0 && t1 && t2) {
            return { roundOver: true, winnerId: this.manoId };
        }
        return { roundOver: false };
    }
}
exports.TrucoRound = TrucoRound;
