// =====================================================================
// przelicznik.js — przelicznik walut po kursie średnim NBP (SPEC.md §2.2)
// Właściciel: agent UI. Dane wyłącznie przez nbp.js (bez fetch).
// =====================================================================

import {
  MIN_DATE,
  DEFAULT_CODES,
  ValidationError,
  NoDataError,
  getAllCurrencies,
  convert,
  todayISO,
} from './nbp.js';

// ---------------------------------------------------------------------
// Formatowanie (pl-PL)
// ---------------------------------------------------------------------

const fmtMoney = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Kwota wejściowa: co najmniej 2 miejsca, ale bez gubienia dokładności wpisanej przez użytkownika
const fmtInput = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
// Kurs: min. 4 miejsca, pełna precyzja z API
const fmtRate = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 4, maximumFractionDigits: 8 });

const WEEKDAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' */
function plDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

/** Nazwa dnia tygodnia dla daty ISO (liczone w UTC, bez przesunięć strefy). */
function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * Parsuje kwotę wpisaną przez użytkownika.
 * Akceptuje przecinek i kropkę jako separator dziesiętny oraz spacje
 * (także twarde) jako separatory tysięcy. Zwraca number lub null.
 */
export function parseAmount(raw) {
  let s = String(raw).trim().replace(/[\s  ']/g, '');
  if (s === '') return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Oba znaki: separatorem dziesiętnym jest ten, który występuje ostatni
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const thousands = dec === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(dec, '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.split('.').join(''); // „1.000.000” — kropki jako separatory tysięcy
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// --- Czas w Warszawie i polskie święta (do opisu, dlaczego brak notowania) ---

const warsawTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Minuty od północy w Europe/Warsaw. */
function warsawMinutes(now = new Date()) {
  const [h, m] = warsawTimeFmt.format(now).split(':').map(Number);
  return h * 60 + m;
}

/** Wielkanoc (algorytm Meeusa/Jonesa/Butchera) jako ms UTC. */
function easterMs(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}

/** Nazwa ustawowego święta w Polsce przypadającego w danym dniu albo null. */
function polishHoliday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const md = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const fixed = {
    '01-01': 'Nowy Rok', '01-06': 'Święto Trzech Króli', '05-01': 'Święto Pracy',
    '05-03': 'Święto Konstytucji 3 Maja', '08-15': 'Wniebowzięcie NMP', '11-01': 'Wszystkich Świętych',
    '11-11': 'Narodowe Święto Niepodległości', '12-25': 'Boże Narodzenie', '12-26': 'drugi dzień Bożego Narodzenia',
  };
  if (md === '01-06' && y < 2011) return null; // święto przywrócone od 2011 r.
  if (fixed[md]) return fixed[md];
  if (md === '12-24' && y >= 2025) return 'Wigilia Bożego Narodzenia';
  const t = Date.UTC(y, m - 1, d);
  const easter = easterMs(y);
  if (t === easter + 86400000) return 'Poniedziałek Wielkanocny';
  if (t === easter + 60 * 86400000) return 'Boże Ciało';
  return null;
}

// Mały pomocnik do budowania DOM
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

// ---------------------------------------------------------------------
// init
// ---------------------------------------------------------------------

export function init(rootElement) {
  rootElement.replaceChildren();
  const today = todayISO();

  // --- Pola formularza ---
  const inKwota = el('input', {
    id: 'przel-kwota', class: 'field__input num', type: 'text', inputmode: 'decimal',
    autocomplete: 'off', spellcheck: 'false', value: '100',
  });
  const selWaluta = el('select', { id: 'przel-waluta', class: 'field__input' },
    el('option', { value: 'EUR', text: 'Wczytywanie walut…' }));
  const inData = el('input', {
    id: 'przel-data', class: 'field__input', type: 'date', min: MIN_DATE, max: today, value: today,
  });

  // Kierunek: przełącznik segmentowy
  const segKierunek = el('div', {
    id: 'przel-kierunek', class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'przel-kierunek-label',
  });
  for (const [value, label] of [['toPLN', 'Waluta → PLN'], ['fromPLN', 'PLN → waluta']]) {
    const id = `przel-kierunek-${value}`;
    segKierunek.append(
      el('input', { id, type: 'radio', name: 'przel-kierunek', value, checked: value === 'toPLN' }),
      el('label', { class: 'segmented__option', for: id, text: label }),
    );
  }

  const cbPoprzedni = el('input', { id: 'przel-poprzedni', type: 'checkbox', 'aria-describedby': 'przel-poprzedni-hint' });

  const btnZamien = el('button', { id: 'przel-zamien', class: 'btn btn--ghost', type: 'button', text: '⇄ Zamień kierunek' });
  const btnSubmit = el('button', { id: 'przel-submit', class: 'btn btn--primary', type: 'submit', text: 'Przelicz' });

  // --- Komunikaty i wynik ---
  const blad = el('div', { id: 'przel-blad', class: 'alert alert--error', role: 'alert', hidden: true });
  const wynikKwota = el('p', { id: 'przel-wynik-kwota', class: 'result__value' });
  const wynikSzczegoly = el('dl', { id: 'przel-wynik-szczegoly', class: 'result__meta', hidden: true });
  const wynikUwaga = el('p', { id: 'przel-wynik-uwaga', class: 'alert alert--info', hidden: true });
  const wynik = el('output', {
    id: 'przel-wynik', class: 'result', 'aria-live': 'polite', for: 'przel-kwota przel-waluta przel-data przel-poprzedni',
  }, wynikKwota, wynikSzczegoly, wynikUwaga);

  const form = el('form', { id: 'przel-form', class: 'card', novalidate: true, 'aria-labelledby': 'przel-h' },
    el('div', { class: 'card__body' },
      el('div', { class: 'field-row' },
        el('div', { class: 'field' },
          el('label', { class: 'field__label', for: 'przel-kwota', text: 'Kwota' }), inKwota),
        el('div', { class: 'field' },
          el('label', { class: 'field__label', for: 'przel-waluta', text: 'Waluta' }), selWaluta),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field__label', for: 'przel-data', text: 'Data kursu' }), inData,
        el('p', { class: 'field__hint', text: `Od ${plDate(MIN_DATE)} do dziś.` })),
      el('div', { class: 'field' },
        el('span', { id: 'przel-kierunek-label', class: 'field__label', text: 'Kierunek' }), segKierunek),
      el('div', { class: 'field' },
        el('label', { class: 'checkbox', for: 'przel-poprzedni' }, cbPoprzedni,
          ' Kurs z dnia roboczego poprzedzającego datę (VAT/PIT)'),
        el('p', {
          id: 'przel-poprzedni-hint', class: 'field__hint',
          text: 'Przy rozliczeniu VAT i PIT przelicza się po kursie średnim NBP z ostatniego dnia roboczego przed dniem transakcji (np. wystawienia faktury).',
        })),
      el('div', { class: 'field-row' }, btnSubmit, btnZamien),
      blad,
      wynik,
    ),
  );

  rootElement.append(
    el('h2', { id: 'przel-h', class: 'section__title', text: 'Przelicznik' }),
    el('p', { class: 'section__desc', text: 'Przeliczenie po kursie średnim NBP z wybranego dnia (tabela A, a dla pozostałych walut tabela B).' }),
    form,
  );

  // Pola, które mogą być oznaczone jako błędne (pole ValidationError.field → input)
  const fieldInputs = { amount: inKwota, code: selWaluta, date: inData };
  let tableOf = new Map(); // kod → 'A' | 'B'
  let requestId = 0;       // chroni przed nadpisaniem wyniku przez starsze, wolniejsze zapytanie
  let debounceTimer = null;

  // --- Obsługa błędów pól ---
  /** Pole daty pozwala wybrać dzisiejszy dzień także po północy (strona otwarta wcześniej). */
  function syncDateLimits() {
    inData.max = todayISO();
  }

  function clearErrors() {
    blad.hidden = true;
    blad.textContent = '';
    for (const input of Object.values(fieldInputs)) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }

  function showError(message, field) {
    blad.textContent = message;
    blad.hidden = false;
    const input = fieldInputs[field];
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'przel-blad');
    }
  }

  function clearResult(text = '') {
    wynikKwota.textContent = text;
    wynikKwota.classList.toggle('muted', Boolean(text));
    wynikSzczegoly.hidden = true;
    wynikSzczegoly.replaceChildren();
    wynikUwaga.hidden = true;
    wynikUwaga.textContent = '';
  }

  function direction() {
    return form.querySelector('input[name="przel-kierunek"]:checked')?.value || 'toPLN';
  }

  // --- Komunikat o cofnięciu kursu ---
  function fallbackNote(rate) {
    const parts = [];
    if (rate.mode === 'previousBusinessDay') {
      parts.push(`Kurs z ostatniego dnia roboczego przed ${plDate(rate.requestedDate)}: ${plDate(rate.effectiveDate)}, tabela ${rate.no}.`);
    } else if (rate.mode === 'fallback') {
      const wd = weekday(rate.requestedDate);
      const weekend = wd === 'sobota' || wd === 'niedziela';
      const holiday = polishHoliday(rate.requestedDate);
      const used = `Użyto kursu z ${plDate(rate.effectiveDate)}, tabela ${rate.no}.`;
      if (rate.table === 'A' && rate.requestedDate === todayISO() && !weekend && !holiday) {
        // Dzień roboczy, dziś: przed ok. 12:15 tabela zwykle jeszcze nie wyszła
        parts.push(warsawMinutes() < 12 * 60 + 15
          ? `Dzisiejsza tabela nie została jeszcze opublikowana (zwykle ok. 12:00). ${used}`
          : `Dzisiejsza tabela nie jest jeszcze dostępna w API NBP. ${used}`);
      } else {
        const why = holiday ? `${wd}, ${holiday} — dzień bez notowania`
          : weekend ? wd : `${wd} — dzień bez notowania`;
        parts.push(`Brak notowania z dnia ${plDate(rate.requestedDate)} (${why}). ${used}`);
      }
    }
    if (rate.table === 'B') {
      parts.push('Tabela B publikowana jest raz w tygodniu (zwykle w środę), więc kurs może pochodzić sprzed kilku dni.');
    }
    return parts.join(' ');
  }

  // --- Render wyniku ---
  function renderResult(res) {
    const { rate } = res;
    const from = res.direction === 'toPLN' ? rate.code : 'PLN';
    const to = res.resultCurrency;

    wynikKwota.classList.remove('muted');
    wynikKwota.replaceChildren(
      `${fmtInput.format(res.amount)} ${from} = `,
      el('strong', { text: `${fmtMoney.format(res.resultRounded)} ${to}` }),
    );

    const rows = [
      ['Kurs średni', `1 ${rate.code} = ${fmtRate.format(rate.mid)} PLN`],
      ['Tabela', `${rate.no} (tabela ${rate.table})`],
      ['Data notowania', plDate(rate.effectiveDate)],
      ['Data żądana', plDate(rate.requestedDate)],
    ];
    wynikSzczegoly.replaceChildren(...rows.flatMap(([dt, dd]) => [el('dt', { text: dt }), el('dd', { text: dd })]));
    wynikSzczegoly.hidden = false;

    const note = rate.fallback || rate.table === 'B' ? fallbackNote(rate) : '';
    wynikUwaga.textContent = note;
    wynikUwaga.hidden = !note;
  }

  // --- Główna akcja: przeliczenie ---
  async function calculate() {
    clearTimeout(debounceTimer);
    const myId = ++requestId;
    syncDateLimits();
    clearErrors();
    // Wcześniejsze (porzucone) zapytanie mogło zostawić stan ładowania
    form.classList.remove('is-loading');
    wynik.removeAttribute('aria-busy');
    btnSubmit.disabled = false;

    // Walidacja po stronie formularza (reszta w nbp.js → ValidationError)
    const amount = parseAmount(inKwota.value);
    if (amount === null) {
      clearResult();
      showError('Podaj poprawną kwotę, np. 1 250,50 lub 1250.50.', 'amount');
      return;
    }
    const date = inData.value;
    if (!date) {
      clearResult();
      showError(`Podaj datę z zakresu ${plDate(MIN_DATE)} – ${plDate(todayISO())}.`, 'date');
      return;
    }

    // Stan ładowania: pasek na karcie + aria-busy; poprzedni wynik zostaje,
    // żeby treść nie przeskakiwała i czytnik nie ogłaszał „Wczytywanie…” co chwilę
    form.classList.add('is-loading');
    wynik.setAttribute('aria-busy', 'true');
    btnSubmit.disabled = true;
    if (wynikSzczegoly.hidden) clearResult('Wczytywanie…');
    try {
      const res = await convert({
        amount,
        code: selWaluta.value,
        date,
        direction: direction(),
        previousBusinessDay: cbPoprzedni.checked,
      });
      if (myId !== requestId) return; // nowsze zapytanie w toku
      renderResult(res);
    } catch (err) {
      if (myId !== requestId) return;
      clearResult();
      if (err instanceof ValidationError) {
        showError(err.message, err.field);
      } else if (err instanceof NoDataError) {
        // Brak danych to nie awaria — komunikat informacyjny
        wynikUwaga.textContent = err.message;
        wynikUwaga.hidden = false;
      } else {
        showError(err?.message || 'Nie udało się pobrać kursu z NBP. Spróbuj ponownie.');
      }
    } finally {
      if (myId === requestId) {
        form.classList.remove('is-loading');
        wynik.removeAttribute('aria-busy');
        btnSubmit.disabled = false;
      }
    }
  }

  // Przeliczanie automatyczne po zmianie pól (debounce 300 ms)
  function scheduleCalculate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(calculate, 300);
  }

  // --- Zdarzenia ---
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    calculate();
  });
  form.addEventListener('input', scheduleCalculate);
  form.addEventListener('change', scheduleCalculate);
  btnZamien.addEventListener('click', () => {
    const next = direction() === 'toPLN' ? 'fromPLN' : 'toPLN';
    form.querySelector(`#przel-kierunek-${next}`).checked = true;
    calculate();
  });

  // --- Lista walut (A i B w optgroupach), potem pierwsze przeliczenie ---
  function fillCurrencies(list) {
    tableOf = new Map(list.map((c) => [c.code, c.table]));
    const groups = { A: el('optgroup', { label: 'Tabela A' }), B: el('optgroup', { label: 'Tabela B' }) };
    for (const c of list) {
      groups[c.table]?.append(el('option', { value: c.code, text: `${c.code} — ${c.currency}` }));
    }
    const prev = selWaluta.value;
    selWaluta.replaceChildren(...[groups.A, groups.B].filter((g) => g.children.length));
    selWaluta.value = tableOf.has(prev) ? prev : 'EUR';
  }

  return getAllCurrencies()
    .then((list) => fillCurrencies(list))
    .catch((err) => {
      // Awaryjnie: główne waluty, żeby przelicznik dalej działał
      fillCurrencies(DEFAULT_CODES.map((code) => ({ code, currency: code, table: 'A' })));
      showError(`Nie udało się wczytać pełnej listy walut: ${err?.message || 'błąd sieci'}. Dostępne są tylko główne waluty.`);
    })
    .then(() => {
      // Nie kasuj komunikatu o liście walut, jeśli był
      const listError = blad.hidden ? '' : blad.textContent;
      return calculate().then(() => {
        if (listError && blad.hidden) { blad.textContent = listError; blad.hidden = false; }
      });
    });
}
