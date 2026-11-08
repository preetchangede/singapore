"""Binary bundle writer.

A *bundle* covers 4,096 m x 4,096 m and holds 4 x 4 *tiles* of 1,024 m.  Each
tile carries six sections (buildings, roads, rails, ground areas, water,
trees).  Geometry is stored tile-relative as int16 at 1/16 m with delta
coding, which gzips extremely well.  The browser decodes and meshes bundles in
Web Workers (see web/src/workers/).

Binary layout (little endian) — mirrored in web/src/data/bundleFormat.ts
------------------------------------------------------------------------
header (32 B):  u32 magic 'SGB1' | u16 version | u8 bx | u8 by | u32 nStrings |
                u32 stringsOffset | u32 tableOffset | 12 B reserved
strings:        repeated (u16 byteLen, utf-8 bytes), padded to 4 B
table:          16 tiles x 6 sections x (u32 offset, u32 count)
sections:       see writers below; every record is 2-byte aligned
"""
import gzip
import json
import math
import pickle
import struct
import time
import zlib
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import box as sbox

from .config import CACHE, OUT, HALF, BUNDLE, TILE, NB, TILES_PER_BUNDLE
from .heights import CLASSES, C
from .vegetation import KINDS

MAGIC = 0x31424753  # 'SGB1'
VERSION = 1
Q = 16.0  # coordinate quantisation: 1/16 m
SECTIONS = ["buildings", "roads", "rails", "areas", "water", "trees"]

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------
CSS = {
    "white": "#f2f2ee", "black": "#2a2a2a", "grey": "#9a9a98", "gray": "#9a9a98", "red": "#a8463a",
    "brown": "#7a5a44", "yellow": "#e3cf8a", "orange": "#d08a4a", "green": "#6f8f5a", "blue": "#5d7c99",
    "beige": "#e1d6bd", "cream": "#efe6cf", "tan": "#cdb48f", "silver": "#c3c6c8", "lightgrey": "#c8c8c4",
    "lightgray": "#c8c8c4", "darkgrey": "#5f5f5f", "darkgray": "#5f5f5f", "pink": "#e3b2b2", "teal": "#4f8a86",
    "maroon": "#7a3434", "navy": "#34456a", "purple": "#7a5a8a", "gold": "#c9a54a", "olive": "#7d7a4a",
    "lightblue": "#a9c4d6", "darkblue": "#2f4560", "lightyellow": "#f1e8b8", "ivory": "#f2eedf",
    "terracotta": "#a8573a", "salmon": "#e09b86", "khaki": "#c9bf8c", "darkgreen": "#3f5a3a",
}
PAL = {
    "hdb_wall": ["#ebe7dd", "#f0ebe1", "#e7e1d1", "#ece7de", "#e4dfd3", "#dedad1", "#efe8d8", "#e9e4dc"],
    "condo_wall": ["#e9e6e1", "#dcd9d3", "#d0d4d5", "#e4ddd1", "#cbc5ba", "#e8e3da", "#d7d2c8"],
    "glass": ["#6f8796", "#5e7280", "#7d8f99", "#4f6470", "#8a9ca3", "#56707d", "#6b7d75", "#3f5563", "#7c8c8f"],
    "house_wall": ["#f1ece2", "#ece4d4", "#e3d9c6", "#f3f0e9", "#dbd2c3", "#e9e2d6", "#d7cdbd"],
    "tile_roof": ["#a4543a", "#b25e3c", "#8f4a35", "#9c6b52", "#5b5d63", "#6d5048", "#b36a47", "#7e4434", "#545b63"],
    "shop_wall": ["#e9c7b1", "#c9dcc5", "#f0dfa8", "#b9d2dc", "#e7b9b9", "#d8c6e3", "#f2d1a0", "#a9cfc2",
                  "#f5e3c4", "#e8d3b9", "#cfe0d8", "#f3c9a4", "#bcd3b2"],
    "ind_wall": ["#c7ccd0", "#b8bec2", "#d4d4cc", "#a9b4b8", "#c9c2b2", "#bfc5c0"],
    "metal_roof": ["#a7b0b5", "#8f9aa1", "#b4bab9", "#7f8f8a", "#9aa6b6", "#c2c6c4", "#6f8a8e"],
    "civic_wall": ["#e8e2d6", "#ddd6c8", "#efe8da", "#e2dccf", "#d8d0c0"],
    "retail_wall": ["#dcd6cc", "#cfc9bf", "#e4ddd0", "#d6d1c9"],
    "flat_roof": ["#9c9a95", "#a8a59f", "#8e8d89", "#b3afa6", "#a19d96", "#93918c"],
    "green_roof": ["#5f7f45", "#6b8a4a", "#58773f"],
    "parking": ["#b9b6ae", "#a9a69f", "#c2beb5"],
    "temple": ["#c9a35a", "#b8463a", "#e7d7b0"],
}


