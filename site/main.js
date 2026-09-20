/* Hairline — landing page behaviour.
   No framework, no dependencies. Everything degrades to a readable page
   if this file never loads. */

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Nav gets a border once the page has scrolled. */
const nav = document.getElementById('nav');
const onScroll = () => nav.dataset.stuck = String(window.scrollY > 8);
onScroll();
addEventListener('scroll', onScroll, { passive: true });

/* Sections rise in once, then the observer lets them go. */
const reveals = document.querySelectorAll('.reveal');
if (reduced) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  );
  reveals.forEach((el) => io.observe(el));
}

/* The hero command types itself, once, when it is on screen. */
const typed = document.getElementById('typed');
const caret = document.getElementById('caret');
if (typed && caret) {
  const command = typed.textContent;
  if (reduced) {
    caret.remove();
  } else {
    typed.textContent = '';
    const type = () => {
      let i = 0;
      const step = () => {
        typed.textContent = command.slice(0, ++i);
        if (i < command.length) setTimeout(step, 18);
        else setTimeout(() => caret.remove(), 900);
      };
      step();
    };
    const heroIo = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      heroIo.disconnect();
      setTimeout(type, 420);
    });
    heroIo.observe(typed);
  }
}

/* Quickstart tabs. */
const tabs = [...document.querySelectorAll('.tab')];
const select = (tab) => {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
  }
  tab.focus();
};
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    select(tabs[(index + step + tabs.length) % tabs.length]);
  });
});

/* Copy buttons, with the failure path visible rather than silent. */
for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.dataset.done = 'true';
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Press ⌘C';
    }
    setTimeout(() => {
      delete button.dataset.done;
      button.textContent = label;
    }, 1600);
  });
}
