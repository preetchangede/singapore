"""Global (non-tiled) assets + the manifest.

  terrain/near.bin     u16 heights 2048^2, gzip   h = v / 50 - 50   (m)
  terrain/far.bin      u16 heights 2048^2, gzip   (262 km square)
  terrain/coast.bin    u8 signed distance 4096^2, gzip, sqrt-encoded (see client)
  terrain/canopy.bin   u8 canopy height 4096^2 (16 m), gzip, 0.25 m units
  buildings/overview.bin  far LOD buildings, grouped by bundle/tile (gzip)
  labels.json          planning areas, subzones, places (for map labels + location readout)
  search.bin           gzip JSON search index
  manifest.json
"""
import gzip
import json
import math
import pickle
import struct
import time
from collections import defaultdict

import numpy as np
import shapely

from .config import CACHE, OUT, HALF, FAR_HALF, BUNDLE, TILE, NB, TILES_PER_BUNDLE, DOMAIN, E0, N0, \
    MP_PLANNING, MP_SUBZONE
from .bundles import write_building, Strings, tile_of, tile_center, MAGIC
from .proj import geom_to_local, local_to_ll
from .schema import POI_TYPES, POI_IDX
from . import heights


def gz(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(data, compresslevel=9, mtime=0))
    return path.stat().st_size


HSCALE = 20.0  # 5 cm


def enc_height(h):
    """Row-wise delta coding split into hi/lo byte planes (gzip-friendly).
    Client: v = prefix_sum_row((hi << 8) | lo) mod 2^16 ; h = v / HSCALE - 50."""
    v = np.clip(np.round((h + 50.0) * HSCALE), 0, 65535).astype(np.int64)
    d = np.diff(v, axis=1, prepend=0)
    d[:, 0] = v[:, 0]
    d = (d % 65536).astype(np.uint16)
    return np.concatenate([(d >> 8).astype(np.uint8).ravel(), (d & 255).astype(np.uint8).ravel()])


def terrain_assets():
    near = np.load(CACHE / "height_near.npy")
    far = np.load(CACHE / "height_far.npy")
    s1 = gz(OUT / "terrain" / "near.bin", enc_height(near).tobytes())
    s2 = gz(OUT / "terrain" / "far.bin", enc_height(far).tobytes())
    sdf = np.load(CACHE / "sdf.npy")
    # 8192 -> 4096 by averaging; sqrt encoding keeps precision close to the shore
    s4 = sdf.reshape(4096, 2, 4096, 2).mean(axis=(1, 3))
    MAXD = 2000.0
    v = 128 + np.sign(s4) * np.sqrt(np.clip(np.abs(s4) / MAXD, 0, 1)) * 127
    s3 = gz(OUT / "terrain" / "coast.bin", np.clip(np.round(v), 0, 255).astype(np.uint8).tobytes())
    can = np.load(CACHE / "canopy16.npy")
    s5 = gz(OUT / "terrain" / "canopy.bin", np.clip(np.round(can * 4), 0, 255).astype(np.uint8).tobytes())
    print(f"[globals] terrain near {s1/1e6:.2f} MB, far {s2/1e6:.2f} MB, coast {s3/1e6:.2f} MB, canopy {s5/1e6:.2f} MB")
    return {"near": {"file": "terrain/near.bin", "size": int(near.shape[0]), "half": HALF, "enc": [HSCALE, 50.0], "coding": "delta-planes"},
            "far": {"file": "terrain/far.bin", "size": int(far.shape[0]), "half": FAR_HALF, "enc": [HSCALE, 50.0], "coding": "delta-planes"},
            "coast": {"file": "terrain/coast.bin", "size": 4096, "half": HALF, "maxd": MAXD},
            "canopy": {"file": "terrain/canopy.bin", "size": int(can.shape[0]), "half": HALF, "scale": 0.25}}


