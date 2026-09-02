// src/game/trucoGame.ts
import { Card, createDeck, shuffleDeck, compareCards } from './trucoEngine';

export interface PlayerRoundHand {
  userId: string;
  cards: Card[];
  cardsPlayed: (Card | null)[];
}

export interface PlayCardResult {
  success: boolean;
  message?: string;
  trickIndex?: number;
  isTrickOver?: boolean;
  trickWinnerId?: string;
  nextTurn?: string;
  roundOver?: boolean;
  winnerId?: string;
  points?: number;
}

export class TrucoRound {
  public p1: PlayerRoundHand;
  public p2: PlayerRoundHand;
  public manoId: string;
  public currentTurn: string;
  public currentTrickIndex: number = 0;
  public trickWinners: (string | null)[] = [null, null, null];
  public isFinished: boolean = false;
  public winnerId: string | null = null;
  public targetPoints: number;
  public withFlor: boolean;

  public envidoResolved: boolean = false;
  public florResolved: boolean = false;
  public trucoPointsAtStake: number = 1;
  public awaitingResponseFrom: string | null = null;

  constructor(p1Id: string, p2Id: string, manoId: string, targetPoints: number = 30, withFlor: boolean = true) {
    this.manoId = manoId;
    this.currentTurn = manoId;
    this.targetPoints = Number(targetPoints) === 15 ? 15 : 30;
    this.withFlor = (withFlor === true || (withFlor as unknown) === 'true');

    const deck = shuffleDeck(createDeck());

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

  public calculateFlorPoints(callChain: string[], accepted: boolean, p1TotalScore: number, p2TotalScore: number): number {
    const lastCall = callChain[callChain.length - 1];

    if (!accepted) {
      if (lastCall === 'CONTRAFLOR') return 4;
      if (lastCall === 'CONTRAFLOR_AL_JUEGO') return 7;
      return 3;
    } else {
      if (lastCall === 'CONTRAFLOR_AL_JUEGO') {
        const leaderScore = Math.max(p1TotalScore, p2TotalScore);
        return this.targetPoints - leaderScore;
      }
      if (lastCall === 'CONTRAFLOR') return 6;
      return 3;
    }
  }

  public playCard(userId: string, cardId: string): PlayCardResult {
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

    const comp = compareCards(p1Played, p2Played);
    let trickWinner = 'PARDA';

    if (comp > 0) trickWinner = this.p1.userId;
    else if (comp < 0) trickWinner = this.p2.userId;

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

  private checkRoundWinner(): { roundOver: boolean; winnerId?: string } {
    const t0 = this.trickWinners[0];
    const t1 = this.trickWinners[1];
    const t2 = this.trickWinners[2];

    const p1 = this.p1.userId;
    const p2 = this.p2.userId;

    let p1Wins = 0;
    let p2Wins = 0;
    if (t0 === p1) p1Wins++; if (t0 === p2) p2Wins++;
    if (t1 === p1) p1Wins++; if (t1 === p2) p2Wins++;
    if (t2 === p1) p1Wins++; if (t2 === p2) p2Wins++;

    // 1. Ganador por llevarse 2 bazas limpias (esto ya te funcionaba bien)
    if (p1Wins >= 2) return { roundOver: true, winnerId: p1 };
    if (p2Wins >= 2) return { roundOver: true, winnerId: p2 };

    // 2. Si hay PARDA en la primera baza
    if (t0 === 'PARDA') {
      if (t1 && t1 !== 'PARDA') return { roundOver: true, winnerId: t1 }; // Gana el que mata en la 2da
      if (t1 === 'PARDA' && t2 && t2 !== 'PARDA') return { roundOver: true, winnerId: t2 }; // Doble parda, define la 3ra
      if (t1 === 'PARDA' && t2 === 'PARDA') return { roundOver: true, winnerId: this.manoId }; // Triple parda, gana mano
    }

    // 3. Si alguien mata en la primera, pero la segunda es PARDA -> Gana automáticamente (Tu bug estaba acá)
    if (t0 && t0 !== 'PARDA' && t1 === 'PARDA') {
      return { roundOver: true, winnerId: t0 };
    }

    // 4. Si ganan una y una, y llegan a una tercera baza que es PARDA -> Gana el que hizo primera
    if (t0 && t1 && t0 !== 'PARDA' && t1 !== 'PARDA' && t2 === 'PARDA') {
      return { roundOver: true, winnerId: t0 };
    }

    return { roundOver: false };
  }
  }