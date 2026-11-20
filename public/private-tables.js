(() => {
  if (window.TrucoPrivateTables) return;
  let opened = false;
  function normalize(value) {
    const password = String(value || '').trim();
    if (password && (password.length < 6 || password.length > 32 || /[\u0000-\u001f\u007f]/.test(password))) {
      throw Error('La contraseña de la mesa debe tener entre 6 y 32 caracteres.');
    }
    return password;
  }
  function readCreation(id, checkboxId) {
    try {
      if (checkboxId && !document.getElementById(checkboxId)?.checked) return '';
      const password = normalize(document.getElementById(id)?.value);
      if (checkboxId && !password) throw Error('Ingresá una contraseña o destildá Con contraseña.');
      return password;
    } catch (error) { alert(error.message); return null; }
  }
  const checkbox = document.getElementById('useTablePassword');
  const fields = document.getElementById('tablePasswordFields');
  const creationInput = document.getElementById('inputTablePassword');
  if (checkbox && fields && creationInput) {
    // Cada carga comienza con una mesa pública, aunque el navegador restaure el formulario.
    checkbox.checked = false;
    function updateCreationFields() {
      const enabled = checkbox.checked;
      fields.hidden = !enabled; fields.style.display = enabled ? '' : 'none';
      creationInput.disabled = !enabled;
      if (!enabled) creationInput.value = '';
    }
    checkbox.addEventListener('change', updateCreationFields); updateCreationFields();
  }
  function askPassword() {
    if (opened) return Promise.resolve(null);
    opened = true;
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:#000b;z-index:12000;display:flex;align-items:center;justify-content:center;padding:20px';
      overlay.innerHTML = '<form role="dialog" aria-modal="true" aria-labelledby="privateTableTitle" style="width:100%;max-width:370px;background:#16222f;color:#fff;border:1px solid #48cae4;border-radius:16px;padding:22px"><h3 id="privateTableTitle" style="margin:0 0 12px;color:#ffd166">🔒 Mesa con contraseña</h3><label for="privateTablePassword">Ingresá la contraseña que te pasó el creador.</label><input id="privateTablePassword" type="password" autocomplete="off" maxlength="32" required style="box-sizing:border-box;width:100%;margin:12px 0;padding:12px;border:1px solid #64748b;border-radius:9px;background:#0b1320;color:#fff;font-size:16px"><p aria-live="polite" style="color:#ffd166;margin:0 0 12px"></p><div style="display:flex;gap:10px"><button type="button" style="flex:1;padding:12px;border:0;border-radius:9px;background:#475569;color:white">Cancelar</button><button type="submit" style="flex:1;padding:12px;border:0;border-radius:9px;background:#0077b6;color:white;font-weight:bold">Entrar</button></div></form>';
      const form = overlay.querySelector('form'), input = overlay.querySelector('input'), message = overlay.querySelector('p');
      let settled = false;
      function finish(value) {
        if (settled) return;
        settled = true; opened = false; input.value = ''; overlay.remove();
        previousFocus?.focus?.(); resolve(value);
      }
      form.onsubmit = event => {
        event.preventDefault();
        try { const password = normalize(input.value); if (!password) throw Error('Ingresá la contraseña de la mesa.'); finish(password); }
        catch (error) { message.textContent = error.message; input.focus(); }
      };
      overlay.querySelector('button[type="button"]').onclick = () => finish(null);
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); finish(null); }
        if (event.key === 'Tab') {
          const controls = [...form.querySelectorAll('input,button')], first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
      document.body.appendChild(overlay); input.focus();
    });
  }
  window.TrucoPrivateTables = { readCreation, askPassword };
})();
