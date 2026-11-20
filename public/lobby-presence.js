(() => {
  const main = document.getElementById('lobbyContainer'), team = document.getElementById('lobbyView'), root = main || team;
  if (!root) return;
  const card = document.createElement('section');
  card.id = 'lobbyPresence';
  card.style.cssText = 'padding:14px 18px;border:1px solid #334155;border-radius:12px;background:#0b1724;color:#e2e8f0';
  card.innerHTML = '<strong style="color:#7dd3fc">🟢 Jugadores en el lobby</strong><p data-players style="margin:8px 0;overflow-wrap:anywhere">Conectando…</p><span data-matches style="color:#b8c9d8;font-size:.9rem"></span>';
  if (main) document.querySelector('.create-table-card').insertAdjacentElement('beforebegin', card);
  else team.insertAdjacentElement('beforebegin', card);
  let attached, lastSent = 0, lastLobby;
  const visible = element => {
    const view = element.ownerDocument.defaultView;
    for (let node = element; node; node = node.parentElement) if (view.getComputedStyle(node).display === 'none') return false;
    return true;
  };
  function isLobby() {
    if (!visible(root) || (team && window.frameElement && !visible(window.frameElement))) return false;
    if (main) return typeof currentUser !== 'undefined' && currentUser && !currentUser.isGuest && !isGameStarted;
    return typeof myUser !== 'undefined' && !!myUser;
  }
  function report(force = false) {
    attach();
    const inLobby = !!isLobby(); card.hidden = !inLobby;
    if (!attached?.connected) return;
    const now = Date.now();
    if (!force && inLobby === lastLobby && now - lastSent < 10000) return;
    lastSent = now; lastLobby = inLobby;
    attached.emit('lobby_presence', { inLobby });
  }
  function attach() {
    if (typeof socket === 'undefined' || !socket || socket === attached) return;
    attached = socket;
    socket.on('lobby_activity', data => {
      const players = Array.isArray(data?.players) ? data.players.filter(user => typeof user === 'string') : [];
      card.querySelector('[data-players]').textContent = players.length
        ? `Otros jugadores (${players.length}): ${players.map(user => '@' + user).join(' · ')}`
        : 'Por ahora no hay otros jugadores en el lobby.';
      card.querySelector('[data-matches]').textContent = `🃏 Partidas en curso: ${Math.max(0, Number(data?.activeMatches) || 0)}`;
    });
    socket.on('connect', () => report(true));
    socket.on('disconnect', () => {
      card.querySelector('[data-players]').textContent = 'Reconectando…';
      card.querySelector('[data-matches]').textContent = '';
    });
  }
  new MutationObserver(() => report()).observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
  document.addEventListener('visibilitychange', () => report(true));
  window.addEventListener('pageshow', () => report(true));
  setInterval(() => report(), 1000); report(true);
})();
