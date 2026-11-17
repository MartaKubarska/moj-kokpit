// nbp.js — moduł danych kokpitu walutowego (kursy średnie NBP, tabele A i B).
// Czysty ES module: działa w przeglądarce i w Node 24 (globalny fetch), bez DOM.
// Kontrakt: SPEC.md, sekcja 1.

export const API_BASE = 'https://api.nbp.pl/api/';
export const MIN_DATE = '2002-01-02';
export const MAX_RANGE_DAYS = 367;
export const DEFAULT_CODES = ['EUR', 'USD', 'CHF', 'GBP'];

/** @typedef {'A'|'B'} TableType */

/** @typedef {Object} Currency
 *  @property {string} code
 *  @property {string} currency
 *  @property {TableType} table
 */

/** @typedef {Object} RatePoint
 *  @property {string} no
 *  @property {string} effectiveDate
 *  @property {number} mid
 */

/** @typedef {Object} RateSeries
 *  @property {TableType} table
 *  @property {string} code
 *  @property {string} currency
 *  @property {RatePoint[]} rates
 */

/** @typedef {Object} RateOnDate
 *  @property {TableType} table
 *  @property {string} code
 *  @property {string} currency
 *  @property {string} no
 *  @property {string} effectiveDate
 *  @property {number} mid
 *  @property {string} requestedDate
 *  @property {boolean} fallback
 *  @property {'exact'|'fallback'|'previousBusinessDay'} mode
 */

/** @typedef {Object} TableChange
 *  @property {string} code
 *  @property {string} currency
 *  @property {number} mid
 *  @property {number|null} prevMid
 *  @property {number|null} diff
 *  @property {number|null} diffPct
 *  @property {'up'|'down'|'flat'|null} direction
 */

/** @typedef {Object} LatestTables
 *  @property {{no:string, effectiveDate:string}} current
 *  @property {{no:string, effectiveDate:string}} previous
 *  @property {TableChange[]} rates
 */

/** @typedef {Object} ConversionResult
 *  @property {number} amount
 *  @property {'toPLN'|'fromPLN'} direction
 *  @property {RateOnDate} rate
 *  @property {number} result
 *  @property {number} resultRounded
 *  @property {string} resultCurrency
 */

// ---------------------------------------------------------------------------
// Błędy
// ---------------------------------------------------------------------------

/** Awaria: sieć, HTTP inny niż 200/404, niepoprawny JSON. */
export class NbpError extends Error {
  constructor(message, { status = null, url = '', cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'NbpError';
    this.status = status;
    this.url = url;
  }
}

/** Brak danych (HTTP 404 lub pusta odpowiedź) — to nie jest awaria. */
export class NoDataError extends NbpError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'NoDataError';
  }
}

/** Niepoprawne argumenty wywołania (data, kod waluty, kwota…). */
export class ValidationError extends Error {
  constructor(message, field = '') {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Daty (string YYYY-MM-DD, arytmetyka w UTC)
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

// Formatter daty w strefie Europe/Warsaw; 'en-CA' daje format YYYY-MM-DD.
const warsawFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Dzisiejsza data w Europe/Warsaw (YYYY-MM-DD). */
export function todayISO() {
  return warsawFmt.format(new Date());
}

// ISO -> liczba ms (UTC północ); null gdy data nie istnieje (np. 2026-02-30).
function isoToMs(iso) {
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Dodaje n dni do daty ISO (n może być ujemne). */
export function addDays(iso, n) {
  const ms = isoToMs(iso);
  if (ms === null) throw new ValidationError(`Niepoprawna data: „${iso}”. Oczekiwany format RRRR-MM-DD.`, 'date');
  return msToIso(ms + n * DAY_MS);
}

// Format do komunikatów: 17.11.2026
function plDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Walidacja daty wejściowej: format, istnienie, MIN_DATE ≤ date ≤ dziś.
function validateDate(date, field = 'date') {
  if (isoToMs(date) === null) {
    throw new ValidationError(`Niepoprawna data: „${date}”. Oczekiwany format RRRR-MM-DD.`, field);
  }
  if (date < MIN_DATE) {
    throw new ValidationError(`Data ${plDate(date)} jest zbyt wczesna — NBP udostępnia kursy od ${plDate(MIN_DATE)}.`, field);
  }
  const today = todayISO();
  if (date > today) {
    throw new ValidationError(`Data ${plDate(date)} jest z przyszłości — najpóźniejsza możliwa to ${plDate(today)}.`, field);
  }
  return date;
}

// Normalizacja i podstawowa walidacja kodu waluty.
function normCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new ValidationError(`Niepoprawny kod waluty: „${code}”. Oczekiwany trzyliterowy kod ISO, np. EUR.`, 'code');
  }
  return c;
}

function normTable(table) {
  const t = String(table).toUpperCase();
  if (t !== 'A' && t !== 'B') throw new ValidationError(`Nieznana tabela kursów: „${table}”. Dozwolone: A lub B.`, 'table');
  return t;
}

// ---------------------------------------------------------------------------
// Pobieranie + cache
// ---------------------------------------------------------------------------

const TTL_MS = 10 * 60 * 1000;
/** @type {Map<string, {promise: Promise<any>, expires: number}>} klucz = pełny URL */
const cache = new Map();

/** Czyści cały cache (np. w testach). */
export function clearCache() {
  cache.clear();
}

// Czy wpis ma wygasać: tabele, zapytania „last” i zakresy kończące się dziś.
function isVolatile(url) {
  return url.includes('/tables/') || url.includes('/last/') || url.includes(todayISO());
}

// Surowe zapytanie: 200 -> JSON, 404 -> NoDataError, reszta -> NbpError.
async function rawFetch(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (cause) {
    throw new NbpError('Nie udało się połączyć z serwerem NBP. Sprawdź połączenie z internetem i spróbuj ponownie.', { url, cause });
  }
  if (res.status === 404) {
    throw new NoDataError('Brak danych NBP dla wybranych parametrów.', { status: 404, url });
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).trim().slice(0, 200); } catch { /* bez szczegółów */ }
    throw new NbpError(`Serwer NBP zwrócił błąd HTTP ${res.status}${detail ? ` (${detail})` : ''}.`, { status: res.status, url });
  }
  let data;
  try {
    data = await res.json();
  } catch (cause) {
    throw new NbpError('Serwer NBP zwrócił niepoprawną odpowiedź (błędny JSON).', { status: res.status, url, cause });
  }
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    throw new NoDataError('Brak danych NBP dla wybranych parametrów.', { status: res.status, url });
  }
  return data;
}

