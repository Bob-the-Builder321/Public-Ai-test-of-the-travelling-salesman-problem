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
    terminal_access_h: float = 0.0
    boarding_wait_h: float = 0.0
    terminal_egress_h: float = 0.0
    fixed_cost_per_leg: float = 0.0

    @property
    def fixed_time_per_leg_h(self) -> float:
        return self.terminal_access_h + self.boarding_wait_h + self.terminal_egress_h

    @fixed_time_per_leg_h.setter
    def fixed_time_per_leg_h(self, value: float) -> None:
        self.terminal_access_h = 0.0
        self.terminal_egress_h = 0.0
        self.boarding_wait_h = float(value)


DEFAULT_MODES: list[Mode] = [
    # ICE/EV cars: door-to-door, no terminal overhead.
    Mode("ICE car",     1.30,  90, 0.15, 0.00, 0.00, 0.00, 0.0),
    Mode("EV car",      1.30,  90, 0.05, 0.00, 0.00, 0.00, 0.0),
    # Coach/Train: 15 min to station, 15 min wait, 15 min from station.
    Mode("Coach",       1.35,  65, 0.04, 0.25, 0.25, 0.25, 1.0),
    Mode("Train",       1.20, 120, 0.12, 0.25, 0.25, 0.25, 2.0),
    # Night train: 30 min board (luggage + sleeper).
    Mode("Night train", 1.20,  80, 0.10, 0.25, 0.50, 0.25, 30.0),
    # Flight: 45 min to/from airport, 2h security + boarding wait.
    Mode("Flight",      1.00, 700, 0.20, 0.75, 2.00, 0.75, 30.0),
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
# Currency
# ---------------------------------------------------------------------------


CURRENCY_SYMBOLS = {
    "GBP": "£", "EUR": "€", "USD": "$", "CAD": "C$", "AUD": "A$",
    "NZD": "NZ$", "JPY": "¥", "CNY": "¥", "INR": "₹", "CHF": "CHF",
    "SEK": "kr", "NOK": "kr", "DKK": "kr", "PLN": "zł", "CZK": "Kč",
    "HUF": "Ft",
}


def currency_symbol(code: str) -> str:
    return CURRENCY_SYMBOLS.get(code.upper(), code.upper() + " ")


# ---------------------------------------------------------------------------
# Disk cache + caching wrappers (reduces repeated API calls)
# ---------------------------------------------------------------------------


class JsonCache:
    def __init__(self, path: Optional[str] = None, ttl_seconds: int = 86400,
                 enabled: bool = True):
        self.path = path or os.path.join(os.path.expanduser("~"), ".tsp-tool-cache.json")
        self.ttl = ttl_seconds
        self.enabled = enabled
        self.data: dict = {}
        if enabled:
            try:
                with open(self.path) as f:
                    self.data = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                self.data = {}
            except Exception as e:
                print(f"cache load failed: {e}", file=sys.stderr)

    def get(self, key: str):
        if not self.enabled:
            return None
        entry = self.data.get(key)
        if not entry:
            return None
        if time.time() - entry.get("ts", 0) > self.ttl:
            return None
        return entry.get("v")

    def set(self, key: str, value) -> None:
        if not self.enabled:
            return
        self.data[key] = {"ts": time.time(), "v": value}
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.path)
        except Exception as e:
            print(f"cache save failed: {e}", file=sys.stderr)


class CachedGeocoder:
    """Wrap any geocoder with a disk cache keyed on (provider type, normalized name)."""
    def __init__(self, inner, cache: JsonCache):
        self.inner = inner
        self.cache = cache

    def geocode(self, name: str):
        key = f"geo:{type(self.inner).__name__}:{name.strip().lower()}"
        v = self.cache.get(key)
        if v is not None:
            return tuple(v) if v else None
        r = self.inner.geocode(name)
        self.cache.set(key, list(r) if r else [])
        return r


