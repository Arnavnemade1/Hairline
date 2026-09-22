/* Hairline — landing page behaviour.
   No framework, no dependencies. The page is complete without this file:
   every scenario and every code sample is in the HTML, and the `js` class on
   <html> is what collapses them into tabs. */

/* Nav rule appears once the page has scrolled. */
const nav = document.getElementById('nav');
const updateNav = () => {
  nav.dataset.stuck = String(window.scrollY > 4);
};
updateNav();
addEventListener('scroll', updateNav, { passive: true });

/* Mobile menu. */
const toggle = document.querySelector('.nav__toggle');
const menu = document.getElementById('mobile-menu');

const setMenu = (open) => {
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  menu.hidden = !open;
};

toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
menu.addEventListener('click', (event) => {
  if (event.target.closest('a')) setMenu(false);
});
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !menu.hidden) {
    setMenu(false);
    toggle.focus();
  }
});
matchMedia('(min-width: 1041px)').addEventListener('change', (query) => {
  if (query.matches) setMenu(false);
});

/* Tabs: roving tabindex, arrow keys in either orientation, Home and End. */
for (const group of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];

  const select = (tab, { focus = false } = {}) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls'))?.classList.toggle('is-active', selected);
    }
    if (focus) tab.focus();
    // On narrow screens the scenario list scrolls sideways; keep the chosen one
    // in view there, and only there, so desktop clicks never nudge the page.
    const list = tab.parentElement;
    if (list && list.scrollWidth > list.clientWidth) {
      list.scrollTo({ left: tab.offsetLeft - list.offsetLeft - 16, behavior: 'smooth' });
    }
  };

  group.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tabs.includes(tab)) select(tab);
  });

  group.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const next = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], { focus: true });
  });
}

/* Copy buttons. */
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is unavailable on plain http and in some embedded views.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
};

for (const button of document.querySelectorAll('.copy')) {
  const label = button.querySelector('span');
  let timer;
  button.addEventListener('click', async () => {
    const ok = await copyText(button.dataset.copy ?? '');
    label.textContent = ok ? 'Copied' : 'Copy failed';
    button.dataset.state = ok ? 'copied' : '';
    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = 'Copy';
      button.dataset.state = '';
    }, 1800);
  });
}

/* Footer year. */
for (const node of document.querySelectorAll('[data-year]')) {
  node.textContent = String(new Date().getFullYear());
}
