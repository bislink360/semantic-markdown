// The token meter panel: switches tabs and sends clicks and choices to the extension (src/meterPanel.ts).
(function () {
  const vscode = acquireVsCodeApi();
  const post = (message) => vscode.postMessage(message);

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      const name = tab.getAttribute('data-tab');
      for (const t of document.querySelectorAll('[data-tab]')) {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      }
      for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.getAttribute('data-pane') !== name;
      post({ type: 'tab', value: name });
      return;
    }
    const el = event.target.closest('[data-msg]');
    if (!el || el.tagName === 'SELECT') return;
    event.preventDefault();
    post({ type: el.getAttribute('data-msg'), file: el.getAttribute('data-file'), slug: el.getAttribute('data-slug') });
  });

  document.addEventListener('change', (event) => {
    const el = event.target.closest('select[data-msg]');
    if (el) post({ type: el.getAttribute('data-msg'), value: el.value, file: el.value });
  });
})();
