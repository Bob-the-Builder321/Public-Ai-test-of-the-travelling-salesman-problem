"""
Multi-transport Traveling Salesman comparison.

Find a good tour visiting a set of cities for each mode of transport
(ICE car, EV car, coach, train, flight) and report total distance,
journey time, and cost per mode.

Pluggable providers:

  Geocoder   local gazetteer | OpenStreetMap Nominatim | Google Geocoding
  Router     Haversine + detour factor | Google Distance Matrix
  Prices     editable config (prices.json) + SerpAPI Google Flights
             + optional scrapers, layered so missing data falls through to
             config defaults

CLI examples:
  python tsp.py                                  # defaults: built-in UK cities
  python tsp.py --interactive                    # type destinations at the prompt
  python tsp.py --city London --city Paris --city Rome
  python tsp.py --cities-file mycities.json
  python tsp.py --geocoder google --router google --google-key $GOOGLE_MAPS_API_KEY
  python tsp.py --serpapi-key $SERPAPI_KEY --depart-date 2026-06-01
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Core types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class City:
    name: str
    lat: float
    lon: float


@dataclass
class Mode:
    name: str
    detour_factor: float
    avg_speed_kmh: float
    cost_per_km: float
    fixed_time_per_leg_h: float = 0.0
    fixed_cost_per_leg: float = 0.0


DEFAULT_MODES: list[Mode] = [
    Mode("ICE car",  detour_factor=1.30, avg_speed_kmh=90,  cost_per_km=0.15),
    Mode("EV car",   detour_factor=1.30, avg_speed_kmh=90,  cost_per_km=0.05),
    Mode("Coach",    detour_factor=1.35, avg_speed_kmh=65,  cost_per_km=0.04,
         fixed_time_per_leg_h=0.25, fixed_cost_per_leg=1.0),
    Mode("Train",    detour_factor=1.20, avg_speed_kmh=120, cost_per_km=0.12,
         fixed_time_per_leg_h=0.25, fixed_cost_per_leg=2.0),
    Mode("Flight",   detour_factor=1.00, avg_speed_kmh=700, cost_per_km=0.20,
         fixed_time_per_leg_h=2.50, fixed_cost_per_leg=30.0),
]


DEFAULT_CITIES: list[City] = [
    City("London",     51.5074, -0.1278),
    City("Manchester", 53.4808, -2.2426),
    City("Edinburgh",  55.9533, -3.1883),
    City("Cardiff",    51.4816, -3.1791),
    City("Belfast",    54.5973, -5.9301),
    City("Birmingham", 52.4862, -1.8904),
    City("Glasgow",    55.8642, -4.2518),
    City("Bristol",    51.4545, -2.5879),
]


# ---------------------------------------------------------------------------
# HTTP helper (stdlib only)
# ---------------------------------------------------------------------------


def http_get_json(url: str, timeout: float = 15.0, headers: Optional[dict] = None) -> dict:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "tsp-tool/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_get_text(url: str, timeout: float = 15.0, headers: Optional[dict] = None) -> str:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "tsp-tool/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Geocoders
# ---------------------------------------------------------------------------


class LocalGazetteer:
    DATA: dict[str, tuple[float, float]] = {
        "london":     (51.5074, -0.1278),
        "manchester": (53.4808, -2.2426),
        "edinburgh":  (55.9533, -3.1883),
        "cardiff":    (51.4816, -3.1791),
        "belfast":    (54.5973, -5.9301),
        "birmingham": (52.4862, -1.8904),
        "glasgow":    (55.8642, -4.2518),
        "bristol":    (51.4545, -2.5879),
        "paris":      (48.8566,  2.3522),
        "berlin":     (52.5200, 13.4050),
        "rome":       (41.9028, 12.4964),
        "madrid":     (40.4168, -3.7038),
        "dublin":     (53.3498, -6.2603),
        "amsterdam":  (52.3676,  4.9041),
        "new york":   (40.7128, -74.0060),
        "tokyo":      (35.6762, 139.6503),
    }

    def geocode(self, name: str) -> Optional[tuple[float, float]]:
        return self.DATA.get(name.strip().lower())


class NominatimGeocoder:
    URL = "https://nominatim.openstreetmap.org/search"

    def geocode(self, name: str) -> Optional[tuple[float, float]]:
        q = urllib.parse.urlencode({"q": name, "format": "json", "limit": 1})
        try:
            data = http_get_json(f"{self.URL}?{q}")
        except Exception as e:
            print(f"  ! Nominatim failed for {name!r}: {e}", file=sys.stderr)
            return None
        if not data:
            return None
        return float(data[0]["lat"]), float(data[0]["lon"])


class GoogleGeocoder:
    URL = "https://maps.googleapis.com/maps/api/geocode/json"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def geocode(self, name: str) -> Optional[tuple[float, float]]:
        q = urllib.parse.urlencode({"address": name, "key": self.api_key})
        try:
            data = http_get_json(f"{self.URL}?{q}")
        except Exception as e:
            print(f"  ! Google geocode failed for {name!r}: {e}", file=sys.stderr)
            return None
        if data.get("status") != "OK" or not data.get("results"):
            return None
        loc = data["results"][0]["geometry"]["location"]
        return loc["lat"], loc["lng"]


class FallbackGeocoder:
    def __init__(self, *geocoders):
        self.geocoders = geocoders

    def geocode(self, name: str) -> Optional[tuple[float, float]]:
        for g in self.geocoders:
            res = g.geocode(name)
            if res is not None:
                return res
        return None


# ---------------------------------------------------------------------------
# Routers (per-leg distance + duration, mode-aware)
# ---------------------------------------------------------------------------


def haversine_km(a: City, b: City) -> float:
    r = 6371.0088
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class HaversineRouter:
    """Great-circle distance scaled by mode.detour_factor; time from mode.avg_speed_kmh."""

    def route(self, mode: Mode, a: City, b: City) -> tuple[float, float]:
        distance = haversine_km(a, b) * mode.detour_factor
        time_h = distance / mode.avg_speed_kmh + mode.fixed_time_per_leg_h
        return distance, time_h


class GoogleRoutesRouter:
    """Google Distance Matrix for driving/transit; haversine fallback for flight
    and for any leg Google can't service (e.g. no transit route)."""

    URL = "https://maps.googleapis.com/maps/api/distancematrix/json"
    GOOGLE_MODE = {
        "ICE car": ("driving", None),
        "EV car":  ("driving", None),
        "Coach":   ("transit", "bus"),
        "Train":   ("transit", "rail"),
    }

    def __init__(self, api_key: str, fallback: HaversineRouter):
        self.api_key = api_key
        self.fallback = fallback

    def route(self, mode: Mode, a: City, b: City) -> tuple[float, float]:
        cfg = self.GOOGLE_MODE.get(mode.name)
        if cfg is None:
            return self.fallback.route(mode, a, b)
        g_mode, transit_mode = cfg
        params = {
            "origins": f"{a.lat},{a.lon}",
            "destinations": f"{b.lat},{b.lon}",
            "mode": g_mode,
            "key": self.api_key,
        }
        if transit_mode:
            params["transit_mode"] = transit_mode
        url = f"{self.URL}?{urllib.parse.urlencode(params)}"
        try:
            data = http_get_json(url)
            row = data["rows"][0]["elements"][0]
            if row.get("status") == "OK":
                distance = row["distance"]["value"] / 1000.0
                time_h = row["duration"]["value"] / 3600.0 + mode.fixed_time_per_leg_h
                return distance, time_h
            print(f"  ! Google Routes status={row.get('status')} for "
                  f"{mode.name} {a.name}->{b.name}; using fallback", file=sys.stderr)
        except Exception as e:
            print(f"  ! Google Routes error for {mode.name} {a.name}->{b.name}: {e}",
                  file=sys.stderr)
        return self.fallback.route(mode, a, b)


