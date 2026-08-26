// src/game/trucoEngine.ts
export type Suit = 'ESPADA' | 'BASTO' | 'ORO' | 'COPA';

export interface Card {
  id: string;
  number: number;
  suit: Suit;
  hierarchy: number;
}

export function getCardEnvidoValue(num: number): number {
  if (num >= 10 && num <= 12) return 0;
  return num;
}

export function hasFlor(cards: Card[]): boolean {
  if (!cards || cards.length < 3) return false;
  return cards[0].suit === cards[1].suit && cards[1].suit === cards[2].suit;
}

export function calculateFlor(cards: Card[]): number {
  if (!hasFlor(cards)) return 0;
  return 20 + getCardEnvidoValue(cards[0].number) + getCardEnvidoValue(cards[1].number) + getCardEnvidoValue(cards[2].number);
}

export function calculateEnvido(cards: Card[]): number {
  return getEnvidoDetails(cards).score;
}

export function getEnvidoDetails(cards: Card[]): { score: number; envidoCards: Card[] } {
  const suits: { [key in Suit]?: Card[] } = {};
  for (const c of cards) {
    if (!suits[c.suit]) suits[c.suit] = [];
    suits[c.suit]!.push(c);
  }

  let bestScore = -1;
  let bestCards: Card[] = [];

  for (const s in suits) {
    const list = suits[s as Suit]!;
    if (list.length >= 2) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const val = 20 + getCardEnvidoValue(list[i].number) + getCardEnvidoValue(list[j].number);
          if (val > bestScore) {
            bestScore = val;
            bestCards = [list[i], list[j]];
          }
        }
      }
    }
  }

  if (bestScore === -1) {
    let maxVal = -1;
    let maxCard = cards[0];
    for (const c of cards) {
      const v = getCardEnvidoValue(c.number);
      if (v > maxVal) {
        maxVal = v;
        maxCard = c;
      }
    }
    bestScore = maxVal;
    bestCards = [maxCard];
  }

  return { score: bestScore, envidoCards: bestCards };
}

export const DECK_DEFINITIONS: { number: number; suit: Suit; hierarchy: number }[] = [
  { number: 1, suit: 'ESPADA', hierarchy: 14 },
  { number: 1, suit: 'BASTO', hierarchy: 13 },
  { number: 7, suit: 'ESPADA', hierarchy: 12 },
  { number: 7, suit: 'ORO', hierarchy: 11 },
  { number: 3, suit: 'ESPADA', hierarchy: 10 },
  { number: 3, suit: 'BASTO', hierarchy: 10 },
  { number: 3, suit: 'ORO', hierarchy: 10 },
  { number: 3, suit: 'COPA', hierarchy: 10 },
  { number: 2, suit: 'ESPADA', hierarchy: 9 },
  { number: 2, suit: 'BASTO', hierarchy: 9 },
  { number: 2, suit: 'ORO', hierarchy: 9 },
  { number: 2, suit: 'COPA', hierarchy: 9 },
  { number: 1, suit: 'ORO', hierarchy: 8 },
  { number: 1, suit: 'COPA', hierarchy: 8 },
  { number: 12, suit: 'ESPADA', hierarchy: 7 },
  { number: 12, suit: 'BASTO', hierarchy: 7 },
  { number: 12, suit: 'ORO', hierarchy: 7 },
  { number: 12, suit: 'COPA', hierarchy: 7 },
  { number: 11, suit: 'ESPADA', hierarchy: 6 },
  { number: 11, suit: 'BASTO', hierarchy: 6 },
  { number: 11, suit: 'ORO', hierarchy: 6 },
  { number: 11, suit: 'COPA', hierarchy: 6 },
  { number: 10, suit: 'ESPADA', hierarchy: 5 },
  { number: 10, suit: 'BASTO', hierarchy: 5 },
  { number: 10, suit: 'ORO', hierarchy: 5 },
  { number: 10, suit: 'COPA', hierarchy: 5 },
  { number: 7, suit: 'COPA', hierarchy: 4 },
  { number: 7, suit: 'BASTO', hierarchy: 4 },
  { number: 6, suit: 'ESPADA', hierarchy: 3 },
  { number: 6, suit: 'BASTO', hierarchy: 3 },
  { number: 6, suit: 'ORO', hierarchy: 3 },
  { number: 6, suit: 'COPA', hierarchy: 3 },
  { number: 5, suit: 'ESPADA', hierarchy: 2 },
  { number: 5, suit: 'BASTO', hierarchy: 2 },
  { number: 5, suit: 'ORO', hierarchy: 2 },
  { number: 5, suit: 'COPA', hierarchy: 2 },
  { number: 4, suit: 'ESPADA', hierarchy: 1 },
  { number: 4, suit: 'BASTO', hierarchy: 1 },
  { number: 4, suit: 'ORO', hierarchy: 1 },
  { number: 4, suit: 'COPA', hierarchy: 1 },
];

export function generateDeck(): Card[] {
  const deck: Card[] = DECK_DEFINITIONS.map(d => ({
    id: `${d.number}_${d.suit}`,
    number: d.number,
    suit: d.suit,
    hierarchy: d.hierarchy,
  }));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function compareCards(c1: Card, c2: Card): 'P1' | 'P2' | 'PARDA' {
  if (c1.hierarchy > c2.hierarchy) return 'P1';
  if (c2.hierarchy > c1.hierarchy) return 'P2';
  return 'PARDA';
}