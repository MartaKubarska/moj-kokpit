// =====================================================================
// app.js — punkt wejścia: inicjuje moduły niezależnie (SPEC.md §2.3)
// Właściciel: agent UI.
// =====================================================================

import { initRates, initChart } from './wykres.js';
import { init as initPrzelicznik } from './przelicznik.js';

/** Wstawia komunikat błędu do sekcji (gdy moduł nie wystartował). */
function showSectionAlert(section, message, kind = 'error') {
  const alert = document.createElement('p');
  alert.className = `alert alert--${kind}`;
  alert.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  alert.textContent = message;
  section.append(alert);
}

/**
 * Uruchamia jeden moduł w try/catch — awaria jednego nie blokuje pozostałych.
 * Obsługuje zarówno init synchroniczny, jak i zwracający Promise.
 */
async function start(sectionId, initFn, name) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  try {
    await initFn(section);
  } catch (err) {
    console.error(`[kokpit] Błąd modułu „${name}”:`, err);
    // Moduł mógł już wyrenderować własny komunikat — dodajemy tylko, gdy sekcja jest pusta
    if (!section.querySelector('.alert')) {
      if (!section.querySelector('h2')) {
        const h2 = document.createElement('h2');
        h2.className = 'section__title';
        h2.id = section.getAttribute('aria-labelledby') || '';
        h2.textContent = name;
        section.prepend(h2);
      }
      showSectionAlert(section, `Nie udało się uruchomić modułu: ${err?.message || 'nieznany błąd'}.`);
    }
  }
}

function setupFooter() {
  const info = document.getElementById('stopka-info');
  if (!info) return;
  const year = new Date().getFullYear();
  info.append(`© ${year} · Kokpit walutowy · dane z `);
  const link = document.createElement('a');
  link.href = 'https://api.nbp.pl/';
  link.textContent = 'api.nbp.pl';
  info.append(link, '.');
}

function main() {
  setupFooter();

  // Wykres wymaga Chart.js z CDN — gdy się nie załadował, informujemy w sekcji
  const chartMissing = typeof Chart === 'undefined';

  start('sekcja-kursy', initRates, 'Kursy średnie NBP');

  if (chartMissing) {
    const section = document.getElementById('sekcja-wykres');
    const h2 = document.createElement('h2');
    h2.className = 'section__title';
    h2.id = 'wykres-h';
    h2.textContent = 'Wykres zmian kursu';
    section.replaceChildren(h2);
    showSectionAlert(section, 'Nie udało się wczytać biblioteki Chart.js (CDN). Sprawdź połączenie z internetem lub blokowanie skryptów i odśwież stronę.');
  } else {
    start('sekcja-wykres', initChart, 'Wykres zmian kursu');
  }

  start('sekcja-przelicznik', initPrzelicznik, 'Przelicznik');
}

// Moduły ES są odroczone, ale na wszelki wypadek czekamy na DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
