export type ActiveGameMode = '1v1' | '2v2';

export interface ActiveGamePresence {
  mode: ActiveGameMode;
  roomId: string;
}

const activeGamesByUser = new Map<string, ActiveGamePresence>();

function normalizeUser(userId: string): string {
  return String(userId || '').trim().toLowerCase();
}

export function getActiveGamePresence(userId: string): ActiveGamePresence | null {
  const key = normalizeUser(userId);
  if (!key) return null;
  return activeGamesByUser.get(key) || null;
}

export function claimActiveGame(userId: string, mode: ActiveGameMode, roomId: string): boolean {
  const key = normalizeUser(userId);
  const cleanRoomId = String(roomId || '').trim();
  if (!key || !cleanRoomId) return false;

  const current = activeGamesByUser.get(key);
  if (current && (current.mode !== mode || current.roomId !== cleanRoomId)) return false;

  activeGamesByUser.set(key, { mode, roomId: cleanRoomId });
  return true;
}

export function releaseActiveGame(userId: string, mode: ActiveGameMode, roomId: string): void {
  const key = normalizeUser(userId);
  if (!key) return;

  const current = activeGamesByUser.get(key);
  if (current && current.mode === mode && current.roomId === roomId) {
    activeGamesByUser.delete(key);
  }
}