# ---------------------------------------------------------------------------
# Price providers (composable; first non-None wins, ConfigPrices is the floor)
# ---------------------------------------------------------------------------


class ConfigPrices:
    """Default per-km + per-leg from modes, plus optional overrides from JSON."""

    def __init__(self, modes: list[Mode], overrides_file: Optional[str] = None):
        self.by_name = {m.name: m for m in modes}
        if overrides_file and os.path.exists(overrides_file):
            with open(overrides_file) as f:
                overrides = json.load(f)
            for name, fields in overrides.get("modes", {}).items():
                if name in self.by_name:
                    for k, v in fields.items():
                        setattr(self.by_name[name], k, v)

    def per_km(self, mode_name: str) -> float:
        return self.by_name[mode_name].cost_per_km

    def per_leg_fixed(self, mode_name: str) -> float:
        return self.by_name[mode_name].fixed_cost_per_leg

    def leg_price(self, mode_name: str, a: City, b: City) -> Optional[float]:
        return None  # config-only: let leg cost be computed from per_km * distance


class SerpApiFlightPrices:
    """Cheapest one-way Google Flights fare via SerpAPI (https://serpapi.com).

    Requires a SerpAPI account key. Results are cached per (origin, destination,
    depart_date). Returns price in GBP when SerpAPI yields one; otherwise None
    (caller falls back to per-km defaults).
    """

    URL = "https://serpapi.com/search"

    def __init__(self, api_key: str, depart_date: str, currency: str = "GBP"):
        self.api_key = api_key
        self.depart_date = depart_date
        self.currency = currency
        self.cache: dict[tuple[str, str], Optional[float]] = {}

    def _iata_hint(self, city: City) -> str:
        # SerpAPI's google_flights engine accepts city names; we pass coordinates
        # via a "near" hint by sending the city name. Best effort.
        return city.name

    def leg_price(self, mode_name: str, a: City, b: City) -> Optional[float]:
        if mode_name != "Flight":
            return None
        key = (a.name, b.name)
        if key in self.cache:
            return self.cache[key]
        params = {
            "engine": "google_flights",
            "departure_id": self._iata_hint(a),
            "arrival_id": self._iata_hint(b),
            "outbound_date": self.depart_date,
            "type": "2",  # one-way
            "currency": self.currency,
            "api_key": self.api_key,
        }
        url = f"{self.URL}?{urllib.parse.urlencode(params)}"
        try:
            data = http_get_json(url, timeout=20)
            best = data.get("best_flights") or data.get("other_flights") or []
            price = None
            for f in best:
                if f.get("price") is not None:
                    price = float(f["price"])
                    break
            self.cache[key] = price
            return price
        except Exception as e:
            print(f"  ! SerpAPI flights {a.name}->{b.name}: {e}", file=sys.stderr)
            self.cache[key] = None
            return None


