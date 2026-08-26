// src/game/trucoEngine.ts

export type Suit = 'ESPADA' | 'BASTO' | 'ORO' | 'COPA';

export interface Card {
  id: string;
  number: number;
  suit: Suit;
  hierarchy: number;
  envidoValue: number;
}

export const CARDS_DATA: Omit<Card, 'id'>[] = [
  // 1 de Espada (Macho)
  { number: 1, suit: 'ESPADA', hierarchy: 1, envidoValue: 1 },
  // 1 de Basto (Hembra)
  { number: 1, suit: 'BASTO', hierarchy: 2, envidoValue: 1 },
  // 7 de Espada
  { number: 7, suit: 'ESPADA', hierarchy: 3, envidoValue: 7 },
  // 7 de Oro
  { number: 7, suit: 'ORO', hierarchy: 4, envidoValue: 7 },
  // 3s
  { number: 3, suit: 'ESPADA', hierarchy: 5, envidoValue: 3 },
  { number: 3, suit: 'BASTO', hierarchy: 5, envidoValue: 3 },
  { number: 3, suit: 'ORO', hierarchy: 5, envidoValue: 3 },
  { number: 3, suit: 'COPA', hierarchy: 5, envidoValue: 3 },
  // 2s
  { number: 2, suit: 'ESPADA', hierarchy: 6, envidoValue: 2 },
  { number: 2, suit: 'BASTO', hierarchy: 6, envidoValue: 2 },
  { number: 2, suit: 'ORO', hierarchy: 6, envidoValue: 2 },
  { number: 2, suit: 'COPA', hierarchy: 6, envidoValue: 2 },
  // 1s falsos
  { number: 1, suit: 'ORO', hierarchy: 7, envidoValue: 1 },
  { number: 1, suit: 'COPA', hierarchy: 7, envidoValue: 1 },
  // 12s
  { number: 12, suit: 'ESPADA', hierarchy: 8, envidoValue: 0 },
  { number: 12, suit: 'BASTO', hierarchy: 8, envidoValue: 0 },
  { number: 12, suit: 'ORO', hierarchy: 8, envidoValue: 0 },
  { number: 12, suit: 'COPA', hierarchy: 8, envidoValue: 0 },
  // 11s
  { number: 11, suit: 'ESPADA', hierarchy: 9, envidoValue: 0 },
  { number: 11, suit: 'BASTO', hierarchy: 9, envidoValue: 0 },
  { number: 11, suit: 'ORO', hierarchy: 9, envidoValue: 0 },
  { number: 11, suit: 'COPA', hierarchy: 9, envidoValue: 0 },
  // 10s
  { number: 10, suit: 'ESPADA', hierarchy: 10, envidoValue: 0 },
  { number: 10, suit: 'BASTO', hierarchy: 10, envidoValue: 0 },
  { number: 10, suit: 'ORO', hierarchy: 10, envidoValue: 0 },
  { number: 10, suit: 'COPA', hierarchy: 10, envidoValue: 0 },
  // 7s falsos
  { number: 7, suit: 'COPA', hierarchy: 11, envidoValue: 7 },
  { number: 7, suit: 'BASTO', hierarchy: 11, envidoValue: 7 },
  // 6s
  { number: 6, suit: 'ESPADA', hierarchy: 12, envidoValue: 6 },
  { number: 6, suit: 'BASTO', hierarchy: 12, envidoValue: 6 },
  { number: 6, suit: 'ORO', hierarchy: 12, envidoValue: 6 },
  { number: 6, suit: 'COPA', hierarchy: 12, envidoValue: 6 },
  // 5s
  { number: 5, suit: 'ESPADA', hierarchy: 13, envidoValue: 5 },
  { number: 5, suit: 'BASTO', hierarchy: 13, envidoValue: 5 },
  { number: 5, suit: 'ORO', hierarchy: 13, envidoValue: 5 },
  { number: 5, suit: 'COPA', hierarchy: 13, envidoValue: 5 },
  // 4s
  { number: 4, suit: 'ESPADA', hierarchy: 14, envidoValue: 4 },
  { number: 4, suit: 'BASTO', hierarchy: 14, envidoValue: 4 },
  { number: 4, suit: 'ORO', hierarchy: 14, envidoValue: 4 },
  { number: 4, suit: 'COPA', hierarchy: 14, envidoValue: 4 },
];

export function createDeck(): Card[] {
  return CARDS_DATA.map(c => ({
    ...c,
    id: `${c.number}_${c.suit.toLowerCase()}`
  }));
}

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function getShuffledDeck(): Card[] {
  return shuffleDeck(createDeck());
}

export function compareCards(c1: Card, c2: Card): number {
  if (c1.hierarchy < c2.hierarchy) return 1;
  if (c1.hierarchy > c2.hierarchy) return -1;
  return 0;
}

export function hasFlor(cards: Card[]): boolean {
  if (!cards || cards.length < 3) return false;
  const s0 = cards[0].suit;
  return cards.every(c => c.suit === s0);
}

export function calculateFlor(cards: Card[]): number {
  if (!hasFlor(cards)) return 0;
  return 20 + cards.reduce((acc, c) => acc + c.envidoValue, 0);
}

export function getEnvidoDetails(cards: Card[]): { score: number; envidoCards: Card[] } {
  if (!cards || cards.length === 0) return { score: 0, envidoCards: [] };

  const suitsMap: { [key: string]: Card[] } = {};
  cards.forEach(c => {
    suitsMap[c.suit] = suitsMap[c.suit] || [];
    suitsMap[c.suit].push(c);
  });

  let maxScore = -1;
  let bestPair: Card[] = [];

  for (const suit in suitsMap) {
    const list = suitsMap[suit];
    if (list.length >= 2) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const score = 20 + list[i].envidoValue + list[j].envidoValue;
          if (score > maxScore) {
            maxScore = score;
            bestPair = [list[i], list[j]];
          }
        }
      }
    }
  }

  if (maxScore === -1) {
    let highestCard = cards[0];
    cards.forEach(c => {
      if (c.envidoValue > highestCard.envidoValue) highestCard = c;
    });
    return { score: highestCard.envidoValue, envidoCards: [highestCard] };
  }

  return { score: maxScore, envidoCards: bestPair };
}

export function calculateEnvido(cards: Card[]): number {
  return getEnvidoDetails(cards).score;
}