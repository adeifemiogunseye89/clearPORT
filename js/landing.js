// ══════════════════════════════════════
// LANDING PAGE — scroll effects only.
// The API-calling tool logic lives in app.html's page modules, not here.
// ══════════════════════════════════════

// ── NAV SCROLL EFFECT
window.addEventListener('scroll', () => {
  const nav = document.getElementById('l-nav');
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 20);
});

/*── SCROLL REVEAL
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
 // JS fallback for browsers without animation-timeline support (Safari/Firefox as of 2026)
  if (!CSS.supports('animation-timeline: view()')) {
    const items = document.querySelectorAll('.port-carousel .carousel-item');
    const scroller = document.querySelector('.port-carousel');

    const applyScale = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const centerX = scrollerRect.left + scrollerRect.width / 2;

      items.forEach(item => {
        const rect = item.getBoundingClientRect();
        const itemCenter = rect.left + rect.width / 2;
        const distance = Math.abs(centerX - itemCenter);
        const maxDistance = scrollerRect.width / 2 + rect.width / 2;
        const proximity = 1 - Math.min(distance / maxDistance, 1); // 1 = centered, 0 = at edge

        item.classList.toggle('js-in-view', proximity > 0.6);
        item.classList.toggle('js-out-view', proximity <= 0.6);
      });
    };

    scroller.addEventListener('scroll', applyScale, { passive: true });
    window.addEventListener('resize', applyScale);
    applyScale();
  }*/