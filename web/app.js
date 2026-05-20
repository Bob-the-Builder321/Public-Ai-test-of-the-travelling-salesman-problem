// Browser version of the multi-transport TSP comparison.
// Default path is fully offline (built-in gazetteer + haversine + config prices).
// Opting into Google Maps loads the official JS SDK; opting into SerpAPI
// attempts a direct fetch (which usually needs a proxy due to CORS).

'use strict';

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
  makeMode('ICE car',     1.30,  90, 0.15, 0.00, 0.00, 0.00, 0),
  makeMode('EV car',      1.30,  90, 0.05, 0.00, 0.00, 0.00, 0),
  makeMode('Coach',       1.35,  65, 0.04, 0.25, 0.25, 0.25, 1),
  makeMode('Train',       1.20, 120, 0.12, 0.25, 0.25, 0.25, 2),
  makeMode('Night train', 1.20,  80, 0.10, 0.25, 0.50, 0.25, 30),
  makeMode('Flight',      1.00, 700, 0.20, 0.75, 2.00, 0.75, 30),
];

const CURRENCY_SYMBOLS = {
  GBP: '£', EUR: '€', USD: '$', CAD: 'C$', AUD: 'A$', NZD: 'NZ$',
  JPY: '¥', CNY: '¥', INR: '₹', CHF: 'CHF', SEK: 'kr', NOK: 'kr',
  DKK: 'kr', PLN: 'zł', CZK: 'Kč', HUF: 'Ft',
};
function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code.toUpperCase()] || (code.toUpperCase() + ' ');
}

class LocalStorageCache {
  constructor({ prefix = 'tsp:', ttlSeconds = 86400, enabled = true } = {}) {
    this.prefix = prefix;
    this.ttl = ttlSeconds;
    this.enabled = enabled && typeof localStorage !== 'undefined';
  }
  get(key) {
    if (!this.enabled) return undefined;
    try {
      const raw = localStorage.getItem(this.prefix + key);
      if (!raw) return undefined;
      const e = JSON.parse(raw);
      if ((Date.now() / 1000) - (e.ts || 0) > this.ttl) return undefined;
      return e.v;
    } catch { return undefined; }
  }
  set(key, value) {
    if (!this.enabled) return;
    try { localStorage.setItem(this.prefix + key, JSON.stringify({ ts: Date.now() / 1000, v: value })); }
    catch { /* quota or disabled */ }
  }
  clear() {
    if (!this.enabled) return;
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.prefix)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  }
}

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