def overview_buildings():
    B = pickle.load(open(CACHE / "buildings.pkl", "rb"))["recs"]
    NT = NB * TILES_PER_BUNDLE
    per_tile = defaultdict(list)
    n = 0
    for r in B:
        if r.get("skip3d"):
            continue
        tall = (r["h"] or 0) >= 20
        big = r["area"] >= 2000 and (r["h"] or 0) >= 6
        if not (tall or big):
            continue
        tx, ty = tile_of(r["cx"], r["cy"])
        if 0 <= tx < NT and 0 <= ty < NT:
            per_tile[(tx, ty)].append(r)
            n += 1
    strings = Strings()
    table = np.zeros((NB * NB, 16, 2), "<u4")
    body = bytearray()
    header = 32
    # strings are not needed for the overview (names come from the detail bundles)
    for (tx, ty), recs in per_tile.items():
        bx, by = tx // TILES_PER_BUNDLE, ty // TILES_PER_BUNDLE
        ti = (ty % TILES_PER_BUNDLE) * TILES_PER_BUNDLE + (tx % TILES_PER_BUNDLE)
        ox, oy = tile_center(tx, ty)
        buf = bytearray()
        cnt = 0
        recs.sort(key=lambda r: -r["h"])
        for r in recs:
            rr = dict(r)
            rr["name"] = None
            rr["addr"] = None
            if write_building(buf, rr, ox, oy, strings, 0.6):
                cnt += 1
        while len(body) % 4:
            body.append(0)
        table[by * NB + bx, ti, 0] = len(body)
        table[by * NB + bx, ti, 1] = cnt
        body += buf
    hdr = struct.pack("<IHBBIII12x", MAGIC, 1, NB, NB, 0, header, header)
    table_bytes = table.tobytes()
    # offsets are relative to the start of the body; body follows the table
    raw = hdr + table_bytes + bytes(body)
    size = gz(OUT / "buildings" / "overview.bin", raw)
    print(f"[globals] overview buildings {n} -> {size/1e6:.2f} MB")
    return {"file": "buildings/overview.bin", "count": n, "bodyOffset": len(hdr) + len(table_bytes)}


def simplify_rings(g, tol):
    g = g.simplify(tol, preserve_topology=True)
    out = []
    for p in shapely.get_parts(g):
        if p.geom_type != "Polygon":
            continue
        out.append([[round(x, 0), round(y, 0)] for x, y in np.asarray(p.exterior.coords)[:-1]])
    return out