def hex_to_rgb(h):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def parse_colour(c):
    if not c:
        return None
    c = c.strip().lower().replace(" ", "")
    if c.startswith("#") and len(c) in (4, 7):
        try:
            return hex_to_rgb(c)
        except ValueError:
            return None
    if c in CSS:
        return hex_to_rgb(CSS[c])
    return None


def rgb565(rgb):
    r, g, b = rgb
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def h32(s):
    return zlib.crc32(str(s).encode()) & 0xFFFFFFFF


def pick(pal, seed):
    p = PAL[pal]
    return hex_to_rgb(p[seed % len(p)])


def building_colours(r, seed):
    cls = r["cls"]
    wall = parse_colour(r.get("colour"))
    roof = parse_colour(r.get("roof_colour"))
    glass = False
    green = False
    mat = (r.get("material") or "").lower()
    if cls == C["hdb"]:
        w = pick("hdb_wall", seed)
        ro = pick("flat_roof", seed >> 3)
    elif cls in (C["house"], C["terrace"]):
        w = pick("house_wall", seed)
        ro = pick("tile_roof", seed >> 4) if r["roof"] in (1, 2, 3, 6) else pick("flat_roof", seed >> 4)
    elif cls == C["shophouse"]:
        w = pick("shop_wall", seed)
        ro = pick("tile_roof", (seed >> 4) % 4)
    elif cls in (C["office"], C["hotel"]):
        tall = r["h"] > 40
        glass = tall or mat == "glass" or (seed % 3 == 0)
        w = pick("glass", seed) if glass else pick("condo_wall", seed)
        ro = pick("flat_roof", seed >> 3)
        green = (seed % 9 == 0)
    elif cls == C["condo"]:
        glass = r["h"] > 60 and (seed % 4 == 0)
        w = pick("glass", seed) if glass else pick("condo_wall", seed)
        ro = pick("flat_roof", seed >> 3)
        green = (seed % 7 == 0)
    elif cls in (C["industrial"], C["warehouse"]):
        w = pick("ind_wall", seed)
        ro = pick("metal_roof", seed >> 3)
    elif cls in (C["civic"], C["school"], C["hospital"], C["transport"], C["sports"]):
        w = pick("civic_wall", seed)
        ro = pick("metal_roof", seed >> 3) if cls in (C["transport"], C["sports"]) else pick("flat_roof", seed >> 3)
        green = cls == C["school"] and seed % 5 == 0
    elif cls == C["religious"]:
        w = pick("temple", seed) if seed % 2 else pick("civic_wall", seed)
        ro = pick("tile_roof", seed >> 4)
    elif cls == C["parking"]:
        w = pick("parking", seed)
        ro = pick("flat_roof", seed >> 3)
    elif cls == C["retail"]:
        w = pick("retail_wall", seed)
        ro = pick("flat_roof", seed >> 3)
        glass = r["h"] > 25 and seed % 3 == 0
    elif cls == C["roof"]:
        w = hex_to_rgb("#c9c9c4")
        ro = pick("metal_roof", seed)
    elif cls == C["tank"]:
        w = hex_to_rgb("#dcdcd8")
        ro = hex_to_rgb("#cfcfcb")
    elif cls == C["greenhouse"]:
        w = hex_to_rgb("#c8d8d4")
        ro = hex_to_rgb("#d4e0dc")
        glass = True
    else:
        w = pick("condo_wall", seed)
        ro = pick("flat_roof", seed >> 3)
    if mat == "glass":
        glass = True
    if green and r["roof"] == 0:
        ro = pick("green_roof", seed >> 5)
    return wall or w, roof or ro, glass, green


