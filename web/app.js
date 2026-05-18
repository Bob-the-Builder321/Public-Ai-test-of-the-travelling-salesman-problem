// Browser version of the multi-transport TSP comparison.
// Default path is fully offline (built-in gazetteer + haversine + config prices).
// Opting into Google Maps loads the official JS SDK; opting into SerpAPI
// attempts a direct fetch (which usually needs a proxy due to CORS).

'use strict';

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
  london: [51.5074, -0.1278], manchester: [53.4808, -2.2426], edinburgh: [55.9533, -3.1883],
  cardiff: [51.4816, -3.1791], belfast: [54.5973, -5.9301], birmingham: [52.4862, -1.8904],
  glasgow: [55.8642, -4.2518], bristol: [51.4545, -2.5879], paris: [48.8566, 2.3522],
  berlin: [52.5200, 13.4050], rome: [41.9028, 12.4964], madrid: [40.4168, -3.7038],
  dublin: [53.3498, -6.2603], amsterdam: [52.3676, 4.9041], 'new york': [40.7128, -74.0060],
  tokyo: [35.6762, 139.6503],
};

// ---------------------------------------------------------------------------
// Geocoders (all return Promise<{lat,lon}|null>)
// ---------------------------------------------------------------------------

const LocalGazetteer = {
  async geocode(name) {
    const v = LOCAL_GAZETTEER[name.trim().toLowerCase()];
    return v ? { lat: v[0], lon: v[1] } : null;
  },
};

const NominatimGeocoder = {
  async geocode(name) {
    const q = new URLSearchParams({ q: name, format: 'json', limit: '1' }).toString();
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?${q}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.length) return null;
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    } catch (e) {
      console.warn('Nominatim:', e.message);
      return null;
    }
  },
};

class GoogleGeocoder {
  constructor(geocoder) { this.geocoder = geocoder; }
  async geocode(name) {
    return new Promise((resolve) => {
      this.geocoder.geocode({ address: name }, (results, status) => {
        if (status === 'OK' && results[0]) {
          const loc = results[0].geometry.location;
          resolve({ lat: loc.lat(), lon: loc.lng() });
        } else {
          console.warn('Google geocode:', status);
          resolve(null);
        }
      });
    });
  }
}

