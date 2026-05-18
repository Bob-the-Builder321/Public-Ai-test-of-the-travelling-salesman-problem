// Multi-transport Traveling Salesman comparison.
//
// Given a list of cities with latitude/longitude, find a good tour for each
// mode of transport (ICE car, EV car, coach, train, flight) and report total
// distance, journey time, and cost for that tour.
//
// TSP heuristic: nearest-neighbor from every start, then 2-opt improvement.
// Distances: great-circle (haversine) scaled by a per-mode detour factor.

'use strict';

const MODES = [
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

function legCost(mode, gcKm) {
  const distance = gcKm * mode.detourFactor;
  const timeH = distance / mode.avgSpeedKmh + mode.fixedTimePerLegH;
  const cost = distance * mode.costPerKm + mode.fixedCostPerLeg;
  return { distance, timeH, cost };
}

function buildMatrix(cities, mode, metric) {
  const n = cities.length;
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const gc = haversineKm(cities[i], cities[j]);
      const leg = legCost(mode, gc);
      const v = metric === 'distance' ? leg.distance : metric === 'time' ? leg.timeH : leg.cost;
      m[i][j] = m[j][i] = v;
    }
  }
  return m;
}

function tourTotal(tour, matrix) {
  let total = 0;
  for (let i = 0; i < tour.length; i++) {
    total += matrix[tour[i]][tour[(i + 1) % tour.length]];
  }
  return total;
}

function nearestNeighbor(start, matrix) {
  const n = matrix.length;
  const unvisited = new Set();
  for (let i = 0; i < n; i++) if (i !== start) unvisited.add(i);
  const tour = [start];
  while (unvisited.size) {
    const last = tour[tour.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (const j of unvisited) {
      if (matrix[last][j] < bestD) {
        bestD = matrix[last][j];
        best = j;
      }
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
        const a = best[i];
        const b = best[i + 1];
        const c = best[j];
        const d = best[(j + 1) % n];
        const delta = matrix[a][c] + matrix[b][d] - (matrix[a][b] + matrix[c][d]);
        if (delta < -1e-9) {
          // reverse best[i+1 .. j]
          let lo = i + 1;
          let hi = j;
          while (lo < hi) {
            const tmp = best[lo];
            best[lo] = best[hi];
            best[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return best;
}

function solveTsp(matrix) {
  const n = matrix.length;
  let bestTour = null;
  let bestLen = Infinity;
  for (let start = 0; start < n; start++) {
    const tour = twoOpt(nearestNeighbor(start, matrix), matrix);
    const length = tourTotal(tour, matrix);
    if (length < bestLen) {
      bestLen = length;
      bestTour = tour;
    }
  }
  return bestTour;
}

function summariseTour(tour, cities, mode) {
  let distance = 0;
  let timeH = 0;
  let cost = 0;
  for (let i = 0; i < tour.length; i++) {
    const a = cities[tour[i]];
    const b = cities[tour[(i + 1) % tour.length]];
    const leg = legCost(mode, haversineKm(a, b));
    distance += leg.distance;
    timeH += leg.timeH;
    cost += leg.cost;
  }
  return { distance, timeH, cost };
}

function fmtTime(hours) {
  let h = Math.floor(hours);
  let m = Math.round((hours - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  return `${String(h).padStart(3)}h ${String(m).padStart(2, '0')}m`;
}

function run(cities = DEFAULT_CITIES, optimiseFor = 'time') {
  if (!['distance', 'time', 'cost'].includes(optimiseFor)) {
    throw new Error(`optimiseFor must be distance|time|cost, got ${optimiseFor}`);
  }
  console.log(`Cities (${cities.length}): ${cities.map((c) => c.name).join(', ')}`);
  console.log(`Optimising each tour for: ${optimiseFor}\n`);

  const header = `${'Mode'.padEnd(10)} ${'Distance'.padStart(10)} ${'Time'.padStart(10)} ${'Cost'.padStart(10)}   Tour`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const mode of MODES) {
    const matrix = buildMatrix(cities, mode, optimiseFor);
    const tour = solveTsp(matrix);
    const s = summariseTour(tour, cities, mode);
    const names = tour.concat([tour[0]]).map((i) => cities[i].name).join(' -> ');
    const dist = `${s.distance.toFixed(0)}km`.padStart(10);
    const time = fmtTime(s.timeH).padStart(10);
    const cost = `£${s.cost.toFixed(2)}`.padStart(10);
    console.log(`${mode.name.padEnd(10)} ${dist} ${time} ${cost}   ${names}`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let optimise = 'time';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--optimise' && i + 1 < args.length) {
      optimise = args[i + 1];
      i++;
    }
  }
  run(DEFAULT_CITIES, optimise);
}

module.exports = { run, solveTsp, haversineKm, legCost, MODES, DEFAULT_CITIES };