# ---------------------------------------------------------------------------
# Binary helpers
# ---------------------------------------------------------------------------
class Strings:
    def __init__(self):
        self.idx = {}
        self.items = []

    def get(self, s):
        if not s:
            return 0xFFFF
        s = str(s)[:120]
        if s in self.idx:
            return self.idx[s]
        if len(self.items) >= 0xFFFE:
            return 0xFFFF
        self.idx[s] = len(self.items)
        self.items.append(s)
        return self.idx[s]

    def blob(self):
        out = bytearray()
        for s in self.items:
            b = s.encode("utf-8")
            out += struct.pack("<H", len(b)) + b
        while len(out) % 4:
            out.append(0)
        return bytes(out)


def q(v, o):
    return np.clip(np.round((np.asarray(v) - o) * Q), -32767, 32767).astype(np.int16)


def ring_coords(ring, ox, oy, close_drop=True):
    c = np.asarray(ring.coords)
    if close_drop and len(c) > 1 and np.allclose(c[0], c[-1]):
        c = c[:-1]
    return c


def enc_coords(c, ox, oy):
    """Absolute first vertex, then deltas; int16 at 1/16 m."""
    xi = np.round((c[:, 0] - ox) * Q).astype(np.int64)
    yi = np.round((c[:, 1] - oy) * Q).astype(np.int64)
    xi = np.clip(xi, -32767, 32767)
    yi = np.clip(yi, -32767, 32767)
    dx = np.diff(xi, prepend=0)
    dy = np.diff(yi, prepend=0)
    dx[0], dy[0] = xi[0], yi[0]
    if np.abs(dx).max(initial=0) > 32767 or np.abs(dy).max(initial=0) > 32767:
        raise ValueError("delta overflow")
    return np.column_stack([dx, dy]).astype("<i2").tobytes()


def polygon_rings(poly, simplify=0.0):
    if simplify > 0:
        poly = poly.simplify(simplify, preserve_topology=True)
        if poly.is_empty or poly.geom_type != "Polygon":
            return None
    rings = [poly.exterior] + list(poly.interiors)
    out = []
    for r in rings:
        c = np.asarray(r.coords)[:-1]
        if len(c) >= 3:
            out.append(c)
    return out or None


def write_polygon(buf, rings, ox, oy):
    total = sum(len(r) for r in rings)
    if total > 65000:
        return False
    buf += struct.pack("<HH", len(rings), total)
    buf += struct.pack(f"<{len(rings)}H", *[len(r) for r in rings])
    for r in rings:
        buf += enc_coords(r, ox, oy)
    return True


# ---------------------------------------------------------------------------
# Section writers
# ---------------------------------------------------------------------------
def write_building(buf, r, ox, oy, strings, simplify=0.0):
    rings = polygon_rings(r["geom"], simplify)
    if rings is None:
        return False
    seed = h32(r["id"]) & 0xFFFF
    wall, roof, glass, green = building_colours(r, seed)
    flags = 0
    flags |= 1 if r["part"] else 0
    flags |= 2 if r.get("hdb") else 0
    flags |= 4 if r.get("skip3d") else 0
    flags |= 8 if r.get("landmark") else 0
    flags |= 16 if r.get("has_parts") else 0
    flags |= 32 if glass else 0
    flags |= 64 if green else 0
    flags |= 128 if r["src"] == "model" else 0
    h = max(0.0, min(r["h"], 6500.0))
    minh = max(0.0, min(r["minh"] or 0.0, h - 0.5))
    rh = max(0.0, min(r.get("roof_h") or 0.0, h - minh))
    hdr = struct.pack(
        "<BBBBHHHHHHHHH",
        r["cls"], max(0, r["roof"]), flags, min(255, max(0, r["levels"] or 0)),
        int(round(h * 10)), int(round(minh * 10)), int(round(rh * 10)),
        rgb565(wall), rgb565(roof), seed,
        strings.get(r.get("name")), strings.get(r.get("addr")), 0)
    tmp = bytearray(hdr)
    if not write_polygon(tmp, rings, ox, oy):
        return False
    buf += tmp
    return True


