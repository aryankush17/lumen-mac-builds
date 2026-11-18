(function () {
  if (window.parent === window) return;
  const allowed = ['forest','midnight','plum','indigo','slate','pine-light','ink-light','plum-light','indigo-light','slate-light'];
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'lumen-theme' || !allowed.includes(event.data.id)) return;
    let origin;
    try { origin = new URL(event.origin); } catch (_) { return; }
    if (origin.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(origin.hostname)) return;
    document.documentElement.dataset.lumenTheme = event.data.id;
  });
  window.parent.postMessage({type:'lumen-theme-ready'}, '*');
})();