class CachedRouter:
    """Wrap any router with a disk cache keyed on (provider type, mode, endpoints)."""
    def __init__(self, inner, cache: JsonCache):
        self.inner = inner
        self.cache = cache

    def route(self, mode, a, b):
        key = (f"route:{type(self.inner).__name__}:{mode.name}:"
               f"{a.lat:.4f},{a.lon:.4f}->{b.lat:.4f},{b.lon:.4f}")
        v = self.cache.get(key)
        if v is not None:
            return tuple(v)
        r = self.inner.route(mode, a, b)
        self.cache.set(key, list(r))
        return r


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
        "brussels":   (50.8503,  4.3517),
        "vienna":     (48.2082, 16.3738),
        "munich":     (48.1351, 11.5820),
        "zurich":     (47.3769,  8.5417),
        "milan":      (45.4642,  9.1900),
        "barcelona":  (41.3851,  2.1734),
        "prague":     (50.0755, 14.4378),
        "copenhagen": (55.6761, 12.5683),
        "stockholm":  (59.3293, 18.0686),
        "oslo":       (59.9139, 10.7522),
        "lisbon":     (38.7223, -9.1393),
        "warsaw":     (52.2297, 21.0122),
        "budapest":   (47.4979, 19.0402),
        "athens":     (37.9838, 23.7275),
        "istanbul":   (41.0082, 28.9784),
        "sofia":      (42.6977, 23.3219),
        "belgrade":   (44.7866, 20.4489),
        "bucharest":  (44.4268, 26.1025),
        "zagreb":     (45.8150, 15.9819),
        "ljubljana":  (46.0569, 14.5058),
        "bratislava": (48.1486, 17.1077),
        "tallinn":    (59.4370, 24.7536),
        "riga":       (56.9496, 24.1052),
        "vilnius":    (54.6872, 25.2797),
        "luxembourg": (49.6116,  6.1319),
        "reykjavik":  (64.1466, -21.9426),
        "moscow":     (55.7558, 37.6173),
        "tirana":     (41.3275, 19.8189),
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

    def __init__(self, api_key: str, depart_date: str, currency: str = "GBP",
                 cache: Optional[JsonCache] = None):
        self.api_key = api_key
        self.depart_date = depart_date
        self.currency = currency
        self.cache_mem: dict[tuple[str, str], Optional[float]] = {}
        self.disk_cache = cache

    def _iata_hint(self, city: City) -> str:
        # SerpAPI's google_flights engine accepts city names; we pass coordinates
        # via a "near" hint by sending the city name. Best effort.
        return city.name

    def leg_price(self, mode_name: str, a: City, b: City) -> Optional[float]:
        if mode_name != "Flight":
            return None
        key = (a.name, b.name)
        if key in self.cache_mem:
            return self.cache_mem[key]
        disk_key = f"serpapi:{self.currency}:{self.depart_date}:{a.name}->{b.name}"
        if self.disk_cache:
            v = self.disk_cache.get(disk_key)
            if v is not None:
                self.cache_mem[key] = v if v != "" else None
                return self.cache_mem[key]
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
        except Exception as e:
            print(f"  ! SerpAPI flights {a.name}->{b.name}: {e}", file=sys.stderr)
            price = None
        self.cache_mem[key] = price
        if self.disk_cache:
            self.disk_cache.set(disk_key, price if price is not None else "")
        return price


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
                 currency: str = "GBP", use_prod: bool = False,
                 cache: Optional[JsonCache] = None):
        self.api_key = api_key
        self.api_secret = api_secret
        self.depart_date = depart_date
        self.currency = currency
        self.base = self.PROD_BASE if use_prod else self.TEST_BASE
        self.token: Optional[str] = None
        self.token_expires_at: float = 0
        self.airport_cache: dict[tuple[float, float], Optional[str]] = {}
        self.price_cache: dict[tuple[str, str], Optional[float]] = {}
        self.disk_cache = cache

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
        disk_key = f"amadeus_airport:{key[0]},{key[1]}"
        if self.disk_cache:
            v = self.disk_cache.get(disk_key)
            if v is not None:
                self.airport_cache[key] = v if v else None
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
        if self.disk_cache:
            self.disk_cache.set(disk_key, iata or "")
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
        disk_key = f"amadeus_price:{self.currency}:{self.depart_date}:{orig}->{dest}"
        if self.disk_cache:
            v = self.disk_cache.get(disk_key)
            if v is not None:
                self.price_cache[cache_key] = v if v != "" else None
                return self.price_cache[cache_key]
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
        if self.disk_cache:
            self.disk_cache.set(disk_key, price if price is not None else "")
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


