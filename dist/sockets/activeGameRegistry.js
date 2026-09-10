"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveGamePresence = getActiveGamePresence;
exports.claimActiveGame = claimActiveGame;
exports.releaseActiveGame = releaseActiveGame;
const activeGamesByUser = new Map();
function normalizeUser(userId) {
    return String(userId || '').trim().toLowerCase();
}
function getActiveGamePresence(userId) {
    const key = normalizeUser(userId);
    if (!key)
        return null;
    return activeGamesByUser.get(key) || null;
}
function claimActiveGame(userId, mode, roomId) {
    const key = normalizeUser(userId);
    const cleanRoomId = String(roomId || '').trim();
    if (!key || !cleanRoomId)
        return false;
    const current = activeGamesByUser.get(key);
    if (current && (current.mode !== mode || current.roomId !== cleanRoomId))
        return false;
    activeGamesByUser.set(key, { mode, roomId: cleanRoomId });
    return true;
}
function releaseActiveGame(userId, mode, roomId) {
    const key = normalizeUser(userId);
    if (!key)
        return;
    const current = activeGamesByUser.get(key);
    if (current && current.mode === mode && current.roomId === roomId) {
        activeGamesByUser.delete(key);
    }
}