// Curated Interrail reservation data, mirrors interrail-reservations.json.
// Source: https://www.eurail.com/en/plan-your-trip/seat-reservations/reservation-fees
const INTERRAIL_DATA = {
  fx: { EUR: 1.0, GBP: 0.85, USD: 1.10, CHF: 0.95, CAD: 1.50, AUD: 1.65, NZD: 1.80,
        JPY: 168, SEK: 11.3, NOK: 11.5, DKK: 7.45, PLN: 4.30, CZK: 25.0, HUF: 395 },
  included_countries: [
    'AT','BE','BA','BG','HR','CZ','DK','EE','FI','FR',
    'DE','GB','GR','HU','IE','IT','LV','LT','LU','ME',
    'NL','MK','NO','PL','PT','RO','RS','SK','SI','ES',
    'SE','CH','TR',
  ],
  city_country: {
    London: 'GB', Manchester: 'GB', Birmingham: 'GB', Edinburgh: 'GB',
    Glasgow: 'GB', Cardiff: 'GB', Bristol: 'GB', Belfast: 'GB',
    Paris: 'FR', Lyon: 'FR', Marseille: 'FR', Bordeaux: 'FR',
    Lille: 'FR', Nice: 'FR', Strasbourg: 'FR', Toulouse: 'FR',
    Berlin: 'DE', Munich: 'DE', Hamburg: 'DE', Frankfurt: 'DE',
    Cologne: 'DE', Stuttgart: 'DE', Hannover: 'DE', Leipzig: 'DE',
    Madrid: 'ES', Barcelona: 'ES', Seville: 'ES', Valencia: 'ES',
    Rome: 'IT', Milan: 'IT', Naples: 'IT', Florence: 'IT',
    Venice: 'IT', Turin: 'IT', Bologna: 'IT',
    Amsterdam: 'NL', Rotterdam: 'NL', Utrecht: 'NL', 'The Hague': 'NL',
    Brussels: 'BE', Antwerp: 'BE', Bruges: 'BE',
    Vienna: 'AT', Salzburg: 'AT', Innsbruck: 'AT', Graz: 'AT',
    Zurich: 'CH', Geneva: 'CH', Bern: 'CH', Basel: 'CH',
    Copenhagen: 'DK', Stockholm: 'SE', Gothenburg: 'SE', Malmo: 'SE',
    Oslo: 'NO', Bergen: 'NO', Helsinki: 'FI',
    Dublin: 'IE', Lisbon: 'PT', Porto: 'PT',
    Prague: 'CZ', Brno: 'CZ', Warsaw: 'PL', Krakow: 'PL', Budapest: 'HU',
    Athens: 'GR', Thessaloniki: 'GR',
    Sofia: 'BG',
    Bucharest: 'RO', 'Cluj-Napoca': 'RO',
    Belgrade: 'RS',
    Tallinn: 'EE', Riga: 'LV', Vilnius: 'LT',
    Bratislava: 'SK', Ljubljana: 'SI', Zagreb: 'HR',
    Sarajevo: 'BA', Podgorica: 'ME', Skopje: 'MK',
    Luxembourg: 'LU',
    Istanbul: 'TR', Ankara: 'TR',
    Reykjavik: 'IS',
    Moscow: 'RU', 'Saint Petersburg': 'RU',
    Kyiv: 'UA', Minsk: 'BY',
    Tirana: 'AL', Valletta: 'MT',
  },
  domestic: {
    FR: { fee_eur: 10, operator: 'TGV INOUI',    mandatory: true,  high_speed_only: true },
    ES: { fee_eur: 10, operator: 'AVE',          mandatory: true,  high_speed_only: true },
    IT: { fee_eur: 13, operator: 'Frecciarossa', mandatory: true,  high_speed_only: true },
    SE: { fee_eur: 10, operator: 'SJ X2000',     mandatory: false, high_speed_only: true },
    DE: { fee_eur: 0,  operator: 'ICE',          mandatory: false },
    AT: { fee_eur: 0,  operator: 'Railjet',      mandatory: false },
    CH: { fee_eur: 0,  operator: 'various',      mandatory: false },
    NL: { fee_eur: 0,  operator: 'various',      mandatory: false },
    BE: { fee_eur: 0,  operator: 'various',      mandatory: false },
    DK: { fee_eur: 0,  operator: 'various',      mandatory: false },
    NO: { fee_eur: 0,  operator: 'various',      mandatory: false },
    FI: { fee_eur: 0,  operator: 'various',      mandatory: false },
    CZ: { fee_eur: 0,  operator: 'various',      mandatory: false },
    PL: { fee_eur: 0,  operator: 'various',      mandatory: false },
    HU: { fee_eur: 0,  operator: 'various',      mandatory: false },
    PT: { fee_eur: 15, operator: 'Alfa Pendular',mandatory: true,  high_speed_only: true },
    GB: { fee_eur: 0,  operator: '(GB not in Interrail Global Pass)', mandatory: false },
  },
  international: [
    { pair: ['GB','FR'], operator: 'Eurostar',          fee_eur: 30, mandatory: true, channel_crossing: true },
    { pair: ['GB','BE'], operator: 'Eurostar',          fee_eur: 30, mandatory: true, channel_crossing: true },
    { pair: ['GB','NL'], operator: 'Eurostar',          fee_eur: 30, mandatory: true, channel_crossing: true },
    { pair: ['FR','BE'], operator: 'Eurostar/Thalys',   fee_eur: 22, mandatory: true },
    { pair: ['FR','NL'], operator: 'Eurostar/Thalys',   fee_eur: 30, mandatory: true },
    { pair: ['FR','DE'], operator: 'TGV INOUI / ICE',   fee_eur: 19, mandatory: true },
    { pair: ['FR','CH'], operator: 'TGV Lyria',         fee_eur: 29, mandatory: true },
    { pair: ['FR','IT'], operator: 'TGV / Frecciarossa',fee_eur: 35, mandatory: true },
    { pair: ['FR','ES'], operator: 'TGV inOui / Renfe', fee_eur: 35, mandatory: true },
    { pair: ['FR','LU'], operator: 'TGV',               fee_eur: 10, mandatory: true },
    { pair: ['DE','BE'], operator: 'ICE',               fee_eur: 19, mandatory: true },
    { pair: ['DE','NL'], operator: 'ICE / IC',          fee_eur: 0,  mandatory: false },
    { pair: ['DE','CH'], operator: 'EC / ICE',          fee_eur: 0,  mandatory: false },
    { pair: ['DE','AT'], operator: 'Railjet / ICE',     fee_eur: 0,  mandatory: false },
    { pair: ['DE','DK'], operator: 'EC / IC',           fee_eur: 0,  mandatory: false },
    { pair: ['DE','CZ'], operator: 'EC',                fee_eur: 0,  mandatory: false },
    { pair: ['DE','PL'], operator: 'EC',                fee_eur: 0,  mandatory: false },
    { pair: ['AT','IT'], operator: 'Railjet / EC',      fee_eur: 19, mandatory: true },
    { pair: ['AT','CH'], operator: 'Railjet / EC',      fee_eur: 0,  mandatory: false },
    { pair: ['AT','HU'], operator: 'Railjet',           fee_eur: 0,  mandatory: false },
    { pair: ['CH','IT'], operator: 'EC / Frecciarossa', fee_eur: 13, mandatory: true },
    { pair: ['NL','BE'], operator: 'IC / Eurostar',     fee_eur: 0,  mandatory: false },
    { pair: ['ES','PT'], operator: 'Trenhotel',         fee_eur: 15, mandatory: true },
    { pair: ['DK','SE'], operator: 'Öresundståg',      fee_eur: 0,  mandatory: false },
    { pair: ['SE','NO'], operator: 'SJ',                fee_eur: 0,  mandatory: false },
    { pair: ['NO','SE'], operator: 'SJ',                fee_eur: 0,  mandatory: false },
  ],
  night_trains: [
    { operator: 'ÖBB Nightjet',
      pairs: [['AT','DE'], ['AT','IT'], ['AT','CH'], ['AT','BE'], ['AT','NL'],
              ['DE','IT'], ['DE','CH'], ['DE','FR'], ['DE','NL'], ['DE','BE'],
              ['AT','HU'], ['IT','CH']],
      seat_eur: 19, couchette_eur: 39, sleeper_eur: 89, mandatory: true },
    { operator: 'European Sleeper',
      pairs: [['BE','DE'], ['DE','CZ'], ['BE','CZ'], ['NL','DE'], ['NL','CZ']],
      seat_eur: 0, couchette_eur: 49, sleeper_eur: 99, mandatory: true },
    { operator: 'Trenitalia Intercity Notte',
      pairs: [['IT','IT']],
      seat_eur: 0, couchette_eur: 30, sleeper_eur: 80, mandatory: true },
    { operator: 'Snälltåget', pairs: [['SE','DE']],
      seat_eur: 0, couchette_eur: 49, sleeper_eur: 79, mandatory: true },
    { operator: 'Renfe Trenhotel', pairs: [['ES','PT'], ['ES','FR']],
      seat_eur: 0, couchette_eur: 30, sleeper_eur: 70, mandatory: true },
  ],
  defaults: { unknown_day_fee_eur: 5, unknown_night_supplement_eur: 30 },
  pass_prices: {
    global_pass_adult_first: {
      flexi: [
        { travel_days: 4,  within_days: 30, price_eur: 367 },
        { travel_days: 5,  within_days: 30, price_eur: 413 },
        { travel_days: 7,  within_days: 30, price_eur: 495 },
        { travel_days: 10, within_days: 60, price_eur: 581 },
        { travel_days: 15, within_days: 60, price_eur: 718 },
      ],
      continuous: [
        { duration_days: 15, price_eur: 618  },
        { duration_days: 22, price_eur: 761  },
        { duration_days: 31, price_eur: 904  },
        { duration_days: 62, price_eur: 1073 },
        { duration_days: 93, price_eur: 1242 },
      ],
    },
  },
};