def write_line(buf, rec, geom, ox, oy, strings, elev=None, is_rail=False):
    c = np.asarray(geom.coords)
    if len(c) < 2 or len(c) > 65000:
        return False
    flags = 0
    if not is_rail:
        flags |= 1 if rec.get("oneway") else 0
    flags |= 2 if rec.get("bridge") else 0
    flags |= 4 if elev is not None else 0
    width = rec.get("width", 3.0 if is_rail else 4.0)
    buf += struct.pack("<BBBBbBHH", rec["cls"], flags, min(255, int(round(width * 4))),
                       min(255, rec.get("lanes", 0)), max(-128, min(127, rec.get("layer", 0))),
                       {"sg": 0, "jb": 1, "riau": 2}[rec.get("region", "sg")],
                       strings.get(rec.get("name")), len(c))
    buf += enc_coords(c, ox, oy)
    if elev is not None:
        buf += np.clip(np.round(np.asarray(elev) * 10), 0, 65535).astype("<u2").tobytes()
    return True


def write_area(buf, rings, ground, flags, name, ox, oy, strings):
    tmp = bytearray(struct.pack("<BBH", ground, flags, strings.get(name)))
    if not write_polygon(tmp, rings, ox, oy):
        return False
    buf += tmp
    return True


def write_water(buf, rings, kind, level, name, ox, oy, strings):
    k = {"reservoir": 0, "lake": 1, "pond": 2, "river": 3, "canal": 4}.get(kind, 1)
    tmp = bytearray(struct.pack("<BBhH", k, 0, int(round(level * 10)), strings.get(name)))
    if not write_polygon(tmp, rings, ox, oy):
        return False
    buf += tmp
    return True


# ---------------------------------------------------------------------------
# Spatial assignment
# ---------------------------------------------------------------------------
def tile_of(x, y):
    tx = int(math.floor((x + HALF) / TILE))
    ty = int(math.floor((y + HALF) / TILE))
    return tx, ty


def tile_box(tx, ty, pad=0.0):
    x0 = -HALF + tx * TILE
    y0 = -HALF + ty * TILE
    return sbox(x0 - pad, y0 - pad, x0 + TILE + pad, y0 + TILE + pad)


def tile_center(tx, ty):
    return -HALF + (tx + 0.5) * TILE, -HALF + (ty + 0.5) * TILE


def split_polys(g):
    for p in shapely.get_parts(g):
        if p.geom_type == "Polygon" and not p.is_empty and p.area > 0.5:
            yield p
        elif p.geom_type in ("MultiPolygon", "GeometryCollection"):
            yield from split_polys(p)


def split_lines(g):
    for p in shapely.get_parts(g):
        if p.geom_type == "LineString" and not p.is_empty and p.length > 0.05:
            yield p
        elif p.geom_type in ("MultiLineString", "GeometryCollection"):
            yield from split_lines(p)