def leg_cost(mode: Mode, a: City, b: City, router, prices,
             policy: Optional["TrainPolicy"] = None,
             reservations: Optional["ReservationLookup"] = None,
             currency: str = "EUR") -> tuple[float, float, float]:
    distance, time_h = router.route(mode, a, b)
    absolute = prices.leg_price(mode.name, a, b)
    if absolute is not None:
        return distance, time_h, absolute
    # Default cost: per_km * distance + flat per-leg overhead.
    cost = distance * prices.per_km(mode.name) + prices.per_leg_fixed(mode.name)
    # For Train/Night-train under an active pass, replace the flat overhead
    # with the actual reservation/sleeper fee from the curated dataset.
    if (policy and policy.interrail_pass and reservations and reservations.loaded()
            and mode.name in ("Train", "Night train")):
        cost = distance * prices.per_km(mode.name)  # likely 0 under pass pricing
        if mode.name == "Train":
            info = reservations.day_train(a, b, currency=currency)
            cost += info["fee"]
        else:  # Night train
            info = reservations.night_train(a, b, currency=currency, tier="couchette")
            cost += info["fee"]
    return distance, time_h, cost


# ---------------------------------------------------------------------------
# Train policy: Interrail pass, Eurostar opt-out, reservations, night trains
# ---------------------------------------------------------------------------


@dataclass
class TrainPolicy:
    interrail_pass: bool = True
    exclude_eurostar: bool = False
    seat_reservations_ok: bool = True
    night_trains: str = "exclude"   # "include" | "exclude" | "only"
    reservation_fee_gbp: float = 5.0
    sleeper_supplement_gbp: float = 30.0
    reservation_required_min_km: float = 300.0
    night_train_min_km: float = 500.0
    reservations_file: Optional[str] = None     # path to interrail-reservations.json


def crosses_channel(a: City, b: City) -> bool:
    """True iff one endpoint is on the British Isles and the other isn't."""
    def on_isles(c: City) -> bool:
        return 49.5 <= c.lat <= 61.0 and -10.5 <= c.lon <= 2.0
    return on_isles(a) != on_isles(b)


