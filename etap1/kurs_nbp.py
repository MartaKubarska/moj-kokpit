"""Przeliczanie kwot w walutach obcych na PLN po kursie średnim NBP z dnia wczorajszego."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

NBP_API = "https://api.nbp.pl/api/exchangerates/rates/{table}/{code}/{start}/{end}/?format=json"


def _pobierz_kurs(code: str, table: str, dzien: date, max_dni_wstecz: int) -> dict | None:
    """Zwraca ostatnie notowanie z przedziału [dzien - max_dni_wstecz, dzien] albo None."""
    url = NBP_API.format(
        table=table,
        code=code.lower(),
        start=(dzien - timedelta(days=max_dni_wstecz)).isoformat(),
        end=dzien.isoformat(),
    )
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            dane = json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 404:  # brak notowań w przedziale lub waluty w tej tabeli
            return None
        raise
    return dane["rates"][-1] if dane.get("rates") else None


def przelicz_na_pln(kwota: float | str | Decimal, waluta: str, dzis: date | None = None) -> dict:
    """Przelicza kwotę w walucie obcej na złote po kursie średnim NBP z dnia wczorajszego.

    Jeśli wczoraj nie było notowania (weekend, święto), używany jest kurs
    z ostatniego wcześniejszego dnia roboczego. Waluta jest szukana najpierw
    w tabeli A, a gdy jej tam nie ma – w tabeli B (waluty egzotyczne).

    Zwraca słownik z kwotą w PLN oraz danymi użytego kursu (numer tabeli, data).
    """
    waluta = waluta.strip().upper()
    if waluta == "PLN":
        raise ValueError("Kwota jest już w PLN.")

    wczoraj = (dzis or date.today()) - timedelta(days=1)

    for tabela, zapas_dni in (("A", 10), ("B", 14)):  # tabela B wychodzi raz w tygodniu
        notowanie = _pobierz_kurs(waluta, tabela, wczoraj, zapas_dni)
        if notowanie:
            break
    else:
        raise LookupError(f"Brak kursu średniego NBP dla waluty {waluta} do dnia {wczoraj}.")

    kurs = Decimal(str(notowanie["mid"]))
    kwota_pln = (Decimal(str(kwota)) * kurs).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    return {
        "kwota": Decimal(str(kwota)),
        "waluta": waluta,
        "kurs": kurs,
        "kwota_pln": kwota_pln,
        "tabela": notowanie["no"],
        "data_kursu": notowanie["effectiveDate"],
    }


if __name__ == "__main__":
    import sys

    kwota_arg, waluta_arg = (sys.argv[1], sys.argv[2]) if len(sys.argv) == 3 else ("100", "EUR")
    w = przelicz_na_pln(kwota_arg, waluta_arg)
    print(
        f"{w['kwota']} {w['waluta']} = {w['kwota_pln']} PLN "
        f"(kurs {w['kurs']}, tabela {w['tabela']} z {w['data_kursu']})"
    )
