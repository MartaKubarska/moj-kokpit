# Kokpit walutowy NBP — specyfikacja (etap 2)

Data odniesienia: **2026-11-17**. Interfejs po polsku. Statyczne pliki, bez builda/npm, ES modules (`<script type="module">`).
Uruchomienie: `cd /home/azureuser/moj-kokpit/etap2 && python3 -m http.server 8000` → http://localhost:8000

## 0. Pliki i właściciele

| Plik | Właściciel | Rola |
|---|---|---|
| `nbp.js` | DANE | moduł danych (przeglądarka + Node 24, globalny `fetch`, zero DOM) |
| `wykres.js` | WYKRES | panel kursów + wykres (importuje tylko z `nbp.js`) |
| `przelicznik.js` | UI | przelicznik (importuje tylko z `nbp.js`) |
| `index.html`, `style.css`, `app.js` | UI | szkielet, tokeny/komponenty, punkt wejścia |
| `README.md` | UI | jak uruchomić |

Zasady wspólne:
- Nikt nie edytuje cudzego pliku. Potrzeba zmiany kontraktu → zgłoszenie do architekta.
- Moduły UI nie wołają `fetch` bezpośrednio — wyłącznie przez `nbp.js`.
- Daty wszędzie jako string `YYYY-MM-DD` (strefa Europe/Warsaw, bez obiektów `Date` w API publicznym).
- Kursy jako `number` (pełna precyzja z API, bez zaokrąglania). Formatowanie wyświetlania: `Intl.NumberFormat('pl-PL')`, kurs min. 4 miejsca.
- Chart.js ładowany w `index.html` klasycznym skryptem (globalny `Chart`), przed `app.js`:
  `<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>`

---

## 1. `nbp.js` — kontrakt eksportów

```
export const API_BASE = 'https://api.nbp.pl/api/';
export const MIN_DATE = '2002-01-02';
export const MAX_RANGE_DAYS = 367;
export const DEFAULT_CODES = ['EUR', 'USD', 'CHF', 'GBP'];
```

### 1.1 Typy (JSDoc, kształty obiektów)

```
/** @typedef {'A'|'B'} TableType */

/** @typedef {Object} Currency      — pozycja listy walut
 *  @property {string} code        'EUR'
 *  @property {string} currency    'euro' (nazwa z API)
 *  @property {TableType} table
 */

/** @typedef {Object} RatePoint     — jedno notowanie
 *  @property {string} no             '223/A/NBP/2026'
 *  @property {string} effectiveDate  'YYYY-MM-DD'
 *  @property {number} mid
 */

/** @typedef {Object} RateSeries
 *  @property {TableType} table
 *  @property {string} code
 *  @property {string} currency
 *  @property {RatePoint[]} rates     posortowane rosnąco po effectiveDate, bez duplikatów
 */

/** @typedef {Object} RateOnDate    — wynik kursu „na dzień”
 *  @property {TableType} table
 *  @property {string} code
 *  @property {string} currency
 *  @property {string} no
 *  @property {string} effectiveDate  data faktycznego notowania
 *  @property {number} mid
 *  @property {string} requestedDate  data, o którą pytano (wejście użytkownika)
 *  @property {boolean} fallback      true gdy effectiveDate !== requestedDate (cofnięto) lub tryb „dzień poprzedzający”
 *  @property {'exact'|'fallback'|'previousBusinessDay'} mode
 */

/** @typedef {Object} TableChange   — wiersz panelu zmian
 *  @property {string} code
 *  @property {string} currency
 *  @property {number} mid            kurs z ostatniej tabeli
 *  @property {number|null} prevMid   kurs z poprzedniej tabeli (null gdy waluty nie było)
 *  @property {number|null} diff      mid - prevMid
 *  @property {number|null} diffPct   (mid - prevMid) / prevMid * 100
 *  @property {'up'|'down'|'flat'|null} direction
 */

/** @typedef {Object} LatestTables
 *  @property {{no:string, effectiveDate:string}} current
 *  @property {{no:string, effectiveDate:string}} previous
 *  @property {TableChange[]} rates   wszystkie waluty tabeli A, kolejność jak w API
 */
```