class ReservationLookup {
  constructor(data = INTERRAIL_DATA) {
    this.data = data || {};
    this.cityCountry = this.data.city_country || {};
    this.domestic = this.data.domestic || {};
    this.international = this.data.international || [];
    this.nightTrains = this.data.night_trains || [];
    this.defaults = this.data.defaults || {};
    this.fx = this.data.fx || { EUR: 1 };
    this.passPrices = this.data.pass_prices || {};
    this.includedCountries = new Set(this.data.included_countries || []);
  }

  isCountryIncluded(code) {
    if (!this.includedCountries.size) return true;
    if (code == null) return true;
    return this.includedCountries.has(code);
  }

  pickPass(railDays, tripDays, currency = 'EUR', tier = 'global_pass_adult_first') {
    const prices = this.passPrices[tier] || {};
    let best = null;
    const consider = (price, eur, kind, label) => {
      if (!best || price < best.price) best = { price, priceEur: eur, kind, label };
    };
    for (const f of prices.flexi || []) {
      if (railDays <= f.travel_days && tripDays <= f.within_days) {
        consider(this._eurTo(f.price_eur, currency), f.price_eur, 'flexi',
                 `${f.travel_days}d flexi / ${f.within_days}d window`);
      }
    }
    for (const c of prices.continuous || []) {
      if (tripDays <= c.duration_days) {
        consider(this._eurTo(c.price_eur, currency), c.price_eur, 'continuous',
                 `${c.duration_days}d continuous`);
      }
    }
    return best;
  }
  loaded() { return !!this.data && !!this.data.city_country; }
  countryOf(city) { return this.cityCountry[city.name] || null; }
  _eurTo(eur, currency) {
    const rate = this.fx[currency.toUpperCase()] || this.fx.EUR || 1;
    return eur * (rate / (this.fx.EUR || 1));
  }
  dayTrain(a, b, currency = 'EUR') {
    const ca = this.countryOf(a), cb = this.countryOf(b);
    if (!ca || !cb) return { fee: this._eurTo(this.defaults.unknown_day_fee_eur || 5, currency),
                              operator: '(unknown)', mandatory: false, channelCrossing: false };
    if (ca === cb) {
      const dom = this.domestic[ca];
      return dom
        ? { fee: this._eurTo(dom.fee_eur || 0, currency), operator: dom.operator || '',
            mandatory: !!dom.mandatory, channelCrossing: false }
        : { fee: 0, operator: '', mandatory: false, channelCrossing: false };
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
            return { fee: this._eurTo(e[key] || 0, currency), operator: e.operator || '',
                     mandatory: e.mandatory !== false, channelCrossing: false };
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
  if (policy.interrailPass && reservations && reservations.loaded()) {
    const ca = reservations.countryOf(a);
    const cb = reservations.countryOf(b);
    if (ca != null && !reservations.isCountryIncluded(ca)) {
      return `${mode.name}: ${a.name} (${ca}) not in Interrail Global Pass area`;
    }
    if (cb != null && !reservations.isCountryIncluded(cb)) {
      return `${mode.name}: ${b.name} (${cb}) not in Interrail Global Pass area`;
    }
  }
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
      if (info.mandatory) return `Train: ${a.name}->${b.name} on ${info.operator} needs reservation`;
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

class LocalGazetteer {
  async geocode(name) {
    const v = LOCAL_GAZETTEER[name.trim().toLowerCase()];
    return v ? { lat: v[0], lon: v[1] } : null;
  }
}

class NominatimGeocoderClass {
  constructor({ cache = null } = {}) { this.cache = cache; }
  async geocode(name) {
    const k = `geo:Nominatim:${name.trim().toLowerCase()}`;
    if (this.cache) {
      const v = this.cache.get(k);
      if (v !== undefined) return v;
    }
    const q = new URLSearchParams({ q: name, format: 'json', limit: '1' }).toString();
    let result = null;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?${q}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (data.length) result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    } catch (e) {
      console.warn('Nominatim:', e.message);
    }
    if (this.cache) this.cache.set(k, result);
    return result;
  }
}
const NominatimGeocoder = new NominatimGeocoderClass();

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
  constructor(modes) {
    this.byName = Object.fromEntries(modes.map((m) => [m.name,
      makeMode(m.name, m.detourFactor, m.avgSpeedKmh, m.costPerKm,
               m.terminalAccessH, m.boardingWaitH, m.terminalEgressH, m.fixedCostPerLeg),
    ]));
  }
  perKm(name) { return this.byName[name].costPerKm; }
  perLegFixed(name) { return this.byName[name].fixedCostPerLeg; }
  async legPrice() { return null; }
  modes() { return Object.values(this.byName); }
  update(name, field, value) { if (this.byName[name]) this.byName[name][field] = value; }
  clone() { return new ConfigPrices(Object.values(this.byName)); }
}

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
      console.warn(`Amadeus airport ${city.name}:`, e.message);
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
      console.warn(`Amadeus flight ${orig}->${dest}:`, e.message);
    }
    this.priceCache.set(cacheKey, price);
    if (this.diskCache) this.diskCache.set(diskKey, price == null ? '' : price);
    return price;
  }
}

