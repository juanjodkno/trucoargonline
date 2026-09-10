import { Card, createDeck, shuffleDeck } from './trucoEngine';

export type TeamId = 'A' | 'B';
export type TrickTeamWinner = TeamId | 'PARDA' | null;

export interface TeamPlayerHand {
  seat: number;
  userId: string;
  team: TeamId;
  cards: Card[];
  originalCards: Card[];
  cardsPlayed: (Card | null)[];
}

export interface TeamPlayCardResult {
  success: boolean;
  message?: string;
  trickIndex?: number;
  isTrickOver?: boolean;
  trickWinnerTeam?: TrickTeamWinner;
  trickWinnerSeat?: number | null;
  nextTurnSeat?: number;
  roundOver?: boolean;
  winnerTeam?: TeamId;
  points?: number;
}

export function teamForSeat(seat: number): TeamId {
  return seat % 2 === 0 ? 'A' : 'B';
}

export class TeamTrucoRound {
  public players: TeamPlayerHand[];
  public manoSeat: number;
  public currentTurnSeat: number;
  public currentTrickIndex = 0;
  public trickLeaderSeat: number;
  public trickWinners: TrickTeamWinner[] = [null, null, null];
  public trickWinnerSeats: (number | null)[] = [null, null, null];
  public isFinished = false;
  public winnerTeam: TeamId | null = null;
  public targetPoints: number;
  public withFlor: boolean;
  public trucoPointsAtStake = 1;
  public envidoResolved = false;
  public florResolved = false;

  constructor(userIdsBySeat: string[], manoSeat: number, targetPoints = 30, withFlor = false) {
    if (!Array.isArray(userIdsBySeat) || userIdsBySeat.length !== 4) {
      throw new Error('TeamTrucoRound requiere exactamente 4 jugadores.');
    }

    this.manoSeat = ((Number(manoSeat) % 4) + 4) % 4;
    this.currentTurnSeat = this.manoSeat;
    this.trickLeaderSeat = this.manoSeat;
    this.targetPoints = Number(targetPoints) === 15 ? 15 : 30;
    this.withFlor = withFlor === true;

    const deck = shuffleDeck(createDeck());
    this.players = userIdsBySeat.map((userId, seat) => {
      const hand = [deck[seat], deck[seat + 4], deck[seat + 8]];
      return {
        seat,
        userId,
        team: teamForSeat(seat),
        cards: [...hand],
        originalCards: [...hand],
        cardsPlayed: [null, null, null]
      };
    });
  }

  public getPlayerBySeat(seat: number): TeamPlayerHand | undefined {
    return this.players.find(p => p.seat === seat);
  }

  public getPlayerByUserId(userId: string): TeamPlayerHand | undefined {
    const key = String(userId || '').toLowerCase();
    return this.players.find(p => p.userId.toLowerCase() === key);
  }

  public getAllCardsForSeat(seat: number): Card[] {
    return [...(this.getPlayerBySeat(seat)?.originalCards || [])];
  }

  public hasSeatPlayedAnyCard(seat: number): boolean {
    const player = this.getPlayerBySeat(seat);
    return !!player?.cardsPlayed.some(Boolean);
  }

  public playCard(seat: number, cardId: string): TeamPlayCardResult {
    if (this.isFinished) return { success: false, message: 'La mano ya finalizó.' };
    if (seat !== this.currentTurnSeat) return { success: false, message: 'No es tu turno.' };

    const player = this.getPlayerBySeat(seat);
    if (!player) return { success: false, message: 'Jugador inválido.' };

    const cardIndex = player.cards.findIndex(card => card.id === cardId);
    if (cardIndex < 0) return { success: false, message: 'No poseés esa carta.' };

    const [played] = player.cards.splice(cardIndex, 1);
    player.cardsPlayed[this.currentTrickIndex] = played;

    const allPlayed = this.players.every(p => !!p.cardsPlayed[this.currentTrickIndex]);
    if (!allPlayed) {
      this.currentTurnSeat = (seat + 1) % 4;
      return {
        success: true,
        trickIndex: this.currentTrickIndex,
        isTrickOver: false,
        nextTurnSeat: this.currentTurnSeat,
        roundOver: false
      };
    }

    const trick = this.resolveCurrentTrick();
    this.trickWinners[this.currentTrickIndex] = trick.team;
    this.trickWinnerSeats[this.currentTrickIndex] = trick.seat;

    const round = this.checkRoundWinner();
    if (round.roundOver) {
      this.isFinished = true;
      this.winnerTeam = round.winnerTeam!;
      return {
        success: true,
        trickIndex: this.currentTrickIndex,
        isTrickOver: true,
        trickWinnerTeam: trick.team,
        trickWinnerSeat: trick.seat,
        roundOver: true,
        winnerTeam: this.winnerTeam,
        points: this.trucoPointsAtStake
      };
    }

    const finishedTrick = this.currentTrickIndex;
    this.currentTrickIndex++;
    this.trickLeaderSeat = trick.team === 'PARDA' || trick.seat == null ? this.trickLeaderSeat : trick.seat;
    this.currentTurnSeat = this.trickLeaderSeat;

    return {
      success: true,
      trickIndex: finishedTrick,
      isTrickOver: true,
      trickWinnerTeam: trick.team,
      trickWinnerSeat: trick.seat,
      nextTurnSeat: this.currentTurnSeat,
      roundOver: false
    };
  }

  private resolveCurrentTrick(): { team: TrickTeamWinner; seat: number | null } {
    const played = this.players
      .map(p => ({ seat: p.seat, team: p.team, card: p.cardsPlayed[this.currentTrickIndex]! }))
      .filter(x => !!x.card);

    const bestHierarchy = Math.min(...played.map(x => x.card.hierarchy));
    const best = played.filter(x => x.card.hierarchy === bestHierarchy);
    const teams = new Set(best.map(x => x.team));

    if (teams.size > 1) return { team: 'PARDA', seat: null };

    const winningTeam = best[0].team;
    // Si dos compañeros empatan como cartas máximas, sale primero el que jugó antes en la baza.
    const order = [0, 1, 2, 3].map(i => (this.trickLeaderSeat + i) % 4);
    const winnerSeat = order.find(seat => best.some(x => x.seat === seat)) ?? best[0].seat;
    return { team: winningTeam, seat: winnerSeat };
  }

  private checkRoundWinner(): { roundOver: boolean; winnerTeam?: TeamId } {
    const [t0, t1, t2] = this.trickWinners;
    const winsA = this.trickWinners.filter(x => x === 'A').length;
    const winsB = this.trickWinners.filter(x => x === 'B').length;

    if (winsA >= 2) return { roundOver: true, winnerTeam: 'A' };
    if (winsB >= 2) return { roundOver: true, winnerTeam: 'B' };

    if (t0 === 'PARDA') {
      if (t1 && t1 !== 'PARDA') return { roundOver: true, winnerTeam: t1 };
      if (t1 === 'PARDA' && t2 && t2 !== 'PARDA') return { roundOver: true, winnerTeam: t2 };
      if (t1 === 'PARDA' && t2 === 'PARDA') return { roundOver: true, winnerTeam: teamForSeat(this.manoSeat) };
    }

    if (t0 && t0 !== 'PARDA' && t1 === 'PARDA') {
      return { roundOver: true, winnerTeam: t0 };
    }

    if (t0 && t1 && t0 !== 'PARDA' && t1 !== 'PARDA' && t0 !== t1 && t2 === 'PARDA') {
      return { roundOver: true, winnerTeam: t0 };
    }

    return { roundOver: false };
  }
}