// Zapytanie z cache (wartość = Promise, deduplikacja równoległych wywołań).
function fetchJson(path) {
  const url = API_BASE + path + (path.includes('?') ? '&' : '?') + 'format=json';
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expires > now) return hit.promise;

  const promise = rawFetch(url);
  const entry = { promise, expires: isVolatile(url) ? now + TTL_MS : Infinity };
  cache.set(url, entry);
  // Odrzucone Promise usuwamy z cache (jeśli wpis nie został już zastąpiony).
  promise.catch(() => { if (cache.get(url) === entry) cache.delete(url); });
  return promise;
}

// Uruchamia zadania z limitem równoległości.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Waluty
// ---------------------------------------------------------------------------

/** Lista walut z bieżącej tabeli (A lub B), posortowana po kodzie. */
export async function getCurrencies(table = 'A') {
  const t = normTable(table);
  const data = await fetchJson(`exchangerates/tables/${t}/`);
  const rates = data[0]?.rates ?? [];
  return rates
    .map((r) => ({ code: r.code.toUpperCase(), currency: r.currency, table: t }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Suma walut z tabel A i B; przy duplikacie kodu wygrywa A. */
export async function getAllCurrencies() {
  const [a, b] = await Promise.all([getCurrencies('A'), getCurrencies('B')]);
  const map = new Map();
  for (const c of [...b, ...a]) map.set(c.code, c); // A nadpisuje B
  return [...map.values()].sort((x, y) => x.code.localeCompare(y.code));
}

/** 'A' jeśli kod jest w tabeli A, inaczej 'B', inaczej ValidationError. */
export async function resolveTable(code) {
  const c = normCode(code);
  const a = await getCurrencies('A');
  if (a.some((x) => x.code === c)) return 'A';
  const b = await getCurrencies('B');
  if (b.some((x) => x.code === c)) return 'B';
  throw new ValidationError(`Nieznana waluta: „${c}”. NBP nie publikuje dla niej kursu średniego (tabele A i B).`, 'code');
}

async function tableFor(code, table) {
  return table ? normTable(table) : resolveTable(code);
}

// ---------------------------------------------------------------------------
// Panel zmian
// ---------------------------------------------------------------------------

/** Dwie ostatnie tabele A i zmiana kursu każdej waluty. */
export async function getLatestTables() {
  const data = await fetchJson('exchangerates/tables/A/last/2/');
  const tables = [...data].sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate));
  if (tables.length < 2) throw new NoDataError('Brak dwóch ostatnich tabel kursów NBP.');
  const [prev, cur] = tables.slice(-2);
  const prevMap = new Map(prev.rates.map((r) => [r.code.toUpperCase(), r.mid]));

  const rates = cur.rates.map((r) => {
    const code = r.code.toUpperCase();
    const prevMid = prevMap.has(code) ? prevMap.get(code) : null;
    const diff = prevMid === null ? null : r.mid - prevMid;
    const diffPct = prevMid === null || prevMid === 0 ? null : (diff / prevMid) * 100;
    const direction = diff === null ? null : diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    return { code, currency: r.currency, mid: r.mid, prevMid, diff, diffPct, direction };
  });

  return {
    current: { no: cur.no, effectiveDate: cur.effectiveDate },
    previous: { no: prev.no, effectiveDate: prev.effectiveDate },
    rates,
  };
}

// ---------------------------------------------------------------------------
// Serie kursów
// ---------------------------------------------------------------------------

// Nazwa waluty z odpowiedzi; stare dane (np. 2002) nie mają pola `currency`
// (jest tylko `country`, np. „RFN”), wtedy zwracamy kod waluty.
function currencyName(data) {
  return data.currency ?? data.code;
}

// Pobiera jeden zakres (≤ 367 dni); 404 -> null.
async function fetchRange(t, code, start, end) {
  try {
    return await fetchJson(`exchangerates/rates/${t}/${code}/${start}/${end}/`);
  } catch (err) {
    if (err instanceof NoDataError) return null;
    throw err;
  }
}

/** Seria kursów w zakresie dat; dłuższe zakresy dzielone na kawałki ≤ 367 dni. */
export async function getSeries(code, start, end, { table } = {}) {
  const c = normCode(code);
  if (isoToMs(start) === null) throw new ValidationError(`Niepoprawna data początkowa: „${start}”.`, 'start');
  if (isoToMs(end) === null) throw new ValidationError(`Niepoprawna data końcowa: „${end}”.`, 'end');
  const today = todayISO();
  const s = start < MIN_DATE ? MIN_DATE : start;
  const e = end > today ? today : end;
  if (s > e) {
    throw new ValidationError(`Data początkowa (${plDate(s)}) jest późniejsza niż końcowa (${plDate(e)}).`, 'start');
  }
  const t = await tableFor(c, table);

  // Podział na kawałki po MAX_RANGE_DAYS dni (włącznie z obiema granicami).
  const chunks = [];
  for (let from = s; from <= e; from = addDays(from, MAX_RANGE_DAYS)) {
    const to = addDays(from, MAX_RANGE_DAYS - 1);
    chunks.push([from, to < e ? to : e]);
  }

  const parts = await mapLimit(chunks, 3, ([a, b]) => fetchRange(t, c, a, b));
  const found = parts.filter(Boolean);
  if (found.length === 0) {
    throw new NoDataError(`Brak notowań ${c} (tabela ${t}) w okresie ${plDate(s)} – ${plDate(e)}.`);
  }

  // Łączenie, deduplikacja po dacie, sortowanie rosnąco.
  const byDate = new Map();
  for (const p of found) for (const r of p.rates) byDate.set(r.effectiveDate, { no: r.no, effectiveDate: r.effectiveDate, mid: r.mid });
  const rates = [...byDate.values()].sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate));
  return { table: t, code: c, currency: currencyName(found.at(-1)), rates };
}

