"""OpenStreetMap extraction.

Reads one or more .osm.pbf files and produces plain Python records with
shapely geometries projected into the local world frame.  Only the tags the
renderer needs are kept.

Output (pickled to CACHE/osm_<region>.pkl):
    {
      'buildings': [ {id, geom, tags, part} ],
      'roads':     [ {id, geom, tags} ],
      'rails':     [ {id, geom, tags} ],
      'areas':     [ {id, geom, tags} ],     # landuse / natural / leisure / ...
      'lines':     [ {id, geom, tags} ],     # waterways, coastline, tree rows, piers ...
      'points':    [ {id, x, y, tags} ],     # trees, places, stations, POIs
    }
"""
import pickle
import time

import numpy as np
import osmium
import shapely
from shapely import wkb as swkb

from .config import CACHE
from .proj import geom_to_local, ll_to_local

BUILDING_KEYS = {
    "building", "building:part", "height", "min_height", "building:levels",
    "building:min_level", "roof:shape", "roof:height", "roof:levels", "roof:colour",
    "building:colour", "building:material", "roof:material", "roof:direction",
    "roof:orientation", "name", "name:en", "addr:housenumber", "addr:street",
    "amenity", "shop", "tourism", "leisure", "man_made", "residential", "layer",
    "location", "historic", "religion", "operator", "start_date", "wikidata",
    "aeroway", "office", "denomination", "heritage", "parking", "service",
    "building:use", "government", "military", "sport", "level", "construction",
}
ROAD_KEYS = {
    "highway", "name", "name:en", "ref", "lanes", "width", "oneway", "bridge", "tunnel",
    "layer", "level", "covered", "area", "surface", "junction", "service",
    "sidewalk", "footway", "maxspeed", "indoor", "location", "construction", "man_made",
    "bridge:structure", "bridge:name",
}
RAIL_KEYS = {
    "railway", "name", "bridge", "tunnel", "layer", "service", "usage", "level",
    "electrified", "gauge", "location", "covered", "embankment", "construction",
}
AREA_PRIMARY = (
    "landuse", "natural", "leisure", "amenity", "aeroway", "man_made", "water",
    "waterway", "golf", "place", "boundary", "tourism", "highway", "area:highway",
    "building", "power", "military", "landcover", "surface", "public_transport",
    "bridge", "parking", "sport", "playground", "barrier",
)
AREA_KEYS = set(AREA_PRIMARY) | {
    "name", "name:en", "layer", "covered", "location", "tunnel", "bridge",
    "protect_class", "intermittent", "basin", "reservoir_type", "wetland",
    "leaf_type", "garden:type", "access", "religion", "level", "indoor", "height",
    "min_height", "disused", "construction", "salt",
}
LINE_KEYS = {
    "waterway", "natural", "man_made", "aerialway", "barrier", "width", "name",
    "name:en", "tunnel", "layer", "bridge", "intermittent", "location", "covered",
    "power", "height", "highway",
}
POINT_KEYS = {
    "natural", "place", "railway", "station", "public_transport", "tourism",
    "amenity", "historic", "name", "name:en", "name:zh", "name:ms", "name:ta",
    "aeroway", "man_made", "leisure", "shop", "height", "denotation",
    "species", "genus", "leaf_type", "circumference", "diameter_crown",
    "network", "ref", "wikidata", "population", "highway", "crossing", "ele",
    "building", "office", "sport", "subway", "light_rail", "monorail", "level",
    "location", "religion", "operator", "brand", "cuisine", "waterway", "lock",
}
POINT_TRIGGERS = (
    "natural", "place", "railway", "tourism", "historic", "aeroway", "man_made",
    "public_transport", "amenity", "leisure", "highway", "shop", "office",
)


def _sub(tags, keys):
    return {t.k: t.v for t in tags if t.k in keys}


