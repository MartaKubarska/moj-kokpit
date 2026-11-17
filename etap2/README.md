# Kokpit walutowy NBP (etap 2)

Statyczna aplikacja (HTML/CSS/JS, ES modules, bez builda i npm) pokazująca kursy średnie NBP:

- **Panel kursów** – EUR, USD, CHF, GBP (+ dowolne waluty z tabeli A), kurs bieżący i poprzedni, zmiana ▲/▼ w %, numer i data tabeli.
- **Wykres** – jedna lub kilka walut, okres 1M / 3M / 1R / 5L / własny zakres; przy kilku walutach tryb „zmiana % od początku okresu”.
- **Przelicznik** – dowolna data od 2002-01-02, waluta → PLN i PLN → waluta, tabela A lub B, automatyczne cofnięcie do ostatniego notowania oraz tryb „kurs z dnia roboczego poprzedzającego datę” (VAT/PIT).

## Uruchomienie

```bash
cd /home/azureuser/moj-kokpit/etap2 && python3 -m http.server 8000
```

Następnie otwórz <http://localhost:8000>.

Serwer HTTP jest potrzebny, bo przeglądarki nie ładują modułów ES z `file://`.
Wymagany dostęp do internetu: dane z `https://api.nbp.pl/api/`, Chart.js z cdnjs.

## Pliki

| Plik | Rola |
|---|---|
| `index.html` | szkielet strony (kontenery sekcji) |
| `style.css` | tokeny (jasny/ciemny motyw) i komponenty wspólne |
| `app.js` | punkt wejścia – inicjuje moduły niezależnie |
| `nbp.js` | moduł danych NBP (działa też w Node 24) |
| `wykres.js` | panel kursów i wykres (Chart.js 4.4.1) |
| `przelicznik.js` | przelicznik walut |
| `SPEC.md` | kontrakt między modułami |

## Test modułu danych w Node 24

```bash
cd /home/azureuser/moj-kokpit/etap2
node -e "import('./nbp.js').then(m=>m.getRateOnDate('EUR','2026-11-15')).then(console.log)"
```

## Uwagi

- Kursy średnie NBP mają charakter informacyjny. Tabela A publikowana jest w dni robocze ok. 12:00, tabela B raz w tygodniu (zwykle w środę).
- Kwoty w PLN zaokrąglane są do 2 miejsc dopiero na końcu obliczeń; kurs używany jest z pełną precyzją.