/** Ostatnie n notowań (1 ≤ n ≤ 255). */
export async function getLastN(code, n, { table } = {}) {
  const c = normCode(code);
  if (!Number.isInteger(n) || n < 1 || n > 255) {
    throw new ValidationError('Liczba notowań musi być liczbą całkowitą od 1 do 255.', 'n');
  }
  const t = await tableFor(c, table);
  let data;
  try {
    data = await fetchJson(`exchangerates/rates/${t}/${c}/last/${n}/`);
  } catch (err) {
    if (err instanceof NoDataError) throw new NoDataError(`Brak notowań ${c} w tabeli ${t}.`, { status: err.status, url: err.url });
    throw err;
  }
  const rates = data.rates
    .map((r) => ({ no: r.no, effectiveDate: r.effectiveDate, mid: r.mid }))
    .sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate));
  return { table: t, code: c, currency: currencyName(data), rates };
}

// ---------------------------------------------------------------------------
// Kurs na dzień
// ---------------------------------------------------------------------------

// Szuka ostatniego notowania ≤ date (bez walidacji „≤ dziś”; date już sprawdzona).
async function findRateOnOrBefore(t, c, date) {
  const win = t === 'B' ? 14 : 10;
  let end = date;
  for (let attempt = 0; attempt < 2 && end >= MIN_DATE; attempt++) {
    let start = addDays(end, -win);
    if (start < MIN_DATE) start = MIN_DATE;
    const data = await fetchRange(t, c, start, end);
    if (data && data.rates.length) {
      const last = [...data.rates].sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate)).at(-1);
      return { table: t, code: c, currency: currencyName(data), no: last.no, effectiveDate: last.effectiveDate, mid: last.mid };
    }
    end = addDays(start, -1);
  }
  throw new NoDataError(
    `Brak notowania ${c} (tabela ${t}) z dnia ${plDate(date)} ani z ${win * 2} dni wcześniej.`,
  );
}

