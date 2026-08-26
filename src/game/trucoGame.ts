// src/game/trucoGame.ts
import { Card, generateDeck, compareCards } from './trucoEngine';

export interface PlayerHand {
  id: string;
  cards: Card[];
  cardsPlayed: (Card | null)[];
}

export interface TrickRecord {
  trickIndex: number;          // 0 = 1ra, 1 = 2da, 2 = 3ra
  p1Card: Card | null;
  p2Card: Card | null;
  winnerId: string | 'PARDA' | null;
  firstPlayerId: string;       // Quién tiró primero en este lance
}

export class TrucoRound {
  public p1: PlayerHand;
  public p2: PlayerHand;
  public manoId: string;
  public currentTurn: string;
  public currentTrickIndex: number = 0; // 0, 1, o 2
  public tricks: TrickRecord[] = [];
  
  public trucoPointsAtStake: number = 1;
  public targetPoints: number;
  public withFlor: boolean;
  public awaitingResponseFrom: string | null = null;

  constructor(p1Id: string, p2Id: string, manoId: string, targetPoints: number = 30, withFlor: boolean = false) {
    this.manoId = manoId;
    this.currentTurn = manoId; // En 1ra mano arranca SIEMPRE el que es mano
    this.targetPoints = targetPoints;
    this.withFlor = withFlor;

    const deck = generateDeck();
    this.p1 = { id: p1Id, cards: [deck[0], deck[1], deck[2]], cardsPlayed: [] };
    this.p2 = { id: p2Id, cards: [deck[3], deck[4], deck[5]], cardsPlayed: [] };

    // Inicializamos el registro del primer lance (1ra mano)
    this.tricks.push({
      trickIndex: 0,
      p1Card: null,
      p2Card: null,
      winnerId: null,
      firstPlayerId: manoId,
    });
  }

  public playCard(playerId: string, cardId: string) {
    if (this.awaitingResponseFrom) {
      return { success: false, message: 'Hay un canto pendiente de respuesta.' };
    }
    if (this.currentTurn !== playerId) {
      return { success: false, message: 'No es tu turno de jugar.' };
    }

    const player = playerId === this.p1.id ? this.p1 : this.p2;
    const cardIndex = player.cards.findIndex(c => c.id === cardId);
    if (cardIndex === -1) {
      return { success: false, message: 'No tenés esa carta en tu mano.' };
    }

    const [playedCard] = player.cards.splice(cardIndex, 1);
    player.cardsPlayed.push(playedCard);

    const activeTrick = this.tricks[this.currentTrickIndex];
    if (playerId === this.p1.id) activeTrick.p1Card = playedCard;
    else activeTrick.p2Card = playedCard;

    const rivalId = playerId === this.p1.id ? this.p2.id : this.p1.id;

    // CASO A: Es la primera carta tirada en esta mano
    if (!activeTrick.p1Card || !activeTrick.p2Card) {
      this.currentTurn = rivalId; // Le toca tirar la segunda carta al rival
      return {
        success: true,
        isTrickOver: false,
        trickIndex: this.currentTrickIndex,
        nextTurn: this.currentTurn,
      };
    }

    // CASO B: Ambos ya tiraron en esta mano -> Definimos quién mató
    const comp = compareCards(activeTrick.p1Card, activeTrick.p2Card);
    let trickWinnerId: string | 'PARDA' = 'PARDA';

    if (comp === 'P1') trickWinnerId = this.p1.id;
    else if (comp === 'P2') trickWinnerId = this.p2.id;
    activeTrick.winnerId = trickWinnerId;

    // Verificamos si ya hay un ganador definitivo de la ronda
    const roundWinner = this.evaluateRoundWinner();

    if (roundWinner) {
      return {
        success: true,
        isTrickOver: true,
        trickIndex: this.currentTrickIndex,
        trickWinnerId,
        roundOver: true,
        winnerId: roundWinner,
        points: this.trucoPointsAtStake,
      };
    }

    // Si la ronda no terminó, pasamos a la siguiente mano (de 1ra a 2da, o de 2da a 3ra)
    this.currentTrickIndex++;
    
    // El que mató sale tirando primero en la siguiente mano (si fue parda, tira el que tiró primero en la anterior)
    const nextLeader = trickWinnerId !== 'PARDA' ? trickWinnerId : activeTrick.firstPlayerId;
    this.currentTurn = nextLeader;

    this.tricks.push({
      trickIndex: this.currentTrickIndex,
      p1Card: null,
      p2Card: null,
      winnerId: null,
      firstPlayerId: nextLeader,
    });

    return {
      success: true,
      isTrickOver: true,
      trickIndex: this.currentTrickIndex - 1,
      trickWinnerId,
      roundOver: false,
      nextTurn: this.currentTurn,
    };
  }

  private evaluateRoundWinner(): string | null {
    const t = this.tricks;
    const p1Id = this.p1.id;
    const p2Id = this.p2.id;

    const p1Wins = t.filter(x => x.winnerId === p1Id).length;
    const p2Wins = t.filter(x => x.winnerId === p2Id).length;

    // 1. Ganar 2 manos limpias (ej: 1ra y 2da -> 2-0 / o 1ra y 3ra)
    if (p1Wins === 2) return p1Id;
    if (p2Wins === 2) return p2Id;

    // 2. Si hubo Parda en 1ra mano -> El que gana la 2da se lleva todo
    if (t.length >= 2 && t[0].winnerId === 'PARDA' && t[1]?.winnerId) {
      if (t[1].winnerId !== 'PARDA') return t[1].winnerId;
    }

    // 3. Si hubo Parda en 2da mano -> Gana el que ganó la 1ra
    if (t.length >= 2 && t[1]?.winnerId === 'PARDA' && t[0].winnerId !== 'PARDA') {
      return t[0].winnerId;
    }

    // 4. Si se jugó la 3ra mano
    if (t.length === 3 && t[2]?.winnerId) {
      if (t[2].winnerId === p1Id) return p1Id;
      if (t[2].winnerId === p2Id) return p2Id;
      if (t[2].winnerId === 'PARDA') return this.manoId; // Triple parda gana el mano
    }

    return null;
  }
}