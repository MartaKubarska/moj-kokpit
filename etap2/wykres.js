// wykres.js — panel kursów + wykres zmian kursu (właściciel: agent WYKRES).
// Dane wyłącznie przez nbp.js; Chart.js jako globalny window.Chart (ładowany w index.html).
// Moduł nie wstrzykuje własnego CSS — korzysta tylko z klas wspólnych ze style.css.

import {
  MIN_DATE,
  DEFAULT_CODES,
  NoDataError,
  getCurrencies,
  getLatestTables,
  getSeries,
  periodToRange,
  todayISO,
} from './nbp.js';

const STORAGE_KEY = 'kokpit.kursy';
const MAX_POINTS = 1300;      // limit punktów na serię (5L / własny zakres)
const SERIES_COUNT = 6;       // tokeny --series-1..6 = maks. liczba walut na wykresie

// ---------- Formatowanie (pl-PL) ----------

// Kurs: min. 4 miejsca, pełna precyzja z API (IDR 0,00021922, KRW 0,002997…)
const fmtRate = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
const fmtPct = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPctFine = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtInt = new Intl.NumberFormat('pl-PL');
const fixedFmtCache = new Map();

/** Formatter z dokładnie `d` miejscami po przecinku (cache). */
function fmtFixed(d) {
  if (!fixedFmtCache.has(d)) {
    fixedFmtCache.set(d, new Intl.NumberFormat('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  return fixedFmtCache.get(d);
}

/** Liczba miejsc po przecinku potrzebna, by krok osi `step` był dokładnie widoczny (min. `min`). */
function decimalsForStep(step, min = 0) {
  if (!(step > 0) || !Number.isFinite(step)) return Math.max(min, 4);
  for (let d = 0; d <= 10; d++) {
    const scaled = step * 10 ** d;
    const r = Math.round(scaled);
    if (r >= 1 && Math.abs(scaled - r) < 1e-6 * scaled) return Math.max(min, d);
  }
  return 10;
}

/** Zmiana bezwzględna kursu ze znakiem (minus typograficzny). */
function fmtSignedRate(value) {
  const abs = fmtRate.format(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

/** 'YYYY-MM-DD' -> 'DD.MM.YYYY' */
function fmtDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Procent ze znakiem; minus typograficzny (U+2212). */
function fmtSignedPct(value) {
  // Bardzo mała zmiana nie może wyglądać jak „+0,00%” — wtedy więcej miejsc
  const f = value !== 0 && Math.abs(value) < 0.005 ? fmtPctFine : fmtPct;
  const abs = f.format(Math.abs(value));
  if (value > 0) return `+${abs}%`;
  if (value < 0) return `−${abs}%`;
  return `${abs}%`;
}

/** Bezpieczne tworzenie elementu: el('p', { id, class, text, attrs }, ...dzieci) */
function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.id) node.id = opts.id;
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === false || v == null) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/** Komunikat błędu / braku danych w kontenerze alertów.
 *  Zwraca true, gdy komunikat jest ogłaszany przez role="alert"
 *  (wtedy nie należy go powtarzać w regionie aria-live statusu). */
function showAlert(container, err) {
  container.replaceChildren();
  if (!err) return false;
  const isInfo = err instanceof NoDataError;
  const msg = err && err.message ? err.message : 'Wystąpił nieoczekiwany błąd.';
  container.append(el('div', {
    class: `alert ${isInfo ? 'alert--info' : 'alert--error'}`,
    attrs: { role: isInfo ? null : 'alert' },
    text: msg,
  }));
  return !isInfo;
}

// ---------- localStorage (zawsze w try/catch) ----------

function loadCodes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((c) => typeof c === 'string')) {
        return [...new Set(arr.map((c) => c.toUpperCase()))];
      }
    }
  } catch { /* brak dostępu do storage — używamy domyślnych */ }
  return [...DEFAULT_CODES];
}

function saveCodes(codes) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(codes)); } catch { /* ignorujemy */ }
}

// ======================================================================
// PANEL KURSÓW
// ======================================================================

