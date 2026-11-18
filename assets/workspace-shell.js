/* Native Workspace only. The surrounding Lumen shell keeps its original UI. */
(function () {
  'use strict';
  var workspacePromise;
  if (!window.LumenTheme) document.documentElement.dataset.appearance = localStorage.getItem('lumen-pages-theme') || 'dark';
  function workspace() {
    // Compact navigation keeps readable names for assistive technology and hover.
    document.querySelectorAll('.navi').forEach(function (button) {
      var label = button.querySelector('.lbl');
      if (!label) return;
      button.setAttribute('aria-label', label.textContent.trim());
      if (!button.title) button.title = label.textContent.trim();
    });
    if (workspacePromise) return workspacePromise;
    workspacePromise = fetch('/pages-app/').then(function (response) {
      if (!response.ok) throw new Error('Workspace could not be loaded. Please try again.');
      return response.text();
    }).then(async function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      await Promise.all(Array.from(doc.querySelectorAll('link[rel=stylesheet]')).map(function (source) {
        var href = source.getAttribute('href');
        if (!href || !href.startsWith('/pages-app/assets/')) return;
        if (document.querySelector('link[data-workspace-style="' + href + '"]')) return;
        return new Promise(function (resolve, reject) {
          var link = document.createElement('link');
          link.rel = 'stylesheet'; link.href = href; link.dataset.workspaceStyle = href;
          link.onload = resolve;
          link.onerror = function () { link.remove(); reject(new Error('Workspace styles could not be loaded.')); };
          document.head.appendChild(link);
        });
      }));
      var source = doc.querySelector('script[type=module][src]');
      var src = source && source.getAttribute('src');
      if (!src || !src.startsWith('/pages-app/assets/')) throw new Error('Workspace build is unavailable.');
      await import(src);
    }).catch(function (error) {
      workspacePromise = null;
      var host = document.getElementById('lumen-workspace');
      if (!host) return;
      host.replaceChildren();
      var box = document.createElement('div'); box.className = 'workspace-loading';
      var label = document.createElement('b'); label.textContent = error.message;
      var button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Retry'; button.onclick = workspace;
      box.append(label, button); host.append(box);
    });
    return workspacePromise;
  }

  window.addEventListener('lumen-toggle-appearance', function () {
    if (window.LumenTheme) return;
    var next = document.documentElement.dataset.appearance === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.appearance = next;
    localStorage.setItem('lumen-pages-theme', next);
    window.dispatchEvent(new CustomEvent('lumen-appearance'));
  });
  window.LumenWorkspace = {open: workspace};
})();