### 1.2 Błędy

```
export class NbpError extends Error {          // awaria: sieć, HTTP ≠ 200/404, zły JSON
  constructor(message, { status, url, cause } = {})
  name = 'NbpError'; status: number|null; url: string
}
export class NoDataError extends NbpError {    // HTTP 404 lub pusta odpowiedź = brak danych, NIE awaria
  name = 'NoDataError'
}
export class ValidationError extends Error {   // złe argumenty (data < MIN_DATE, > dziś, start > end, nieznany kod)
  name = 'ValidationError'; field: string
}
```
Komunikaty `message` po polsku, gotowe do pokazania użytkownikowi.

### 1.3 Funkcje

| Funkcja | Zwraca | Opis |
|---|---|---|
| `getCurrencies(table = 'A')` | `Promise<Currency[]>` | Lista walut z `/exchangerates/tables/{table}/`. Sort. alfabetycznie po `code`. Cache. |
| `getAllCurrencies()` | `Promise<Currency[]>` | Suma A i B; przy duplikacie kodu wygrywa A. |
| `resolveTable(code)` | `Promise<TableType>` | `'A'` jeśli kod jest w tabeli A, inaczej `'B'` jeśli w B, inaczej `ValidationError`. |
| `getLatestTables()` | `Promise<LatestTables>` | `/exchangerates/tables/A/last/2/`; liczy zmianę dla każdej waluty. `direction`: `flat` gdy `diff === 0`. Cache 10 min. |
| `getSeries(code, start, end, { table } = {})` | `Promise<RateSeries>` | Seria kursów. `table` domyślnie z `resolveTable`. Zakres dzielony na kawałki ≤ 367 dni (włącznie), pobierane równolegle (maks. 3 naraz), łączone i sortowane. Kawałek z 404 = pusty (pomijany). Gdy cały zakres pusty → `NoDataError`. `start` przycinany do `MIN_DATE`, `end` do dziś. Cache w pamięci per kawałek. |
| `getLastN(code, n, { table } = {})` | `Promise<RateSeries>` | `/rates/{t}/{code}/last/{n}/`, `1 ≤ n ≤ 255`. |
| `getRateOnDate(code, date, { table } = {})` | `Promise<RateOnDate>` | Kurs z dnia `date`; gdy brak notowania → ostatnie wcześniejsze. Okno szukania: A 10 dni, B 14 dni (`/rates/{t}/{code}/{date-okno}/{date}/`, bierzemy ostatni punkt). Brak w oknie → drugie okno wstecz (łącznie maks. 2 próby), potem `NoDataError`. `mode`: `exact` lub `fallback`. |
| `getRateBeforeDate(code, date, { table } = {})` | `Promise<RateOnDate>` | Zasada VAT/PIT: ostatnie notowanie z dnia **ściśle wcześniejszego** niż `date` (= `getRateOnDate(code, addDays(date,-1))`), `mode: 'previousBusinessDay'`, `fallback: true`, `requestedDate` = oryginalne `date`. |
| `convert({ amount, code, date, direction, previousBusinessDay = false })` | `Promise<ConversionResult>` | Patrz niżej. |
| `periodToRange(period, today = todayISO())` | `{start, end}` | `period ∈ '1M'|'3M'|'1R'|'5L'`. Odejmowanie kalendarzowe (miesiące/lata), `start` ≥ `MIN_DATE`. |
| `todayISO()` | `string` | Dzisiejsza data w Europe/Warsaw (`YYYY-MM-DD`). |
| `addDays(iso, n)` | `string` | Arytmetyka dat w UTC (bez przesunięć DST). |
| `clearCache()` | `void` | Czyści cały cache (testy). |