def run():
    t0 = time.time()
    B = pickle.load(open(CACHE / "buildings.pkl", "rb"))["recs"]
    F = pickle.load(open(CACHE / "features.pkl", "rb"))
    trees = np.load(CACHE / "trees.npy")
    out_dir = OUT / "bundles"
    out_dir.mkdir(parents=True, exist_ok=True)
    NT = NB * TILES_PER_BUNDLE

    tiles = defaultdict(lambda: {s: [] for s in SECTIONS})

    # --- buildings by centroid
    for r in B:
        if r["h"] is None:
            continue
        tx, ty = tile_of(r["cx"], r["cy"])
        if 0 <= tx < NT and 0 <= ty < NT:
            tiles[(tx, ty)]["buildings"].append(r)

    # --- linework: bridges assigned whole (elevation profile), the rest clipped per tile
    def assign_lines(recs, key):
        geoms = np.array([r["geom"] for r in recs], dtype=object)
        bounds = shapely.bounds(geoms)
        for i, r in enumerate(recs):
            g = r["geom"]
            if r.get("elev") is not None:
                c = np.asarray(g.coords)
                e = r["elev"]
                # split long chains into ~800 m pieces
                seg = np.hypot(*np.diff(c, axis=0).T)
                s = np.concatenate([[0], np.cumsum(seg)])
                start = 0
                while start < len(c) - 1:
                    end = start + 1
                    while end < len(c) - 1 and s[end] - s[start] < 800:
                        end += 1
                    piece = c[start:end + 1]
                    mid = piece[len(piece) // 2]
                    tx, ty = tile_of(mid[0], mid[1])
                    if 0 <= tx < NT and 0 <= ty < NT:
                        tiles[(tx, ty)][key].append((r, shapely.LineString(piece), e[start:end + 1]))
                    start = end
                continue
            b = bounds[i]
            tx0, ty0 = tile_of(b[0], b[1])
            tx1, ty1 = tile_of(b[2], b[3])
            for tx in range(max(0, tx0), min(NT - 1, tx1) + 1):
                for ty in range(max(0, ty0), min(NT - 1, ty1) + 1):
                    if tx0 == tx1 and ty0 == ty1:
                        tiles[(tx, ty)][key].append((r, g, None))
                        continue
                    part = shapely.intersection(g, tile_box(tx, ty))
                    for p in split_lines(part):
                        tiles[(tx, ty)][key].append((r, p, None))

    assign_lines(F["roads"], "roads")
    assign_lines(F["rails"], "rails")
    print(f"[bundle] lines assigned in {time.time()-t0:.0f}s")

    # --- areas & water: clip to tiles
    def assign_polys(recs, key, simplify):
        geoms = np.array([r["geom"] for r in recs], dtype=object)
        bounds = shapely.bounds(geoms)
        for i, r in enumerate(recs):
            g = r["geom"]
            if not g.is_valid:
                g = shapely.make_valid(g)
            if simplify:
                g = g.simplify(simplify, preserve_topology=True)
            b = bounds[i]
            tx0, ty0 = tile_of(b[0], b[1])
            tx1, ty1 = tile_of(b[2], b[3])
            for tx in range(max(0, tx0), min(NT - 1, tx1) + 1):
                for ty in range(max(0, ty0), min(NT - 1, ty1) + 1):
                    if tx0 == tx1 and ty0 == ty1:
                        part = g
                    else:
                        part = shapely.intersection(g, tile_box(tx, ty, pad=0.5))
                    for p in split_polys(part):
                        tiles[(tx, ty)][key].append((r, p))

    # draw order: large / low-priority first so small features paint over them
    from .schema import GROUND
    areas = sorted(F["areas"], key=lambda a: (GROUND[a["ground"]][3], -a.get("area", 0)))
    assign_polys(areas, "areas", 0.3)
    assign_polys(F["water"], "water", 0.3)
    print(f"[bundle] polygons assigned in {time.time()-t0:.0f}s")

    # --- trees
    tx = np.floor((trees["x"] + HALF) / TILE).astype(int)
    ty = np.floor((trees["y"] + HALF) / TILE).astype(int)
    order = np.lexsort((ty, tx))
    trees, tx, ty = trees[order], tx[order], ty[order]
    keys = tx * 1000 + ty
    uniq, starts = np.unique(keys, return_index=True)
    ends = list(starts[1:]) + [len(keys)]
    for k, s, e in zip(uniq, starts, ends):
        a, b = int(k // 1000), int(k % 1000)
        if 0 <= a < NT and 0 <= b < NT:
            tiles[(a, b)]["trees"] = trees[s:e]

    # --- write bundles
    manifest = {"bundles": [], "version": VERSION}
    total_raw = total_gz = 0
    stats = defaultdict(int)
    for by in range(NB):
        for bx in range(NB):
            strings = Strings()
            sections = []  # (tile_index, section_index, bytes, count)
            nonempty = False
            for j in range(TILES_PER_BUNDLE):
                for i in range(TILES_PER_BUNDLE):
                    t = (bx * TILES_PER_BUNDLE + i, by * TILES_PER_BUNDLE + j)
                    if t not in tiles:
                        continue
                    T = tiles[t]
                    ox, oy = tile_center(*t)
                    ti = j * TILES_PER_BUNDLE + i
                    # buildings
                    buf = bytearray(); n = 0
                    for r in T["buildings"]:
                        if write_building(buf, r, ox, oy, strings, 0.05):
                            n += 1
                    sections.append((ti, 0, bytes(buf), n)); stats["buildings"] += n
                    # roads
                    buf = bytearray(); n = 0
                    for rec, g, e in sorted(T["roads"], key=lambda x: (x[0].get("layer", 0), -x[0]["cls"])):
                        if write_line(buf, rec, g, ox, oy, strings, e):
                            n += 1
                    sections.append((ti, 1, bytes(buf), n)); stats["roads"] += n
                    buf = bytearray(); n = 0
                    for rec, g, e in T["rails"]:
                        if write_line(buf, rec, g, ox, oy, strings, e, is_rail=True):
                            n += 1
                    sections.append((ti, 2, bytes(buf), n)); stats["rails"] += n
                    buf = bytearray(); n = 0
                    for rec, p in T["areas"]:
                        rings = polygon_rings(p)
                        if rings and write_area(buf, rings, rec["ground"], 0, rec.get("name"), ox, oy, strings):
                            n += 1
                    sections.append((ti, 3, bytes(buf), n)); stats["areas"] += n
                    buf = bytearray(); n = 0
                    for rec, p in T["water"]:
                        rings = polygon_rings(p)
                        if rings and write_water(buf, rings, rec["kind"], rec["level"], rec.get("name"), ox, oy, strings):
                            n += 1
                    sections.append((ti, 4, bytes(buf), n)); stats["water"] += n
                    tr = T["trees"]
                    if len(tr):
                        arr = np.zeros(len(tr), dtype=[("x", "<i2"), ("y", "<i2"), ("h", "u1"), ("r", "u1"), ("k", "u1"), ("p", "u1")])
                        arr["x"] = q(tr["x"], ox)
                        arr["y"] = q(tr["y"], oy)
                        arr["h"] = np.clip(np.round(tr["h"] * 4), 1, 255)
                        arr["r"] = np.clip(np.round(tr["r"] * 10), 1, 255)
                        arr["k"] = tr["kind"]
                        sections.append((ti, 5, arr.tobytes(), len(tr))); stats["trees"] += len(tr)
                    nonempty = True
            if not nonempty:
                continue
            sblob = strings.blob()
            header_size = 32
            table_size = 16 * 6 * 8
            strings_off = header_size
            table_off = strings_off + len(sblob)
            data_off = table_off + table_size
            table = np.zeros((16, 6, 2), "<u4")
            body = bytearray()
            for ti, si, b, n in sections:
                while len(body) % 4:
                    body.append(0)
                table[ti, si, 0] = data_off + len(body)
                table[ti, si, 1] = n
                body += b
            hdr = struct.pack("<IHBBIII12x", MAGIC, VERSION, bx, by, len(strings.items), strings_off, table_off)
            raw = hdr + sblob + table.tobytes() + bytes(body)
            gz = gzip.compress(raw, compresslevel=9, mtime=0)
            fn = f"b{bx:02d}_{by:02d}.bin"
            (out_dir / fn).write_bytes(gz)
            manifest["bundles"].append({"x": bx, "y": by, "file": fn, "bytes": len(gz), "raw": len(raw)})
            total_raw += len(raw)
            total_gz += len(gz)
    print(f"[bundle] {len(manifest['bundles'])} bundles, raw {total_raw/1e6:.1f} MB, gz {total_gz/1e6:.1f} MB; {dict(stats)}")
    json.dump(manifest, open(CACHE / "bundles_manifest.json", "w"))
    print(f"[bundle] done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    run()
