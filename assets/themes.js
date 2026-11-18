/* Theme preference is local to this browser, independent of account credentials. */
(function () {
  'use strict';
  const palettes = window.LumenPalettes;
  const key = 'lumen-theme';
  const root = document.documentElement;
  const read = name => { try { return localStorage.getItem(name); } catch (_) { return null; } };
  let current = Object.hasOwn(palettes, read(key)) ? read(key) : 'forest';
  let saved = true;
  function apply(id, persist) {
    if (!Object.hasOwn(palettes, id)) return;
    current = id;
    root.dataset.lumenTheme = id;
    root.dataset.appearance = palettes[id].mode;
    saved = true;
    try {
      localStorage.setItem('lumen-pages-theme', palettes[id].mode);
      if (persist) {
        localStorage.setItem(key, id);
        localStorage.setItem('lumen-theme-' + palettes[id].mode, id);
      }
    } catch (_) { saved = false; }
    window.dispatchEvent(new CustomEvent('lumen-appearance'));
    window.dispatchEvent(new CustomEvent('lumen-theme-change', {detail: {id, ...palettes[id]}}));
    renderSelection();
    updateStudio();
  }
  function updateStudio() {
    for (const id of ['wb-frame','ab-frame','admin-frame']) {
      const frame = document.getElementById(id);
      if (!frame || !frame.src) continue;
      const target = new URL(frame.src, location.href);
      if (!['127.0.0.1','localhost','lumen-brain.vercel.app'].includes(target.hostname)) continue;
      frame.contentWindow?.postMessage({type:'lumen-theme', id:current}, target.origin);
    }
  }
  window.addEventListener('message', event => {
    for (const id of ['wb-frame','ab-frame','admin-frame']) {
      const frame = document.getElementById(id);
      if (frame?.src && event.source === frame.contentWindow && event.origin === new URL(frame.src).origin && event.data?.type === 'lumen-theme-ready') updateStudio();
    }
  });
  // Only the known local editor frame may expand over Lumen's navigation.
  window.addEventListener('message', event => {
    const frame = document.getElementById('wb-frame');
    if (!frame?.src || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
    if (event.data?.type === 'lumen-builder-editing' && typeof event.data.active === 'boolean') {
      root.classList.toggle('lumen-builder-focus', event.data.active);
    }
  });
  function renderSelection() {
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === current;
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('.theme-check').textContent = selected ? 'Selected' : 'Choose';
    });
    const status = document.getElementById('theme-status');
    if (status) status.textContent = palettes[current].name + (saved ? ' · Saved automatically on this browser.' : ' · Applied, but this browser could not save your preference.');
  }
  window.LumenTheme = {select: id => apply(id, true), get current() {return current;}};
  apply(current, false);
  window.addEventListener('storage', event => {
    if (event.key === key && Object.hasOwn(palettes, event.newValue)) apply(event.newValue, false);
  });
  document.addEventListener('DOMContentLoaded', () => {
    const settings = document.getElementById('settings-theme');
    if (!settings) return;
    if (window.TITLES?.settings) window.TITLES.settings[1] = 'Choose your appearance and manage your API keys.';
    const section = document.createElement('section');
    section.className = 'theme-settings';
    section.setAttribute('aria-labelledby', 'theme-heading');
    section.innerHTML = '<div class="theme-heading"><div><span class="ui-eyebrow">APPEARANCE</span><h2 id="theme-heading">Make Lumen yours.</h2><p>Choose a colour combination. Your theme changes immediately across Lumen.</p></div><span class="theme-auto">Auto-saved</span></div><p id="theme-status" role="status" aria-live="polite"></p>';
    for (const [mode, ids] of [['light', ['pine-light','ink-light','plum-light','indigo-light','slate-light']], ['dark', ['forest','midnight','plum','indigo','slate']]]) {
      const group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = mode === 'light' ? 'Light themes' : 'Dark themes';
      group.append(legend);
      const grid = document.createElement('div'); grid.className = 'theme-grid';
      ids.forEach(id => {
        const p = palettes[id], button = document.createElement('button');
        button.type = 'button'; button.className = 'theme-choice'; button.dataset.themeChoice = id;
        button.setAttribute('aria-label', p.name);
        for (const token of ['base','nav','brand','accent','text','muted']) button.style.setProperty('--sample-' + token, p[token]);
        button.innerHTML = '<span class="theme-sample" aria-hidden="true"><span class="theme-sample-nav"><i></i><i></i><i></i></span><span class="theme-sample-main"><b></b><i></i><span><i></i><i></i></span></span></span><span class="theme-choice-label"></span><span class="theme-check"></span>';
        button.querySelector('.theme-choice-label').textContent = p.name;
        button.onclick = () => apply(id, true);
        grid.append(button);
      });
      group.append(grid); section.append(group);
    }
    settings.prepend(section); renderSelection();
  });
})();

// Website generation is handled by the authenticated Lumen host. API keys never
// cross into the editor or become part of an exported website.
window.addEventListener('message', async event => {
  const frame = document.getElementById('wb-frame');
  if (!frame?.src || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin || event.data?.type !== 'lumen-website-generate') return;
  const {requestId, prompt} = event.data;
  if (typeof requestId !== 'string' || requestId.length > 80 || typeof prompt !== 'string' || prompt.length > 6000) return;
  let result;
  try {
    const response = await fetch('/website-builder/generate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt})});
    result = await response.json();
    if (!response.ok && !result.error) result = {error:'Website generation is unavailable. Please try again.'};
  } catch { result = {error:'Could not reach Lumen. Please reconnect and try again.'}; }
  event.source.postMessage({type:'lumen-website-result',requestId,...result}, event.origin);
});