`ConversionResult`:
```
{
  amount: number,               // wejście
  direction: 'toPLN'|'fromPLN', // toPLN: waluta→PLN (amount*mid), fromPLN: PLN→waluta (amount/mid)
  rate: RateOnDate,
  result: number,               // pełna precyzja, bez zaokrąglania
  resultRounded: number,        // Math.round(Number((result * 100).toPrecision(15))) / 100 — TYLKO tu (toPrecision usuwa szum binarny, np. 4.015 → 4.02)
  resultCurrency: 'PLN'|string  // 'PLN' albo kod waluty
}
```
Zaokrąglanie do 2 miejsc wyłącznie na końcu (`resultRounded`); kurs nigdy nie jest zaokrąglany przed mnożeniem/dzieleniem.

### 1.4 Wymagania techniczne
- Wszystkie URL z `?format=json` i nagłówkiem `Accept: application/json`.
- Cache: `Map` w pamięci modułu, klucz = pełny URL, wartość = **Promise** (deduplikacja równoległych zapytań); odrzucone Promise są usuwane z cache. Wpisy dotyczące dzisiejszej daty / `last` / `tables` wygasają po 10 min; dane historyczne bez wygasania.
- Walidacja dat: `MIN_DATE ≤ date ≤ todayISO()`, inaczej `ValidationError`.
- Kod waluty normalizowany do wielkich liter.
- Brak zależności od `window`/`document` — moduł testowalny w Node 24: `node -e "import('./nbp.js').then(m=>m.getRateOnDate('EUR','2026-11-15')).then(console.log)"`.

---

## 2. Kontrakt modułów UI

Każdy moduł eksportuje:
```
export function init(rootElement: HTMLElement): void | Promise<void>
```
- Moduł sam renderuje całe wnętrze `rootElement` (nagłówek sekcji `<h2>` włącznie).
- Wszystkie id mają prefiks modułu (unikalne na stronie). Moduł nie dotyka DOM poza `rootElement`.
- Stany: ładowanie (`.is-loading` na karcie + tekst „Wczytywanie…”), błąd (`.alert.alert--error`), brak danych (`.alert.alert--info`) — komunikat z `err.message`.
- Wyniki/komunikaty zmienne w regionach `aria-live="polite"`.
- Komunikacja między modułami: zdarzenie `CustomEvent('kokpit:currencies-changed', { detail: { codes: string[] } })` wysyłane na `document` przez panel kursów, gdy użytkownik doda/usunie walutę (wykres może z niego skorzystać — opcjonalnie).

### 2.1 `wykres.js` (WYKRES)

Eksporty (panel i wykres to osobne sekcje strony, więc moduł ma dwa punkty wejścia o tym samym kontrakcie co `init`):
```
export function initRates(rootElement)  // renderuje panel kursów w #sekcja-kursy
export function initChart(rootElement)  // renderuje wykres w #sekcja-wykres
export function init(rootElement)       // wygoda: tworzy w rootElement dwa <div> i woła oba powyższe
```
`app.js` używa `initRates` i `initChart`.

**Panel kursów** (`initRates`) tworzy:
| id / klasa | element |
|---|---|
| `#kursy-meta` | `<p>` „Tabela nr 223/A/NBP/2026 z dnia 17.11.2026 (poprzednia: 222/A/NBP/2026, 16.11.2026)” — zawsze widoczne |
| `#kursy-lista` | `<ul class="rate-grid">` z `<li class="card rate-card" data-code="EUR">` |
| `.rate-card__code`, `.rate-card__name`, `.rate-card__mid`, `.rate-card__prev`, `.rate-card__change` | zawartość kafla; `.rate-card__change` ma klasę `change--up` / `change--down` / `change--flat` i tekst `▲ +0,12%` / `▼ −0,08%` / `■ 0,00%`; strzałka `aria-hidden`, obok `.visually-hidden` „wzrost”/„spadek” |
| `.rate-card__remove` | przycisk `btn btn--ghost` „Usuń EUR” (aria-label) |
| `#kursy-dodaj-form` | formularz: `label[for=kursy-dodaj-select]` + `<select id="kursy-dodaj-select" class="field__input">` (waluty tabeli A spoza listy) + `button.btn` „Dodaj” |
| `#kursy-status` | `aria-live="polite"` |

Lista wybranych walut w `localStorage['kokpit.kursy']` (try/catch; domyślnie `DEFAULT_CODES`).