class FallbackGeocoder {
  constructor(list) { this.list = list; }
  async geocode(name) {
    for (const g of this.list) {
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
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const HaversineRouter = {
  async route(mode, a, b) {
    const distance = haversineKm(a, b) * mode.detourFactor;
    const timeH = distance / mode.avgSpeedKmh + mode.fixedTimePerLegH;
    return { distance, timeH };
  },
};

class GoogleRoutesRouter {
  static GOOGLE_MODE = {
    'ICE car': { travelMode: 'DRIVING' },
    'EV car':  { travelMode: 'DRIVING' },
    'Coach':   { travelMode: 'TRANSIT', transitOptions: { modes: ['BUS'] } },
    'Train':   { travelMode: 'TRANSIT', transitOptions: { modes: ['RAIL'] } },
  };

  constructor(service, fallback) { this.service = service; this.fallback = fallback; }

  async route(mode, a, b) {
    const cfg = GoogleRoutesRouter.GOOGLE_MODE[mode.name];
    if (!cfg) return this.fallback.route(mode, a, b);
    const req = {
      origins: [new google.maps.LatLng(a.lat, a.lon)],
      destinations: [new google.maps.LatLng(b.lat, b.lon)],
      travelMode: cfg.travelMode,
    };
    if (cfg.transitOptions) req.transitOptions = cfg.transitOptions;
    try {
      const res = await new Promise((resolve, reject) => {
        this.service.getDistanceMatrix(req, (resp, status) => {
          if (status === 'OK') resolve(resp);
          else reject(new Error(status));
        });
      });
      const el = res.rows[0].elements[0];
      if (el.status === 'OK') {
        return {
          distance: el.distance.value / 1000,
          timeH: el.duration.value / 3600 + mode.fixedTimePerLegH,
        };
      }
      console.warn(`Google route ${mode.name} ${a.name}->${b.name}: ${el.status}`);
    } catch (e) {
      console.warn(`Google route ${mode.name} ${a.name}->${b.name}: ${e.message}`);
    }
    return this.fallback.route(mode, a, b);
  }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

class ConfigPrices {
  constructor(modes) { this.byName = Object.fromEntries(modes.map((m) => [m.name, { ...m }])); }
  perKm(name) { return this.byName[name].costPerKm; }
  perLegFixed(name) { return this.byName[name].fixedCostPerLeg; }
  async legPrice() { return null; }
  modes() { return Object.values(this.byName); }
  update(name, field, value) { if (this.byName[name]) this.byName[name][field] = value; }
}

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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const payload = await r.json();
      this.token = payload.access_token;
      this.tokenExpiresAt = Date.now() / 1000 + (payload.expires_in || 1799);
      return this.token;
    } catch (e) {
      console.warn('Amadeus auth:', e.message);
      return null;
    }
  }

  async _authedGet(path, params) {
    const token = await this._getToken();
    if (!token) return null;
    const r = await fetch(`${this.base}${path}?${new URLSearchParams(params).toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
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
      console.warn(`Amadeus airport ${city.name}:`, e.message);
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
      console.warn(`Amadeus flight ${orig}->${dest}:`, e.message);
      this.priceCache.set(cacheKey, null);
      return null;
    }
  }
}

class SerpApiFlightPrices {
  constructor(apiKey, departDate, currency = 'GBP') {
    this.apiKey = apiKey; this.departDate = departDate; this.currency = currency;
    this.cache = new Map();
  }
  async legPrice(modeName, a, b) {
    if (modeName !== 'Flight') return null;
    const key = `${a.name}|${b.name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: a.name, arrival_id: b.name,
      outbound_date: this.departDate, type: '2',
      currency: this.currency, api_key: this.apiKey,
    });
    try {
      const r = await fetch(`https://serpapi.com/search?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const list = (data.best_flights && data.best_flights.length ? data.best_flights : data.other_flights) || [];
      const price = list.find((f) => f.price != null);
      const value = price ? Number(price.price) : null;
      this.cache.set(key, value);
      return value;
    } catch (e) {
      console.warn(`SerpAPI ${a.name}->${b.name}: ${e.message}`);
      this.cache.set(key, null);
      return null;
    }
  }
}

class PriceStack {
  constructor(config, { flights = [] } = {}) { this.config = config; this.flights = flights; }
  async perKm(name) { return this.config.perKm(name); }
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

function tourTotal(t, M) { let s = 0; for (let i = 0; i < t.length; i++) s += M[t[i]][t[(i + 1) % t.length]]; return s; }

function nearestNeighbor(start, M) {
  const n = M.length;
  const u = new Set();
  for (let i = 0; i < n; i++) if (i !== start) u.add(i);
  const tour = [start];
  while (u.size) {
    const last = tour[tour.length - 1];
    let best = -1, bestD = Infinity;
    for (const j of u) if (M[last][j] < bestD) { bestD = M[last][j]; best = j; }
    tour.push(best); u.delete(best);
  }
  return tour;
}

function twoOpt(tour, M) {
  const n = tour.length;
  const best = tour.slice();
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = best[i], b = best[i + 1], c = best[j], d = best[(j + 1) % n];
        const delta = M[a][c] + M[b][d] - (M[a][b] + M[c][d]);
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

function solveTsp(M) {
  let bestTour = null, bestLen = Infinity;
  for (let s = 0; s < M.length; s++) {
    const t = twoOpt(nearestNeighbor(s, M), M);
    const len = tourTotal(t, M);
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

function fmtTime(hours) {
  let h = Math.floor(hours);
  let m = Math.round((hours - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// State + UI
// ---------------------------------------------------------------------------

const state = {
  cities: [],
  prices: new ConfigPrices(DEFAULT_MODES),
  googleLoaded: false,
  googleGeocoder: null,
  googleService: null,
};

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

function renderCities() {
  const ul = $('city-list');
  ul.innerHTML = '';
  if (!state.cities.length) {
    ul.innerHTML = '<li class="hint" style="background:transparent;border:0;">No destinations yet. Add some above, or click "Load UK defaults".</li>';
    return;
  }
  state.cities.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="name"></span>
      <span class="coords"></span>
      <button title="Remove" aria-label="Remove">×</button>
    `;
    li.querySelector('.name').textContent = c.name;
    li.querySelector('.coords').textContent = `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`;
    li.querySelector('button').onclick = () => { state.cities.splice(i, 1); renderCities(); };
    ul.appendChild(li);
  });
}

function renderPriceTable() {
  const tbody = $('price-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const m of state.prices.modes()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td></td>
      <td><input type="number" step="0.01" data-field="costPerKm"></td>
      <td><input type="number" step="1"    data-field="avgSpeedKmh"></td>
      <td><input type="number" step="0.05" data-field="detourFactor"></td>
      <td><input type="number" step="0.5"  data-field="fixedCostPerLeg"></td>
      <td><input type="number" step="0.25" data-field="fixedTimePerLegH"></td>
    `;
    tr.children[0].textContent = m.name;
    const inputs = tr.querySelectorAll('input');
    inputs.forEach((inp) => {
      const f = inp.dataset.field;
      inp.value = m[f];
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) state.prices.update(m.name, f, v);
      });
    });
    tbody.appendChild(tr);
  }
}

function activeGeocoder() {
  const list = [LocalGazetteer];
  if ($('use-google-geocode').checked && state.googleGeocoder) {
    list.unshift(new GoogleGeocoder(state.googleGeocoder));
  }
  // Nominatim always tried before falling back to local-only, since it's free and CORS-friendly.
  list.splice(list.length - 1 + 1, 0, NominatimGeocoder);
  return new FallbackGeocoder(list);
}

function activeRouter() {
  if ($('use-google-routes').checked && state.googleService) {
    return new GoogleRoutesRouter(state.googleService, HaversineRouter);
  }
  return HaversineRouter;
}

function activePrices() {
  const flights = [];
  if ($('use-amadeus').checked) {
    const key = $('amadeus-key').value.trim();
    const secret = $('amadeus-secret').value.trim();
    const date = $('amadeus-date').value;
    const useProd = $('amadeus-prod').checked;
    if (key && secret && date) flights.push(new AmadeusFlightPrices(key, secret, date, { useProd }));
  }
  if ($('use-serpapi').checked) {
    const key = $('serpapi-key').value.trim();
    const date = $('depart-date').value;
    if (key && date) flights.push(new SerpApiFlightPrices(key, date));
  }
  return new PriceStack(state.prices, { flights });
}

async function addCity(rawName) {
  const name = rawName.trim();
  if (!name) return;
  setStatus(`Looking up "${name}"…`);
  const r = await activeGeocoder().geocode(name);
  if (r) {
    state.cities.push({ name, lat: r.lat, lon: r.lon });
    renderCities();
    setStatus(`Added ${name}.`, 'ok');
  } else {
    const manual = prompt(`Could not find "${name}". Enter coordinates as "lat,lon" or cancel:`);
    if (!manual) { setStatus(`Skipped ${name}.`); return; }
    const parts = manual.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      state.cities.push({ name, lat: parts[0], lon: parts[1] });
      renderCities();
      setStatus(`Added ${name} (manual coordinates).`, 'ok');
    } else {
      setStatus(`Bad coordinates for ${name}.`, 'error');
    }
  }
}

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (state.googleLoaded) return resolve();
    const cb = `__googleMapsCb_${Date.now()}`;
    window[cb] = () => {
      state.googleLoaded = true;
      state.googleGeocoder = new google.maps.Geocoder();
      state.googleService = new google.maps.DistanceMatrixService();
      delete window[cb];
      resolve();
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${cb}`;
    s.async = true;
    s.onerror = () => reject(new Error('failed to load Google Maps JS SDK'));
    document.head.appendChild(s);
  });
}

async function run() {
  if (state.cities.length < 2) { setStatus('Need at least 2 destinations.', 'error'); return; }
  const optimise = document.querySelector('input[name="optimise"]:checked').value;
  const router = activeRouter();
  const prices = activePrices();

  $('run').disabled = true;
  setStatus('Computing tours…');
  try {
    const rows = [];
    for (const mode of prices.modes()) {
      const M = await buildMatrix(state.cities, mode, router, prices, optimise);
      const tour = solveTsp(M);
      const s = await summariseTour(tour, state.cities, mode, router, prices);
      const names = tour.concat([tour[0]]).map((i) => state.cities[i].name).join(' → ');
      rows.push({ mode: mode.name, distance: s.distance, timeH: s.timeH, cost: s.cost, names });
    }
    renderResults(rows, optimise);
    setStatus(`Done. Optimised for ${optimise}.`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, 'error');
  } finally {
    $('run').disabled = false;
  }
}

function renderResults(rows, optimise) {
  $('results-card').hidden = false;
  $('results-meta').textContent =
    `${state.cities.length} destinations · tour minimises ${optimise} per mode · prices in GBP.`;

  const winners = {
    distance: Math.min(...rows.map((r) => r.distance)),
    time:     Math.min(...rows.map((r) => r.timeH)),
    cost:     Math.min(...rows.map((r) => r.cost)),
  };

  const tbody = $('results-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (
      (optimise === 'distance' && r.distance === winners.distance) ||
      (optimise === 'time' && r.timeH === winners.time) ||
      (optimise === 'cost' && r.cost === winners.cost)
    ) tr.classList.add('best');
    tr.innerHTML = `
      <td></td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="tour"></td>
    `;
    tr.children[0].textContent = r.mode;
    tr.children[1].textContent = `${r.distance.toFixed(0)} km`;
    tr.children[2].textContent = fmtTime(r.timeH);
    tr.children[3].textContent = `£${r.cost.toFixed(2)}`;
    tr.children[4].textContent = r.names;
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  renderPriceTable();
  renderCities();

  $('add-city').addEventListener('click', () => {
    const inp = $('city-name');
    addCity(inp.value).then(() => { inp.value = ''; inp.focus(); });
  });
  $('city-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('add-city').click(); }
  });
  $('add-defaults').addEventListener('click', () => {
    state.cities = DEFAULT_CITIES.map((c) => ({ ...c }));
    renderCities();
    setStatus('Loaded UK defaults.', 'ok');
  });
  $('clear-cities').addEventListener('click', () => {
    state.cities = [];
    renderCities();
    setStatus('');
  });

  $('load-google').addEventListener('click', async () => {
    const key = $('google-key').value.trim();
    if (!key) { setStatus('Paste your Google Maps API key first.', 'error'); return; }
    setStatus('Loading Google Maps SDK…');
    try {
      await loadGoogleMaps(key);
      setStatus('Google Maps SDK loaded.', 'ok');
      $('use-google-geocode').checked = true;
      $('use-google-routes').checked = true;
    } catch (e) {
      setStatus(`Google Maps SDK failed: ${e.message}`, 'error');
    }
  });

  $('run').addEventListener('click', run);
});
