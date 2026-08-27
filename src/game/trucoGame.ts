// src/game/trucoGame.ts
import { Card, createDeck, shuffleDeck, compareCards } from './trucoEngine';

export interface PlayerRoundHand {
  userId: string;
  team: 'TEAM_1' | 'TEAM_2';
  cards: Card[];
  cardsPlayed: (Card | null)[];
}

export interface PlayCardResult {
  success: boolean;
  message?: string;
  trickIndex?: number;
  isTrickOver?: boolean;
  trickWinnerId?: string;
  trickWinnerTeam?: 'TEAM_1' | 'TEAM_2' | 'PARDA';
  nextTurn?: string;
  roundOver?: boolean;
  winnerId?: string;
  winnerTeam?: 'TEAM_1' | 'TEAM_2';
  points?: number;
}

export class TrucoRound {
  public players: PlayerRoundHand[] = [];
  public playerMap: Map<string, PlayerRoundHand> = new Map();
  public p1: PlayerRoundHand;
  public p2: PlayerRoundHand;
  public p3?: PlayerRoundHand;
  public p4?: PlayerRoundHand;
  public is2v2: boolean = false;

  public manoId: string;
  public currentTurn: string;
  public trickLeaderUserId: string;
  public currentTrickIndex: number = 0;
  public trickWinners: ('TEAM_1' | 'TEAM_2' | 'PARDA' | null)[] = [null, null, null];
  public isFinished: boolean = false;
  public winnerId: string | null = null;
  public winnerTeam: 'TEAM_1' | 'TEAM_2' | null = null;
  public targetPoints: number;
  public withFlor: boolean;

  public envidoResolved: boolean = false;
  public trucoPointsAtStake: number = 1;
  public awaitingResponseFrom: string | null = null;

  constructor(
    p1OrPlayers: string | string[],
    p2OrManoId: string,
    manoIdOrTargetPoints?: string | number,
    targetPointsOrWithFlor?: number | boolean,
    withFlorParam?: boolean
  ) {
    let playerIds: string[] = [];
    let mano: string;
    let points: number = 30;
    let flor: boolean = true;

    if (Array.isArray(p1OrPlayers)) {
      playerIds = p1OrPlayers;
      mano = p2OrManoId;
      if (typeof manoIdOrTargetPoints === 'number') points = manoIdOrTargetPoints;
      if (typeof targetPointsOrWithFlor === 'boolean') flor = targetPointsOrWithFlor;
    } else {
      playerIds = [p1OrPlayers, p2OrManoId];
      mano = typeof manoIdOrTargetPoints === 'string' ? manoIdOrTargetPoints : p1OrPlayers;
      if (typeof targetPointsOrWithFlor === 'number') points = targetPointsOrWithFlor;
      if (typeof withFlorParam === 'boolean') flor = withFlorParam;
    }

    this.is2v2 = playerIds.length === 4;
    this.manoId = mano;
    this.currentTurn = mano;
    this.trickLeaderUserId = mano;
    this.targetPoints = Number(points) === 15 ? 15 : 30;
    this.withFlor = flor === true || (flor as unknown) === 'true';

    const deck = shuffleDeck(createDeck());

    if (this.is2v2) {
      // 4 Jugadores: Equipo 1 (P1 y P3) vs Equipo 2 (P2 y P4)
      this.p1 = {
        userId: playerIds[0],
        team: 'TEAM_1',
        cards: [deck[0], deck[4], deck[8]],
        cardsPlayed: [null, null, null]
      };
      this.p2 = {
        userId: playerIds[1],
        team: 'TEAM_2',
        cards: [deck[1], deck[5], deck[9]],
        cardsPlayed: [null, null, null]
      };
      this.p3 = {
        userId: playerIds[2],
        team: 'TEAM_1',
        cards: [deck[2], deck[6], deck[10]],
        cardsPlayed: [null, null, null]
      };
      this.p4 = {
        userId: playerIds[3],
        team: 'TEAM_2',
        cards: [deck[3], deck[7], deck[11]],
        cardsPlayed: [null, null, null]
      };

      this.players = [this.p1, this.p2, this.p3, this.p4];
    } else {
      // 2 Jugadores (1 vs 1 tradicional)
      this.p1 = {
        userId: playerIds[0],
        team: 'TEAM_1',
        cards: [deck[0], deck[2], deck[4]],
        cardsPlayed: [null, null, null]
      };
      this.p2 = {
        userId: playerIds[1],
        team: 'TEAM_2',
        cards: [deck[1], deck[3], deck[5]],
        cardsPlayed: [null, null, null]
      };

      this.players = [this.p1, this.p2];
    }

    this.players.forEach(p => {
      this.playerMap.set(p.userId.toLowerCase(), p);
    });
  }