**Wykres** (`initChart`) tworzy:
| id / klasa | element |
|---|---|
| `#wykres-waluty` | `<fieldset class="field">` z `<legend>` „Waluty”, checkboxy `.chip` (`input[type=checkbox][name=wykres-waluta]`) — waluty tabeli A; domyślnie EUR zaznaczone |
| `#wykres-okres` | `<div class="segmented" role="radiogroup" aria-label="Okres">` z `input[type=radio][name=wykres-okres]` + label: `1M`, `3M`, `1R`, `5L`, `Własny` (domyślnie 3M) |
| `#wykres-od`, `#wykres-do` | `<input type="date" class="field__input">` (min `2002-01-02`, max dziś), widoczne tylko przy „Własny” |
| `#wykres-tryb-proc` | checkbox „Zmiana % od początku okresu”; aktywny/sensowny gdy ≥ 2 waluty (przy 1 walucie wyłączony, przy ≥2 domyślnie włączony) |
| `#wykres-canvas-wrap` | `<div class="chart-wrap">` (wys. 320px, mobile 260px) z `<canvas id="wykres-canvas" role="img" aria-label="…">` |
| `#wykres-status` | `aria-live="polite"` — zakres, liczba punktów, błędy |

Szczegóły Chart.js: `type: 'line'`, oś X `type: 'category'` z etykietami `effectiveDate` (unia dat wszystkich serii, posortowana; brakujące punkty `null`, `spanGaps: true`), `pointRadius: 0`, `tension: 0`, `interaction: { mode: 'index', intersect: false }`, `maxTicksLimit: 8`. Tryb %: `y = (mid / pierwszy_mid − 1) * 100`, oś Y z sufiksem `%`. Kolory serii z tokenów `--series-1..6` (odczyt `getComputedStyle`; maks. 6 walut naraz — kolejne pigułki blokowane), przerysowanie przy zmianie `prefers-color-scheme`. Przy 5L i własnym zakresie nie przekraczać ~1300 punktów na serię (próbkować co n-ty punkt, zawsze z ostatnim). Instancję niszczyć (`chart.destroy()`) przed ponownym utworzeniem.

### 2.2 `przelicznik.js` (UI)

Eksport: `init(rootElement)`. Tworzy `<form id="przel-form" class="card" novalidate>`:
| id | element |
|---|---|
| `#przel-kwota` | `<input type="text" inputmode="decimal" class="field__input">` — akceptuje przecinek i kropkę, spacje jako separatory tysięcy; domyślnie `100` |
| `#przel-waluta` | `<select>` z `<optgroup label="Tabela A">` i `<optgroup label="Tabela B">` (z `getAllCurrencies`); domyślnie EUR |
| `#przel-data` | `<input type="date">` min `2002-01-02`, max dziś, domyślnie dziś |
| `#przel-kierunek` | `.segmented` radio `name=przel-kierunek`: „Waluta → PLN” (`toPLN`, domyślny) / „PLN → waluta” (`fromPLN`) |
| `#przel-poprzedni` | checkbox „Kurs z dnia roboczego poprzedzającego datę (VAT/PIT)” + `.field__hint` z krótkim wyjaśnieniem |
| `#przel-zamien` | `button.btn.btn--ghost` „Zamień kierunek” |
| `#przel-submit` | `button.btn.btn--primary` „Przelicz” (dodatkowo przeliczanie automatyczne po zmianie pól, debounce 300 ms) |
| `#przel-wynik` | `<output class="result" aria-live="polite">` |
| `#przel-wynik-kwota` | duża liczba: `100,00 EUR = 423,15 PLN` |
| `#przel-wynik-szczegoly` | `<dl class="result__meta">`: Kurs średni (1 EUR = 4,2315 PLN), Tabela (nr), Data notowania (`effectiveDate`), Data żądana |
| `#przel-wynik-uwaga` | `.alert.alert--info` gdy `rate.fallback`: „Brak notowania z dnia 15.11.2026 (niedziela). Użyto kursu z 13.11.2026, tabela 221/A/NBP/2026.” / w trybie VAT: „Kurs z ostatniego dnia roboczego przed 17.11.2026: 16.11.2026.” Dla tabeli B dopisek, że tabela B publikowana jest raz w tygodniu. |
| `#przel-blad` | `.alert.alert--error` + `aria-invalid="true"` i `aria-describedby` na błędnym polu |