class ScrapedPerKmPrices:
    """Best-effort: refresh per-km cost for fuel-driven modes from a user-supplied
    URL + JSON path or regex. Falls back to None on any failure.

    Configure via prices.json under "scrapers":
        {
          "scrapers": {
            "ICE car": {"url": "...", "regex": "Petrol\\s*([0-9.]+)\\s*p/L", "convert": "uk_pence_per_litre_to_gbp_per_km"},
            "EV car":  {"url": "...", "regex": "Electricity\\s*([0-9.]+)\\s*p/kWh", "convert": "uk_pence_per_kwh_to_gbp_per_km"}
          }
        }
    """

    CONVERTERS = {
        # 7 L/100km @ X p/litre -> (X/100) * 0.07 GBP/km
        "uk_pence_per_litre_to_gbp_per_km": lambda x: (x / 100.0) * 0.07,
        # 0.18 kWh/km @ X p/kWh -> (X/100) * 0.18 GBP/km
        "uk_pence_per_kwh_to_gbp_per_km":  lambda x: (x / 100.0) * 0.18,
        "identity": lambda x: x,
    }

    def __init__(self, config: dict):
        self.config = config or {}
        self.cache: dict[str, Optional[float]] = {}

    def per_km(self, mode_name: str) -> Optional[float]:
        if mode_name in self.cache:
            return self.cache[mode_name]
        spec = self.config.get(mode_name)
        if not spec:
            self.cache[mode_name] = None
            return None
        try:
            import re
            text = http_get_text(spec["url"])
            m = re.search(spec["regex"], text)
            if not m:
                raise ValueError("regex did not match")
            value = float(m.group(1))
            value = self.CONVERTERS[spec.get("convert", "identity")](value)
            self.cache[mode_name] = value
            return value
        except Exception as e:
            print(f"  ! scraper for {mode_name} failed: {e}", file=sys.stderr)
            self.cache[mode_name] = None
            return None


class PriceStack:
    """Layered provider: scraped per-km overrides config; SerpAPI overrides per-leg."""

    def __init__(self, config: ConfigPrices,
                 scraped: Optional[ScrapedPerKmPrices] = None,
                 flights: Optional[SerpApiFlightPrices] = None):
        self.config = config
        self.scraped = scraped
        self.flights = flights

    def per_km(self, mode_name: str) -> float:
        if self.scraped is not None:
            v = self.scraped.per_km(mode_name)
            if v is not None:
                return v
        return self.config.per_km(mode_name)

    def per_leg_fixed(self, mode_name: str) -> float:
        return self.config.per_leg_fixed(mode_name)

    def leg_price(self, mode_name: str, a: City, b: City) -> Optional[float]:
        if self.flights is not None:
            v = self.flights.leg_price(mode_name, a, b)
            if v is not None:
                return v
        return None


# ---------------------------------------------------------------------------
# Leg cost combining router + prices
# ---------------------------------------------------------------------------


