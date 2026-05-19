// Multi-transport Traveling Salesman comparison.
//
// Find a good tour visiting a set of cities for each mode of transport
// (ICE car, EV car, coach, train, flight) and report total distance,
// journey time, and cost per mode.
//
// Pluggable providers:
//   Geocoder   local gazetteer | OpenStreetMap Nominatim | Google Geocoding
//   Router     Haversine + detour factor | Google Distance Matrix
//   Prices     editable prices.json + optional scrapers + SerpAPI Google Flights
//
// CLI examples:
//   node tsp.js
//   node tsp.js --interactive
//   node tsp.js --city London --city Paris --city Rome
//   node tsp.js --cities-file mycities.json
//   node tsp.js --geocoder google --router google --google-key $GOOGLE_MAPS_API_KEY
//   node tsp.js --amadeus-key $AMADEUS_API_KEY --amadeus-secret $AMADEUS_API_SECRET \
//               --depart-date 2026-06-01
//   node tsp.js --serpapi-key $SERPAPI_KEY --depart-date 2026-06-01
//
// Requires Node 18+ for built-in fetch.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Disk cache + caching wrappers
// ---------------------------------------------------------------------------

class JsonCache {
  constructor({ filePath = null, ttlSeconds = 86400, enabled = true } = {}) {
    this.path = filePath || path.join(os.homedir(), '.tsp-tool-cache.json');
    this.ttl = ttlSeconds;
    this.enabled = enabled;
    this.data = {};
    if (enabled) {
      try { this.data = JSON.parse(fs.readFileSync(this.path, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') console.error(`cache load: ${e.message}`); }
    }
  }
  get(key) {
    if (!this.enabled) return undefined;
    const e = this.data[key];
    if (!e) return undefined;
    if ((Date.now() / 1000) - (e.ts || 0) > this.ttl) return undefined;
    return e.v;
  }
  set(key, value) {
    if (!this.enabled) return;
    this.data[key] = { ts: Date.now() / 1000, v: value };
    try {
      const tmp = this.path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.path);
    } catch (e) { console.error(`cache save: ${e.message}`); }
  }
}

class CachedGeocoder {
  constructor(inner, cache) { this.inner = inner; this.cache = cache; }
  async geocode(name) {
    const key = `geo:${this.inner.constructor.name}:${name.trim().toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached && cached.lat != null ? cached : null;
    }
    const r = await this.inner.geocode(name);
    this.cache.set(key, r || null);
    return r;
  }
}

class CachedRouter {
  constructor(inner, cache) { this.inner = inner; this.cache = cache; }
  async route(mode, a, b) {
    const key = `route:${this.inner.constructor.name}:${mode.name}:`
      + `${a.lat.toFixed(4)},${a.lon.toFixed(4)}->${b.lat.toFixed(4)},${b.lon.toFixed(4)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const r = await this.inner.route(mode, a, b);
    this.cache.set(key, r);
    return r;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function makeMode(name, detourFactor, avgSpeedKmh, costPerKm,
                  terminalAccessH, boardingWaitH, terminalEgressH, fixedCostPerLeg) {
  const m = { name, detourFactor, avgSpeedKmh, costPerKm,
              terminalAccessH, boardingWaitH, terminalEgressH, fixedCostPerLeg };
  Object.defineProperty(m, 'fixedTimePerLegH', {
    enumerable: true,
    get() { return this.terminalAccessH + this.boardingWaitH + this.terminalEgressH; },
    set(v) { this.terminalAccessH = 0; this.terminalEgressH = 0; this.boardingWaitH = +v; },
  });
  return m;
}

const DEFAULT_MODES = [
  //         name           detour avgKmh £/km access wait  egress fixed
  makeMode('ICE car',     1.30,  90,    0.15, 0.00, 0.00, 0.00, 0),
  makeMode('EV car',      1.30,  90,    0.05, 0.00, 0.00, 0.00, 0),
  makeMode('Coach',       1.35,  65,    0.04, 0.25, 0.25, 0.25, 1),
  makeMode('Train',       1.20, 120,    0.12, 0.25, 0.25, 0.25, 2),
  makeMode('Night train', 1.20,  80,    0.10, 0.25, 0.50, 0.25, 30),
  makeMode('Flight',      1.00, 700,    0.20, 0.75, 2.00, 0.75, 30),
];

const CURRENCY_SYMBOLS = {
  GBP: '£', EUR: '€', USD: '$', CAD: 'C$', AUD: 'A$', NZD: 'NZ$',
  JPY: '¥', CNY: '¥', INR: '₹', CHF: 'CHF', SEK: 'kr', NOK: 'kr',
  DKK: 'kr', PLN: 'zł', CZK: 'Kč', HUF: 'Ft',
};

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code.toUpperCase()] || (code.toUpperCase() + ' ');
}

const DEFAULT_CITIES = [
  { name: 'London',     lat: 51.5074, lon: -0.1278 },
  { name: 'Manchester', lat: 53.4808, lon: -2.2426 },
  { name: 'Edinburgh',  lat: 55.9533, lon: -3.1883 },
  { name: 'Cardiff',    lat: 51.4816, lon: -3.1791 },
  { name: 'Belfast',    lat: 54.5973, lon: -5.9301 },
  { name: 'Birmingham', lat: 52.4862, lon: -1.8904 },
  { name: 'Glasgow',    lat: 55.8642, lon: -4.2518 },
  { name: 'Bristol',    lat: 51.4545, lon: -2.5879 },
];

const LOCAL_GAZETTEER = {
  london:     [51.5074, -0.1278],
  manchester: [53.4808, -2.2426],
  edinburgh:  [55.9533, -3.1883],
  cardiff:    [51.4816, -3.1791],
  belfast:    [54.5973, -5.9301],
  birmingham: [52.4862, -1.8904],
  glasgow:    [55.8642, -4.2518],
  bristol:    [51.4545, -2.5879],
  paris:      [48.8566,  2.3522],
  berlin:     [52.5200, 13.4050],
  rome:       [41.9028, 12.4964],
  madrid:     [40.4168, -3.7038],
  dublin:     [53.3498, -6.2603],
  amsterdam:  [52.3676,  4.9041],
  brussels:   [50.8503,  4.3517],
  vienna:     [48.2082, 16.3738],
  munich:     [48.1351, 11.5820],
  zurich:     [47.3769,  8.5417],
  milan:      [45.4642,  9.1900],
  barcelona:  [41.3851,  2.1734],
  prague:     [50.0755, 14.4378],
  copenhagen: [55.6761, 12.5683],
  stockholm:  [59.3293, 18.0686],
  oslo:       [59.9139, 10.7522],
  lisbon:     [38.7223, -9.1393],
  warsaw:     [52.2297, 21.0122],
  budapest:   [47.4979, 19.0402],
  'new york': [40.7128, -74.0060],
  tokyo:      [35.6762, 139.6503],
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpGetJson(url, { timeoutMs = 15000, headers = { 'User-Agent': 'tsp-tool/1.0' } } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function httpGetText(url, { timeoutMs = 15000, headers = { 'User-Agent': 'tsp-tool/1.0' } } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Geocoders
// ---------------------------------------------------------------------------

class LocalGazetteer {
  async geocode(name) {
    const v = LOCAL_GAZETTEER[name.trim().toLowerCase()];
    return v ? { lat: v[0], lon: v[1] } : null;
  }
}

class NominatimGeocoder {
  async geocode(name) {
    const q = new URLSearchParams({ q: name, format: 'json', limit: '1' }).toString();
    try {
      const data = await httpGetJson(`https://nominatim.openstreetmap.org/search?${q}`);
      if (!Array.isArray(data) || !data.length) return null;
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    } catch (e) {
      console.error(`  ! Nominatim failed for ${JSON.stringify(name)}: ${e.message}`);
      return null;
    }
  }
}

class GoogleGeocoder {
  constructor(apiKey) { this.apiKey = apiKey; }
  async geocode(name) {
    const q = new URLSearchParams({ address: name, key: this.apiKey }).toString();
    try {
      const data = await httpGetJson(`https://maps.googleapis.com/maps/api/geocode/json?${q}`);
      if (data.status !== 'OK' || !data.results || !data.results.length) return null;
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lon: loc.lng };
    } catch (e) {
      console.error(`  ! Google geocode failed for ${JSON.stringify(name)}: ${e.message}`);
      return null;
    }
  }
}

class FallbackGeocoder {
  constructor(...geocoders) { this.geocoders = geocoders; }
  async geocode(name) {
    for (const g of this.geocoders) {
      const r = await g.geocode(name);
      if (r) return r;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

function haversineKm(a, b) {
  const R = 6371.0088;
  const toRad = (x) => (x * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

class HaversineRouter {
  async route(mode, a, b) {
    const distance = haversineKm(a, b) * mode.detourFactor;
    const timeH = distance / mode.avgSpeedKmh + mode.fixedTimePerLegH;
    return { distance, timeH };
  }
}

class GoogleRoutesRouter {
  static GOOGLE_MODE = {
    'ICE car': { mode: 'driving' },
    'EV car':  { mode: 'driving' },
    'Coach':   { mode: 'transit', transitMode: 'bus' },
    'Train':   { mode: 'transit', transitMode: 'rail' },
  };

  constructor(apiKey, fallback) {
    this.apiKey = apiKey;
    this.fallback = fallback;
  }

  async route(mode, a, b) {
    const cfg = GoogleRoutesRouter.GOOGLE_MODE[mode.name];
    if (!cfg) return this.fallback.route(mode, a, b);
    const params = new URLSearchParams({
      origins: `${a.lat},${a.lon}`,
      destinations: `${b.lat},${b.lon}`,
      mode: cfg.mode,
      key: this.apiKey,
    });
    if (cfg.transitMode) params.append('transit_mode', cfg.transitMode);
    try {
      const data = await httpGetJson(`https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`);
      const row = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0];
      if (row && row.status === 'OK') {
        return {
          distance: row.distance.value / 1000,
          timeH: row.duration.value / 3600 + mode.fixedTimePerLegH,
        };
      }
      console.error(`  ! Google Routes status=${row && row.status} for ${mode.name} ${a.name}->${b.name}; using fallback`);
    } catch (e) {
      console.error(`  ! Google Routes error for ${mode.name} ${a.name}->${b.name}: ${e.message}`);
    }
    return this.fallback.route(mode, a, b);
  }
}

// ---------------------------------------------------------------------------
// Price providers
// ---------------------------------------------------------------------------

class ConfigPrices {
  constructor(modes, overridesFile) {
    this.byName = Object.fromEntries(modes.map((m) => [m.name,
      makeMode(m.name, m.detourFactor, m.avgSpeedKmh, m.costPerKm,
               m.terminalAccessH, m.boardingWaitH, m.terminalEgressH, m.fixedCostPerLeg),
    ]));
    if (overridesFile && fs.existsSync(overridesFile)) {
      const data = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
      const overrides = (data && data.modes) || {};
      for (const [name, fields] of Object.entries(overrides)) {
        if (this.byName[name]) Object.assign(this.byName[name], fields);
      }
    }
  }
  perKm(name) { return this.byName[name].costPerKm; }
  perLegFixed(name) { return this.byName[name].fixedCostPerLeg; }
  async legPrice(_name, _a, _b) { return null; }
  modes() { return Object.values(this.byName); }
}

class SerpApiFlightPrices {
  constructor(apiKey, departDate, { currency = 'GBP', cache = null } = {}) {
    this.apiKey = apiKey;
    this.departDate = departDate;
    this.currency = currency;
    this.memCache = new Map();
    this.diskCache = cache;
  }
  async legPrice(modeName, a, b) {
    if (modeName !== 'Flight') return null;
    const key = `${a.name}|${b.name}`;
    if (this.memCache.has(key)) return this.memCache.get(key);
    const diskKey = `serpapi:${this.currency}:${this.departDate}:${a.name}->${b.name}`;
    if (this.diskCache) {
      const v = this.diskCache.get(diskKey);
      if (v !== undefined) {
        const value = v === '' ? null : v;
        this.memCache.set(key, value);
        return value;
      }
    }
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: a.name,
      arrival_id: b.name,
      outbound_date: this.departDate,
      type: '2',
      currency: this.currency,
      api_key: this.apiKey,
    });
    let price = null;
    try {
      const data = await httpGetJson(`https://serpapi.com/search?${params.toString()}`, { timeoutMs: 20000 });
      const flights = (data.best_flights && data.best_flights.length ? data.best_flights : data.other_flights) || [];
      for (const f of flights) {
        if (f.price != null) { price = Number(f.price); break; }
      }
    } catch (e) {
      console.error(`  ! SerpAPI flights ${a.name}->${b.name}: ${e.message}`);
    }
    this.memCache.set(key, price);
    if (this.diskCache) this.diskCache.set(diskKey, price == null ? '' : price);
    return price;
  }
}

const SCRAPE_CONVERTERS = {
  uk_pence_per_litre_to_gbp_per_km: (x) => (x / 100) * 0.07,
  uk_pence_per_kwh_to_gbp_per_km:   (x) => (x / 100) * 0.18,
  identity: (x) => x,
};

class AmadeusFlightPrices {
  static TEST_BASE = 'https://test.api.amadeus.com';
  static PROD_BASE = 'https://api.amadeus.com';

  constructor(apiKey, apiSecret, departDate,
              { currency = 'GBP', useProd = false, cache = null } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.departDate = departDate;
    this.currency = currency;
    this.base = useProd ? AmadeusFlightPrices.PROD_BASE : AmadeusFlightPrices.TEST_BASE;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.airportCache = new Map();
    this.priceCache = new Map();
    this.diskCache = cache;
  }

  async _getToken() {
    if (this.token && Date.now() / 1000 < this.tokenExpiresAt - 30) return this.token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.apiKey,
      client_secret: this.apiSecret,
    }).toString();
    try {
      const r = await fetch(`${this.base}/v1/security/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'tsp-tool/1.0' },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const payload = await r.json();
      this.token = payload.access_token;
      this.tokenExpiresAt = Date.now() / 1000 + (payload.expires_in || 1799);
      return this.token;
    } catch (e) {
      console.error(`  ! Amadeus auth failed: ${e.message}`);
      return null;
    }
  }

  async _authedGet(path, params) {
    const token = await this._getToken();
    if (!token) return null;
    const url = `${this.base}${path}?${new URLSearchParams(params).toString()}`;
    return httpGetJson(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'tsp-tool/1.0' },
      timeoutMs: 20000,
    });
  }

  async _nearestAirport(city) {
    const key = `${city.lat.toFixed(3)},${city.lon.toFixed(3)}`;
    if (this.airportCache.has(key)) return this.airportCache.get(key);
    const diskKey = `amadeus_airport:${key}`;
    if (this.diskCache) {
      const v = this.diskCache.get(diskKey);
      if (v !== undefined) {
        const value = v === '' ? null : v;
        this.airportCache.set(key, value);
        return value;
      }
    }
    let iata = null;
    try {
      const data = await this._authedGet('/v1/reference-data/locations/airports', {
        latitude: city.lat.toFixed(4),
        longitude: city.lon.toFixed(4),
        radius: '200',
        'page[limit]': '1',
        sort: 'relevance',
      });
      const results = (data && data.data) || [];
      iata = results[0] ? results[0].iataCode : null;
    } catch (e) {
      console.error(`  ! Amadeus airport lookup for ${city.name}: ${e.message}`);
    }
    this.airportCache.set(key, iata);
    if (this.diskCache) this.diskCache.set(diskKey, iata || '');
    return iata;
  }

  async legPrice(modeName, a, b) {
    if (modeName !== 'Flight') return null;
    const cacheKey = `${a.name}|${b.name}`;
    if (this.priceCache.has(cacheKey)) return this.priceCache.get(cacheKey);
    const [orig, dest] = await Promise.all([this._nearestAirport(a), this._nearestAirport(b)]);
    if (!orig || !dest || orig === dest) { this.priceCache.set(cacheKey, null); return null; }
    const diskKey = `amadeus_price:${this.currency}:${this.departDate}:${orig}->${dest}`;
    if (this.diskCache) {
      const v = this.diskCache.get(diskKey);
      if (v !== undefined) {
        const value = v === '' ? null : v;
        this.priceCache.set(cacheKey, value);
        return value;
      }
    }
    let price = null;
    try {
      const data = await this._authedGet('/v2/shopping/flight-offers', {
        originLocationCode: orig,
        destinationLocationCode: dest,
        departureDate: this.departDate,
        adults: '1',
        currencyCode: this.currency,
        max: '1',
        nonStop: 'false',
      });
      const offers = (data && data.data) || [];
      price = offers[0] ? Number(offers[0].price.grandTotal) : null;
    } catch (e) {
      console.error(`  ! Amadeus flight search ${orig}->${dest}: ${e.message}`);
    }
    this.priceCache.set(cacheKey, price);
    if (this.diskCache) this.diskCache.set(diskKey, price == null ? '' : price);
    return price;
  }
}

class ScrapedPerKmPrices {
  constructor(config) {
    this.config = config || {};
    this.cache = new Map();
  }
  async perKm(modeName) {
    if (this.cache.has(modeName)) return this.cache.get(modeName);
    const spec = this.config[modeName];
    if (!spec) { this.cache.set(modeName, null); return null; }
    try {
      const text = await httpGetText(spec.url);
      const m = new RegExp(spec.regex).exec(text);
      if (!m) throw new Error('regex did not match');
      const raw = parseFloat(m[1]);
      const conv = SCRAPE_CONVERTERS[spec.convert || 'identity'];
      const value = conv(raw);
      this.cache.set(modeName, value);
      return value;
    } catch (e) {
      console.error(`  ! scraper for ${modeName} failed: ${e.message}`);
      this.cache.set(modeName, null);
      return null;
    }
  }
}

class PriceStack {
  constructor(config, { scraped = null, flights = [] } = {}) {
    this.config = config;
    this.scraped = scraped;
    this.flights = flights;
  }
  async perKm(name) {
    if (this.scraped) {
      const v = await this.scraped.perKm(name);
      if (v != null) return v;
    }
    return this.config.perKm(name);
  }
  perLegFixed(name) { return this.config.perLegFixed(name); }
  async legPrice(name, a, b) {
    for (const p of this.flights) {
      const v = await p.legPrice(name, a, b);
      if (v != null) return v;
    }
    return null;
  }
  modes() { return this.config.modes(); }
}

// ---------------------------------------------------------------------------
// Leg cost + TSP
// ---------------------------------------------------------------------------

async function legCost(mode, a, b, router, prices,
                       { policy = null, reservations = null, currency = 'EUR' } = {}) {
  const { distance, timeH } = await router.route(mode, a, b);
  const absolute = await prices.legPrice(mode.name, a, b);
  if (absolute != null) return { distance, timeH, cost: absolute };
  let cost = distance * (await prices.perKm(mode.name)) + prices.perLegFixed(mode.name);
  if (policy && policy.interrailPass && reservations && reservations.loaded()
      && (mode.name === 'Train' || mode.name === 'Night train')) {
    cost = distance * (await prices.perKm(mode.name));
    const info = mode.name === 'Train'
      ? reservations.dayTrain(a, b, currency)
      : reservations.nightTrain(a, b, currency, 'couchette');
    cost += info.fee;
  }
  return { distance, timeH, cost };
}

// ---------------------------------------------------------------------------
// Train policy: Interrail pass, Eurostar opt-out, reservations, night trains
// ---------------------------------------------------------------------------

const DEFAULT_TRAIN_POLICY = {
  interrailPass: true,
  excludeEurostar: false,
  seatReservationsOk: true,
  nightTrains: 'exclude',
  reservationFeeGbp: 5,
  sleeperSupplementGbp: 30,
  reservationRequiredMinKm: 300,
  nightTrainMinKm: 500,
};

class ReservationLookup {
  constructor(filePath = null) {
    this.data = {};
    if (filePath && fs.existsSync(filePath)) {
      try { this.data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch (e) { console.error(`could not load reservations: ${e.message}`); }
    }
    this.cityCountry = this.data.city_country || {};
    this.domestic = this.data.domestic || {};
    this.international = this.data.international || [];
    this.nightTrains = this.data.night_trains || [];
    this.defaults = this.data.defaults || {};
    this.fx = this.data.fx || { EUR: 1 };
  }
  loaded() { return Object.keys(this.data).length > 0; }
  countryOf(city) { return this.cityCountry[city.name] || null; }
  _eurTo(eur, currency) {
    const rate = this.fx[currency.toUpperCase()] || this.fx.EUR || 1;
    return eur * (rate / (this.fx.EUR || 1));
  }
  dayTrain(a, b, currency = 'EUR') {
    const ca = this.countryOf(a), cb = this.countryOf(b);
    if (!ca || !cb) {
      return { fee: this._eurTo(this.defaults.unknown_day_fee_eur || 5, currency),
               operator: '(unknown)', mandatory: false, channelCrossing: false };
    }
    if (ca === cb) {
      const dom = this.domestic[ca];
      if (dom) return { fee: this._eurTo(dom.fee_eur || 0, currency),
                        operator: dom.operator || '', mandatory: !!dom.mandatory,
                        channelCrossing: false };
      return { fee: 0, operator: '', mandatory: false, channelCrossing: false };
    }
    for (const e of this.international) {
      const p = e.pair || [];
      if (p.length === 2 && ((p[0] === ca && p[1] === cb) || (p[0] === cb && p[1] === ca))) {
        return { fee: this._eurTo(e.fee_eur || 0, currency),
                 operator: e.operator || '', mandatory: e.mandatory !== false,
                 channelCrossing: !!e.channel_crossing };
      }
    }
    return { fee: this._eurTo(this.defaults.unknown_day_fee_eur || 5, currency),
             operator: '(unknown international)', mandatory: false,
             channelCrossing: crossesChannel(a, b) };
  }
  nightTrain(a, b, currency = 'EUR', tier = 'couchette') {
    const ca = this.countryOf(a), cb = this.countryOf(b);
    const key = `${tier}_eur`;
    if (ca && cb) {
      for (const e of this.nightTrains) {
        for (const p of (e.pairs || [])) {
          if ((p[0] === ca && p[1] === cb) || (p[0] === cb && p[1] === ca)) {
            return { fee: this._eurTo(e[key] || 0, currency),
                     operator: e.operator || '', mandatory: e.mandatory !== false,
                     channelCrossing: false };
          }
        }
      }
    }
    return { fee: this._eurTo(this.defaults.unknown_night_supplement_eur || 30, currency),
             operator: '(unknown night train)', mandatory: false,
             channelCrossing: crossesChannel(a, b) };
  }
}

function crossesChannel(a, b) {
  const onIsles = (c) => c.lat >= 49.5 && c.lat <= 61.0 && c.lon >= -10.5 && c.lon <= 2.0;
  return onIsles(a) !== onIsles(b);
}

function filterTrainModes(modes, policy) {
  return modes.filter((m) => {
    if (m.name === 'Train' && policy.nightTrains === 'only') return false;
    if (m.name === 'Night train' && policy.nightTrains === 'exclude') return false;
    return true;
  });
}

function applyPassPricing(prices, policy) {
  if (!policy.interrailPass) return;
  const cfg = prices.config.byName;
  if (cfg.Train) { cfg.Train.costPerKm = 0; cfg.Train.fixedCostPerLeg = 0; }
  if (cfg['Night train']) {
    cfg['Night train'].costPerKm = 0;
    cfg['Night train'].fixedCostPerLeg = 0;
  }
}

function legFeasible(mode, a, b, policy, reservations = null) {
  if (mode.name !== 'Train' && mode.name !== 'Night train') return null;
  let channel = false;
  if (reservations && reservations.loaded()) {
    channel = reservations.dayTrain(a, b).channelCrossing;
  } else {
    channel = crossesChannel(a, b);
  }
  if (policy.excludeEurostar && channel) {
    return `${mode.name}: Eurostar (channel crossing) excluded`;
  }
  if (mode.name === 'Train' && !policy.seatReservationsOk) {
    if (reservations && reservations.loaded()) {
      const info = reservations.dayTrain(a, b);
      if (info.mandatory) {
        return `Train: ${a.name}->${b.name} on ${info.operator} needs reservation`;
      }
    } else {
      const distance = haversineKm(a, b) * mode.detourFactor;
      if (distance >= policy.reservationRequiredMinKm) {
        return `Train: ${distance.toFixed(0)}km leg likely needs reservation`;
      }
    }
  }
  if (mode.name === 'Night train') {
    const distance = haversineKm(a, b) * mode.detourFactor;
    if (distance < policy.nightTrainMinKm) {
      return `Night train: ${distance.toFixed(0)}km leg shorter than ${policy.nightTrainMinKm}km minimum`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scheduling: turn an ordered tour into a dated itinerary, check feasibility
// ---------------------------------------------------------------------------

function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function fmtMonDay(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function stayDaysFor(opts, name) {
  return opts.stays && opts.stays[name] != null ? Number(opts.stays[name]) : opts.daysPerCity;
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

async function computeSchedule(tour, cities, mode, router, prices, opts, policy,
                               reservations = null, currency = 'EUR') {
  policy = policy || DEFAULT_TRAIN_POLICY;
  const legOpts = { policy, reservations, currency };
  const startName = opts.startCity || cities[tour[0]].name;
  const isOpenPath = !!opts.endCity && opts.endCity !== startName;
  let distance = 0, travelH = 0, cost = 0, elapsedH = 0;
  const stops = [];
  let failReason = null;

  for (let i = 0; i < tour.length; i++) {
    const c = cities[tour[i]];
    const arriveH = elapsedH;
    const stayH = stayDaysFor(opts, c.name) * 24;
    const departH = arriveH + stayH;
    let arriveD = null, departD = null;
    if (opts.startDate) {
      arriveD = addDays(opts.startDate, Math.floor(arriveH / 24));
      const lastInclusive = stayH > 0 ? departH - 1e-9 : arriveH;
      departD = addDays(opts.startDate, Math.floor(lastInclusive / 24));
    }
    stops.push({ name: c.name, arrive: arriveD, depart: departD });
    elapsedH = departH;
    if (i + 1 < tour.length) {
      const nxt = cities[tour[i + 1]];
      if (failReason === null) failReason = legFeasible(mode, c, nxt, policy, reservations);
      const leg = await legCost(mode, c, nxt, router, prices, legOpts);
      distance += leg.distance; travelH += leg.timeH; cost += leg.cost;
      elapsedH += leg.timeH;
    }
  }

  if (!isOpenPath && tour.length > 1) {
    const first = cities[tour[0]], last = cities[tour[tour.length - 1]];
    if (failReason === null) failReason = legFeasible(mode, last, first, policy, reservations);
    const leg = await legCost(mode, last, first, router, prices, legOpts);
    distance += leg.distance; travelH += leg.timeH; cost += leg.cost;
    elapsedH += leg.timeH;
  }

  const totalDays = Math.max(1, Math.ceil(elapsedH / 24));

  let reason = failReason;
  if (reason === null && opts.maxDays != null && totalDays > opts.maxDays) {
    reason = `trip is ${totalDays}d, exceeds max ${opts.maxDays}d`;
  } else if (reason === null && opts.pins && Object.keys(opts.pins).length && !opts.startDate) {
    reason = 'pins set but no startDate given';
  } else if (reason === null && opts.pins) {
    const byName = Object.fromEntries(stops.map((s) => [s.name, s]));
    for (const [pn, pd] of Object.entries(opts.pins)) {
      const s = byName[pn];
      if (!s) { reason = `pinned city ${pn} not in tour`; break; }
      const pinT = pd.getTime();
      if (pinT < s.arrive.getTime() || pinT > s.depart.getTime()) {
        reason = `${pn} window ${isoDate(s.arrive)}..${isoDate(s.depart)} misses pinned ${isoDate(pd)}`;
        break;
      }
    }
  }

  return {
    feasible: reason === null,
    distance, travelH, cost, totalDays, stops, reason,
  };
}

function pickObjective(sched, name) {
  return name === 'distance' ? sched.distance : name === 'time' ? sched.travelH : sched.cost;
}

async function constrainedSearch(cities, mode, router, prices, opts, objective, policy,
                                  reservations = null, currency = 'EUR') {
  const n = cities.length;
  const nameToIdx = new Map(cities.map((c, i) => [c.name, i]));
  const startIdx = nameToIdx.get(opts.startCity) ?? 0;
  const startName = cities[startIdx].name;
  const isOpenPath = !!opts.endCity && opts.endCity !== startName;
  const endIdx = isOpenPath ? nameToIdx.get(opts.endCity) : null;
  const middle = [];
  for (let i = 0; i < n; i++) if (i !== startIdx && i !== endIdx) middle.push(i);

  const assemble = (perm) => [startIdx, ...perm, ...(isOpenPath ? [endIdx] : [])];

  let bestPerm = null, bestSched = null, lastReason = 'no feasible tour found';

  const consider = (perm, sched) => {
    if (!sched.feasible) { if (sched.reason) lastReason = sched.reason; return; }
    if (!bestSched || pickObjective(sched, objective) < pickObjective(bestSched, objective)) {
      bestPerm = perm.slice();
      bestSched = sched;
    }
  };

  if (factorial(middle.length) <= 40320) {
    for (const perm of permutations(middle)) {
      const sched = await computeSchedule(assemble(perm), cities, mode, router, prices, opts, policy, reservations, currency);
      consider(perm, sched);
    }
  } else {
    // heuristic: nearest-neighbor seeds + constrained 2-opt
    const seeds = [await nnSeed(startIdx)];
    for (let s = 0; s < 8; s++) seeds.push(shuffle(middle.slice(), s));
    for (const seed of seeds) {
      const { perm, sched } = await twoOptConstrained(seed);
      consider(perm, sched);
    }
  }

  async function nnSeed(start) {
    const unv = new Set(middle);
    const seq = [];
    let last = start;
    while (unv.size) {
      let best = -1, bestVal = Infinity;
      for (const j of unv) {
        const leg = await legCost(mode, cities[last], cities[j], router, prices,
                                   { policy, reservations, currency });
        const v = objective === 'distance' ? leg.distance : objective === 'time' ? leg.timeH : leg.cost;
        if (v < bestVal) { bestVal = v; best = j; }
      }
      seq.push(best); unv.delete(best); last = best;
    }
    return seq;
  }

  async function twoOptConstrained(perm) {
    let cur = perm.slice();
    let curSched = await computeSchedule(assemble(cur), cities, mode, router, prices, opts, policy, reservations, currency);
    let curVal = curSched.feasible ? pickObjective(curSched, objective) : Infinity;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < cur.length - 1; i++) {
        for (let j = i + 1; j < cur.length; j++) {
          const cand = cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1));
          const candSched = await computeSchedule(assemble(cand), cities, mode, router, prices, opts, policy, reservations, currency);
          if (!candSched.feasible) continue;
          const v = pickObjective(candSched, objective);
          if (v + 1e-9 < curVal) { cur = cand; curSched = candSched; curVal = v; improved = true; }
        }
      }
    }
    return { perm: cur, sched: curSched };
  }

  return { tour: bestPerm ? assemble(bestPerm) : null, sched: bestSched, reason: lastReason };
}

function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

function shuffle(arr, seed) {
  // deterministic xorshift shuffle
  let s = seed * 2654435761 >>> 0 || 1;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Input: interactive, CLI, file
// ---------------------------------------------------------------------------

async function resolveCity(name, geocoder) {
  const r = await geocoder.geocode(name);
  return r ? { name, lat: r.lat, lon: r.lon } : null;
}

function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a)));
  const close = () => rl.close();
  return { ask, close };
}

async function promptCities(geocoder) {
  console.log('Enter destinations one per line. Blank line to finish.');
  const { ask, close } = makePrompter();
  let cities = [];
  try {
    while (true) {
      const raw = (await ask(`  city #${cities.length + 1}: `)).trim();
      if (!raw) break;
      const city = await resolveCity(raw, geocoder);
      if (city) {
        cities.push(city);
        console.log(`     -> ${city.lat.toFixed(4)}, ${city.lon.toFixed(4)}`);
        continue;
      }
      const manual = (await ask("     not found. enter 'lat,lon' or blank to skip: ")).trim();
      if (!manual) continue;
      const parts = manual.split(',').map((s) => parseFloat(s.trim()));
      if (parts.length === 2 && parts.every(Number.isFinite)) {
        cities.push({ name: raw, lat: parts[0], lon: parts[1] });
      } else {
        console.log('     bad coordinates, skipping.');
      }
    }
  } finally {
    close();
  }
  return cities;
}

function loadCitiesFile(path) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  return data.map((c) => ({ name: c.name, lat: Number(c.lat), lon: Number(c.lon) }));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmtTime(hours) {
  let h = Math.floor(hours);
  let m = Math.round((hours - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  return `${String(h).padStart(3)}h ${String(m).padStart(2, '0')}m`;
}

async function findBestMeet(cities, starters, mode, router, prices, opts, objective, policy,
                            reservations = null, currency = 'EUR') {
  let best = null;
  let bestTotal = Infinity;
  let lastReason = 'no feasible meet point + tour';
  for (const meet of cities) {
    let bail = null;
    const starterLegs = [];
    let partialTotal = 0;
    for (const s of starters) {
      const fr = legFeasible(mode, s, meet, policy || DEFAULT_TRAIN_POLICY, reservations);
      if (fr) { bail = fr; break; }
      const { distance, timeH, cost } = await legCost(mode, s, meet, router, prices,
                                                       { policy, reservations, currency });
      starterLegs.push({ start: s.name, distance, timeH, cost });
      partialTotal += objective === 'distance' ? distance : objective === 'time' ? timeH : cost;
    }
    if (bail) { lastReason = bail; continue; }
    const subOpts = { ...opts, startCity: meet.name };
    const { tour, sched, reason } = await constrainedSearch(cities, mode, router, prices,
      subOpts, objective, policy, reservations, currency);
    if (!tour) { lastReason = reason; continue; }
    const total = partialTotal + pickObjective(sched, objective);
    if (total < bestTotal) { bestTotal = total; best = { meet, sched, starterLegs }; }
  }
  return best ? best : { meet: null, sched: null, starterLegs: null, reason: lastReason };
}

function fmtStop(stop) {
  if (!stop.arrive) return stop.name;
  if (stop.arrive.getTime() === stop.depart.getTime()) return `${stop.name}(${fmtMonDay(stop.arrive)})`;
  return `${stop.name}(${fmtMonDay(stop.arrive)}-${fmtMonDay(stop.depart)})`;
}

async function report(cities, modes, router, prices, optimiseFor, opts, policy,
                      { starters = null, currency = 'GBP', reservations = null } = {}) {
  const sym = currencySymbol(currency);
  const startName = opts.startCity || cities[0].name;
  const isOpenPath = !!opts.endCity && opts.endCity !== startName;
  console.log(`Cities (${cities.length}): ${cities.map((c) => c.name).join(', ')}`);
  if (starters && starters.length) {
    console.log(`Starting from (${starters.length}): ${starters.map((s) => s.name).join(', ')}`);
    console.log('Best meeting point picked per mode below.');
  } else {
    console.log(`Start: ${startName}` + (isOpenPath ? `   End: ${opts.endCity}` : '   (closed loop)'));
  }
  const extras = [];
  if (opts.startDate) extras.push(`Start date: ${isoDate(opts.startDate)}`);
  if (opts.maxDays != null) extras.push(`Max days: ${opts.maxDays}`);
  if (extras.length) console.log(extras.join('   '));
  if (opts.pins && Object.keys(opts.pins).length) {
    console.log('Pins: ' + Object.entries(opts.pins).map(([n, d]) => `${n}@${isoDate(d)}`).join(', '));
  }
  if (policy && (policy.interrailPass || policy.excludeEurostar
                 || !policy.seatReservationsOk || policy.nightTrains !== 'exclude')) {
    const bits = [];
    if (policy.interrailPass) bits.push('Interrail pass');
    if (policy.excludeEurostar) bits.push('no Eurostar');
    if (!policy.seatReservationsOk) bits.push('no reservations');
    if (policy.nightTrains !== 'exclude') bits.push(`night trains: ${policy.nightTrains}`);
    console.log('Rail policy: ' + bits.join(', '));
  }
  console.log(`Currency: ${currency} (${sym})   Optimising each tour for: ${optimiseFor}\n`);
  const header = `${'Mode'.padEnd(12)} ${'Distance'.padStart(10)} ${'Travel'.padStart(10)} ${'Cost'.padStart(11)} ${'Days'.padStart(6)}   Itinerary`;
  console.log(header);
  console.log('-'.repeat(header.length));
  const dash = (w) => '-'.padStart(w);
  for (const mode of modes) {
    if (starters && starters.length) {
      const r = await findBestMeet(cities, starters, mode, router, prices, opts, optimiseFor,
        policy, reservations, currency);
      if (!r.meet) {
        console.log(`${mode.name.padEnd(12)} ${dash(10)} ${dash(10)} ${dash(11)} ${dash(6)}   infeasible: ${r.reason}`);
        continue;
      }
      const { meet, sched, starterLegs } = r;
      let joint = sched.stops.map(fmtStop).join(' -> ');
      if (!isOpenPath) joint += ` -> ${sched.stops[0].name}`;
      const starterStr = starterLegs.map((l) =>
        `${l.start}->${meet.name} ${l.distance.toFixed(0)}km/${fmtTime(l.timeH).trim()}`).join(', ');
      const totalStarter = starterLegs.reduce((s, l) => s + l.cost, 0);
      const totalCost = sched.cost + totalStarter;
      const dist = `${sched.distance.toFixed(0)}km`.padStart(10);
      const time = fmtTime(sched.travelH).padStart(10);
      const cost = `${sym}${totalCost.toFixed(2)}`.padStart(11);
      const days = `${sched.totalDays}d`.padStart(6);
      console.log(`${mode.name.padEnd(12)} ${dist} ${time} ${cost} ${days}   meet at ${meet.name} [${starterStr}] then ${joint}`);
      continue;
    }
    const { tour, sched, reason } = await constrainedSearch(cities, mode, router, prices,
      opts, optimiseFor, policy, reservations, currency);
    if (!tour) {
      console.log(`${mode.name.padEnd(12)} ${dash(10)} ${dash(10)} ${dash(11)} ${dash(6)}   infeasible: ${reason}`);
      continue;
    }
    let names = sched.stops.map(fmtStop).join(' -> ');
    if (!isOpenPath) names += ` -> ${sched.stops[0].name}`;
    const dist = `${sched.distance.toFixed(0)}km`.padStart(10);
    const time = fmtTime(sched.travelH).padStart(10);
    const cost = `${sym}${sched.cost.toFixed(2)}`.padStart(11);
    const days = `${sched.totalDays}d`.padStart(6);
    console.log(`${mode.name.padEnd(12)} ${dist} ${time} ${cost} ${days}   ${names}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    interactive: false, city: [], citiesFile: null,
    geocoder: 'local', router: 'haversine', pricesFile: 'prices.json',
    enableScrapers: false,
    googleKey: process.env.GOOGLE_MAPS_API_KEY || null,
    serpapiKey: process.env.SERPAPI_KEY || null,
    amadeusKey: process.env.AMADEUS_API_KEY || null,
    amadeusSecret: process.env.AMADEUS_API_SECRET || null,
    amadeusProd: false,
    departDate: null,
    startCity: null, endCity: null, startDate: null,
    maxDays: null, daysPerCity: 1, stays: [], pins: [],
    interrail: true, excludeEurostar: false, noReservations: false,
    nightTrains: 'exclude',
    reservationsFile: 'interrail-reservations.json',
    meetFrom: [],
    currency: 'GBP',
    cacheFile: path.join(os.homedir(), '.tsp-tool-cache.json'),
    cacheTtl: 86400, noCache: false,
    optimise: 'time',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--interactive': out.interactive = true; break;
      case '--city': out.city.push(next()); break;
      case '--cities-file': out.citiesFile = next(); break;
      case '--geocoder': out.geocoder = next(); break;
      case '--router': out.router = next(); break;
      case '--prices-file': out.pricesFile = next(); break;
      case '--enable-scrapers': out.enableScrapers = true; break;
      case '--google-key': out.googleKey = next(); break;
      case '--serpapi-key': out.serpapiKey = next(); break;
      case '--amadeus-key': out.amadeusKey = next(); break;
      case '--amadeus-secret': out.amadeusSecret = next(); break;
      case '--amadeus-prod': out.amadeusProd = true; break;
      case '--depart-date': out.departDate = next(); break;
      case '--start': out.startCity = next(); break;
      case '--end': out.endCity = next(); break;
      case '--start-date': out.startDate = next(); break;
      case '--max-days': out.maxDays = parseInt(next(), 10); break;
      case '--days-per-city': out.daysPerCity = parseInt(next(), 10); break;
      case '--stay': out.stays.push(next()); break;
      case '--pin': out.pins.push(next()); break;
      case '--interrail': case '--interrail-pass': out.interrail = true; break;
      case '--no-pass': out.interrail = false; break;
      case '--reservations-file': out.reservationsFile = next(); break;
      case '--exclude-eurostar': out.excludeEurostar = true; break;
      case '--no-reservations': out.noReservations = true; break;
      case '--night-trains': out.nightTrains = next(); break;
      case '--meet-from': out.meetFrom.push(next()); break;
      case '--currency': out.currency = next(); break;
      case '--cache-file': out.cacheFile = next(); break;
      case '--cache-ttl': out.cacheTtl = parseInt(next(), 10); break;
      case '--no-cache': out.noCache = true; break;
      case '--optimise': out.optimise = next(); break;
      case '-h': case '--help':
        console.log('see file header for usage');
        process.exit(0);
      default:
        console.error(`unknown flag: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

function buildGeocoder(name, googleKey, cache) {
  const local = new LocalGazetteer();
  const wrap = (g) => (cache && cache.enabled) ? new CachedGeocoder(g, cache) : g;
  if (name === 'local') return local;
  if (name === 'nominatim') return new FallbackGeocoder(wrap(new NominatimGeocoder()), local);
  if (name === 'google') {
    if (!googleKey) {
      console.error('--geocoder google needs --google-key or $GOOGLE_MAPS_API_KEY; falling back to Nominatim.');
      return new FallbackGeocoder(wrap(new NominatimGeocoder()), local);
    }
    return new FallbackGeocoder(wrap(new GoogleGeocoder(googleKey)),
                                 wrap(new NominatimGeocoder()), local);
  }
  throw new Error(`unknown geocoder ${name}`);
}

function buildRouter(name, googleKey, cache) {
  const hav = new HaversineRouter();
  if (name === 'haversine') return hav;
  if (name === 'google') {
    if (!googleKey) {
      console.error('--router google needs --google-key or $GOOGLE_MAPS_API_KEY; falling back to haversine.');
      return hav;
    }
    const g = new GoogleRoutesRouter(googleKey, hav);
    return (cache && cache.enabled) ? new CachedRouter(g, cache) : g;
  }
  throw new Error(`unknown router ${name}`);
}

function buildPrices(modes, pricesFile, opts) {
  const { serpapiKey, amadeusKey, amadeusSecret, amadeusProd,
          departDate, enableScrapers, currency = 'GBP', cache = null } = opts;
  const config = new ConfigPrices(modes, pricesFile);
  let scraped = null;
  if (enableScrapers && pricesFile && fs.existsSync(pricesFile)) {
    const data = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
    if (data.scrapers) scraped = new ScrapedPerKmPrices(data.scrapers);
  }
  const flights = [];
  const needsDate = amadeusKey || serpapiKey;
  if (needsDate && !departDate) {
    console.error('flight API keys given without --depart-date; skipping live flight prices.');
  } else {
    if (amadeusKey && amadeusSecret && departDate) {
      flights.push(new AmadeusFlightPrices(amadeusKey, amadeusSecret, departDate,
        { useProd: !!amadeusProd, currency, cache }));
    } else if (amadeusKey && !amadeusSecret) {
      console.error('--amadeus-key given without --amadeus-secret; skipping Amadeus.');
    }
    if (serpapiKey && departDate) {
      flights.push(new SerpApiFlightPrices(serpapiKey, departDate, { currency, cache }));
    }
  }
  return new PriceStack(config, { scraped, flights });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['distance', 'time', 'cost'].includes(args.optimise)) {
    console.error(`--optimise must be distance|time|cost, got ${args.optimise}`);
    process.exit(2);
  }
  const cache = new JsonCache({ filePath: args.cacheFile, ttlSeconds: args.cacheTtl,
                                 enabled: !args.noCache });
  const geocoder = buildGeocoder(args.geocoder, args.googleKey, cache);
  const router = buildRouter(args.router, args.googleKey, cache);
  const prices = buildPrices(DEFAULT_MODES, args.pricesFile, {
    serpapiKey: args.serpapiKey,
    amadeusKey: args.amadeusKey,
    amadeusSecret: args.amadeusSecret,
    amadeusProd: args.amadeusProd,
    departDate: args.departDate,
    enableScrapers: args.enableScrapers,
    currency: args.currency,
    cache,
  });

  let cities = [];
  if (args.citiesFile) cities.push(...loadCitiesFile(args.citiesFile));
  for (const name of args.city) {
    const c = await resolveCity(name, geocoder);
    if (!c) { console.error(`could not geocode ${JSON.stringify(name)}`); process.exit(2); }
    cities.push(c);
  }
  if (args.interactive) cities.push(...(await promptCities(geocoder)));
  if (!cities.length) cities.push(...DEFAULT_CITIES);
  if (cities.length < 2) { console.error('need at least 2 cities'); process.exit(2); }

  const stays = {};
  for (const spec of args.stays) {
    const eq = spec.indexOf('=');
    if (eq < 0) { console.error(`--stay expects CITY=DAYS, got ${spec}`); process.exit(2); }
    stays[spec.slice(0, eq).trim()] = parseInt(spec.slice(eq + 1), 10);
  }
  const pins = {};
  for (const spec of args.pins) {
    const eq = spec.indexOf('=');
    if (eq < 0) { console.error(`--pin expects CITY=YYYY-MM-DD, got ${spec}`); process.exit(2); }
    pins[spec.slice(0, eq).trim()] = parseISODate(spec.slice(eq + 1).trim());
  }
  const cityNames = new Set(cities.map((c) => c.name));
  if (args.startCity && !cityNames.has(args.startCity)) { console.error(`--start ${args.startCity} not in cities`); process.exit(2); }
  if (args.endCity && !cityNames.has(args.endCity)) { console.error(`--end ${args.endCity} not in cities`); process.exit(2); }
  for (const n of [...Object.keys(stays), ...Object.keys(pins)]) {
    if (!cityNames.has(n)) { console.error(`--stay/--pin city ${n} not in cities`); process.exit(2); }
  }

  if (args.startCity) {
    const idx = cities.findIndex((c) => c.name === args.startCity);
    if (idx > 0) cities = [cities[idx], ...cities.slice(0, idx), ...cities.slice(idx + 1)];
  }

  const opts = {
    startDate: args.startDate ? parseISODate(args.startDate) : null,
    daysPerCity: args.daysPerCity,
    stays, pins,
    maxDays: args.maxDays,
    startCity: args.startCity || cities[0].name,
    endCity: args.endCity,
  };

  if (!['include', 'exclude', 'only'].includes(args.nightTrains)) {
    console.error(`--night-trains must be include|exclude|only, got ${args.nightTrains}`);
    process.exit(2);
  }
  const policy = {
    ...DEFAULT_TRAIN_POLICY,
    interrailPass: args.interrail,
    excludeEurostar: args.excludeEurostar,
    seatReservationsOk: !args.noReservations,
    nightTrains: args.nightTrains,
  };
  applyPassPricing(prices, policy);
  const modes = filterTrainModes(prices.modes(), policy);
  const reservations = new ReservationLookup(args.reservationsFile);

  const starters = [];
  for (const name of args.meetFrom) {
    const c = await resolveCity(name, geocoder);
    if (!c) { console.error(`could not geocode --meet-from ${name}`); process.exit(2); }
    starters.push(c);
  }

  await report(cities, modes, router, prices, args.optimise, opts, policy,
               { starters: starters.length ? starters : null,
                 currency: args.currency, reservations });
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  haversineKm, legCost, computeSchedule, constrainedSearch, report,
  parseISODate, addDays, isoDate, fmtMonDay,
  LocalGazetteer, NominatimGeocoder, GoogleGeocoder, FallbackGeocoder,
  HaversineRouter, GoogleRoutesRouter,
  ConfigPrices, SerpApiFlightPrices, AmadeusFlightPrices, ScrapedPerKmPrices, PriceStack,
  DEFAULT_MODES, DEFAULT_CITIES,
};
