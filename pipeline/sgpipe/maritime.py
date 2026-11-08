"""Maritime layer: anchorages, the Singapore Strait traffic separation scheme, ferry routes.

Source: OpenStreetMap seamarks (OpenSeaMap tagging) and route=ferry ways.

    seamark:type=anchorage         named MPA anchorage polygons ("Eastern Bunkering A (AEBA) Sector E")
    seamark:type=separation_lane   TSS lane centrelines, drawn in the direction of traffic
    route=ferry                    scheduled ferry routes

Anchored ships are placed here (deterministically) rather than in the client: each
anchorage is filled with a Poisson-disk sample whose spacing follows the ship size the
anchorage serves, keeping clear of land.  Moving traffic (TSS, ferries) is simulated in
the client along the exported routes.

Output: OUT/maritime.json (pipeline frame: x east, y north, metres).
"""
import json
import math
import pickle
import random
import re

import numpy as np
import osmium
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge

from .config import CACHE, OUT, RAW, FAR_HALF
from .proj import ll_to_local

# ship types (index shared with web/src/world/Ships.ts)
SHIP_TYPES = ["container", "tanker", "bulk", "cargo", "tug", "bunker", "ferry", "bumboat", "naval", "carcarrier"]
T = {n: i for i, n in enumerate(SHIP_TYPES)}

# typical length range per type (m)
LENGTH = {
    "container": (210, 400), "tanker": (180, 333), "bulk": (180, 292), "cargo": (95, 165),
    "tug": (24, 36), "bunker": (60, 115), "ferry": (34, 46), "bumboat": (9, 14),
    "naval": (95, 140), "carcarrier": (170, 200),
}

# anchorage purpose -> (ship mix, min spacing between big ships, occupancy)
MIX = {
    "petroleum": ({"tanker": 0.82, "bunker": 0.18}, 620, 0.8),
    "bunkering": ({"tanker": 0.3, "container": 0.21, "bulk": 0.26, "cargo": 0.08, "bunker": 0.13, "carcarrier": 0.02}, 560, 0.85),
    "holding": ({"container": 0.3, "bulk": 0.32, "tanker": 0.25, "cargo": 0.1, "carcarrier": 0.03}, 650, 0.75),
    "general": ({"container": 0.22, "bulk": 0.33, "tanker": 0.27, "cargo": 0.15, "carcarrier": 0.03}, 620, 0.75),
    "small": ({"tug": 0.3, "bunker": 0.45, "cargo": 0.25}, 260, 0.7),
    "laidup": ({"bulk": 0.4, "tanker": 0.3, "container": 0.2, "cargo": 0.1}, 600, 0.8),
    "special": ({"cargo": 0.5, "tanker": 0.3, "tug": 0.2}, 900, 0.45),
    "naval": ({"naval": 1.0}, 900, 0.5),
    "barge": ({"bunker": 0.7, "tug": 0.3}, 240, 0.6),
}


def classify(name):
    n = (name or "").lower()
    if "petroleum" in n:
        return "petroleum"
    if "bunkering" in n:
        return "bunkering"
    if "small craft" in n:
        return "small"
    if "laid-up" in n or "laid up" in n:
        return "laidup"
    if "man-of-war" in n:
        return "naval"
    if "barge" in n:
        return "barge"
    if "explosive" in n or "special" in n or "reserved" in n or "dangerous" in n or "hazardous" in n:
        return "special"
    if "holding" in n:
        return "holding"
    return "general"


# Main Singapore Strait routes stitched from TSS lane ways (OSM ids), in traffic order.
TSS_ROUTES = {
    "Singapore Strait westbound": [182075799, 182075975, 182075994, 182076258],
    "Singapore Strait eastbound": [182076276, 182076146, 182075812, 182075803],
}

# ferries we simulate (name substring -> craft type, speed m/s)
FERRY_KIND = [
    ("pulau ubin", "bumboat", 4.0),
    ("kusu", "ferry", 7.0), ("st john", "ferry", 7.0), ("lazarus", "ferry", 7.0), ("sister", "ferry", 7.0),
    ("raffles lighthouse", "ferry", 8.0), ("bukom", "ferry", 6.0), ("semakau", "ferry", 6.0),
    ("hantu", "bumboat", 4.0), ("outward bound", "bumboat", 4.0), ("ladang", "bumboat", 4.0),
    ("pengelih", "ferry", 9.0),
    ("", "ferry", 14.0),   # international fast ferries (~27 kn)
]


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.anch = []
        self.lanes = {}
        self.ferries = []

    def way(self, w):
        t = w.tags.get("seamark:type")
        ferry = w.tags.get("route") == "ferry"
        if t not in ("anchorage", "separation_lane") and not ferry:
            return
        try:
            ll = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(ll) < 2:
            return
        lon, lat = np.array(ll).T
        x, y = ll_to_local(lon, lat)
        pts = np.column_stack([x, y])
        if t == "anchorage":
            if len(pts) >= 4:
                name = w.tags.get("seamark:name") or w.tags.get("name") or ""
                self.anch.append((w.id, name, pts))
        elif t == "separation_lane":
            self.lanes[w.id] = pts
        if ferry:
            self.ferries.append((w.id, w.tags.get("name") or "", pts))