def leg_cost(mode: Mode, a: City, b: City, router, prices) -> tuple[float, float, float]:
    distance, time_h = router.route(mode, a, b)
    absolute = prices.leg_price(mode.name, a, b)
    if absolute is not None:
        cost = absolute
    else:
        cost = distance * prices.per_km(mode.name) + prices.per_leg_fixed(mode.name)
    return distance, time_h, cost


# ---------------------------------------------------------------------------
# TSP: nearest-neighbor + 2-opt over a chosen metric
# ---------------------------------------------------------------------------


def build_matrix(cities: list[City], mode: Mode, router, prices, metric: str) -> list[list[float]]:
    n = len(cities)
    m = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d, t, c = leg_cost(mode, cities[i], cities[j], router, prices)
            v = {"distance": d, "time": t, "cost": c}[metric]
            m[i][j] = m[j][i] = v
    return m


def tour_total(tour, matrix):
    return sum(matrix[tour[i]][tour[(i + 1) % len(tour)]] for i in range(len(tour)))


def nearest_neighbor(start, matrix):
    n = len(matrix)
    unvisited = set(range(n))
    unvisited.remove(start)
    tour = [start]
    while unvisited:
        last = tour[-1]
        nxt = min(unvisited, key=lambda j: matrix[last][j])
        tour.append(nxt)
        unvisited.remove(nxt)
    return tour


def two_opt(tour, matrix):
    n = len(tour)
    best = tour[:]
    improved = True
    while improved:
        improved = False
        for i in range(n - 1):
            for j in range(i + 2, n):
                if i == 0 and j == n - 1:
                    continue
                a, b = best[i], best[i + 1]
                c, d = best[j], best[(j + 1) % n]
                delta = (matrix[a][c] + matrix[b][d]) - (matrix[a][b] + matrix[c][d])
                if delta < -1e-9:
                    best[i + 1:j + 1] = reversed(best[i + 1:j + 1])
                    improved = True
    return best


def solve_tsp(matrix):
    n = len(matrix)
    best_tour, best_len = [], math.inf
    for start in range(n):
        tour = two_opt(nearest_neighbor(start, matrix), matrix)
        length = tour_total(tour, matrix)
        if length < best_len:
            best_len, best_tour = length, tour
    return best_tour


def summarise_tour(tour, cities, mode, router, prices):
    distance = time_h = cost = 0.0
    for i in range(len(tour)):
        a = cities[tour[i]]
        b = cities[tour[(i + 1) % len(tour)]]
        d, t, c = leg_cost(mode, a, b, router, prices)
        distance += d
        time_h += t
        cost += c
    return {"distance_km": distance, "time_h": time_h, "cost": cost}


# ---------------------------------------------------------------------------
# Input: interactive prompts, CLI flags, file
# ---------------------------------------------------------------------------


def resolve_city(name: str, geocoder) -> Optional[City]:
    res = geocoder.geocode(name)
    if res is None:
        return None
    return City(name, res[0], res[1])


def prompt_cities(geocoder) -> list[City]:
    print("Enter destinations one per line. Blank line to finish.")
    cities: list[City] = []
    while True:
        try:
            raw = input(f"  city #{len(cities) + 1}: ").strip()
        except EOFError:
            break
        if not raw:
            break
        city = resolve_city(raw, geocoder)
        if city is None:
            try:
                manual = input("     not found. enter 'lat,lon' or blank to skip: ").strip()
            except EOFError:
                break
            if not manual:
                continue
            try:
                lat, lon = (float(x) for x in manual.split(","))
                cities.append(City(raw, lat, lon))
            except ValueError:
                print("     bad coordinates, skipping.")
                continue
        else:
            cities.append(city)
            print(f"     -> {city.lat:.4f}, {city.lon:.4f}")
    return cities


def load_cities_file(path: str) -> list[City]:
    with open(path) as f:
        data = json.load(f)
    return [City(c["name"], float(c["lat"]), float(c["lon"])) for c in data]


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def fmt_time(hours: float) -> str:
    h = int(hours)
    m = int(round((hours - h) * 60))
    if m == 60:
        h, m = h + 1, 0
    return f"{h:>3}h {m:02d}m"


