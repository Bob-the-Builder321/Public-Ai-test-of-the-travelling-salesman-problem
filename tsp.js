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
  constructor(config, { scraped = null, flights = null } = {}) {
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
    if (this.flights) {
      const v = await this.flights.legPrice(name, a, b);
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

async function buildMatrix(cities, mode, router, prices, metric) {
  const n = cities.length;
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const { distance, timeH, cost } = await legCost(mode, cities[i], cities[j], router, prices);
      const v = metric === 'distance' ? distance : metric === 'time' ? timeH : cost;
      m[i][j] = m[j][i] = v;
    }
  }
  return m;
}

function tourTotal(tour, matrix) {
  let total = 0;
  for (let i = 0; i < tour.length; i++) total += matrix[tour[i]][tour[(i + 1) % tour.length]];
  return total;
}

function nearestNeighbor(start, matrix) {
  const n = matrix.length;
  const unvisited = new Set();
  for (let i = 0; i < n; i++) if (i !== start) unvisited.add(i);
  const tour = [start];
  while (unvisited.size) {
    const last = tour[tour.length - 1];
    let best = -1, bestD = Infinity;
    for (const j of unvisited) {
      if (matrix[last][j] < bestD) { bestD = matrix[last][j]; best = j; }
    }
    tour.push(best);
    unvisited.delete(best);
  }
  return tour;
}

function twoOpt(tour, matrix) {
  const n = tour.length;
  const best = tour.slice();
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = best[i], b = best[i + 1], c = best[j], d = best[(j + 1) % n];
        const delta = matrix[a][c] + matrix[b][d] - (matrix[a][b] + matrix[c][d]);
        if (delta < -1e-9) {
          let lo = i + 1, hi = j;
          while (lo < hi) { const t = best[lo]; best[lo] = best[hi]; best[hi] = t; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return best;
}

function solveTsp(matrix) {
  const n = matrix.length;
  let bestTour = null, bestLen = Infinity;
  for (let s = 0; s < n; s++) {
    const t = twoOpt(nearestNeighbor(s, matrix), matrix);
    const len = tourTotal(t, matrix);
    if (len < bestLen) { bestLen = len; bestTour = t; }
  }
  return bestTour;
}

async function summariseTour(tour, cities, mode, router, prices) {
  let distance = 0, timeH = 0, cost = 0;
  for (let i = 0; i < tour.length; i++) {
    const leg = await legCost(mode, cities[tour[i]], cities[tour[(i + 1) % tour.length]], router, prices);
    distance += leg.distance; timeH += leg.timeH; cost += leg.cost;
  }
  return { distance, timeH, cost };
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
  const cities = [];
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

async function report(cities, modes, router, prices, optimiseFor) {
  console.log(`Cities (${cities.length}): ${cities.map((c) => c.name).join(', ')}`);
  console.log(`Optimising each tour for: ${optimiseFor}\n`);
  const header = `${'Mode'.padEnd(10)} ${'Distance'.padStart(10)} ${'Time'.padStart(10)} ${'Cost'.padStart(10)}   Tour`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const mode of modes) {
    const matrix = await buildMatrix(cities, mode, router, prices, optimiseFor);
    const tour = solveTsp(matrix);
    const s = await summariseTour(tour, cities, mode, router, prices);
    const names = tour.concat([tour[0]]).map((i) => cities[i].name).join(' -> ');
    const dist = `${s.distance.toFixed(0)}km`.padStart(10);
    const time = fmtTime(s.timeH).padStart(10);
    const cost = `£${s.cost.toFixed(2)}`.padStart(10);
    console.log(`${mode.name.padEnd(10)} ${dist} ${time} ${cost}   ${names}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    interactive: false, city: [], citiesFile: null,
    geocoder: 'local', router: 'haversine', pricesFile: 'prices.json',
    enableScrapers: false, googleKey: process.env.GOOGLE_MAPS_API_KEY || null,
    serpapiKey: process.env.SERPAPI_KEY || null, departDate: null,
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
      case '--depart-date': out.departDate = next(); break;
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

function buildPrices(modes, pricesFile, serpapiKey, departDate, enableScrapers) {
  const config = new ConfigPrices(modes, pricesFile);
  let scraped = null;
  if (enableScrapers && pricesFile && fs.existsSync(pricesFile)) {
    const data = JSON.parse(fs.readFileSync(pricesFile, 'utf8'));
    if (data.scrapers) scraped = new ScrapedPerKmPrices(data.scrapers);
  }
  let flights = null;
  if (serpapiKey) {
    if (!departDate) {
      console.error('--serpapi-key given without --depart-date; skipping live flight prices.');
    } else {
      flights = new SerpApiFlightPrices(serpapiKey, departDate);
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
  const geocoder = buildGeocoder(args.geocoder, args.googleKey);
  const router = buildRouter(args.router, args.googleKey);
  const prices = buildPrices(DEFAULT_MODES, args.pricesFile, args.serpapiKey, args.departDate, args.enableScrapers);

  const cities = [];
  if (args.citiesFile) cities.push(...loadCitiesFile(args.citiesFile));
  for (const name of args.city) {
    const c = await resolveCity(name, geocoder);
    if (!c) { console.error(`could not geocode ${JSON.stringify(name)}`); process.exit(2); }
    cities.push(c);
  }
  if (args.interactive) cities.push(...(await promptCities(geocoder)));
  if (!cities.length) cities.push(...DEFAULT_CITIES);
  if (cities.length < 2) { console.error('need at least 2 cities'); process.exit(2); }

  await report(cities, prices.modes(), router, prices, args.optimise);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  haversineKm, legCost, solveTsp, report,
  LocalGazetteer, NominatimGeocoder, GoogleGeocoder, FallbackGeocoder,
  HaversineRouter, GoogleRoutesRouter,
  ConfigPrices, SerpApiFlightPrices, ScrapedPerKmPrices, PriceStack,
  DEFAULT_MODES, DEFAULT_CITIES,
};