class ReservationLookup:
    """Loads the curated Eurail reservation table and answers per-leg queries.

    For a Train/Night-train leg between two cities the lookup figures out the
    country of each endpoint, finds the matching domestic/international/night
    entry, and returns the fee (in EUR) plus metadata (operator, mandatory?,
    channel_crossing?). Unknown pairs fall back to the JSON's defaults.
    """

    def __init__(self, path: Optional[str] = None):
        self.data = {}
        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    self.data = json.load(f)
            except Exception as e:
                print(f"could not load reservations file: {e}", file=sys.stderr)
        self.city_country = self.data.get("city_country", {})
        self.domestic = self.data.get("domestic", {})
        self.international = self.data.get("international", [])
        self.night_trains = self.data.get("night_trains", [])
        self.defaults = self.data.get("defaults", {})
        self.fx = self.data.get("fx", {"EUR": 1.0})
        self.pass_prices = self.data.get("pass_prices", {})
        self.included_countries = set(self.data.get("included_countries", []))

    def loaded(self) -> bool:
        return bool(self.data)

    def country_of(self, city: City) -> Optional[str]:
        return self.city_country.get(city.name)

    def is_country_included(self, code: Optional[str]) -> bool:
        """True iff the country is in the Interrail Global Pass area.
        When we don't know the country (None), default to True so unknown
        cities don't get spuriously rejected; users can extend city_country
        in the JSON to enforce strictly."""
        if not self.included_countries:
            return True
        if code is None:
            return True
        return code in self.included_countries

    def _eur_to(self, eur: float, currency: str) -> float:
        rate = self.fx.get(currency.upper(), self.fx.get("EUR", 1.0))
        return eur * (rate / self.fx.get("EUR", 1.0))

    def day_train(self, a: City, b: City, currency: str = "EUR") -> dict:
        """Return {'fee', 'operator', 'mandatory', 'channel_crossing'} for a day train leg."""
        ca, cb = self.country_of(a), self.country_of(b)
        if ca is None or cb is None:
            return {"fee": self._eur_to(self.defaults.get("unknown_day_fee_eur", 5), currency),
                    "operator": "(unknown)", "mandatory": False, "channel_crossing": False}
        if ca == cb:
            dom = self.domestic.get(ca)
            if dom:
                return {"fee": self._eur_to(dom.get("fee_eur", 0), currency),
                        "operator": dom.get("operator", ""),
                        "mandatory": dom.get("mandatory", False),
                        "channel_crossing": False}
            return {"fee": 0, "operator": "", "mandatory": False, "channel_crossing": False}
        for entry in self.international:
            pair = entry.get("pair", [])
            if set(pair) == {ca, cb}:
                return {"fee": self._eur_to(entry.get("fee_eur", 0), currency),
                        "operator": entry.get("operator", ""),
                        "mandatory": entry.get("mandatory", True),
                        "channel_crossing": bool(entry.get("channel_crossing"))}
        return {"fee": self._eur_to(self.defaults.get("unknown_day_fee_eur", 5), currency),
                "operator": "(unknown international)", "mandatory": False,
                "channel_crossing": crosses_channel(a, b)}

    def pick_pass(self, rail_days: int, trip_days: int, currency: str = "EUR",
                  tier: str = "global_pass_adult_first") -> Optional[dict]:
        """Cheapest Interrail pass that covers the trip. Returns None if nothing fits.
        rail_days = distinct days with train travel; trip_days = total trip length.
        """
        prices = self.pass_prices.get(tier, {})
        best = None
        for f in prices.get("flexi", []):
            if rail_days <= f["travel_days"] and trip_days <= f["within_days"]:
                price = self._eur_to(f["price_eur"], currency)
                if best is None or price < best["price"]:
                    best = {"price": price, "price_eur": f["price_eur"],
                            "kind": "flexi",
                            "label": f"{f['travel_days']}d flexi / {f['within_days']}d window"}
        for c in prices.get("continuous", []):
            if trip_days <= c["duration_days"]:
                price = self._eur_to(c["price_eur"], currency)
                if best is None or price < best["price"]:
                    best = {"price": price, "price_eur": c["price_eur"],
                            "kind": "continuous",
                            "label": f"{c['duration_days']}d continuous"}
        return best

    def night_train(self, a: City, b: City, currency: str = "EUR",
                    tier: str = "couchette") -> dict:
        ca, cb = self.country_of(a), self.country_of(b)
        key = f"{tier}_eur"
        if ca and cb:
            for entry in self.night_trains:
                for pair in entry.get("pairs", []):
                    if set(pair) == {ca, cb} or (ca == cb and pair == [ca, ca]):
                        return {"fee": self._eur_to(entry.get(key, 0), currency),
                                "operator": entry.get("operator", ""),
                                "mandatory": entry.get("mandatory", True),
                                "channel_crossing": False}
        return {"fee": self._eur_to(self.defaults.get("unknown_night_supplement_eur", 30), currency),
                "operator": "(unknown night train)", "mandatory": False,
                "channel_crossing": crosses_channel(a, b)}


def filter_train_modes(modes: list[Mode], policy: TrainPolicy) -> list[Mode]:
    """Drop Train when only night trains are wanted, drop Night train when excluded."""
    out: list[Mode] = []
    for m in modes:
        if m.name == "Train" and policy.night_trains == "only":
            continue
        if m.name == "Night train" and policy.night_trains == "exclude":
            continue
        out.append(m)
    return out


def apply_pass_pricing(prices, policy: TrainPolicy) -> None:
    """Zero the per-km train fares when an Interrail pass is active. Per-leg
    reservation / sleeper fees come from ReservationLookup at leg_cost time, so
    we no longer hard-code them here."""
    if not policy.interrail_pass:
        return
    config = prices.config
    if "Train" in config.by_name:
        config.by_name["Train"].cost_per_km = 0.0
        config.by_name["Train"].fixed_cost_per_leg = 0.0
    if "Night train" in config.by_name:
        config.by_name["Night train"].cost_per_km = 0.0
        config.by_name["Night train"].fixed_cost_per_leg = 0.0