def report(cities: list[City], modes: list[Mode], router, prices, optimise_for: str) -> None:
    print(f"Cities ({len(cities)}): " + ", ".join(c.name for c in cities))
    print(f"Optimising each tour for: {optimise_for}\n")
    header = f"{'Mode':<10} {'Distance':>10} {'Time':>10} {'Cost':>10}   Tour"
    print(header)
    print("-" * len(header))
    for mode in modes:
        matrix = build_matrix(cities, mode, router, prices, optimise_for)
        tour = solve_tsp(matrix)
        s = summarise_tour(tour, cities, mode, router, prices)
        names = " -> ".join(cities[i].name for i in tour + [tour[0]])
        print(f"{mode.name:<10} {s['distance_km']:>8.0f}km {fmt_time(s['time_h']):>10} "
              f"£{s['cost']:>8.2f}   {names}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def build_geocoder(name: str, google_key: Optional[str]):
    local = LocalGazetteer()
    if name == "local":
        return local
    if name == "nominatim":
        return FallbackGeocoder(NominatimGeocoder(), local)
    if name == "google":
        if not google_key:
            print("--geocoder google needs --google-key or $GOOGLE_MAPS_API_KEY; "
                  "falling back to Nominatim.", file=sys.stderr)
            return FallbackGeocoder(NominatimGeocoder(), local)
        return FallbackGeocoder(GoogleGeocoder(google_key), NominatimGeocoder(), local)
    raise ValueError(f"unknown geocoder {name}")


def build_router(name: str, google_key: Optional[str]):
    hav = HaversineRouter()
    if name == "haversine":
        return hav
    if name == "google":
        if not google_key:
            print("--router google needs --google-key or $GOOGLE_MAPS_API_KEY; "
                  "falling back to haversine.", file=sys.stderr)
            return hav
        return GoogleRoutesRouter(google_key, hav)
    raise ValueError(f"unknown router {name}")


def build_prices(modes, prices_file, serpapi_key, depart_date, enable_scrapers):
    config = ConfigPrices(modes, overrides_file=prices_file)
    scraped = None
    if enable_scrapers and prices_file and os.path.exists(prices_file):
        with open(prices_file) as f:
            data = json.load(f)
        scraper_cfg = data.get("scrapers")
        if scraper_cfg:
            scraped = ScrapedPerKmPrices(scraper_cfg)
    flights = None
    if serpapi_key:
        if not depart_date:
            print("--serpapi-key given without --depart-date; skipping live flight prices.",
                  file=sys.stderr)
        else:
            flights = SerpApiFlightPrices(serpapi_key, depart_date)
    return PriceStack(config, scraped=scraped, flights=flights)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_argument_group("destinations")
    src.add_argument("--interactive", action="store_true", help="prompt for cities one by one")
    src.add_argument("--city", action="append", default=[], help="city name (repeatable)")
    src.add_argument("--cities-file", help="JSON file: [{name, lat, lon}, ...]")

    prov = p.add_argument_group("providers")
    prov.add_argument("--geocoder", choices=["local", "nominatim", "google"], default="local")
    prov.add_argument("--router", choices=["haversine", "google"], default="haversine")
    prov.add_argument("--prices-file", default="prices.json",
                      help="JSON config of mode overrides and scrapers")
    prov.add_argument("--enable-scrapers", action="store_true",
                      help="use scrapers from prices.json to refresh per-km costs")
    prov.add_argument("--google-key", default=os.environ.get("GOOGLE_MAPS_API_KEY"),
                      help="Google Maps API key (geocoding + distance matrix)")
    prov.add_argument("--serpapi-key", default=os.environ.get("SERPAPI_KEY"),
                      help="SerpAPI key for live Google Flights prices")
    prov.add_argument("--depart-date", help="YYYY-MM-DD for flight quotes (required with --serpapi-key)")

    p.add_argument("--optimise", choices=["distance", "time", "cost"], default="time")
    args = p.parse_args()

    geocoder = build_geocoder(args.geocoder, args.google_key)
    router = build_router(args.router, args.google_key)
    prices = build_prices(DEFAULT_MODES, args.prices_file, args.serpapi_key,
                          args.depart_date, args.enable_scrapers)

    cities: list[City] = []
    if args.cities_file:
        cities.extend(load_cities_file(args.cities_file))
    for name in args.city:
        c = resolve_city(name, geocoder)
        if c is None:
            print(f"could not geocode {name!r}", file=sys.stderr)
            sys.exit(2)
        cities.append(c)
    if args.interactive:
        cities.extend(prompt_cities(geocoder))
    if not cities:
        cities = list(DEFAULT_CITIES)

    if len(cities) < 2:
        print("need at least 2 cities", file=sys.stderr)
        sys.exit(2)

    report(cities, DEFAULT_MODES, router, prices, args.optimise)


if __name__ == "__main__":
    main()