class Extractor(osmium.SimpleHandler):
    def __init__(self, bbox=None, region="sg"):
        super().__init__()
        self.f = osmium.geom.WKBFactory()
        self.bbox = bbox  # lon/lat bbox filter for context regions
        self.region = region
        self.buildings, self.roads, self.rails = [], [], []
        self.areas, self.lines, self.points = [], [], []
        self.n_err = 0

    # ---- helpers -----------------------------------------------------
    def _in_bbox(self, lon, lat):
        b = self.bbox
        return b is None or (b[0] <= lon <= b[2] and b[1] <= lat <= b[3])

    def _way_in_bbox(self, w):
        """True if any node (sampled every few nodes, plus the last) is in the bbox."""
        if self.bbox is None:
            return True
        nodes = w.nodes
        n = len(nodes)
        step = 1 if n < 64 else max(1, n // 64)
        try:
            for i in list(range(0, n, step)) + [n - 1]:
                loc = nodes[i].location
                if loc.valid() and self._in_bbox(loc.lon, loc.lat):
                    return True
        except Exception:
            return False
        return False

    # ---- callbacks ---------------------------------------------------
    def node(self, n):
        t = n.tags
        if len(t) == 0:
            return
        if not any(k in t for k in POINT_TRIGGERS):
            return
        if not n.location.valid():
            return
        lon, lat = n.location.lon, n.location.lat
        if not self._in_bbox(lon, lat):
            return
        tags = _sub(t, POINT_KEYS)
        keep = (
            t.get("natural") in ("tree", "peak", "rock", "cave_entrance")
            or "place" in t
            or t.get("railway") in ("station", "halt", "tram_stop", "subway_entrance")
            or "name" in t
            or t.get("highway") in ("traffic_signals", "crossing", "street_lamp", "bus_stop")
            or t.get("man_made") in ("lighthouse", "tower", "flagpole", "mast")
        )
        if keep:
            self.points.append({"id": n.id, "lon": lon, "lat": lat, "tags": tags})

    def way(self, w):
        t = w.tags
        if len(t) == 0 or len(w.nodes) < 2:
            return
        hw, rw = t.get("highway"), t.get("railway")
        is_closed = w.is_closed() and len(w.nodes) >= 4
        is_area_hw = t.get("area") == "yes"
        try:
            if hw and not is_area_hw:
                if not self._way_in_bbox(w):
                    return
                g = self.f.create_linestring(w)
                self.roads.append({"id": w.id, "geom": g, "tags": _sub(t, ROAD_KEYS)})
            if rw and rw not in ("platform", "station") and not (is_closed and rw in ("platform",)):
                if not self._way_in_bbox(w):
                    return
                g = self.f.create_linestring(w)
                self.rails.append({"id": w.id, "geom": g, "tags": _sub(t, RAIL_KEYS)})
            lin = (
                t.get("waterway") in ("river", "stream", "canal", "drain", "ditch", "tidal_channel")
                or t.get("natural") in ("coastline", "tree_row", "cliff", "ridge")
                or ("aerialway" in t)
                or (t.get("man_made") in ("pier", "breakwater", "groyne", "embankment") and not is_closed)
                or t.get("barrier") in ("wall", "retaining_wall", "city_wall")
                or t.get("power") == "line"
            )
            if lin:
                if not self._way_in_bbox(w):
                    return
                g = self.f.create_linestring(w)
                self.lines.append({"id": w.id, "geom": g, "tags": _sub(t, LINE_KEYS)})
        except Exception:
            self.n_err += 1

    def area(self, a):
        t = a.tags
        if len(t) == 0:
            return
        is_bld = "building" in t or "building:part" in t
        is_area = any(k in t for k in AREA_PRIMARY)
        if not (is_bld or is_area):
            return
        try:
            g = self.f.create_multipolygon(a)
        except Exception:
            self.n_err += 1
            return
        oid = a.orig_id()
        kind = "w" if a.from_way() else "r"
        if self.bbox is not None:
            # cheap bbox test on the WKB via shapely later; keep everything for now
            pass
        if is_bld:
            self.buildings.append({
                "id": f"{kind}{oid}", "geom": g, "tags": _sub(t, BUILDING_KEYS),
                "part": ("building:part" in t and "building" not in t),
            })
        if is_area:
            # Buildings may also carry area tags (e.g. amenity=school); keep the area too
            # unless it is a pure building.
            prim = [k for k in AREA_PRIMARY if k in t and k != "building"]
            if prim:
                self.areas.append({"id": f"{kind}{oid}", "geom": g, "tags": _sub(t, AREA_KEYS)})


def _project_records(recs, bbox=None):
    if not recs:
        return []
    geoms = shapely.from_wkb([r["geom"] for r in recs])
    keep = np.ones(len(recs), bool)
    if bbox is not None:
        box = shapely.box(*bbox)
        keep = shapely.intersects(geoms, box)
    geoms = geoms[keep]
    recs = [r for r, k in zip(recs, keep) if k]
    loc = geom_to_local(geoms)
    out = []
    for r, g in zip(recs, loc):
        if g is None or g.is_empty:
            continue
        r = dict(r)
        r["geom"] = g
        out.append(r)
    return out


def extract(pbf, region, bbox=None):
    t0 = time.time()
    h = Extractor(bbox=bbox, region=region)
    h.apply_file(str(pbf), locations=True, idx="flex_mem")
    print(f"[osm] {region}: parsed in {time.time()-t0:.1f}s  "
          f"b={len(h.buildings)} r={len(h.roads)} rail={len(h.rails)} a={len(h.areas)} "
          f"l={len(h.lines)} p={len(h.points)} err={h.n_err}")
    res = {
        "buildings": _project_records(h.buildings, bbox),
        "roads": _project_records(h.roads, bbox),
        "rails": _project_records(h.rails, bbox),
        "areas": _project_records(h.areas, bbox),
        "lines": _project_records(h.lines, bbox),
    }
    pts = h.points
    if pts:
        lon = np.array([p["lon"] for p in pts])
        lat = np.array([p["lat"] for p in pts])
        x, y = ll_to_local(lon, lat)
        res["points"] = [
            {"id": p["id"], "x": float(xx), "y": float(yy), "tags": p["tags"]}
            for p, xx, yy in zip(pts, x, y)
        ]
    else:
        res["points"] = []
    for r in res["buildings"]:
        r["region"] = region
    print(f"[osm] {region}: projected in {time.time()-t0:.1f}s")
    return res


def run():
    from .config import PBF_SG, PBF_MY, PBF_RIAU, BBOX_JOHOR_LL, BBOX_RIAU_LL
    jobs = [
        ("sg", PBF_SG, None),
        ("jb", PBF_MY, BBOX_JOHOR_LL),
        ("riau", PBF_RIAU, BBOX_RIAU_LL),
    ]
    for region, pbf, bbox in jobs:
        out = CACHE / f"osm_{region}.pkl"
        if out.exists():
            print(f"[osm] {region}: cached")
            continue
        res = extract(pbf, region, bbox)
        with open(out, "wb") as f:
            pickle.dump(res, f, protocol=pickle.HIGHEST_PROTOCOL)


def load(region):
    with open(CACHE / f"osm_{region}.pkl", "rb") as f:
        return pickle.load(f)


if __name__ == "__main__":
    run()