Jeśli `date === dziś` i brak dzisiejszej tabeli (przed ~12:00) — to zwykły fallback z komunikatem „Dzisiejsza tabela nie została jeszcze opublikowana (zwykle ok. 12:00)”.

### 2.3 `app.js` (UI)
```
import { initRates, initChart } from './wykres.js';
import { init as initPrzelicznik } from './przelicznik.js';
```
Inicjuje każdy moduł niezależnie w `try/catch` (awaria jednego nie blokuje innych), ustawia w stopce rok i link do API, pokazuje `.alert` w sekcji gdy `typeof Chart === 'undefined'`.

---

## 3. `index.html` — układ strony

Tylko kontenery; zawartość renderują moduły.
```
<html lang="pl">
<head> meta charset, viewport, <title>Kokpit walutowy NBP</title>, color-scheme light dark,
       style.css, Chart.js (CDN), <script type="module" src="app.js"></script>
<body>
  <a class="skip-link" href="#main">Przejdź do treści</a>
  <header class="site-header">
    <div class="container"><h1 class="site-title">Kokpit walutowy</h1>
      <p class="site-subtitle">Kursy średnie NBP · tabele A i B</p></div>
  </header>
  <main id="main" class="container layout">
    <section id="sekcja-kursy"       class="section" aria-labelledby="kursy-h"></section>
    <section id="sekcja-wykres"      class="section" aria-labelledby="wykres-h"></section>
    <section id="sekcja-przelicznik" class="section" aria-labelledby="przel-h"></section>
  </main>
  <footer class="site-footer"><div class="container">
    Źródło danych: <a href="https://api.nbp.pl/">Narodowy Bank Polski — API</a>.
    Kursy średnie, tabela A (dzienna) i B (tygodniowa). Dane informacyjne.
  </div></footer>
```
Moduły tworzą `<h2>` z id `kursy-h`, `wykres-h`, `przel-h`.

Układ: jedna kolumna, `max-width: 1100px`. ≥ 960px: `.layout` jako grid 2 kolumny — kursy na całą szerokość, pod spodem wykres (2fr) i przelicznik (1fr). `.rate-grid`: `repeat(auto-fill, minmax(150px, 1fr))`. Przy 360px: brak poziomego scrolla (`min-width: 0` w gridzie, `overflow-wrap: anywhere` dla nr tabel, segmenty mogą się zawijać).

---

## 4. `style.css` — design tokens i komponenty wspólne

### 4.1 Tokeny (`:root`)
```
/* kolory — jasny */
--color-bg: #f6f7f9;         --color-surface: #ffffff;   --color-surface-2: #eef1f5;
--color-text: #14181f;       --color-text-muted: #5a6472; --color-border: #d6dbe3;
--color-accent: #1f5fbf;     --color-accent-text: #ffffff; --color-focus: #1f5fbf;
--color-up: #18794e;         --color-up-bg: #e6f4ec;
--color-down: #c4320a;       --color-down-bg: #fdece6;
--color-flat: #5a6472;
--color-info-bg: #e8f0fc;    --color-error: #b42318;     --color-error-bg: #fdecea;
--series-1: #1f5fbf; --series-2: #b25e00; --series-3: #8a3ffc;
--series-4: #0e7c86; --series-5: #c2185b; --series-6: #6d4c41;   /* bez kolorów wzrostu/spadku */
--color-border-strong: #7c8696;   /* obrys kontrolek ≥ 3:1 (ciemny: #66717f) */
--chart-grid: rgba(20,24,31,.08);

/* typografia */
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
--fs-xs: .75rem; --fs-sm: .875rem; --fs-md: 1rem; --fs-lg: 1.25rem; --fs-xl: 1.75rem; --fs-2xl: 2.25rem;
--fw-normal: 400; --fw-medium: 500; --fw-bold: 650;
--lh: 1.5;

/* odstępy i kształt */
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px;
--radius-sm: 6px; --radius: 10px; --radius-lg: 14px;
--shadow: 0 1px 2px rgba(0,0,0,.06), 0 2px 8px rgba(0,0,0,.04);
--container-pad: 16px;   /* boczny margines na telefonie */
```
Ciemny: `@media (prefers-color-scheme: dark) { :root { … } }` z nadpisaniem wszystkich kolorów, np. `--color-bg:#0f1318; --color-surface:#171c23; --color-surface-2:#1f2630; --color-text:#e7ebf0; --color-text-muted:#9aa4b2; --color-border:#2c3440; --color-accent:#6ea8ff; --color-accent-text:#0f1318; --color-up:#4cc38a; --color-up-bg:#12301f; --color-down:#ff7a59; --color-down-bg:#3a1a12; --color-border-strong:#66717f; --series-1:#6ea8ff; --series-2:#f0a24a; --series-3:#b48cff; --series-4:#3cc4cf; --series-5:#f06bb0; --series-6:#c49a82; --chart-grid: rgba(231,235,240,.1);`. `body` ma jawne `background: var(--color-bg)`. Wszystkie pary tekst/tło ≥ 4.5:1 (WCAG AA).