class SerpApiFlightPrices {
  constructor(apiKey, departDate, { currency = 'GBP', cache = null } = {}) {
    this.apiKey = apiKey; this.departDate = departDate; this.currency = currency;
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
      departure_id: a.name, arrival_id: b.name,
      outbound_date: this.departDate, type: '2',
      currency: this.currency, api_key: this.apiKey,
    });
    let value = null;
    try {
      const r = await fetch(`https://serpapi.com/search?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const list = (data.best_flights && data.best_flights.length ? data.best_flights : data.other_flights) || [];
      const price = list.find((f) => f.price != null);
      value = price ? Number(price.price) : null;
    } catch (e) {
      console.warn(`SerpAPI ${a.name}->${b.name}: ${e.message}`);
    }
    this.memCache.set(key, value);
    if (this.diskCache) this.diskCache.set(diskKey, value == null ? '' : value);
    return value;
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
// Scheduling helpers (mirror tsp.js / tsp.py)
// ---------------------------------------------------------------------------

function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
function fmtMonDay(d) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

function stayDaysFor(opts, name) {
  return opts.stays && opts.stays[name] != null ? Number(opts.stays[name]) : opts.daysPerCity;
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
    let arrive = null, depart = null;
    if (opts.startDate) {
      arrive = addDays(opts.startDate, Math.floor(arriveH / 24));
      const lastInclusive = stayH > 0 ? departH - 1e-9 : arriveH;
      depart = addDays(opts.startDate, Math.floor(lastInclusive / 24));
    }
    stops.push({ name: c.name, arrive, depart });
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
  let passCost = 0;
  let passLabel = null;
  if (policy && policy.interrailPass && reservations && reservations.loaded()
      && (mode.name === 'Train' || mode.name === 'Night train')) {
    const startName2 = opts.startCity || cities[tour[0]].name;
    const isCycle2 = !(opts.endCity && opts.endCity !== startName2);
    const railDays = isCycle2 ? tour.length : Math.max(1, tour.length - 1);
    const pick = reservations.pickPass(railDays, totalDays, currency);
    if (pick) {
      passCost = pick.price;
      passLabel = `${pick.label} (${pick.priceEur.toFixed(0)}€)`;
    } else {
      passLabel = `no Global Pass covers ${railDays}d rail / ${totalDays}d trip`;
    }
  }
  let reason = failReason;
  if (reason === null && opts.maxDays != null && totalDays > opts.maxDays) {
    reason = `trip is ${totalDays}d, exceeds max ${opts.maxDays}d`;
  } else if (reason === null && opts.pins && Object.keys(opts.pins).length && !opts.startDate) {
    reason = 'pins set but no start date';
  } else if (reason === null && opts.pins) {
    const byName = Object.fromEntries(stops.map((s) => [s.name, s]));
    for (const [pn, pd] of Object.entries(opts.pins)) {
      const s = byName[pn];
      if (!s) { reason = `pinned city ${pn} not in tour`; break; }
      const t = pd.getTime();
      if (t < s.arrive.getTime() || t > s.depart.getTime()) {
        reason = `${pn} window ${isoDate(s.arrive)}..${isoDate(s.depart)} misses pinned ${isoDate(pd)}`;
        break;
      }
    }
  }
  return { feasible: reason === null, distance, travelH, cost: cost + passCost,
           totalDays, stops, reason, passCost, passLabel };
}

function pickObjective(s, m) { return m === 'distance' ? s.distance : m === 'time' ? s.travelH : s.cost; }

async function constrainedSearch(cities, mode, router, prices, opts, objective, policy,
                                  reservations = null, currency = 'EUR') {
  const n = cities.length;
  const idxOf = new Map(cities.map((c, i) => [c.name, i]));
  const startIdx = idxOf.get(opts.startCity) ?? 0;
  const startName = cities[startIdx].name;
  const isOpenPath = !!opts.endCity && opts.endCity !== startName;
  const endIdx = isOpenPath ? idxOf.get(opts.endCity) : null;
  const middle = [];
  for (let i = 0; i < n; i++) if (i !== startIdx && i !== endIdx) middle.push(i);
  const assemble = (perm) => [startIdx, ...perm, ...(isOpenPath ? [endIdx] : [])];

  let bestPerm = null, bestSched = null, lastReason = 'no feasible tour';
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
    const seeds = [middle.slice()];
    for (let s = 1; s <= 6; s++) seeds.push(shuffle(middle.slice(), s));
    for (const seed of seeds) {
      let cur = seed.slice();
      let curS = await computeSchedule(assemble(cur), cities, mode, router, prices, opts, policy, reservations, currency);
      let curV = curS.feasible ? pickObjective(curS, objective) : Infinity;
      let improved = true;
      while (improved) {
        improved = false;
        for (let i = 0; i < cur.length - 1; i++) {
          for (let j = i + 1; j < cur.length; j++) {
            const cand = cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1));
            const cs = await computeSchedule(assemble(cand), cities, mode, router, prices, opts, policy, reservations, currency);
            if (!cs.feasible) continue;
            const v = pickObjective(cs, objective);
            if (v + 1e-9 < curV) { cur = cand; curS = cs; curV = v; improved = true; }
          }
        }
      }
      consider(cur, curS);
    }
  }
  return { tour: bestPerm ? assemble(bestPerm) : null, sched: bestSched, reason: lastReason };
}

function shuffle(arr, seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
  starters: [],
  prices: new ConfigPrices(DEFAULT_MODES),
  googleLoaded: false,
  googleGeocoder: null,
  googleService: null,
  cache: new LocalStorageCache(),
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
    refreshCityPickers();
    return;
  }
  state.cities.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="name"></span>
      <span class="coords"></span>
      <label class="hint">stay <input type="number" min="0" class="stay" style="width:5ch"></label>
      <label class="hint">pin <input type="date" class="pin"></label>
      <button title="Remove" aria-label="Remove">×</button>
    `;
    li.querySelector('.name').textContent = c.name;
    li.querySelector('.coords').textContent = `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`;
    const stayInp = li.querySelector('.stay');
    stayInp.value = c.stayDays != null ? c.stayDays : '';
    stayInp.placeholder = String(currentDaysPerCity());
    stayInp.addEventListener('change', () => {
      c.stayDays = stayInp.value === '' ? null : parseInt(stayInp.value, 10);
    });
    const pinInp = li.querySelector('.pin');
    pinInp.value = c.pinDate || '';
    pinInp.addEventListener('change', () => { c.pinDate = pinInp.value || null; });
    li.querySelector('button').onclick = () => { state.cities.splice(i, 1); renderCities(); };
    ul.appendChild(li);
  });
  refreshCityPickers();
}

