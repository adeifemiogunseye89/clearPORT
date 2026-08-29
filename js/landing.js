// ══════════════════════════════════════
// LANDING PAGE — scroll effects only.
// The API-calling tool logic lives in app.html's page modules, not here.
// ══════════════════════════════════════

// ── NAV SCROLL EFFECT
window.addEventListener('scroll', () => {
  const nav = document.getElementById('l-nav');
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 20);
});

// ── SCROLL REVEAL
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