Liczby (kursy, kwoty): `font-variant-numeric: tabular-nums`.

### 4.2 Klasy wspólne (jedyne dozwolone do stylizacji modułów; moduły nie wstrzykują własnego CSS)
| Klasa | Przeznaczenie |
|---|---|
| `.container` | szerokość maks. + `padding-inline: var(--container-pad)` |
| `.section`, `.section__title` (h2), `.section__desc` | sekcja strony |
| `.card`, `.card__header`, `.card__body`, `.is-loading` | karta |
| `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--sm` | przyciski (min. 44×44px pola dotyku) |
| `.segmented`, `.segmented__option` (label), `input` w środku wizualnie ukryty, stan `:checked + label` | przełącznik segmentowy (radio) |
| `.chip` | checkbox jako pigułka (wybór walut wykresu) |
| `.field`, `.field__label`, `.field__input`, `.field__hint`, `.field--inline`, `.field-row` | pole formularza (label nad polem; `.field-row` = flex-wrap) |
| `.checkbox` | label z checkboxem |
| `.alert`, `.alert--info`, `.alert--error` | komunikaty |
| `.result`, `.result__value`, `.result__meta` | wynik przelicznika |
| `.rate-grid`, `.rate-card`, `.rate-card__*` | kafle kursów |
| `.change--up`, `.change--down`, `.change--flat` | kolor zmiany (tekst `--color-up/down/flat`, tło `*-bg`) |
| `.chart-wrap` | kontener canvasu (`position: relative`, stała wysokość) |
| `.muted`, `.mono`, `.num`, `.visually-hidden`, `.skip-link` | narzędziowe |

Fokus: `:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }`. `prefers-reduced-motion` wyłącza animacje.

---

## 5. Kryteria akceptacji (skrót)
1. Panel pokazuje EUR/USD/CHF/GBP z kursem bieżącym i poprzednim, ▲/▼, %, kolorem; nr i data tabeli zawsze widoczne; dodanie waluty z tabeli A działa i przetrwa odświeżenie.
2. Wykres 5L dla EUR pobiera ≥ 5 kawałków ≤ 367 dni; powtórne wybranie nie robi nowych zapytań (cache); tryb % przy ≥ 2 walutach.
3. Przelicznik: `EUR, 2026-11-15 (niedziela)` → kurs z piątku 2026-11-13 z komunikatem; z przełącznikiem VAT dla `2026-11-17` → kurs z 2026-11-16; waluta tylko z tabeli B (np. `AFN`) działa z oknem 14 dni; data `2002-01-02` działa; data < `2002-01-02` lub w przyszłości → błąd walidacji.
4. 360px bez poziomego scrolla; jasny i ciemny motyw czytelny; wszystkie pola mają `<label>`; wyniki ogłaszane przez `aria-live`.
5. `nbp.js` importowalny w Node 24 bez błędów.