function currentDaysPerCity() {
  const v = parseInt($('days-per-city').value, 10);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

function renderStarters() {
  const ul = $('starter-list');
  ul.innerHTML = '';
  if (!state.starters.length) {
    ul.innerHTML = '<li class="hint" style="background:transparent;border:0;">No group starters. The trip will use the single Start city above.</li>';
    return;
  }
  state.starters.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="coords"></span><button title="Remove" aria-label="Remove">×</button>';
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.coords').textContent = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
    li.querySelector('button').onclick = () => { state.starters.splice(i, 1); renderStarters(); };
    ul.appendChild(li);
  });
}

async function addStarter(raw) {
  const name = raw.trim();
  if (!name) return;
  setStatus(`Looking up "${name}"…`);
  const r = await activeGeocoder().geocode(name);
  if (r) {
    state.starters.push({ name, lat: r.lat, lon: r.lon });
    renderStarters();
    setStatus(`Added starter ${name}.`, 'ok');
  } else {
    const manual = prompt(`Could not find "${name}". Enter coordinates as "lat,lon" or cancel:`);
    if (!manual) { setStatus(`Skipped ${name}.`); return; }
    const parts = manual.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      state.starters.push({ name, lat: parts[0], lon: parts[1] });
      renderStarters();
      setStatus(`Added starter ${name} (manual).`, 'ok');
    } else {
      setStatus(`Bad coordinates for ${name}.`, 'error');
    }
  }
}