export function initRates(rootElement) {
  rootElement.replaceChildren();

  const meta = el('p', { id: 'kursy-meta', class: 'muted', text: 'Wczytywanie…' });
  const list = el('ul', { id: 'kursy-lista', class: 'rate-grid' });
  const alerts = el('div', { id: 'kursy-alert' });
  const status = el('p', { id: 'kursy-status', class: 'muted', attrs: { 'aria-live': 'polite' } });

  const select = el('select', { id: 'kursy-dodaj-select', class: 'field__input' });
  const addBtn = el('button', { class: 'btn', text: 'Dodaj', attrs: { type: 'submit' } });
  const form = el('form', { id: 'kursy-dodaj-form', class: 'field-row' },
    el('div', { class: 'field' },
      el('label', { class: 'field__label', text: 'Dodaj walutę (tabela A)', attrs: { for: 'kursy-dodaj-select' } }),
      select,
    ),
    addBtn,
  );

  const card = el('div', { class: 'card is-loading' },
    el('div', { class: 'card__header' }, meta),
    el('div', { class: 'card__body' }, alerts, list, form, status),
  );

  rootElement.append(
    el('h2', { id: 'kursy-h', class: 'section__title', text: 'Kursy średnie NBP' }),
    el('p', { class: 'section__desc', text: 'Ostatnie notowanie tabeli A i zmiana względem poprzedniej tabeli.' }),
    card,
  );

  let codes = loadCodes();
  let latest = null; // LatestTables

  // Powiadomienie innych modułów o zmianie listy walut
  function emitChange() {
    document.dispatchEvent(new CustomEvent('kokpit:currencies-changed', { detail: { codes: [...codes] } }));
  }

  function renderCard(row) {
    const li = el('li', { class: 'card rate-card', attrs: { 'data-code': row.code } });

    // Zmiana: strzałka (aria-hidden) + opis dla czytników + procent
    let changeCls = 'change--flat';
    let arrow = '■';
    let srText = 'bez zmian';
    let pctText = '—';
    if (row.direction === 'up') { changeCls = 'change--up'; arrow = '▲'; srText = 'wzrost'; }
    else if (row.direction === 'down') { changeCls = 'change--down'; arrow = '▼'; srText = 'spadek'; }
    else if (row.direction === null) { srText = 'brak poprzedniego notowania'; arrow = ''; }
    if (row.diffPct != null) {
      pctText = row.direction === 'flat'
        ? `${fmtRate.format(0)} (${fmtPct.format(0)}%)`
        : `${fmtSignedRate(row.diff)} (${fmtSignedPct(row.diffPct)})`;
    }

    const change = el('p', { class: `rate-card__change num ${changeCls}` });
    if (arrow) change.append(el('span', { text: arrow, attrs: { 'aria-hidden': 'true' } }), ' ');
    change.append(el('span', { class: 'visually-hidden', text: `${srText} ` }), pctText);

    const prevText = row.prevMid != null ? `poprzednio ${fmtRate.format(row.prevMid)}` : 'poprzednio —';

    const midText = fmtRate.format(row.mid);
    li.append(
      el('p', { class: 'rate-card__code', text: row.code }),
      el('p', { class: 'rate-card__name muted', text: row.currency }),
      el('p', { class: `rate-card__mid num${midText.length > 8 ? ' rate-card__mid--long' : ''}`, text: midText }),
      el('p', { class: 'rate-card__unit muted', text: `PLN za 1 ${row.code}` }),
      el('p', { class: 'rate-card__prev num muted', text: prevText }),
      change,
      el('button', {
        class: 'rate-card__remove btn btn--ghost btn--sm',
        text: 'Usuń',
        attrs: { type: 'button', 'aria-label': `Usuń ${row.code}`, 'data-code': row.code },
      }),
    );
    return li;
  }

  function render() {
    if (!latest) return;
    const { current, previous, rates } = latest;
    meta.className = '';
    meta.textContent = `Tabela nr ${current.no} z dnia ${fmtDate(current.effectiveDate)} ` +
      `(poprzednia: ${previous.no}, ${fmtDate(previous.effectiveDate)})`;

    const byCode = new Map(rates.map((r) => [r.code, r]));
    // Usuwamy z listy kody, których nie ma w tabeli A (np. stary wpis w storage)
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length) {
      codes = codes.filter((c) => byCode.has(c));
      saveCodes(codes);
    }

    list.replaceChildren(...codes.map((c) => renderCard(byCode.get(c))));
    if (!codes.length) {
      list.append(el('li', { class: 'alert alert--info', text: 'Brak wybranych walut. Dodaj walutę z listy poniżej.' }));
    }

    // Select: waluty tabeli A spoza listy, alfabetycznie
    const available = rates.filter((r) => !codes.includes(r.code)).sort((a, b) => a.code.localeCompare(b.code));
    select.replaceChildren(...available.map((r) => el('option', { text: `${r.code} — ${r.currency}`, attrs: { value: r.code } })));
    select.disabled = addBtn.disabled = available.length === 0;
  }

  // Usuwanie (delegacja zdarzeń)
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.rate-card__remove');
    if (!btn) return;
    const code = btn.dataset.code;
    codes = codes.filter((c) => c !== code);
    saveCodes(codes);
    render();
    status.textContent = `Usunięto ${code} z panelu.`;
    select.focus();
    emitChange();
  });

  // Dodawanie
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = select.value;
    if (!code || codes.includes(code)) return;
    codes.push(code);
    saveCodes(codes);
    render();
    status.textContent = `Dodano ${code} do panelu.`;
    emitChange();
  });

  // Odświeżanie: nowa tabela pojawia się ok. 12:00 — sprawdzamy przy powrocie
  // do karty i co 10 minut (cache tabel w nbp.js ma TTL 10 min).
  function refresh() {
    if (document.visibilityState === 'hidden') return;
    getLatestTables()
      .then((data) => {
        if (latest && data.current.no === latest.current.no) return;
        const wasEmpty = !latest;
        latest = data;
        showAlert(alerts, null);
        form.hidden = false;
        render();
        if (!wasEmpty) status.textContent = `Opublikowano nową tabelę: ${data.current.no}.`;
      })
      .catch(() => { /* zostawiamy ostatnie dane */ });
  }
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 10 * 60 * 1000);

  status.textContent = 'Wczytywanie…';
  return getLatestTables()
    .then((data) => {
      latest = data;
      render();
      status.textContent = '';
    })
    .catch((err) => {
      meta.textContent = 'Nie udało się wczytać tabeli kursów.';
      form.hidden = true;
      const announced = showAlert(alerts, err);
      status.textContent = announced ? '' : (err && err.message ? err.message : 'Błąd wczytywania.');
    })
    .finally(() => card.classList.remove('is-loading'));
}

