"""
Multi-transport Traveling Salesman comparison.

Given a list of cities with latitude/longitude, find a good tour for each
mode of transport (ICE car, EV car, coach, train, flight) and report the
total distance, journey time, and cost for that tour.

TSP heuristic: nearest-neighbor from every start, then 2-opt improvement.
Distances: great-circle (haversine) scaled by a per-mode detour factor.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class City:
    name: str
    lat: float
    lon: float


@dataclass(frozen=True)
class Mode:
    name: str
    detour_factor: float      # multiplier applied to great-circle distance
    avg_speed_kmh: float      # door-to-door average speed while moving
    cost_per_km: float        # currency per km of travelled distance
    fixed_time_per_leg_h: float = 0.0   # check-in / boarding / transfer per leg
    fixed_cost_per_leg: float = 0.0     # booking fee / station fee per leg


# Rough, illustrative UK-ish numbers in GBP. Tweak to taste.
MODES: list[Mode] = [
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


def haversine_km(a: City, b: City) -> float:
    r = 6371.0088
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def leg_cost(mode: Mode, gc_km: float) -> tuple[float, float, float]:
    """Return (distance_km, time_h, cost) for one leg under a mode."""
    distance = gc_km * mode.detour_factor
    time_h = distance / mode.avg_speed_kmh + mode.fixed_time_per_leg_h
    cost = distance * mode.cost_per_km + mode.fixed_cost_per_leg
    return distance, time_h, cost


def build_matrix(cities: list[City], mode: Mode, metric: str) -> list[list[float]]:
    n = len(cities)
    m = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            gc = haversine_km(cities[i], cities[j])
            d, t, c = leg_cost(mode, gc)
            v = {"distance": d, "time": t, "cost": c}[metric]
            m[i][j] = m[j][i] = v
    return m


def tour_total(tour: list[int], matrix: list[list[float]]) -> float:
    return sum(matrix[tour[i]][tour[(i + 1) % len(tour)]] for i in range(len(tour)))


def nearest_neighbor(start: int, matrix: list[list[float]]) -> list[int]:
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


def two_opt(tour: list[int], matrix: list[list[float]]) -> list[int]:
    n = len(tour)
    improved = True
    best = tour[:]
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


def solve_tsp(matrix: list[list[float]]) -> list[int]:
    n = len(matrix)
    best_tour: list[int] = []
    best_len = math.inf
    for start in range(n):
        tour = two_opt(nearest_neighbor(start, matrix), matrix)
        length = tour_total(tour, matrix)
        if length < best_len:
            best_len = length
            best_tour = tour
    return best_tour


def summarise_tour(tour: list[int], cities: list[City], mode: Mode) -> dict:
    distance = time_h = cost = 0.0
    for i in range(len(tour)):
        a = cities[tour[i]]
        b = cities[tour[(i + 1) % len(tour)]]
        d, t, c = leg_cost(mode, haversine_km(a, b))
        distance += d
        time_h += t
        cost += c
    return {"distance_km": distance, "time_h": time_h, "cost": cost}


def fmt_time(hours: float) -> str:
    h = int(hours)
    m = int(round((hours - h) * 60))
    if m == 60:
        h, m = h + 1, 0
    return f"{h:>3}h {m:02d}m"


def run(cities: list[City] = DEFAULT_CITIES, optimise_for: str = "time") -> None:
    assert optimise_for in {"distance", "time", "cost"}
    print(f"Cities ({len(cities)}): " + ", ".join(c.name for c in cities))
    print(f"Optimising each tour for: {optimise_for}\n")

    header = f"{'Mode':<10} {'Distance':>10} {'Time':>10} {'Cost':>10}   Tour"
    print(header)
    print("-" * len(header))
    for mode in MODES:
        matrix = build_matrix(cities, mode, optimise_for)
        tour = solve_tsp(matrix)
        s = summarise_tour(tour, cities, mode)
        names = " -> ".join(cities[i].name for i in tour + [tour[0]])
        print(f"{mode.name:<10} {s['distance_km']:>8.0f}km {fmt_time(s['time_h']):>10} "
              f"£{s['cost']:>8.2f}   {names}")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--optimise", choices=["distance", "time", "cost"], default="time",
                   help="Metric each per-mode tour minimises (default: time)")
    args = p.parse_args()
    run(optimise_for=args.optimise)
