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
  python tsp.py --amadeus-key $AMADEUS_API_KEY --amadeus-secret $AMADEUS_API_SECRET \\
                --depart-date 2026-06-01
  python tsp.py --serpapi-key $SERPAPI_KEY --depart-date 2026-06-01
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
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


class AmadeusFlightPrices:
    """Real flight fares via Amadeus Self-Service API (free tier: 2000 calls/month).
    Sign up at developers.amadeus.com to get an API key + secret. Test endpoint is
    used by default; pass use_prod=True for production traffic.

    Resolves each City to its nearest IATA airport via Amadeus's own airport-lookup
    endpoint, then queries Flight Offers Search for the cheapest one-way fare.
    """

    TEST_BASE = "https://test.api.amadeus.com"
    PROD_BASE = "https://api.amadeus.com"

    def __init__(self, api_key: str, api_secret: str, depart_date: str,
                 currency: str = "GBP", use_prod: bool = False):
        self.api_key = api_key
        self.api_secret = api_secret
        self.depart_date = depart_date
        self.currency = currency
        self.base = self.PROD_BASE if use_prod else self.TEST_BASE
        self.token: Optional[str] = None
        self.token_expires_at: float = 0
        self.airport_cache: dict[tuple[float, float], Optional[str]] = {}
        self.price_cache: dict[tuple[str, str], Optional[float]] = {}

    def _get_token(self) -> Optional[str]:
        if self.token and time.time() < self.token_expires_at - 30:
            return self.token
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": self.api_key,
            "client_secret": self.api_secret,
        }).encode()
        req = urllib.request.Request(
            f"{self.base}/v1/security/oauth2/token",
            data=body, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "User-Agent": "tsp-tool/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                payload = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print(f"  ! Amadeus auth failed: {e}", file=sys.stderr)
            return None
        self.token = payload["access_token"]
        self.token_expires_at = time.time() + payload.get("expires_in", 1799)
        return self.token

    def _nearest_airport(self, city: City) -> Optional[str]:
        key = (round(city.lat, 3), round(city.lon, 3))
        if key in self.airport_cache:
            return self.airport_cache[key]
        token = self._get_token()
        if not token:
            self.airport_cache[key] = None
            return None
        params = urllib.parse.urlencode({
            "latitude": f"{city.lat:.4f}",
            "longitude": f"{city.lon:.4f}",
            "radius": "200",
            "page[limit]": "1",
            "sort": "relevance",
        })
        try:
            data = http_get_json(
                f"{self.base}/v1/reference-data/locations/airports?{params}",
                headers={"Authorization": f"Bearer {token}",
                         "User-Agent": "tsp-tool/1.0"},
            )
            results = data.get("data") or []
            iata = results[0]["iataCode"] if results else None
        except Exception as e:
            print(f"  ! Amadeus airport lookup for {city.name}: {e}", file=sys.stderr)
            iata = None
        self.airport_cache[key] = iata
        return iata

    def leg_price(self, mode_name: str, a: City, b: City) -> Optional[float]:
        if mode_name != "Flight":
            return None
        cache_key = (a.name, b.name)
        if cache_key in self.price_cache:
            return self.price_cache[cache_key]
        orig = self._nearest_airport(a)
        dest = self._nearest_airport(b)
        if not orig or not dest or orig == dest:
            self.price_cache[cache_key] = None
            return None
        token = self._get_token()
        if not token:
            self.price_cache[cache_key] = None
            return None
        params = urllib.parse.urlencode({
            "originLocationCode": orig,
            "destinationLocationCode": dest,
            "departureDate": self.depart_date,
            "adults": "1",
            "currencyCode": self.currency,
            "max": "1",
            "nonStop": "false",
        })
        try:
            data = http_get_json(
                f"{self.base}/v2/shopping/flight-offers?{params}",
                headers={"Authorization": f"Bearer {token}",
                         "User-Agent": "tsp-tool/1.0"},
                timeout=20,
            )
            offers = data.get("data") or []
            price = float(offers[0]["price"]["grandTotal"]) if offers else None
        except Exception as e:
            print(f"  ! Amadeus flight search {orig}->{dest}: {e}", file=sys.stderr)
            price = None
        self.price_cache[cache_key] = price
        return price


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
    """Layered provider: scraped per-km overrides config; the first flight provider
    to return a non-None price wins for per-leg flight cost."""

    def __init__(self, config: ConfigPrices,
                 scraped: Optional[ScrapedPerKmPrices] = None,
                 flights: Optional[list] = None):
        self.config = config
        self.scraped = scraped
        self.flights = flights or []

    def per_km(self, mode_name: str) -> float:
        if self.scraped is not None:
            v = self.scraped.per_km(mode_name)
            if v is not None:
                return v
        return self.config.per_km(mode_name)

    def per_leg_fixed(self, mode_name: str) -> float:
        return self.config.per_leg_fixed(mode_name)

    def leg_price(self, mode_name: str, a: City, b: City) -> Optional[float]:
        for provider in self.flights:
            v = provider.leg_price(mode_name, a, b)
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
# Scheduling: turn an ordered tour into a dated itinerary and check feasibility
# ---------------------------------------------------------------------------


@dataclass
class ScheduleOpts:
    """User-supplied scheduling constraints."""
    start_date: Optional[date] = None
    days_per_city: int = 1
    stays: dict = field(default_factory=dict)   # city name -> int days
    pins: dict = field(default_factory=dict)    # city name -> date
    max_days: Optional[int] = None
    start_city: Optional[str] = None            # name; defaults to first city
    end_city: Optional[str] = None              # None or == start_city => closed loop


@dataclass
class Schedule:
    feasible: bool
    distance_km: float = 0.0
    travel_h: float = 0.0
    cost: float = 0.0
    total_days: int = 0
    stops: list = field(default_factory=list)   # [(name, arrive_date|None, depart_date|None)]
    reason: Optional[str] = None


def _stay_days(opts: ScheduleOpts, name: str) -> int:
    return int(opts.stays.get(name, opts.days_per_city))


def compute_schedule(tour: list, cities: list, mode: Mode,
                     router, prices, opts: ScheduleOpts) -> Schedule:
    is_cycle = (opts.end_city is None) or (opts.end_city == opts.start_city) or (opts.end_city == cities[tour[0]].name)

    distance = travel_h = cost = 0.0
    elapsed_h = 0.0
    stops: list = []

    for i, idx in enumerate(tour):
        c = cities[idx]
        arrive_h = elapsed_h
        stay_h = _stay_days(opts, c.name) * 24
        depart_h = arrive_h + stay_h

        if opts.start_date is not None:
            arrive_d = opts.start_date + timedelta(days=int(arrive_h // 24))
            last_inclusive = depart_h - 1e-9 if stay_h > 0 else arrive_h
            depart_d = opts.start_date + timedelta(days=int(last_inclusive // 24))
        else:
            arrive_d = depart_d = None
        stops.append((c.name, arrive_d, depart_d))

        elapsed_h = depart_h
        if i + 1 < len(tour):
            nxt = cities[tour[i + 1]]
            d, t, k = leg_cost(mode, c, nxt, router, prices)
            distance += d; travel_h += t; cost += k
            elapsed_h += t

    if is_cycle and len(tour) > 1:
        first, last = cities[tour[0]], cities[tour[-1]]
        d, t, k = leg_cost(mode, last, first, router, prices)
        distance += d; travel_h += t; cost += k
        elapsed_h += t

    total_days = max(1, math.ceil(elapsed_h / 24))

    reason = None
    if opts.max_days is not None and total_days > opts.max_days:
        reason = f"trip is {total_days}d, exceeds max {opts.max_days}d"
    elif opts.pins and opts.start_date is None:
        reason = "pins set but no --start-date given"
    elif opts.pins:
        by_name = {name: (arr, dep) for name, arr, dep in stops}
        for pin_name, pin_date in opts.pins.items():
            if pin_name not in by_name:
                reason = f"pinned city {pin_name!r} not in tour"; break
            arr, dep = by_name[pin_name]
            if not (arr <= pin_date <= dep):
                reason = (f"{pin_name} window {arr.isoformat()}..{dep.isoformat()} "
                          f"misses pinned {pin_date.isoformat()}")
                break

    return Schedule(
        feasible=(reason is None),
        distance_km=distance, travel_h=travel_h, cost=cost,
        total_days=total_days, stops=stops, reason=reason,
    )


def _objective(schedule: Schedule, name: str) -> float:
    return {"distance": schedule.distance_km, "time": schedule.travel_h,
            "cost": schedule.cost}[name]


def constrained_search(cities: list, mode: Mode, router, prices,
                       opts: ScheduleOpts, objective: str):
    """Return (best_tour, best_schedule) or (None, reason_string)."""
    n = len(cities)
    name_to_idx = {c.name: i for i, c in enumerate(cities)}
    start_idx = name_to_idx.get(opts.start_city, 0)
    is_open_path = bool(opts.end_city) and opts.end_city != cities[start_idx].name
    end_idx = name_to_idx.get(opts.end_city) if is_open_path else None
    middle = [i for i in range(n) if i != start_idx and i != end_idx]

    def assemble(perm: list) -> list:
        return [start_idx] + list(perm) + ([end_idx] if is_open_path else [])

    def score(perm):
        return compute_schedule(assemble(perm), cities, mode, router, prices, opts)

    last_reason = "no feasible tour found"
    best_perm = None
    best_sched: Optional[Schedule] = None

    def consider(perm, sched):
        nonlocal best_perm, best_sched, last_reason
        if not sched.feasible:
            last_reason = sched.reason or last_reason
            return
        if best_sched is None or _objective(sched, objective) < _objective(best_sched, objective):
            best_perm = list(perm)
            best_sched = sched

    if len(middle) <= 8:
        for perm in itertools.permutations(middle):
            consider(perm, score(perm))
    else:
        def nn_seed(seed_start):
            unv = set(middle)
            seq = []
            last = seed_start
            while unv:
                key = {"distance": 0, "time": 1, "cost": 2}[objective]
                nxt = min(unv, key=lambda j: leg_cost(mode, cities[last], cities[j], router, prices)[key])
                seq.append(nxt); unv.remove(nxt); last = nxt
            return seq

        def two_opt(perm):
            cur = perm[:]
            cur_sched = score(cur)
            cur_val = _objective(cur_sched, objective) if cur_sched.feasible else math.inf
            improved = True
            while improved:
                improved = False
                for i in range(len(cur) - 1):
                    for j in range(i + 1, len(cur)):
                        cand = cur[:i] + cur[i:j + 1][::-1] + cur[j + 1:]
                        cand_sched = score(cand)
                        if not cand_sched.feasible:
                            continue
                        v = _objective(cand_sched, objective)
                        if v + 1e-9 < cur_val:
                            cur, cur_sched, cur_val = cand, cand_sched, v
                            improved = True
            return cur, cur_sched

        seeds = [nn_seed(start_idx)]
        rng = random.Random(0)
        seeds.extend(rng.sample(middle, len(middle)) for _ in range(8))
        for seed in seeds:
            perm, sched = two_opt(seed)
            consider(perm, sched)

    if best_perm is None:
        return None, last_reason
    return assemble(best_perm), best_sched


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


def _fmt_stop(name: str, arrive: Optional[date], depart: Optional[date]) -> str:
    if arrive is None:
        return name
    if arrive == depart:
        return f"{name}({arrive.strftime('%b%d')})"
    return f"{name}({arrive.strftime('%b%d')}-{depart.strftime('%b%d')})"


def report(cities: list[City], modes: list[Mode], router, prices,
           optimise_for: str, opts: ScheduleOpts) -> None:
    is_open_path = bool(opts.end_city) and opts.end_city != (opts.start_city or cities[0].name)
    print(f"Cities ({len(cities)}): " + ", ".join(c.name for c in cities))
    print(f"Start: {opts.start_city or cities[0].name}"
          + (f"   End: {opts.end_city}" if is_open_path else "   (closed loop)")
          + (f"   Start date: {opts.start_date.isoformat()}" if opts.start_date else "")
          + (f"   Max days: {opts.max_days}" if opts.max_days else ""))
    if opts.pins:
        print("Pins: " + ", ".join(f"{n}@{d.isoformat()}" for n, d in opts.pins.items()))
    print(f"Optimising each tour for: {optimise_for}\n")
    header = f"{'Mode':<10} {'Distance':>10} {'Travel':>10} {'Cost':>10} {'Days':>6}   Itinerary"
    print(header)
    print("-" * len(header))
    for mode in modes:
        tour, result = constrained_search(cities, mode, router, prices, opts, optimise_for)
        if tour is None:
            print(f"{mode.name:<10} {'-':>10} {'-':>10} {'-':>10} {'-':>6}   infeasible: {result}")
            continue
        sched: Schedule = result
        names = " -> ".join(_fmt_stop(*s) for s in sched.stops)
        if not is_open_path:
            names += f" -> {sched.stops[0][0]}"
        print(f"{mode.name:<10} {sched.distance_km:>8.0f}km {fmt_time(sched.travel_h):>10} "
              f"£{sched.cost:>8.2f} {sched.total_days:>5}d   {names}")


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


def build_prices(modes, prices_file, *, serpapi_key=None, amadeus_key=None,
                 amadeus_secret=None, amadeus_prod=False, depart_date=None,
                 enable_scrapers=False):
    config = ConfigPrices(modes, overrides_file=prices_file)
    scraped = None
    if enable_scrapers and prices_file and os.path.exists(prices_file):
        with open(prices_file) as f:
            data = json.load(f)
        scraper_cfg = data.get("scrapers")
        if scraper_cfg:
            scraped = ScrapedPerKmPrices(scraper_cfg)
    flights: list = []
    needs_date = amadeus_key or serpapi_key
    if needs_date and not depart_date:
        print("flight API keys given without --depart-date; skipping live flight prices.",
              file=sys.stderr)
    else:
        if amadeus_key and amadeus_secret and depart_date:
            flights.append(AmadeusFlightPrices(amadeus_key, amadeus_secret, depart_date,
                                               use_prod=amadeus_prod))
        elif amadeus_key and not amadeus_secret:
            print("--amadeus-key given without --amadeus-secret; skipping Amadeus.",
                  file=sys.stderr)
        if serpapi_key and depart_date:
            flights.append(SerpApiFlightPrices(serpapi_key, depart_date))
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
    prov.add_argument("--amadeus-key", default=os.environ.get("AMADEUS_API_KEY"),
                      help="Amadeus Self-Service API key (recommended; free tier)")
    prov.add_argument("--amadeus-secret", default=os.environ.get("AMADEUS_API_SECRET"),
                      help="Amadeus Self-Service API secret")
    prov.add_argument("--amadeus-prod", action="store_true",
                      help="use Amadeus production endpoint instead of test")
    prov.add_argument("--depart-date", help="YYYY-MM-DD for flight quotes (required with flight API keys)")

    sched = p.add_argument_group("schedule")
    sched.add_argument("--start", dest="start_city", help="city to start from (default: first city)")
    sched.add_argument("--end", dest="end_city",
                       help="city to end at (default: same as start = closed loop)")
    sched.add_argument("--start-date", dest="start_date",
                       help="YYYY-MM-DD; first day of the trip (needed for pins and itinerary dates)")
    sched.add_argument("--max-days", type=int, help="reject tours longer than this many days")
    sched.add_argument("--days-per-city", type=int, default=1, help="default stay per city (days)")
    sched.add_argument("--stay", action="append", default=[],
                       metavar="CITY=DAYS",
                       help="override stay for a specific city (repeatable)")
    sched.add_argument("--pin", action="append", default=[],
                       metavar="CITY=YYYY-MM-DD",
                       help="require being in CITY on the given date (repeatable)")

    p.add_argument("--optimise", choices=["distance", "time", "cost"], default="time")
    args = p.parse_args()

    geocoder = build_geocoder(args.geocoder, args.google_key)
    router = build_router(args.router, args.google_key)
    prices = build_prices(
        DEFAULT_MODES, args.prices_file,
        serpapi_key=args.serpapi_key,
        amadeus_key=args.amadeus_key,
        amadeus_secret=args.amadeus_secret,
        amadeus_prod=args.amadeus_prod,
        depart_date=args.depart_date,
        enable_scrapers=args.enable_scrapers,
    )

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

    stays: dict = {}
    for spec in args.stay:
        if "=" not in spec:
            print(f"--stay expects CITY=DAYS, got {spec!r}", file=sys.stderr); sys.exit(2)
        name, days = spec.split("=", 1)
        stays[name.strip()] = int(days)

    pins: dict = {}
    for spec in args.pin:
        if "=" not in spec:
            print(f"--pin expects CITY=YYYY-MM-DD, got {spec!r}", file=sys.stderr); sys.exit(2)
        name, d = spec.split("=", 1)
        pins[name.strip()] = datetime.strptime(d.strip(), "%Y-%m-%d").date()

    start_date = (datetime.strptime(args.start_date, "%Y-%m-%d").date()
                  if args.start_date else None)

    city_names = {c.name for c in cities}
    if args.start_city and args.start_city not in city_names:
        print(f"--start {args.start_city!r} not in cities", file=sys.stderr); sys.exit(2)
    if args.end_city and args.end_city not in city_names:
        print(f"--end {args.end_city!r} not in cities", file=sys.stderr); sys.exit(2)
    for n in list(stays) + list(pins):
        if n not in city_names:
            print(f"--stay/--pin city {n!r} not in cities", file=sys.stderr); sys.exit(2)

    if args.start_city:
        cities = [next(c for c in cities if c.name == args.start_city)] + \
                 [c for c in cities if c.name != args.start_city]

    opts = ScheduleOpts(
        start_date=start_date,
        days_per_city=args.days_per_city,
        stays=stays,
        pins=pins,
        max_days=args.max_days,
        start_city=args.start_city or cities[0].name,
        end_city=args.end_city,
    )

    report(cities, DEFAULT_MODES, router, prices, args.optimise, opts)


if __name__ == "__main__":
    main()