  public getPlayerHand(userId: string): PlayerRoundHand | undefined {
    return this.playerMap.get((userId || '').toLowerCase());
  }

  public getTeam(userId: string): 'TEAM_1' | 'TEAM_2' {
    const hand = this.getPlayerHand(userId);
    return hand?.team || 'TEAM_1';
  }

  public getTeamPlayers(team: 'TEAM_1' | 'TEAM_2'): string[] {
    return this.players.filter(p => p.team === team).map(p => p.userId);
  }

  public getPartner(userId: string): string | null {
    if (!this.is2v2) return null;
    const hand = this.getPlayerHand(userId);
    if (!hand) return null;
    const partner = this.players.find(p => p.team === hand.team && p.userId.toLowerCase() !== userId.toLowerCase());
    return partner ? partner.userId : null;
  }

  public getRivals(userId: string): string[] {
    const hand = this.getPlayerHand(userId);
    if (!hand) return [];
    return this.players.filter(p => p.team !== hand.team).map(p => p.userId);
  }

  public playCard(userId: string, cardId: string): PlayCardResult {
    if (this.isFinished) {
      return { success: false, message: 'La mano ya ha finalizado.' };
    }

    if (this.currentTurn.toLowerCase() !== (userId || '').toLowerCase()) {
      return { success: false, message: 'No es tu turno.' };
    }

    const hand = this.getPlayerHand(userId);
    if (!hand) {
      return { success: false, message: 'Jugador no encontrado en la mesa.' };
    }

    const cardIdx = hand.cards.findIndex(c => c.id === cardId);
    if (cardIdx === -1) {
      return { success: false, message: 'No posees esa carta.' };
    }

    const [playedCard] = hand.cards.splice(cardIdx, 1);
    hand.cardsPlayed[this.currentTrickIndex] = playedCard;

    // Verificar si todos los jugadores de la mesa ya tiraron su carta en esta baza
    const allPlayed = this.players.every(p => p.cardsPlayed[this.currentTrickIndex] !== null);

    if (!allPlayed) {
      // Rotación de turno al siguiente jugador sentado a la derecha
      const currentIndex = this.players.findIndex(p => p.userId.toLowerCase() === userId.toLowerCase());
      const nextIndex = (currentIndex + 1) % this.players.length;
      this.currentTurn = this.players[nextIndex].userId;

      return {
        success: true,
        trickIndex: this.currentTrickIndex,
        isTrickOver: false,
        nextTurn: this.currentTurn,
        roundOver: false
      };
    }

    // Determinar la carta ganadora de la baza entre todas las cartas jugadas
    let bestCompCard: Card | null = null;
    let bestPlayers: PlayerRoundHand[] = [];

    // Evaluamos en el orden en que fueron jugadas a partir del que abrió la baza
    const startIdx = this.players.findIndex(p => p.userId.toLowerCase() === this.trickLeaderUserId.toLowerCase());
    for (let i = 0; i < this.players.length; i++) {
      const idx = (startIdx + i) % this.players.length;
      const p = this.players[idx];
      const card = p.cardsPlayed[this.currentTrickIndex]!;

      if (!bestCompCard) {
        bestCompCard = card;
        bestPlayers = [p];
      } else {
        const comp = compareCards(card, bestCompCard);
        if (comp > 0) {
          bestCompCard = card;
          bestPlayers = [p];
        } else if (comp === 0) {
          bestPlayers.push(p);
        }
      }
    }

    let trickWinnerTeam: 'TEAM_1' | 'TEAM_2' | 'PARDA' = 'PARDA';
    let winningPlayerId = 'PARDA';

    const team1Present = bestPlayers.some(p => p.team === 'TEAM_1');
    const team2Present = bestPlayers.some(p => p.team === 'TEAM_2');

    if (team1Present && !team2Present) {
      trickWinnerTeam = 'TEAM_1';
      winningPlayerId = bestPlayers[0].userId;
    } else if (team2Present && !team1Present) {
      trickWinnerTeam = 'TEAM_2';
      winningPlayerId = bestPlayers[0].userId;
    } else {
      trickWinnerTeam = 'PARDA';
      winningPlayerId = 'PARDA';
    }

    this.trickWinners[this.currentTrickIndex] = trickWinnerTeam;

    const roundStatus = this.checkRoundWinner();
    if (roundStatus.roundOver) {
      this.isFinished = true;
      this.winnerTeam = roundStatus.winnerTeam || null;
      this.winnerId = roundStatus.winnerId || null;

      return {
        success: true,
        trickIndex: this.currentTrickIndex,
        isTrickOver: true,
        trickWinnerId: winningPlayerId,
        trickWinnerTeam,
        roundOver: true,
        winnerId: this.winnerId || undefined,
        winnerTeam: this.winnerTeam || undefined,
        points: this.trucoPointsAtStake
      };
    }

    this.currentTrickIndex++;

    // Quien mata la baza sale jugando la siguiente; si es parda, sale quien abrió la baza empatada
    if (trickWinnerTeam === 'PARDA') {
      this.currentTurn = this.trickLeaderUserId;
    } else {
      this.currentTurn = winningPlayerId;
      this.trickLeaderUserId = winningPlayerId;
    }

    return {
      success: true,
      trickIndex: this.currentTrickIndex - 1,
      isTrickOver: true,
      trickWinnerId: winningPlayerId,
      trickWinnerTeam,
      nextTurn: this.currentTurn,
      roundOver: false
    };
  }

