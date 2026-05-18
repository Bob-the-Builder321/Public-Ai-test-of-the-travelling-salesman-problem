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
const readline = require('readline');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MODES = [
  { name: 'ICE car', detourFactor: 1.30, avgSpeedKmh: 90,  costPerKm: 0.15, fixedTimePerLegH: 0.00, fixedCostPerLeg: 0  },
  { name: 'EV car',  detourFactor: 1.30, avgSpeedKmh: 90,  costPerKm: 0.05, fixedTimePerLegH: 0.00, fixedCostPerLeg: 0  },
  { name: 'Coach',   detourFactor: 1.35, avgSpeedKmh: 65,  costPerKm: 0.04, fixedTimePerLegH: 0.25, fixedCostPerLeg: 1  },
  { name: 'Train',   detourFactor: 1.20, avgSpeedKmh: 120, costPerKm: 0.12, fixedTimePerLegH: 0.25, fixedCostPerLeg: 2  },
  { name: 'Flight',  detourFactor: 1.00, avgSpeedKmh: 700, costPerKm: 0.20, fixedTimePerLegH: 2.50, fixedCostPerLeg: 30 },
];

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
    this.byName = Object.fromEntries(modes.map((m) => [m.name, { ...m }]));
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
  constructor(apiKey, departDate, currency = 'GBP') {
    this.apiKey = apiKey;
    this.departDate = departDate;
    this.currency = currency;
    this.cache = new Map();
  }
  async legPrice(modeName, a, b) {
    if (modeName !== 'Flight') return null;
    const key = `${a.name}|${b.name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: a.name,
      arrival_id: b.name,
      outbound_date: this.departDate,
      type: '2',
      currency: this.currency,
      api_key: this.apiKey,
    });
    try {
      const data = await httpGetJson(`https://serpapi.com/search?${params.toString()}`, { timeoutMs: 20000 });
      const flights = (data.best_flights && data.best_flights.length ? data.best_flights : data.other_flights) || [];
      let price = null;
      for (const f of flights) {
        if (f.price != null) { price = Number(f.price); break; }
      }
      this.cache.set(key, price);
      return price;
    } catch (e) {
      console.error(`  ! SerpAPI flights ${a.name}->${b.name}: ${e.message}`);
      this.cache.set(key, null);
      return null;
    }
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

  constructor(apiKey, apiSecret, departDate, { currency = 'GBP', useProd = false } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.departDate = departDate;
    this.currency = currency;
    this.base = useProd ? AmadeusFlightPrices.PROD_BASE : AmadeusFlightPrices.TEST_BASE;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.airportCache = new Map();
    this.priceCache = new Map();
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
    try {
      const data = await this._authedGet('/v1/reference-data/locations/airports', {
        latitude: city.lat.toFixed(4),
        longitude: city.lon.toFixed(4),
        radius: '200',
        'page[limit]': '1',
        sort: 'relevance',
      });
      const results = (data && data.data) || [];
      const iata = results[0] ? results[0].iataCode : null;
      this.airportCache.set(key, iata);
      return iata;
    } catch (e) {
      console.error(`  ! Amadeus airport lookup for ${city.name}: ${e.message}`);
      this.airportCache.set(key, null);
      return null;
    }
  }

  async legPrice(modeName, a, b) {
    if (modeName !== 'Flight') return null;
    const cacheKey = `${a.name}|${b.name}`;
    if (this.priceCache.has(cacheKey)) return this.priceCache.get(cacheKey);
    const [orig, dest] = await Promise.all([this._nearestAirport(a), this._nearestAirport(b)]);
    if (!orig || !dest || orig === dest) { this.priceCache.set(cacheKey, null); return null; }
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
      const price = offers[0] ? Number(offers[0].price.grandTotal) : null;
      this.priceCache.set(cacheKey, price);
      return price;
    } catch (e) {
      console.error(`  ! Amadeus flight search ${orig}->${dest}: ${e.message}`);
      this.priceCache.set(cacheKey, null);
      return null;
    }
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

async function legCost(mode, a, b, router, prices) {
  const { distance, timeH } = await router.route(mode, a, b);
  const absolute = await prices.legPrice(mode.name, a, b);
  const cost = absolute != null
    ? absolute
    : distance * (await prices.perKm(mode.name)) + prices.perLegFixed(mode.name);
  return { distance, timeH, cost };
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

async function computeSchedule(tour, cities, mode, router, prices, opts) {
  const startName = opts.startCity || cities[tour[0]].name;
  const isOpenPath = !!opts.endCity && opts.endCity !== startName;
  let distance = 0, travelH = 0, cost = 0, elapsedH = 0;
  const stops = [];

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
      const leg = await legCost(mode, c, nxt, router, prices);
      distance += leg.distance; travelH += leg.timeH; cost += leg.cost;
      elapsedH += leg.timeH;
    }
  }

  if (!isOpenPath && tour.length > 1) {
    const first = cities[tour[0]], last = cities[tour[tour.length - 1]];
    const leg = await legCost(mode, last, first, router, prices);
    distance += leg.distance; travelH += leg.timeH; cost += leg.cost;
    elapsedH += leg.timeH;
  }

  const totalDays = Math.max(1, Math.ceil(elapsedH / 24));

  let reason = null;
  if (opts.maxDays != null && totalDays > opts.maxDays) {
    reason = `trip is ${totalDays}d, exceeds max ${opts.maxDays}d`;
  } else if (opts.pins && Object.keys(opts.pins).length && !opts.startDate) {
    reason = 'pins set but no startDate given';
  } else if (opts.pins) {
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

async function constrainedSearch(cities, mode, router, prices, opts, objective) {
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
      const sched = await computeSchedule(assemble(perm), cities, mode, router, prices, opts);
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
        const leg = await legCost(mode, cities[last], cities[j], router, prices);
        const v = objective === 'distance' ? leg.distance : objective === 'time' ? leg.timeH : leg.cost;
        if (v < bestVal) { bestVal = v; best = j; }
      }
      seq.push(best); unv.delete(best); last = best;
    }
    return seq;
  }

  async function twoOptConstrained(perm) {
    let cur = perm.slice();
    let curSched = await computeSchedule(assemble(cur), cities, mode, router, prices, opts);
    let curVal = curSched.feasible ? pickObjective(curSched, objective) : Infinity;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < cur.length - 1; i++) {
        for (let j = i + 1; j < cur.length; j++) {
          const cand = cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1));
          const candSched = await computeSchedule(assemble(cand), cities, mode, router, prices, opts);
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