def poisson_in(poly, spacing, rng, land, tries=30):
    """Bridson-style dart throwing inside a polygon (spacing in metres)."""
    minx, miny, maxx, maxy = poly.bounds
    cell = spacing / math.sqrt(2)
    grid = {}
    pts = []
    prepared = shapely.prepared.prep(poly)
    area = poly.area
    target = int(area / (spacing * spacing * 0.75)) * 3 + 10
    for _ in range(target * tries):
        if len(pts) > target:
            break
        x = rng.uniform(minx, maxx)
        y = rng.uniform(miny, maxy)
        gx, gy = int((x - minx) / cell), int((y - miny) / cell)
        ok = True
        for i in range(gx - 2, gx + 3):
            for j in range(gy - 2, gy + 3):
                q = grid.get((i, j))
                if q is not None and (q[0] - x) ** 2 + (q[1] - y) ** 2 < spacing * spacing:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        p = Point(x, y)
        if not prepared.contains(p):
            continue
        if land is not None and land.contains(p):
            continue
        grid[(gx, gy)] = (x, y)
        pts.append((x, y))
    return pts


def pick(mix, rng):
    r = rng.random()
    acc = 0.0
    for k, w in mix.items():
        acc += w
        if r <= acc:
            return k
    return next(iter(mix))


def run():
    rd = Reader()
    for f in ("singapore-latest.osm.pbf", "riau_islands-latest.osm.pbf"):
        p = RAW / f
        if p.exists():
            rd.apply_file(str(p), locations=True)
    print(f"anchorages {len(rd.anch)}  lanes {len(rd.lanes)}  ferry ways {len(rd.ferries)}")

    land = pickle.load(open(CACHE / "land.pkl", "rb"))
    land_buf = land.buffer(250).simplify(50)
    land_prep = shapely.prepared.prep(land_buf)

    class LandTest:
        def contains(self, p):
            return land_prep.contains(p)

    rng = random.Random(1965)
    anchorages = []
    ships = []
    seen = set()
    for wid, name, pts in sorted(rd.anch, key=lambda a: a[0]):
        if wid in seen:
            continue
        seen.add(wid)
        poly = Polygon(pts).buffer(0)
        if poly.is_empty or poly.area < 2e4:
            continue
        if abs(poly.centroid.x) > FAR_HALF or abs(poly.centroid.y) > FAR_HALF:
            continue
        kind = classify(name)
        mix, spacing, occ = MIX[kind]
        anchorages.append({"name": name, "kind": kind,
                           "poly": [[round(float(x)), round(float(y))] for x, y in poly.exterior.coords]})
        inner = poly.buffer(-spacing * 0.35)
        if inner.is_empty:
            inner = poly
        for (x, y) in poisson_in(inner, spacing, rng, LandTest()):
            if rng.random() > occ:
                continue
            t = pick(mix, rng)
            lo, hi = LENGTH[t]
            L = lo + (hi - lo) * rng.random() ** 1.3
            # bunkering: a bunker tanker moored alongside some of the big ships
            alongside = 1 if (kind == "bunkering" and t in ("container", "tanker", "bulk", "carcarrier")
                              and rng.random() < 0.35) else 0
            ships.append([round(x), round(y), T[t], round(L), round(rng.random(), 3), alongside])

    routes = []
    for name, ids in TSS_ROUTES.items():
        pts = []
        for i in ids:
            seg = rd.lanes.get(i)
            if seg is None:
                print("missing lane", i)
                continue
            if pts and np.hypot(*(np.array(pts[-1]) - seg[0])) < 1.0:
                seg = seg[1:]
            pts.extend(seg.tolist())
        if len(pts) >= 2:
            line = LineString(pts)
            routes.append({"name": name, "kind": "tss", "craft": -1, "speed": 7.0,
                           "pts": [[round(x), round(y)] for x, y in line.simplify(20).coords]})

    by_name = {}
    for wid, name, pts in rd.ferries:
        by_name.setdefault(name, []).append(LineString(pts))
    for name, lines in sorted(by_name.items()):
        merged = linemerge(lines)
        geoms = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
        line = max(geoms, key=lambda g: g.length)
        # only routes that touch the detailed domain (and are long enough to see)
        if line.length < 600:
            continue
        # keep routes that pass near the island; clip the rest of their length to the far field
        if not line.intersects(shapely.box(-52000, -52000, 52000, 52000)):
            continue
        # trim to the longest run of vertices inside the far field (order preserving: overlay ops
        # would node self-crossing routes into fragments)
        lim = FAR_HALF * 0.6
        best, run = [], []
        for x, y in line.coords:
            if abs(x) < lim and abs(y) < lim:
                run.append((x, y))
            else:
                if len(run) > len(best):
                    best = run
                run = []
        if len(run) > len(best):
            best = run
        if len(best) < 2:
            continue
        line = LineString(best)
        nl = name.lower()
        craft, speed = "ferry", 14.0
        for key, cr, sp in FERRY_KIND:
            if key in nl:
                craft, speed = cr, sp
                break
        routes.append({"name": name or "Ferry", "kind": "ferry", "craft": T[craft], "speed": speed,
                       "pts": [[round(x), round(y)] for x, y in line.simplify(8).coords]})

    out = {"types": SHIP_TYPES, "anchorages": anchorages, "ships": ships, "routes": routes}
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "maritime.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    kinds = {}
    for s in ships:
        kinds[SHIP_TYPES[s[2]]] = kinds.get(SHIP_TYPES[s[2]], 0) + 1
    print(f"anchorages kept {len(anchorages)}  anchored ships {len(ships)} {kinds}")
    print(f"routes {len(routes)}: " + ", ".join(f"{r['name']} ({r['kind']}, {len(r['pts'])} pts)" for r in routes))
    print("wrote", OUT / "maritime.json", (OUT / "maritime.json").stat().st_size, "bytes")


if __name__ == "__main__":
    run()