def leg_feasible(mode: Mode, a: City, b: City, policy: TrainPolicy,
                 reservations: Optional[ReservationLookup] = None) -> Optional[str]:
    """Return None if the leg is allowed, else a short reason string."""
    if mode.name not in ("Train", "Night train"):
        return None
    # Interrail Global Pass area enforcement: when the pass is active, both
    # endpoints must be in one of the 33 included countries.
    if policy.interrail_pass and reservations and reservations.loaded():
        ca = reservations.country_of(a)
        cb = reservations.country_of(b)
        if ca is not None and not reservations.is_country_included(ca):
            return f"{mode.name}: {a.name} ({ca}) not in Interrail Global Pass area"
        if cb is not None and not reservations.is_country_included(cb):
            return f"{mode.name}: {b.name} ({cb}) not in Interrail Global Pass area"
    # Eurostar opt-out — prefer the JSON's channel_crossing flag when available,
    # fall back to the lat/lon heuristic for unknown cities.
    channel = False
    if reservations and reservations.loaded():
        info = reservations.day_train(a, b)
        channel = info.get("channel_crossing", False)
    else:
        channel = crosses_channel(a, b)
    if policy.exclude_eurostar and channel:
        return f"{mode.name}: Eurostar (channel crossing) excluded"
    if mode.name == "Train" and not policy.seat_reservations_ok:
        # Prefer JSON's mandatory flag; fall back to distance heuristic.
        if reservations and reservations.loaded():
            info = reservations.day_train(a, b)
            if info.get("mandatory"):
                return (f"Train: {a.name}->{b.name} on {info.get('operator', '')} "
                        f"needs reservation (--no-reservations set)")
        else:
            distance = haversine_km(a, b) * mode.detour_factor
            if distance >= policy.reservation_required_min_km:
                return f"Train: {distance:.0f}km leg likely needs reservation (--no-reservations set)"
    if mode.name == "Night train":
        distance = haversine_km(a, b) * mode.detour_factor
        if distance < policy.night_train_min_km:
            return f"Night train: {distance:.0f}km leg shorter than {policy.night_train_min_km:.0f}km minimum"
    return None


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
    pass_cost: float = 0.0                       # added to cost when an Interrail pass is bought
    pass_label: Optional[str] = None             # e.g. "7d flexi / 30d window"


def _stay_days(opts: ScheduleOpts, name: str) -> int:
    return int(opts.stays.get(name, opts.days_per_city))


def compute_schedule(tour: list, cities: list, mode: Mode,
                     router, prices, opts: ScheduleOpts,
                     policy: Optional[TrainPolicy] = None,
                     reservations: Optional[ReservationLookup] = None,
                     currency: str = "EUR") -> Schedule:
    is_cycle = (opts.end_city is None) or (opts.end_city == opts.start_city) or (opts.end_city == cities[tour[0]].name)
    policy = policy or TrainPolicy()

    distance = travel_h = cost = 0.0
    elapsed_h = 0.0
    stops: list = []
    fail_reason: Optional[str] = None

    def check_leg(a: City, b: City) -> Optional[str]:
        return leg_feasible(mode, a, b, policy, reservations)

    def leg_call(a: City, b: City):
        return leg_cost(mode, a, b, router, prices, policy, reservations, currency)

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
            if fail_reason is None:
                fail_reason = check_leg(c, nxt)
            d, t, k = leg_call(c, nxt)
            distance += d; travel_h += t; cost += k
            elapsed_h += t

    if is_cycle and len(tour) > 1:
        first, last = cities[tour[0]], cities[tour[-1]]
        if fail_reason is None:
            fail_reason = check_leg(last, first)
        d, t, k = leg_call(last, first)
        distance += d; travel_h += t; cost += k
        elapsed_h += t

    total_days = max(1, math.ceil(elapsed_h / 24))

    # Interrail pass cost: pick the cheapest Global Pass covering rail-days + trip-days.
    # rail_days = number of train legs (approximation: at most one rail journey per day).
    pass_cost = 0.0
    pass_label: Optional[str] = None
    if (policy and policy.interrail_pass and reservations and reservations.loaded()
            and mode.name in ("Train", "Night train")):
        rail_days = len(tour) if is_cycle else max(1, len(tour) - 1)
        pick = reservations.pick_pass(rail_days, total_days, currency)
        if pick:
            pass_cost = pick["price"]
            pass_label = f"{pick['label']} ({pick['price_eur']:.0f}€)"
        else:
            pass_label = f"no Global Pass covers {rail_days}d rail / {total_days}d trip"

    reason = fail_reason
    if reason is None and opts.max_days is not None and total_days > opts.max_days:
        reason = f"trip is {total_days}d, exceeds max {opts.max_days}d"
    elif reason is None and opts.pins and opts.start_date is None:
        reason = "pins set but no --start-date given"
    elif reason is None and opts.pins:
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
        distance_km=distance, travel_h=travel_h, cost=cost + pass_cost,
        total_days=total_days, stops=stops, reason=reason,
        pass_cost=pass_cost, pass_label=pass_label,
    )