function fmtStop(stop) {
  if (!stop.arrive) return stop.name;
  if (stop.arrive.getTime() === stop.depart.getTime()) return `${stop.name}(${fmtMonDay(stop.arrive)})`;
  return `${stop.name}(${fmtMonDay(stop.arrive)}-${fmtMonDay(stop.depart)})`;
}

async function report(cities, modes, router, prices, optimiseFor, opts) {
  const startName = opts.startCity || cities[0].name;
  const isOpenPath = !!opts.endCity && opts.endCity !== startName;
  console.log(`Cities (${cities.length}): ${cities.map((c) => c.name).join(', ')}`);
  let line = `Start: ${startName}` + (isOpenPath ? `   End: ${opts.endCity}` : '   (closed loop)');
  if (opts.startDate) line += `   Start date: ${isoDate(opts.startDate)}`;
  if (opts.maxDays != null) line += `   Max days: ${opts.maxDays}`;
  console.log(line);
  if (opts.pins && Object.keys(opts.pins).length) {
    console.log('Pins: ' + Object.entries(opts.pins).map(([n, d]) => `${n}@${isoDate(d)}`).join(', '));
  }
  console.log(`Optimising each tour for: ${optimiseFor}\n`);
  const header = `${'Mode'.padEnd(10)} ${'Distance'.padStart(10)} ${'Travel'.padStart(10)} ${'Cost'.padStart(10)} ${'Days'.padStart(6)}   Itinerary`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const mode of modes) {
    const { tour, sched, reason } = await constrainedSearch(cities, mode, router, prices, opts, optimiseFor);
    if (!tour) {
      const dash = (w) => '-'.padStart(w);
      console.log(`${mode.name.padEnd(10)} ${dash(10)} ${dash(10)} ${dash(10)} ${dash(6)}   infeasible: ${reason}`);
      continue;
    }
    let names = sched.stops.map(fmtStop).join(' -> ');
    if (!isOpenPath) names += ` -> ${sched.stops[0].name}`;
    const dist = `${sched.distance.toFixed(0)}km`.padStart(10);
    const time = fmtTime(sched.travelH).padStart(10);
    const cost = `£${sched.cost.toFixed(2)}`.padStart(10);
    const days = `${sched.totalDays}d`.padStart(6);
    console.log(`${mode.name.padEnd(10)} ${dist} ${time} ${cost} ${days}   ${names}`);
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

function buildGeocoder(name, googleKey) {
  const local = new LocalGazetteer();
  if (name === 'local') return local;
  if (name === 'nominatim') return new FallbackGeocoder(new NominatimGeocoder(), local);
  if (name === 'google') {
    if (!googleKey) {
      console.error('--geocoder google needs --google-key or $GOOGLE_MAPS_API_KEY; falling back to Nominatim.');
      return new FallbackGeocoder(new NominatimGeocoder(), local);
    }
    return new FallbackGeocoder(new GoogleGeocoder(googleKey), new NominatimGeocoder(), local);
  }
  throw new Error(`unknown geocoder ${name}`);
}

function buildRouter(name, googleKey) {
  const hav = new HaversineRouter();
  if (name === 'haversine') return hav;
  if (name === 'google') {
    if (!googleKey) {
      console.error('--router google needs --google-key or $GOOGLE_MAPS_API_KEY; falling back to haversine.');
      return hav;
    }
    return new GoogleRoutesRouter(googleKey, hav);
  }
  throw new Error(`unknown router ${name}`);
}

function buildPrices(modes, pricesFile, opts) {
  const { serpapiKey, amadeusKey, amadeusSecret, amadeusProd, departDate, enableScrapers } = opts;
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
      flights.push(new AmadeusFlightPrices(amadeusKey, amadeusSecret, departDate, { useProd: !!amadeusProd }));
    } else if (amadeusKey && !amadeusSecret) {
      console.error('--amadeus-key given without --amadeus-secret; skipping Amadeus.');
    }
    if (serpapiKey && departDate) flights.push(new SerpApiFlightPrices(serpapiKey, departDate));
  }
  return new PriceStack(config, { scraped, flights });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['distance', 'time', 'cost'].includes(args.optimise)) {
    console.error(`--optimise must be distance|time|cost, got ${args.optimise}`);
    process.exit(2);
  }
  const geocoder = buildGeocoder(args.geocoder, args.googleKey);
  const router = buildRouter(args.router, args.googleKey);
  const prices = buildPrices(DEFAULT_MODES, args.pricesFile, {
    serpapiKey: args.serpapiKey,
    amadeusKey: args.amadeusKey,
    amadeusSecret: args.amadeusSecret,
    amadeusProd: args.amadeusProd,
    departDate: args.departDate,
    enableScrapers: args.enableScrapers,
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

  await report(cities, prices.modes(), router, prices, args.optimise, opts);
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