function refreshCityPickers() {
  const startSel = $('start-city');
  const endSel = $('end-city');
  const prevStart = startSel.value;
  const prevEnd = endSel.value;
  startSel.innerHTML = '';
  if (!state.cities.length) {
    startSel.innerHTML = '<option value="">(no cities)</option>';
  } else {
    for (const c of state.cities) {
      const o = document.createElement('option');
      o.value = c.name; o.textContent = c.name;
      startSel.appendChild(o);
    }
    startSel.value = state.cities.some((c) => c.name === prevStart) ? prevStart : state.cities[0].name;
  }
  // end keeps "(return to start)" plus the same list
  endSel.innerHTML = '<option value="">(return to start)</option>';
  for (const c of state.cities) {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    endSel.appendChild(o);
  }
  endSel.value = state.cities.some((c) => c.name === prevEnd) ? prevEnd : '';
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
      <td><input type="number" step="0.25" data-field="terminalAccessH"></td>
      <td><input type="number" step="0.25" data-field="boardingWaitH"></td>
      <td><input type="number" step="0.25" data-field="terminalEgressH"></td>
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
  const list = [];
  if ($('use-google-geocode').checked && state.googleGeocoder) {
    list.push(new GoogleGeocoder(state.googleGeocoder));
  }
  list.push(new NominatimGeocoderClass({ cache: state.cache }));
  list.push(new LocalGazetteer());
  return new FallbackGeocoder(list);
}

function activeRouter() {
  if ($('use-google-routes').checked && state.googleService) {
    return new GoogleRoutesRouter(state.googleService, HaversineRouter);
  }
  return HaversineRouter;
}

function activePrices() {
  // Clone so per-run mutations (e.g. Interrail pass pricing) don't bleed across runs.
  const config = state.prices.clone();
  const currency = $('currency').value || 'GBP';
  const flights = [];
  if ($('use-amadeus').checked) {
    const key = $('amadeus-key').value.trim();
    const secret = $('amadeus-secret').value.trim();
    const date = $('amadeus-date').value;
    const useProd = $('amadeus-prod').checked;
    if (key && secret && date) flights.push(new AmadeusFlightPrices(key, secret, date,
      { useProd, currency, cache: state.cache }));
  }
  if ($('use-serpapi').checked) {
    const key = $('serpapi-key').value.trim();
    const date = $('depart-date').value;
    if (key && date) flights.push(new SerpApiFlightPrices(key, date, { currency, cache: state.cache }));
  }
  return new PriceStack(config, { flights });
}