def _objective(schedule: Schedule, name: str) -> float:
    return {"distance": schedule.distance_km, "time": schedule.travel_h,
            "cost": schedule.cost}[name]


def constrained_search(cities: list, mode: Mode, router, prices,
                       opts: ScheduleOpts, objective: str,
                       policy: Optional[TrainPolicy] = None,
                       reservations: Optional[ReservationLookup] = None,
                       currency: str = "EUR"):
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
        return compute_schedule(assemble(perm), cities, mode, router, prices, opts,
                                policy, reservations, currency)

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
                nxt = min(unv, key=lambda j: leg_cost(mode, cities[last], cities[j], router, prices, policy, reservations, currency)[key])
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


def find_best_meet(cities: list[City], starters: list[City], mode: Mode,
                   router, prices, opts: ScheduleOpts, objective: str,
                   policy: Optional[TrainPolicy] = None,
                   reservations: Optional[ReservationLookup] = None,
                   currency: str = "EUR"):
    """Pick the destination that minimises (sum of starters' legs to meet) +
    (joint tour starting at meet). Returns (meet_city, schedule, starter_legs)
    or (None, last_reason, None)."""
    import dataclasses
    best = None
    best_total = math.inf
    last_reason = "no feasible meet point + tour"
    for meet in cities:
        # check each starter can reach the meet under the policy
        starter_legs = []
        bail = None
        partial_total = 0.0
        for s in starters:
            fr = leg_feasible(mode, s, meet, policy or TrainPolicy(), reservations)
            if fr:
                bail = fr
                break
            d, t, c = leg_cost(mode, s, meet, router, prices, policy, reservations, currency)
            starter_legs.append({"start": s.name, "distance": d, "time_h": t, "cost": c})
            partial_total += {"distance": d, "time": t, "cost": c}[objective]
        if bail:
            last_reason = bail
            continue
        sub_opts = dataclasses.replace(opts, start_city=meet.name)
        tour, result = constrained_search(cities, mode, router, prices, sub_opts, objective,
                                          policy, reservations, currency)
        if tour is None:
            last_reason = result
            continue
        sched = result
        total = partial_total + _objective(sched, objective)
        if total < best_total:
            best_total = total
            best = (meet, sched, starter_legs)
    if best is None:
        return None, last_reason, None
    return best


def _fmt_stop(name: str, arrive: Optional[date], depart: Optional[date]) -> str:
    if arrive is None:
        return name
    if arrive == depart:
        return f"{name}({arrive.strftime('%b%d')})"
    return f"{name}({arrive.strftime('%b%d')}-{depart.strftime('%b%d')})"


