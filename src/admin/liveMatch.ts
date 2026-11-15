// Proyección de solo lectura para el backoffice. No contiene cartas ni chats.
export interface AdminLiveMatch {
  id: string;
  mode: '1vs1' | '2vs2';
  teams: [string[], string[]];
  score: [number, number];
  betPerPlayer: number;
  targetPoints: number;
  withFlor: boolean;
  state: 'starting' | 'playing' | 'between_hands' | 'reconnecting';
  disconnectedPlayers: string[];
}