  private checkRoundWinner(): { roundOver: boolean; winnerTeam?: 'TEAM_1' | 'TEAM_2'; winnerId?: string } {
    const t0 = this.trickWinners[0];
    const t1 = this.trickWinners[1];
    const t2 = this.trickWinners[2];

    const manoTeam = this.getTeam(this.manoId);

    const getRep = (team: 'TEAM_1' | 'TEAM_2'): string => {
      return team === 'TEAM_1' ? this.p1.userId : this.p2.userId;
    };

    let t1Wins = 0;
    let t2Wins = 0;
    if (t0 === 'TEAM_1') t1Wins++; if (t0 === 'TEAM_2') t2Wins++;
    if (t1 === 'TEAM_1') t1Wins++; if (t1 === 'TEAM_2') t2Wins++;
    if (t2 === 'TEAM_1') t1Wins++; if (t2 === 'TEAM_2') t2Wins++;

    if (t1Wins >= 2) return { roundOver: true, winnerTeam: 'TEAM_1', winnerId: getRep('TEAM_1') };
    if (t2Wins >= 2) return { roundOver: true, winnerTeam: 'TEAM_2', winnerId: getRep('TEAM_2') };

    // Primera mano PARDA
    if (t0 === 'PARDA') {
      if (t1 && t1 !== 'PARDA') return { roundOver: true, winnerTeam: t1, winnerId: getRep(t1) };
      if (t1 === 'PARDA' && t2 && t2 !== 'PARDA') return { roundOver: true, winnerTeam: t2, winnerId: getRep(t2) };
      if (t1 === 'PARDA' && t2 === 'PARDA') return { roundOver: true, winnerTeam: manoTeam, winnerId: this.manoId };
    }

    // Segunda mano PARDA (gana quien ganó la primera)
    if (t1 === 'PARDA' && t0 && t0 !== 'PARDA') {
      return { roundOver: true, winnerTeam: t0, winnerId: getRep(t0) };
    }

    // Tercera mano PARDA (gana quien ganó la primera)
    if (t2 === 'PARDA' && t0 && t0 !== 'PARDA') {
      return { roundOver: true, winnerTeam: t0, winnerId: getRep(t0) };
    }

    // Tres manos completadas
    if (this.currentTrickIndex === 2 && t0 && t1 && t2) {
      return { roundOver: true, winnerTeam: manoTeam, winnerId: this.manoId };
    }

    return { roundOver: false };
  }
}