// Gdy tabela nie jest podana: najpierw tabela, w której waluta jest dziś
// (resolveTable), a przy braku danych — druga tabela. Skład tabel zmieniał się
// w czasie (np. RUB był w tabeli A do 03.2022, potem w B), więc zasada
// „tabela A, a gdy brak — B” musi dotyczyć konkretnej daty, nie dzisiejszej listy.
// Zwracana `table` to tabela, z której kurs faktycznie pochodzi.
async function findRateAnyTable(c, date, table) {
  if (table) return findRateOnOrBefore(normTable(table), c, date);
  const first = await resolveTable(c);
  const second = first === 'A' ? 'B' : 'A';
  try {
    return await findRateOnOrBefore(first, c, date);
  } catch (err) {
    if (!(err instanceof NoDataError)) throw err;
    try {
      return await findRateOnOrBefore(second, c, date);
    } catch (err2) {
      if (!(err2 instanceof NoDataError)) throw err2;
      throw new NoDataError(`Brak notowania ${c} (tabele A i B) z dnia ${plDate(date)} ani z kilkunastu dni wcześniej.`);
    }
  }
}

/** Kurs z dnia `date`; gdy brak notowania — ostatnie wcześniejsze. */
export async function getRateOnDate(code, date, { table } = {}) {
  const c = normCode(code);
  validateDate(date);
  const r = await findRateAnyTable(c, date, table);
  const fallback = r.effectiveDate !== date;
  return { ...r, requestedDate: date, fallback, mode: fallback ? 'fallback' : 'exact' };
}

/** Zasada VAT/PIT: ostatnie notowanie z dnia ściśle wcześniejszego niż `date`. */
export async function getRateBeforeDate(code, date, { table } = {}) {
  const c = normCode(code);
  validateDate(date);
  const prev = addDays(date, -1);
  if (prev < MIN_DATE) {
    throw new NoDataError(`Brak notowań przed ${plDate(date)} — NBP udostępnia kursy od ${plDate(MIN_DATE)}.`);
  }
  const r = await findRateAnyTable(c, prev, table);
  return { ...r, requestedDate: date, fallback: true, mode: 'previousBusinessDay' };
}

// ---------------------------------------------------------------------------
// Przeliczanie
// ---------------------------------------------------------------------------

/** Przelicza kwotę waluta↔PLN po kursie średnim; zaokrąglenie tylko w resultRounded. */
export async function convert({ amount, code, date, direction, previousBusinessDay = false } = {}) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ValidationError('Podaj poprawną kwotę (liczbę).', 'amount');
  }
  if (amount < 0) throw new ValidationError('Kwota nie może być ujemna.', 'amount');
  if (direction !== 'toPLN' && direction !== 'fromPLN') {
    throw new ValidationError('Nieznany kierunek przeliczenia (dozwolone: toPLN, fromPLN).', 'direction');
  }
  const rate = previousBusinessDay ? await getRateBeforeDate(code, date) : await getRateOnDate(code, date);
  const result = direction === 'toPLN' ? amount * rate.mid : amount / rate.mid;
  // Najpierw usuwamy szum binarny (np. 4.015*100 = 401.49999999999994),
  // potem zaokrąglenie połówki w górę do pełnych groszy.
  const resultRounded = Math.round(Number((result * 100).toPrecision(15))) / 100;
  return {
    amount,
    direction,
    rate,
    result,
    resultRounded,
    resultCurrency: direction === 'toPLN' ? 'PLN' : rate.code,
  };
}

// ---------------------------------------------------------------------------
// Okresy wykresu
// ---------------------------------------------------------------------------

// Odejmuje miesiące kalendarzowo; dzień przycinany do długości miesiąca (31.03 − 1M = 28/29.02).
function subMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total % 12; // 0..11
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return msToIso(Date.UTC(ny, nm, Math.min(d, lastDay)));
}

/** Zakres dat dla okresu '1M' | '3M' | '1R' | '5L'. */
export function periodToRange(period, today = todayISO()) {
  const months = { '1M': 1, '3M': 3, '1R': 12, '5L': 60 }[period];
  if (!months) throw new ValidationError(`Nieznany okres: „${period}”. Dozwolone: 1M, 3M, 1R, 5L.`, 'period');
  if (isoToMs(today) === null) throw new ValidationError(`Niepoprawna data: „${today}”.`, 'today');
  let start = subMonths(today, months);
  if (start < MIN_DATE) start = MIN_DATE;
  return { start, end: today };
}
