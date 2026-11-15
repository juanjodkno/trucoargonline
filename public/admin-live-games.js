(() => {
  const el = id => document.getElementById(id);
  const numbers = new Intl.NumberFormat('es-AR');
  let selected = false, generation = 0, timer = null, flight = null;
  const active = () => selected && !document.hidden;

  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  }

  function render(data) {
    const s = data.summary;
    for (const [id, value] of [['liveMatchCount',s.matches], ['livePlayerCount',s.players], ['liveSoloCount',s.oneVsOne], ['liveTeamCount',s.twoVsTwo]]) el(id).textContent = numbers.format(value);
    const table = node('table', undefined, 'live-table');
    const head = node('thead'), heading = node('tr');
    const labels = ['Modo','Quién juega contra quién','Marcador','Mesa','Estado'];
    labels.forEach(label => heading.appendChild(node('th', label)));
    head.appendChild(heading); table.appendChild(head);
    const body = node('tbody');
    for (const match of data.matches) {
      const row = node('tr');
      function cell(index) { const c = node('td'); c.setAttribute('data-label', labels[index]); row.appendChild(c); return c; }
      cell(0).appendChild(node('span', match.mode));
      const opponents = node('div', undefined, 'live-opponents');
      opponents.appendChild(node('span', match.teams[0].map(u => '@'+u).join(' + ')));
      opponents.appendChild(node('span', 'vs', 'live-versus'));
      opponents.appendChild(node('span', match.teams[1].map(u => '@'+u).join(' + ')));
      cell(1).appendChild(opponents);
      cell(2).appendChild(node('strong', match.score.join(' – ')));
      const details = node('div', numbers.format(match.betPerPlayer)+' fichas por jugador');
      details.appendChild(node('span', match.targetPoints+' puntos · '+(match.withFlor?'Con flor':'Sin flor'), 'live-detail'));
      cell(3).appendChild(details);
      const text = {starting:'Iniciando', playing:'Jugando', between_hands:'Entre manos', reconnecting:'Reconectando'}[match.state] || 'Jugando';
      const status = node('div', text, 'live-status'+(match.state==='reconnecting'?' waiting':''));
      if (match.disconnectedPlayers.length) status.appendChild(node('span', match.disconnectedPlayers.map(u => '@'+u).join(', '), 'live-detail'));
      cell(4).appendChild(status); body.appendChild(row);
    }
    table.appendChild(body);
    el('liveList').replaceChildren(...(data.matches.length ? [table] : []));
    el('liveEmpty').hidden = data.matches.length !== 0;
    el('liveUpdated').textContent = 'Última actualización: '+new Date(data.serverNow).toLocaleTimeString('es-AR', {timeZone:'America/Argentina/Buenos_Aires'});
    el('liveNotice').textContent = '';
  }

  function stop() {
    generation++;
    clearTimeout(timer); timer = null;
    if (flight) flight.abort();
    flight = null;
  }

  async function refresh() {
    if (!active() || flight) return;
    clearTimeout(timer); timer = null;
    const turn = generation, controller = new AbortController();
    flight = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/api/admin/live-games', {headers:getHeaders(), cache:'no-store', signal:controller.signal});
      if (turn !== generation || !active()) return;
      if (res.status === 401) { adminLogout(); return; }
      if (!res.ok) throw Error('Consulta fallida');
      const data = await res.json();
      if (turn !== generation || !active()) return;
      if (!data.success || !Array.isArray(data.matches) || !data.summary) throw Error('Respuesta inválida');
      render(data);
    } catch {
      if (turn === generation && active()) el('liveNotice').textContent = 'Sin actualización por el momento. Reintentando… Los datos visibles corresponden a la última consulta.';
    } finally {
      clearTimeout(timeout);
      if (flight === controller) flight = null;
      if (turn === generation && active()) timer = setTimeout(refresh, 5000);
    }
  }

  window.addEventListener('admin-tab-change', e => {
    selected = e.detail === 'live'; stop();
    if (active()) refresh();
  });
  window.addEventListener('admin-refresh', refresh);
  window.addEventListener('admin-logout', () => {
    selected = false; stop(); el('liveList').replaceChildren();
  });
  document.addEventListener('visibilitychange', () => { stop(); if (active()) refresh(); });
  window.addEventListener('pagehide', stop);
})();