def labels_and_search():
    pa = json.load(open(MP_PLANNING))
    sz = json.load(open(MP_SUBZONE))

    def prop(f, *keys):
        p = f["properties"]
        for k in keys:
            if k in p and p[k]:
                return p[k]
        # data.gov.sg KML-derived GeoJSON packs attributes in Description HTML
        d = p.get("Description", "")
        for k in keys:
            import re
            m = re.search(rf"<th>{k}</th>\s*<td>([^<]*)</td>", d)
            if m:
                return m.group(1)
        return None

    areas = []
    for f in pa["features"]:
        g = shapely.geometry.shape(f["geometry"])
        g = shapely.force_2d(g)
        g = geom_to_local(g)
        name = prop(f, "PLN_AREA_N", "pln_area_n")
        region = prop(f, "REGION_N", "region_n")
        c = g.representative_point()
        areas.append({"name": name.title() if name else None, "region": (region or "").title(),
                      "x": round(c.x), "y": round(c.y), "area": round(g.area), "rings": simplify_rings(g, 25)})
    subs = []
    for f in sz["features"]:
        g = shapely.force_2d(shapely.geometry.shape(f["geometry"]))
        g = geom_to_local(g)
        name = prop(f, "SUBZONE_N", "subzone_n")
        pln = prop(f, "PLN_AREA_N", "pln_area_n")
        c = g.representative_point()
        subs.append({"name": name.title() if name else None, "area_name": pln.title() if pln else None,
                     "x": round(c.x), "y": round(c.y), "area": round(g.area), "rings": simplify_rings(g, 15)})
    F = pickle.load(open(CACHE / "features.pkl", "rb"))
    places = []
    for p in F["pois"]:
        t = POI_TYPES[p["type"]]
        if t in ("place", "suburb", "neighbourhood", "island") and (p["region"] == "sg" or t in ("place", "suburb")):
            places.append({"name": p["name"], "type": t, "x": round(p["x"]), "y": round(p["y"]), "imp": p["imp"]})
    labels = {"planningAreas": areas, "subzones": subs, "places": places}
    (OUT / "labels.json").write_text(json.dumps(labels, separators=(",", ":"), ensure_ascii=False))
    print(f"[globals] labels: {len(areas)} areas, {len(subs)} subzones, {len(places)} places "
          f"({(OUT / 'labels.json').stat().st_size/1e3:.0f} KB)")

    # ---- search index -------------------------------------------------
    entries = {}

    def add(name, typ, x, y, imp, h=0):
        if not name:
            return
        key = (name.lower(), typ)
        cur = entries.get(key)
        if cur is None or imp > cur[4]:
            entries[key] = [name, typ, round(x), round(y), imp, round(h)]

    for a in areas:
        add(a["name"], "district", a["x"], a["y"], 9)
    for s in subs:
        add(s["name"], "neighbourhood", s["x"], s["y"], 6)
    for p in F["pois"]:
        if p["region"] != "sg" and POI_TYPES[p["type"]] not in ("place",):
            continue
        add(p["name"], POI_TYPES[p["type"]], p["x"], p["y"], p["imp"])
    # named roads: representative midpoint of the longest segment per name
    road_best = {}
    for r in F["roads"]:
        if r.get("region") != "sg" or not r.get("name") or r["cls"] > 6:
            continue
        L = r["geom"].length
        if r["name"] not in road_best or L > road_best[r["name"]][0]:
            m = r["geom"].interpolate(0.5, normalized=True)
            road_best[r["name"]] = (L, m.x, m.y)
    for name, (L, x, y) in road_best.items():
        add(name, "road", x, y, 3 + min(3, int(L / 600)))
    B = pickle.load(open(CACHE / "buildings.pkl", "rb"))["recs"]
    for r in B:
        if r["region"] == "sg" and r.get("name") and not r["part"]:
            add(r["name"], "building", r["cx"], r["cy"], 3 + min(4, int((r["h"] or 0) / 50)), r["h"] or 0)
    arr = sorted(entries.values(), key=lambda e: -e[4])
    raw = json.dumps(arr, separators=(",", ":"), ensure_ascii=False).encode()
    size = gz(OUT / "search.bin", raw)
    print(f"[globals] search index {len(arr)} entries ({size/1e3:.0f} KB gz)")


def run():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    terrain = terrain_assets()
    ov = overview_buildings()
    labels_and_search()
    bm = json.load(open(CACHE / "bundles_manifest.json"))
    stats = json.load(open(CACHE / "height_model_stats.json"))
    lon0, lat0 = local_to_ll(0.0, 0.0)
    manifest = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "frame": {"crs": "EPSG:3414 (SVY21)", "E0": E0, "N0": N0, "lon0": float(lon0), "lat0": float(lat0),
                  "half": HALF, "bundle": BUNDLE, "tile": TILE, "nb": NB, "tilesPerBundle": TILES_PER_BUNDLE},
        "terrain": terrain,
        "ground": {"overview": "ground/overview_4k.jpg", "overviewSmall": "ground/overview_2k.jpg", "half": HALF},
        "overview": ov,
        "bundles": [[b["x"], b["y"], b["bytes"]] for b in bm["bundles"]],
        "labels": "labels.json",
        "search": "search.bin",
        "heightModel": stats,
        "attribution": [
            "© OpenStreetMap contributors (ODbL)",
            "HDB Property Information & URA Master Plan 2019 — Singapore Open Data Licence",
            "FABDEM V1-2 — University of Bristol / Fathom (CC BY-NC-SA 4.0)",
            "Meta & WRI High Resolution Canopy Height Maps v2 (CC BY 4.0)",
            "3D-GloBFP building heights — Che et al. 2024 (CC BY 4.0)",
            "ESA WorldCover 2021 (CC BY 4.0)",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"[globals] manifest written in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    run()