async function addCity(rawName) {
  const name = rawName.trim();
  if (!name) return;
  setStatus(`Looking up "${name}"…`);
  const r = await activeGeocoder().geocode(name);
  if (r) {
    state.cities.push({ name, lat: r.lat, lon: r.lon, stayDays: null, pinDate: null });
    renderCities();
    setStatus(`Added ${name}.`, 'ok');
  } else {
    const manual = prompt(`Could not find "${name}". Enter coordinates as "lat,lon" or cancel:`);
    if (!manual) { setStatus(`Skipped ${name}.`); return; }
    const parts = manual.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      state.cities.push({ name, lat: parts[0], lon: parts[1], stayDays: null, pinDate: null });
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

function collectScheduleOpts() {
  const startCity = $('start-city').value || (state.cities[0] && state.cities[0].name) || null;
  const endRaw = $('end-city').value || null;
  const endCity = endRaw && endRaw !== startCity ? endRaw : null;
  const startDate = parseISODate($('trip-start-date').value);
  const maxDaysRaw = parseInt($('max-days').value, 10);
  const maxDays = Number.isFinite(maxDaysRaw) ? maxDaysRaw : null;
  const daysPerCity = currentDaysPerCity();
  const stays = {};
  const pins = {};
  for (const c of state.cities) {
    if (c.stayDays != null) stays[c.name] = c.stayDays;
    if (c.pinDate) {
      const d = parseISODate(c.pinDate);
      if (d) pins[c.name] = d;
    }
  }
  return { startCity, endCity, startDate, maxDays, daysPerCity, stays, pins };
}

function collectRailPolicy() {
  return {
    ...DEFAULT_TRAIN_POLICY,
    interrailPass: $('interrail').checked,
    excludeEurostar: $('exclude-eurostar').checked,
    seatReservationsOk: $('seat-reservations-ok').checked,
    nightTrains: $('night-trains').value,
  };
}

async function findBestMeet(cities, starters, mode, router, prices, opts, objective, policy,
                            reservations = null, currency = 'EUR') {
  let best = null;
  let bestTotal = Infinity;
  let lastReason = 'no feasible meet point + tour';
  for (const meet of cities) {
    let bail = null;
    const starterLegs = [];
    let partial = 0;
    for (const s of starters) {
      const fr = legFeasible(mode, s, meet, policy || DEFAULT_TRAIN_POLICY, reservations);
      if (fr) { bail = fr; break; }
      const { distance, timeH, cost } = await legCost(mode, s, meet, router, prices,
                                                       { policy, reservations, currency });
      starterLegs.push({ start: s.name, distance, timeH, cost });
      partial += objective === 'distance' ? distance : objective === 'time' ? timeH : cost;
    }
    if (bail) { lastReason = bail; continue; }
    const subOpts = { ...opts, startCity: meet.name };
    const { tour, sched, reason } = await constrainedSearch(cities, mode, router, prices,
      subOpts, objective, policy, reservations, currency);
    if (!tour) { lastReason = reason; continue; }
    const total = partial + pickObjective(sched, objective);
    if (total < bestTotal) { bestTotal = total; best = { meet, sched, starterLegs }; }
  }
  return best || { meet: null, sched: null, starterLegs: null, reason: lastReason };
}

async function run() {
  if (state.cities.length < 2) { setStatus('Need at least 2 destinations.', 'error'); return; }
  const optimise = document.querySelector('input[name="optimise"]:checked').value;
  const router = activeRouter();
  const prices = activePrices();
  const opts = collectScheduleOpts();
  const policy = collectRailPolicy();
  applyPassPricing(prices, policy);
  const modes = filterTrainModes(prices.modes(), policy);
  const currency = $('currency').value || 'GBP';
  const reservations = new ReservationLookup();

  if (Object.keys(opts.pins).length && !opts.startDate) {
    setStatus('Pinned dates require a trip Start date.', 'error');
    return;
  }
  let cities = state.cities;
  if (opts.startCity && cities[0].name !== opts.startCity) {
    const idx = cities.findIndex((c) => c.name === opts.startCity);
    if (idx > 0) cities = [cities[idx], ...cities.slice(0, idx), ...cities.slice(idx + 1)];
  }

  $('run').disabled = true;
  setStatus('Computing tours…');
  try {
    const rows = [];
    const isOpenPath = !!opts.endCity && opts.endCity !== opts.startCity;
    for (const mode of modes) {
      if (state.starters.length) {
        const r = await findBestMeet(cities, state.starters, mode, router, prices, opts, optimise,
          policy, reservations, currency);
        if (!r.meet) { rows.push({ mode: mode.name, infeasible: r.reason }); continue; }
        const totalStarter = r.starterLegs.reduce((s, l) => s + l.cost, 0);
        rows.push({
          mode: mode.name,
          distance: r.sched.distance, timeH: r.sched.travelH,
          cost: r.sched.cost + totalStarter, days: r.sched.totalDays,
          stops: r.sched.stops, isOpenPath,
          meet: r.meet.name, starterLegs: r.starterLegs,
          passLabel: r.sched.passLabel,
        });
        continue;
      }
      const { tour, sched, reason } = await constrainedSearch(cities, mode, router, prices,
        opts, optimise, policy, reservations, currency);
      if (!tour) { rows.push({ mode: mode.name, infeasible: reason }); continue; }
      rows.push({
        mode: mode.name,
        distance: sched.distance, timeH: sched.travelH,
        cost: sched.cost, days: sched.totalDays,
        stops: sched.stops, isOpenPath,
        passLabel: sched.passLabel,
      });
    }
    renderResults(rows, optimise, opts, policy, currency);
    setStatus(`Done. Optimised for ${optimise}.`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, 'error');
  } finally {
    $('run').disabled = false;
  }
}

function renderResults(rows, optimise, opts, policy, currency = 'GBP') {
  const sym = currencySymbol(currency);
  $('results-card').hidden = false;
  const startName = opts.startCity || (state.cities[0] && state.cities[0].name) || '';
  const endLabel = opts.endCity && opts.endCity !== startName ? `end ${opts.endCity}` : 'closed loop';
  const startersLabel = state.starters.length
    ? `meet for ${state.starters.length} starters`
    : `start ${startName} · ${endLabel}`;
  $('results-meta').textContent =
    `${state.cities.length} destinations · ${startersLabel}` +
    (opts.startDate ? ` · from ${isoDate(opts.startDate)}` : '') +
    (opts.maxDays != null ? ` · max ${opts.maxDays}d` : '') +
    ` · minimises ${optimise} · prices in ${currency}.`;

  const feasible = rows.filter((r) => !r.infeasible);
  const winners = feasible.length
    ? {
        distance: Math.min(...feasible.map((r) => r.distance)),
        time:     Math.min(...feasible.map((r) => r.timeH)),
        cost:     Math.min(...feasible.map((r) => r.cost)),
      }
    : null;

  const tbody = $('results-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.infeasible) {
      tr.innerHTML = '<td></td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="tour"></td>';
      tr.children[0].textContent = r.mode;
      tr.children[5].textContent = `infeasible: ${r.infeasible}`;
      tbody.appendChild(tr);
      continue;
    }
    if (winners && (
      (optimise === 'distance' && r.distance === winners.distance) ||
      (optimise === 'time' && r.timeH === winners.time) ||
      (optimise === 'cost' && r.cost === winners.cost)
    )) tr.classList.add('best');
    let itinerary = r.stops.map((s) => {
      if (!s.arrive) return s.name;
      const a = fmtMonDay(s.arrive);
      const d = fmtMonDay(s.depart);
      return a === d ? `${s.name} (${a})` : `${s.name} (${a}–${d})`;
    }).join(' → ');
    if (!r.isOpenPath) itinerary += ` → ${r.stops[0].name}`;
    if (r.meet && r.starterLegs) {
      const starterStr = r.starterLegs.map((l) =>
        `${l.start}→${r.meet} ${l.distance.toFixed(0)}km/${fmtTime(l.timeH).trim()}`).join(', ');
      itinerary = `meet at ${r.meet} [${starterStr}] then ${itinerary}`;
    }
    if (r.passLabel) itinerary = `[pass: ${r.passLabel}] ${itinerary}`;
    tr.innerHTML = '<td></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="tour"></td>';
    tr.children[0].textContent = r.mode;
    tr.children[1].textContent = `${r.distance.toFixed(0)} km`;
    tr.children[2].textContent = fmtTime(r.timeH);
    tr.children[3].textContent = `${sym}${r.cost.toFixed(2)}`;
    tr.children[4].textContent = `${r.days}d`;
    tr.children[5].textContent = itinerary;
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  renderPriceTable();
  renderCities();
  renderStarters();

  $('cache-enabled').addEventListener('change', () => {
    state.cache.enabled = $('cache-enabled').checked;
  });
  $('clear-cache').addEventListener('click', () => {
    state.cache.clear();
    setStatus('Cache cleared.', 'ok');
  });

  $('add-starter').addEventListener('click', () => {
    const inp = $('starter-name');
    addStarter(inp.value).then(() => { inp.value = ''; inp.focus(); });
  });
  $('starter-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('add-starter').click(); }
  });
  $('clear-starters').addEventListener('click', () => {
    state.starters = [];
    renderStarters();
    setStatus('Cleared starters.');
  });

  $('add-city').addEventListener('click', () => {
    const inp = $('city-name');
    addCity(inp.value).then(() => { inp.value = ''; inp.focus(); });
  });
  $('city-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('add-city').click(); }
  });
  $('add-defaults').addEventListener('click', () => {
    state.cities = DEFAULT_CITIES.map((c) => ({ ...c, stayDays: null, pinDate: null }));
    renderCities();
    setStatus('Loaded UK defaults.', 'ok');
  });
  $('days-per-city').addEventListener('change', renderCities);
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