def report(cities: list[City], modes: list[Mode], router, prices,
           optimise_for: str, opts: ScheduleOpts,
           policy: Optional[TrainPolicy] = None,
           starters: Optional[list[City]] = None,
           currency: str = "GBP",
           reservations: Optional[ReservationLookup] = None) -> None:
    is_open_path = bool(opts.end_city) and opts.end_city != (opts.start_city or cities[0].name)
    sym = currency_symbol(currency)
    print(f"Cities ({len(cities)}): " + ", ".join(c.name for c in cities))
    if starters:
        print(f"Starting from ({len(starters)}): " + ", ".join(s.name for s in starters))
        print("Best meeting point picked per mode below.")
    else:
        print(f"Start: {opts.start_city or cities[0].name}"
              + (f"   End: {opts.end_city}" if is_open_path else "   (closed loop)"))
    extras = []
    if opts.start_date: extras.append(f"Start date: {opts.start_date.isoformat()}")
    if opts.max_days: extras.append(f"Max days: {opts.max_days}")
    if extras: print("   ".join(extras))
    if opts.pins:
        print("Pins: " + ", ".join(f"{n}@{d.isoformat()}" for n, d in opts.pins.items()))
    if policy and (policy.interrail_pass or policy.exclude_eurostar
                   or not policy.seat_reservations_ok or policy.night_trains != "exclude"):
        bits = []
        if policy.interrail_pass: bits.append("Interrail pass")
        if policy.exclude_eurostar: bits.append("no Eurostar")
        if not policy.seat_reservations_ok: bits.append("no reservations")
        if policy.night_trains != "exclude": bits.append(f"night trains: {policy.night_trains}")
        print("Rail policy: " + ", ".join(bits))
    print(f"Currency: {currency} ({sym})   Optimising each tour for: {optimise_for}\n")
    header = f"{'Mode':<12} {'Distance':>10} {'Travel':>10} {'Cost':>11} {'Days':>6}   Itinerary"
    print(header)
    print("-" * len(header))
    for mode in modes:
        if starters:
            meet, sched, starter_legs = find_best_meet(
                cities, starters, mode, router, prices, opts, optimise_for,
                policy, reservations, currency)
            if meet is None:
                print(f"{mode.name:<12} {'-':>10} {'-':>10} {'-':>11} {'-':>6}   infeasible: {sched}")
                continue
            # tour starts at meet.name; show that first plus the joint tour
            joint_names = " -> ".join(_fmt_stop(*s) for s in sched.stops)
            if not is_open_path:
                joint_names += f" -> {sched.stops[0][0]}"
            starter_str = ", ".join(f"{l['start']}->{meet.name} {l['distance']:.0f}km/{fmt_time(l['time_h']).strip()}" for l in starter_legs)
            total_starter_cost = sum(l["cost"] for l in starter_legs)
            total_cost = sched.cost + total_starter_cost
            prefix = f"[pass: {sched.pass_label}] " if sched.pass_label else ""
            print(f"{mode.name:<12} {sched.distance_km:>8.0f}km {fmt_time(sched.travel_h):>10} "
                  f"{sym}{total_cost:>9.2f} {sched.total_days:>5}d   {prefix}meet at {meet.name} "
                  f"[{starter_str}] then {joint_names}")
            continue
        tour, result = constrained_search(cities, mode, router, prices, opts, optimise_for,
                                          policy, reservations, currency)
        if tour is None:
            print(f"{mode.name:<12} {'-':>10} {'-':>10} {'-':>11} {'-':>6}   infeasible: {result}")
            continue
        sched = result
        names = " -> ".join(_fmt_stop(*s) for s in sched.stops)
        if not is_open_path:
            names += f" -> {sched.stops[0][0]}"
        if sched.pass_label:
            names = f"[pass: {sched.pass_label}] " + names
        print(f"{mode.name:<12} {sched.distance_km:>8.0f}km {fmt_time(sched.travel_h):>10} "
              f"{sym}{sched.cost:>9.2f} {sched.total_days:>5}d   {names}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def build_geocoder(name: str, google_key: Optional[str], cache: Optional[JsonCache] = None):
    local = LocalGazetteer()
    def wrap(g):
        return CachedGeocoder(g, cache) if (cache and cache.enabled and type(g) is not LocalGazetteer) else g
    if name == "local":
        return local
    if name == "nominatim":
        return FallbackGeocoder(wrap(NominatimGeocoder()), local)
    if name == "google":
        if not google_key:
            print("--geocoder google needs --google-key or $GOOGLE_MAPS_API_KEY; "
                  "falling back to Nominatim.", file=sys.stderr)
            return FallbackGeocoder(wrap(NominatimGeocoder()), local)
        return FallbackGeocoder(wrap(GoogleGeocoder(google_key)),
                                wrap(NominatimGeocoder()), local)
    raise ValueError(f"unknown geocoder {name}")


def build_router(name: str, google_key: Optional[str], cache: Optional[JsonCache] = None):
    hav = HaversineRouter()
    if name == "haversine":
        return hav  # deterministic + fast, no caching needed
    if name == "google":
        if not google_key:
            print("--router google needs --google-key or $GOOGLE_MAPS_API_KEY; "
                  "falling back to haversine.", file=sys.stderr)
            return hav
        google = GoogleRoutesRouter(google_key, hav)
        return CachedRouter(google, cache) if (cache and cache.enabled) else google
    raise ValueError(f"unknown router {name}")


def build_prices(modes, prices_file, *, serpapi_key=None, amadeus_key=None,
                 amadeus_secret=None, amadeus_prod=False, depart_date=None,
                 enable_scrapers=False, currency: str = "GBP",
                 cache: Optional[JsonCache] = None):
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
                                               currency=currency, use_prod=amadeus_prod,
                                               cache=cache))
        elif amadeus_key and not amadeus_secret:
            print("--amadeus-key given without --amadeus-secret; skipping Amadeus.",
                  file=sys.stderr)
        if serpapi_key and depart_date:
            flights.append(SerpApiFlightPrices(serpapi_key, depart_date,
                                               currency=currency, cache=cache))
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

    rail = p.add_argument_group("rail policy")
    rail.add_argument("--interrail", "--interrail-pass", dest="interrail",
                      action="store_true", default=True,
                      help="(default) treat Train + Night train as covered by an Interrail pass; "
                           "per-km cost is 0 and reservation fees come from interrail-reservations.json")
    rail.add_argument("--no-pass", dest="interrail", action="store_false",
                      help="disable Interrail pass pricing; trains use the per-km fare in prices.json")
    rail.add_argument("--reservations-file", default="interrail-reservations.json",
                      help="path to the curated Interrail reservations dataset")
    rail.add_argument("--exclude-eurostar", action="store_true",
                      help="exclude Train legs that cross the English Channel")
    rail.add_argument("--no-reservations", action="store_true",
                      help="exclude Train legs that likely require a seat reservation")
    rail.add_argument("--night-trains", choices=["include", "exclude", "only"],
                      default="exclude",
                      help='night-train mode: "exclude" (default) hides Night train; '
                           '"include" shows both Train and Night train; '
                           '"only" hides regular Train')

    grp = p.add_argument_group("group travel")
    grp.add_argument("--meet-from", action="append", default=[], metavar="CITY",
                     help="city someone is starting from (repeatable); the solver picks "
                          "the best destination as the meeting point per mode")

    misc = p.add_argument_group("misc")
    misc.add_argument("--currency", default="GBP",
                      help="display currency and the one passed to flight APIs (e.g. GBP, EUR, USD)")
    misc.add_argument("--cache-file", default=os.path.join(os.path.expanduser("~"),
                                                           ".tsp-tool-cache.json"),
                      help="path to on-disk cache (JSON)")
    misc.add_argument("--cache-ttl", type=int, default=86400,
                      help="cache entry lifetime in seconds (default 24h)")
    misc.add_argument("--no-cache", action="store_true",
                      help="disable on-disk caching")

    p.add_argument("--optimise", choices=["distance", "time", "cost"], default="time")
    args = p.parse_args()

    cache = JsonCache(path=args.cache_file, ttl_seconds=args.cache_ttl,
                      enabled=not args.no_cache)
    geocoder = build_geocoder(args.geocoder, args.google_key, cache)
    router = build_router(args.router, args.google_key, cache)
    prices = build_prices(
        DEFAULT_MODES, args.prices_file,
        serpapi_key=args.serpapi_key,
        amadeus_key=args.amadeus_key,
        amadeus_secret=args.amadeus_secret,
        amadeus_prod=args.amadeus_prod,
        depart_date=args.depart_date,
        enable_scrapers=args.enable_scrapers,
        currency=args.currency,
        cache=cache,
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

    policy = TrainPolicy(
        interrail_pass=args.interrail,
        exclude_eurostar=args.exclude_eurostar,
        seat_reservations_ok=not args.no_reservations,
        night_trains=args.night_trains,
    )
    apply_pass_pricing(prices, policy)
    modes = filter_train_modes(DEFAULT_MODES, policy)

    reservations = ReservationLookup(args.reservations_file)

    starters: list[City] = []
    for name in args.meet_from:
        c = resolve_city(name, geocoder)
        if c is None:
            print(f"could not geocode --meet-from {name!r}", file=sys.stderr); sys.exit(2)
        starters.append(c)

    report(cities, modes, router, prices, args.optimise, opts, policy,
           starters=starters or None, currency=args.currency,
           reservations=reservations)


if __name__ == "__main__":
    main()