// ======================================================================
// WYKRES
// ======================================================================

/** Kolory z tokenów CSS (odczyt przy każdym rysowaniu — reaguje na motyw). */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const series = [];
  const fallbacks = ['#1f5fbf', '#b25e00', '#8a3ffc', '#0e7c86', '#c2185b', '#6d4c41'];
  for (let i = 1; i <= SERIES_COUNT; i++) series.push(v(`--series-${i}`, fallbacks[i - 1]));
  return {
    series,
    text: v('--color-text', '#14181f'),
    muted: v('--color-text-muted', '#5a6472'),
    grid: v('--chart-grid', 'rgba(20,24,31,.08)'),
    surface: v('--color-surface', '#ffffff'),
    border: v('--color-border', '#d6dbe3'),
    font: v('--font-sans', 'system-ui, sans-serif'),
  };
}

/** Próbkowanie indeksów: co n-ty, zawsze z ostatnim. */
function sampleIndexes(length, max) {
  if (length <= max) return null;
  const step = Math.ceil(length / max);
  const idx = [];
  for (let i = 0; i < length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== length - 1) idx.push(length - 1);
  return idx;
}

export function initChart(rootElement) {
  rootElement.replaceChildren();
  const today = todayISO(); // tylko wartości startowe pól; walidacja zawsze z bieżącym todayISO()

  // --- Waluty (checkboxy-chipy) ---
  const chipsBox = el('div', { class: 'field-row' }, el('span', { class: 'muted', text: 'Wczytywanie…' }));
  const chipsSummary = el('p', { id: 'wykres-waluty-wybor', class: 'field__hint', attrs: { 'aria-live': 'polite' } });
  const fsWaluty = el('fieldset', { id: 'wykres-waluty', class: 'field', attrs: { 'aria-describedby': 'wykres-waluty-wybor' } },
    el('legend', { class: 'field__label', text: `Waluty (maks. ${SERIES_COUNT})` }),
    chipsSummary,
    chipsBox,
  );

  // --- Okres (segmented radio) ---
  const periods = [['1M', '1M', '1 miesiąc'], ['3M', '3M', '3 miesiące'], ['1R', '1R', '1 rok'], ['5L', '5L', '5 lat'], ['custom', 'Własny', 'Własny zakres dat']];
  const segOkres = el('div', { id: 'wykres-okres', class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': 'Okres' } });
  for (const [value, label, title] of periods) {
    const id = `wykres-okres-${value}`;
    segOkres.append(
      el('input', { id, attrs: { type: 'radio', name: 'wykres-okres', value, checked: value === '3M' } }),
      el('label', { class: 'segmented__option', text: label, attrs: { for: id, title } }),
    );
  }

  // --- Własny zakres dat ---
  const defaultCustom = periodToRange('1R', today);
  const inOd = el('input', { id: 'wykres-od', class: 'field__input', attrs: { type: 'date', min: MIN_DATE, max: today, value: defaultCustom.start } });
  const inDo = el('input', { id: 'wykres-do', class: 'field__input', attrs: { type: 'date', min: MIN_DATE, max: today, value: today } });
  const customRow = el('div', { class: 'field-row', attrs: { hidden: true } },
    el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Od', attrs: { for: 'wykres-od' } }), inOd),
    el('div', { class: 'field' }, el('label', { class: 'field__label', text: 'Do', attrs: { for: 'wykres-do' } }), inDo),
  );

  // --- Tryb % ---
  const cbPct = el('input', { id: 'wykres-tryb-proc', attrs: { type: 'checkbox', disabled: true } });
  const pctHintId = 'wykres-tryb-proc-hint';
  cbPct.setAttribute('aria-describedby', pctHintId);
  const pctLabel = el('label', { class: 'checkbox', attrs: { for: 'wykres-tryb-proc' } }, cbPct, ' Zmiana % od początku okresu');
  const pctHint = el('p', { id: pctHintId, class: 'field__hint', text: 'Dostępne przy co najmniej dwóch walutach — skale stają się porównywalne.' });

  // --- Canvas, status, alerty ---
  const canvas = el('canvas', { id: 'wykres-canvas', attrs: { role: 'img', 'aria-label': 'Wykres kursów walut' } });
  const wrap = el('div', { id: 'wykres-canvas-wrap', class: 'chart-wrap' }, canvas);
  const alerts = el('div', { id: 'wykres-alert' });
  const status = el('p', { id: 'wykres-status', class: 'muted', attrs: { 'aria-live': 'polite' } });

  const card = el('div', { class: 'card is-loading' },
    el('div', { class: 'card__body' },
      fsWaluty,
      el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Okres', attrs: { 'aria-hidden': 'true' } }), segOkres),
      customRow,
      el('div', { class: 'field' }, pctLabel, pctHint),
      alerts,
      wrap,
      status,
    ),
  );

  rootElement.append(
    el('h2', { id: 'wykres-h', class: 'section__title', text: 'Wykres zmian kursu' }),
    el('p', { class: 'section__desc', text: 'Kurs średni NBP w wybranym okresie. Przy kilku walutach można porównać zmianę procentową.' }),
    card,
  );

  // Brak Chart.js — komunikat zamiast wyjątku
  if (typeof window === 'undefined' || typeof window.Chart === 'undefined') {
    card.classList.remove('is-loading');
    showAlert(alerts, new Error('Nie udało się wczytać biblioteki wykresów (Chart.js). Sprawdź połączenie z internetem.'));
    wrap.hidden = true;
    return;
  }

  // --- Stan ---
  let chart = null;
  let lastData = null;      // { labels, series: [{code, currency, values}], pct, range }
  let requestId = 0;        // ignorowanie spóźnionych odpowiedzi
  let pctTouched = false;   // czy użytkownik sam przełączył tryb %
  let debounceTimer = null;

  const selectedCodes = () =>
    [...chipsBox.querySelectorAll('input[name="wykres-waluta"]:checked')].map((i) => i.value);
  const selectedPeriod = () => segOkres.querySelector('input[name="wykres-okres"]:checked').value;

  /** Tryb % aktywny tylko przy ≥ 2 walutach; domyślnie włączony, dopóki użytkownik go nie zmieni. */
  function syncPctControl() {
    const n = selectedCodes().length;
    if (n >= 2) {
      cbPct.disabled = false;
      if (!pctTouched) cbPct.checked = true;
    } else {
      cbPct.disabled = true;
      cbPct.checked = false;
    }
  }

  /** Limit walut (= liczba kolorów serii), podsumowanie wyboru i znaczniki kolorów na chipach. */
  function syncChips() {
    const inputs = [...chipsBox.querySelectorAll('input[name="wykres-waluta"]')];
    const checked = inputs.filter((i) => i.checked);
    const full = checked.length >= SERIES_COUNT;
    for (const i of inputs) {
      i.disabled = full && !i.checked;
      const label = i.closest('.chip');
      const idx = checked.indexOf(i);
      if (label) {
        if (idx >= 0) label.style.setProperty('--chip-dot', `var(--series-${idx + 1})`);
        else label.style.removeProperty('--chip-dot');
      }
    }
    chipsSummary.textContent = checked.length
      ? `Wybrane (${checked.length}/${SERIES_COUNT}): ${checked.map((i) => i.value).join(', ')}` +
        (full ? `. Osiągnięto limit ${SERIES_COUNT} walut — odznacz którąś, aby wybrać inną.` : '.')
      : 'Nie wybrano żadnej waluty.';
  }

  function syncDateLimits() {
    const t = todayISO();
    inOd.max = t;
    inDo.max = t;
  }

  function currentRange() {
    const p = selectedPeriod();
    if (p !== 'custom') return periodToRange(p, todayISO());
    return { start: inOd.value, end: inDo.value };
  }

  /** Błąd walidacji zakresu z polem (konstruktor ValidationError z nbp.js nie jest częścią kontraktu). */
  function rangeError(message, field) {
    const err = new Error(message);
    err.name = 'ValidationError';
    err.field = field;
    return err;
  }

  function validateRange({ start, end }) {
    if (!start || !end) throw rangeError('Podaj obie daty zakresu.', 'wykres-od');
    if (start < MIN_DATE) throw rangeError(`Data początkowa nie może być wcześniejsza niż ${fmtDate(MIN_DATE)}.`, 'wykres-od');
    if (end > todayISO()) throw rangeError('Data końcowa nie może być z przyszłości.', 'wykres-do');
    if (start > end) throw rangeError('Data początkowa musi być wcześniejsza niż końcowa.', 'wykres-od');
  }

  function setFieldInvalid(field) {
    for (const inp of [inOd, inDo]) {
      inp.removeAttribute('aria-invalid');
      inp.removeAttribute('aria-describedby');
    }
    if (field) {
      const inp = field === 'wykres-do' ? inDo : inOd;
      inp.setAttribute('aria-invalid', 'true');
      inp.setAttribute('aria-describedby', 'wykres-alert');
    }
  }

  /** Buduje zbiór danych: unia dat, null dla braków, opcjonalnie tryb % i próbkowanie. */
  function buildData(seriesList, usePct) {
    const dateSet = new Set();
    for (const s of seriesList) for (const r of s.rates) dateSet.add(r.effectiveDate);
    let labels = [...dateSet].sort();

    let rows = seriesList.map((s) => {
      const map = new Map(s.rates.map((r) => [r.effectiveDate, r.mid]));
      const base = s.rates.length ? s.rates[0].mid : null; // pierwszy kurs w okresie
      const raw = labels.map((d) => (map.has(d) ? map.get(d) : null));
      const values = usePct && base
        ? raw.map((m) => (m == null ? null : (m / base - 1) * 100))
        : raw;
      return { code: s.code, currency: s.currency, colorIndex: s.colorIndex ?? 0, values, raw };
    });

    // Limit punktów (5L / długi własny zakres)
    const idx = sampleIndexes(labels.length, MAX_POINTS);
    if (idx) {
      labels = idx.map((i) => labels[i]);
      rows = rows.map((r) => ({ ...r, values: idx.map((i) => r.values[i]), raw: idx.map((i) => r.raw[i]) }));
    }
    return { labels, rows, sampled: !!idx };
  }

  /** Tworzy (od nowa) wykres z bieżącymi kolorami motywu. */
  function draw() {
    if (!lastData) return;
    const { labels, rows, pct } = lastData;
    const theme = readTheme();
    const Chart = window.Chart;

    if (chart) { chart.destroy(); chart = null; }

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: rows.map((r, i) => {
          const color = theme.series[r.colorIndex % SERIES_COUNT];
          return {
            label: r.code,
            data: r.values,
            raw: r.raw, // kursy źródłowe (do tooltipa w trybie %)
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0,
            spanGaps: true,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        font: { family: theme.font },
        color: theme.muted,
        scales: {
          x: {
            type: 'category',
            grid: { color: theme.grid },
            border: { color: theme.border },
            ticks: {
              color: theme.muted,
              maxTicksLimit: 8,
              autoSkip: true,
              maxRotation: 0,
              callback(value) { return fmtDate(this.getLabelForValue(value)); },
            },
          },
          y: {
            grid: { color: theme.grid },
            border: { color: theme.border },
            ticks: {
              color: theme.muted,
              // Liczba miejsc z kroku podziałki — etykiety zawsze się różnią (także IDR, KRW, CLP)
              callback: (v, i, ticks) => {
                const step = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0;
                if (pct) return `${fmtFixed(decimalsForStep(step, 0)).format(v)}%`;
                return fmtFixed(decimalsForStep(step, 2)).format(v);
              },
            },
            title: { display: true, color: theme.muted, text: pct ? 'Zmiana od początku okresu [%]' : 'Kurs średni [PLN]' },
          },
        },
        plugins: {
          legend: {
            display: rows.length > 1,
            labels: { color: theme.text, usePointStyle: true, pointStyle: 'line', boxWidth: 24 },
          },
          tooltip: {
            backgroundColor: theme.surface,
            titleColor: theme.text,
            bodyColor: theme.text,
            borderColor: theme.border,
            borderWidth: 1,
            callbacks: {
              title: (items) => (items.length ? fmtDate(items[0].label) : ''),
              label: (ctx) => {
                const y = ctx.parsed.y;
                if (y == null) return `${ctx.dataset.label}: brak notowania`;
                const rate = ctx.dataset.raw[ctx.dataIndex];
                if (pct) {
                  const rateTxt = rate != null ? ` (${fmtRate.format(rate)} PLN)` : '';
                  return `${ctx.dataset.label}: ${fmtSignedPct(y)}${rateTxt}`;
                }
                return `${ctx.dataset.label}: ${fmtRate.format(y)} PLN`;
              },
            },
          },
        },
      },
    });
  }

  /** Pobiera serie dla wybranych walut i okresu, potem rysuje. */
  async function load() {
    const myId = ++requestId;
    const codes = selectedCodes();
    showAlert(alerts, null);
    setFieldInvalid(null);

    // Wcześniejsze zapytanie mogło zostawić .is-loading — tu je zastępujemy
    card.classList.remove('is-loading');

    if (!codes.length) {
      if (chart) { chart.destroy(); chart = null; }
      lastData = null;
      showAlert(alerts, new NoDataError('Zaznacz co najmniej jedną walutę.'));
      status.textContent = 'Nie wybrano waluty.';
      canvas.setAttribute('aria-label', 'Wykres pusty — nie wybrano waluty');
      return;
    }

    syncDateLimits();
    let range;
    try {
      range = currentRange();
      validateRange(range);
    } catch (err) {
      // Nie zostawiamy starego wykresu, który wyglądałby na wynik nowego zakresu
      if (chart) { chart.destroy(); chart = null; }
      lastData = null;
      canvas.setAttribute('aria-label', 'Wykres pusty — niepoprawny zakres dat');
      setFieldInvalid(err.field);
      const announced = showAlert(alerts, err);
      status.textContent = announced ? '' : err.message;
      return;
    }

    card.classList.add('is-loading');
    status.textContent = 'Wczytywanie…';

    const results = await Promise.allSettled(codes.map((c) => getSeries(c, range.start, range.end, { table: 'A' })));
    if (myId !== requestId) return; // nowsze zapytanie w toku

    card.classList.remove('is-loading');
    const ok = [];
    const failed = [];
    results.forEach((r, i) => {
      // colorIndex = pozycja w wyborze — ten sam kolor co znacznik na chipie
      if (r.status === 'fulfilled' && r.value.rates.length) ok.push({ ...r.value, colorIndex: i });
      else failed.push({ code: codes[i], err: r.status === 'rejected' ? r.reason : new NoDataError('Brak danych.') });
    });

    if (!ok.length) {
      if (chart) { chart.destroy(); chart = null; }
      lastData = null;
      const err = failed[0].err;
      const announced = showAlert(alerts, err);
      status.textContent = announced ? 'Wykres pusty.' : (err.message || 'Brak danych dla wybranego okresu.');
      canvas.setAttribute('aria-label', 'Wykres pusty — brak danych');
      return;
    }

    if (failed.length) {
      const allNoData = failed.every((f) => f.err instanceof NoDataError);
      const msg = `Nie udało się wczytać: ${failed.map((f) => f.code).join(', ')}` +
        (failed[0].err && failed[0].err.message ? ` (${failed[0].err.message})` : '') + '.';
      showAlert(alerts, allNoData ? new NoDataError(msg) : new Error(msg));
    }

    const usePct = ok.length >= 2 && cbPct.checked;
    const { labels, rows, sampled } = buildData(ok, usePct);
    lastData = { labels, rows, pct: usePct, range };
    draw();

    // Status i opis wykresu dla czytników ekranu
    const first = labels[0];
    const last = labels[labels.length - 1];
    const summary = rows.map((r) => {
      const vals = r.values.filter((v) => v != null);
      if (!vals.length) return `${r.code}: brak danych`;
      const end = vals[vals.length - 1];
      return usePct ? `${r.code} ${fmtSignedPct(end)}` : `${r.code} ${fmtRate.format(end)} PLN`;
    }).join('; ');
    canvas.setAttribute('aria-label',
      `Wykres ${usePct ? 'zmiany procentowej kursu' : 'kursu średniego'} ${rows.map((r) => r.code).join(', ')} ` +
      `od ${fmtDate(first)} do ${fmtDate(last)}. Na koniec okresu: ${summary}.`);
    status.textContent =
      `Zakres ${fmtDate(first)} – ${fmtDate(last)}, ${fmtInt.format(labels.length)} notowań` +
      (sampled ? ' (wyświetlono co n-te notowanie)' : '') +
      (usePct ? '. Tryb: zmiana % od początku okresu.' : '.');
  }

  function scheduleLoad(delay = 250) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, delay);
  }

  // --- Zdarzenia ---
  chipsBox.addEventListener('change', () => { syncChips(); syncPctControl(); scheduleLoad(); });
  segOkres.addEventListener('change', () => {
    const isCustom = selectedPeriod() === 'custom';
    customRow.hidden = !isCustom;
    scheduleLoad(0);
  });
  for (const inp of [inOd, inDo]) inp.addEventListener('change', () => scheduleLoad(300));
  cbPct.addEventListener('change', () => {
    pctTouched = true;
    // Przeliczenie % nie wymaga pobierania (dane w cache nbp.js), ale najprościej przeładować
    scheduleLoad(0);
  });

  // Przerysowanie przy zmianie motywu (kolory z tokenów CSS)
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => requestAnimationFrame(() => { if (lastData) draw(); });
    if (mq.addEventListener) mq.addEventListener('change', onTheme);
    else if (mq.addListener) mq.addListener(onTheme);
  } catch { /* brak matchMedia */ }

  // --- Start: lista walut tabeli A ---
  status.textContent = 'Wczytywanie…';
  return getCurrencies('A')
    .then((currencies) => {
      // Najpierw główne waluty (jak w panelu), potem reszta alfabetycznie
      const rank = (c) => { const i = DEFAULT_CODES.indexOf(c.code); return i < 0 ? DEFAULT_CODES.length : i; };
      const sorted = [...currencies].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
      chipsBox.replaceChildren(...sorted.map((c) => {
        const id = `wykres-waluta-${c.code}`;
        const input = el('input', { id, attrs: { type: 'checkbox', name: 'wykres-waluta', value: c.code, checked: c.code === 'EUR' } });
        return el('label', { class: 'chip', attrs: { for: id, title: c.currency } },
          input,
          el('span', { class: 'chip__dot', attrs: { 'aria-hidden': 'true' } }),
          c.code,
          el('span', { class: 'visually-hidden', text: ` — ${c.currency}` }));
      }));
      syncChips();
      syncPctControl();
      return load();
    })
    .catch((err) => {
      card.classList.remove('is-loading');
      chipsBox.replaceChildren();
      const announced = showAlert(alerts, err);
      status.textContent = announced ? '' : (err && err.message ? err.message : 'Błąd wczytywania listy walut.');
    });
}

// ======================================================================
// Wygoda: oba widoki w jednym kontenerze
// ======================================================================

export function init(rootElement) {
  rootElement.replaceChildren();
  const ratesBox = el('div');
  const chartBox = el('div');
  rootElement.append(ratesBox, chartBox);
  return Promise.all([initRates(ratesBox), initChart(chartBox)]);
}
