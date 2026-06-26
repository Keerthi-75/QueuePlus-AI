(function () {
  function showPanel(groupSelector, targetAttr, targetValue) {
    document.querySelectorAll(groupSelector).forEach(panel => {
      panel.hidden = panel.getAttribute(targetAttr) !== targetValue;
    });
  }

  function bindTabSystem(tabSelector, panelSelector, tabAttr, panelAttr, fallback) {
    const tabs = Array.from(document.querySelectorAll(tabSelector));
    const panels = Array.from(document.querySelectorAll(panelSelector));
    if (!tabs.length || !panels.length) return;
    function activate(value) {
      tabs.forEach(tab => {
        const active = tab.getAttribute(tabAttr) === value;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      showPanel(panelSelector, panelAttr, value);
    }
    tabs.forEach(tab => tab.addEventListener('click', () => activate(tab.getAttribute(tabAttr))));
    const first = tabs.find(t => t.classList.contains('active'))?.getAttribute(tabAttr) || fallback || tabs[0].getAttribute(tabAttr);
    activate(first);
  }

  bindTabSystem('[data-hub-tab]', '[data-hub-panel]', 'data-hub-tab', 'data-hub-panel', 'camera');

  const revealItems = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && revealItems.length) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealItems.forEach(item => observer.observe(item));
  } else {
    revealItems.forEach(item => item.classList.add('is-visible'));
  }

  document.querySelectorAll('[data-focus-target]').forEach(item => {
    item.addEventListener('click', () => {
      const target = document.getElementById(item.dataset.focusTarget);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => target.focus?.(), 450);
      }
    });
  });
})();
