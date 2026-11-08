"""Classification of OSM linework and areas into renderer-ready features.

Products (cache/features.pkl):
    roads   [{geom, cls, width, lanes, oneway, layer, bridge, tunnel, name, elev?}]
    rails   [{geom, cls, layer, bridge, tunnel, name, elev?}]
    areas   [{geom, ground, name}]           ground material polygons
    water   [{geom, level, kind, name}]      inland water bodies (sea comes from the land mask)
    pois    [{x, y, type, name, imp}]
"""
import math
import pickle
import time
from collections import defaultdict

import numpy as np
import shapely
from shapely.ops import linemerge

from .config import CACHE, HALF
from .heights import parse_len, parse_int
from .schema import ROAD_CLASSES, RAIL_CLASSES, GROUND_IDX, POI_IDX
from . import osm

RC = {n: i for i, n in enumerate(ROAD_CLASSES)}
RLC = {n: i for i, n in enumerate(RAIL_CLASSES)}

HW = {
    "motorway": "motorway", "trunk": "trunk", "primary": "primary", "secondary": "secondary",
    "tertiary": "tertiary", "residential": "minor", "unclassified": "minor", "living_street": "minor",
    "road": "minor", "service": "service", "motorway_link": "motorway_link", "trunk_link": "motorway_link",
    "primary_link": "link", "secondary_link": "link", "tertiary_link": "link", "pedestrian": "pedestrian",
    "footway": "footway", "path": "footway", "corridor": None, "steps": "steps", "cycleway": "cycleway",
    "track": "track", "busway": "busway", "bus_guideway": "busway", "raceway": "raceway",
    "bridleway": "footway",
}
LANE_W = {"motorway": 3.6, "trunk": 3.5, "primary": 3.4, "secondary": 3.3, "tertiary": 3.2,
          "minor": 3.0, "service": 3.0, "motorway_link": 3.6, "link": 3.4, "busway": 3.5, "raceway": 4.0}
DEF_LANES = {"motorway": (3, 3), "trunk": (3, 4), "primary": (2, 4), "secondary": (2, 4), "tertiary": (2, 2),
             "minor": (1, 2), "service": (1, 2), "motorway_link": (1, 2), "link": (1, 2), "busway": (1, 2),
             "raceway": (2, 2)}
NONLANE_W = {"pedestrian": 6.0, "footway": 2.0, "steps": 2.2, "cycleway": 2.4, "track": 3.0}


def road_record(r):
    t = r["tags"]
    hw = t.get("highway")
    cls = HW.get(hw)
    if cls is None:
        return None
    if t.get("indoor") == "yes" or t.get("level", "0").startswith("-") or t.get("location") == "underground":
        return None
    if hw == "service" and t.get("service") in ("parking_aisle", "drive-through"):
        pass
    tunnel = t.get("tunnel") in ("yes", "building_passage", "culvert") or t.get("covered") == "yes"
    bridge = t.get("bridge") not in (None, "no")
    layer = parse_int(t.get("layer")) or 0
    if layer < 0 and not bridge:
        tunnel = True if layer <= -1 and t.get("tunnel") else tunnel
    oneway = t.get("oneway") in ("yes", "1", "true", "-1") or t.get("junction") == "roundabout"
    if t.get("oneway") == "-1":
        r = dict(r)
        r["geom"] = shapely.reverse(r["geom"])
    lanes = parse_int(t.get("lanes"))
    width = parse_len(t.get("width"))
    if cls in LANE_W:
        if not lanes:
            lanes = DEF_LANES[cls][0 if oneway else 1]
        if not width or width < 2 or width > 60:
            width = lanes * LANE_W[cls] + (1.2 if cls in ("motorway", "trunk") else 0.4)
    else:
        lanes = lanes or 0
        if not width or width < 0.8 or width > 30:
            width = NONLANE_W.get(cls, 3.0)
        if hw == "service" and t.get("service") == "parking_aisle":
            width = 6.0
    return {
        "geom": r["geom"], "cls": RC[cls], "width": float(width), "lanes": int(lanes or 0),
        "oneway": bool(oneway), "layer": int(layer), "bridge": bool(bridge), "tunnel": bool(tunnel),
        "name": t.get("name:en") or t.get("name"), "ref": t.get("ref"), "osm": r["id"],
        "service": t.get("service"),
    }


def rail_record(r):
    t = r["tags"]
    rw = t.get("railway")
    if rw in ("subway",):
        cls = "mrt"
    elif rw == "light_rail":
        cls = "lrt"
    elif rw in ("rail", "narrow_gauge", "preserved"):
        cls = "rail"
    elif rw == "monorail":
        cls = "monorail"
    elif rw == "tram":
        cls = "tram"
    elif rw in ("funicular",):
        cls = "funicular"
    elif rw in ("disused", "abandoned"):
        cls = "disused"
    else:
        return None
    tunnel = t.get("tunnel") not in (None, "no") or t.get("location") == "underground" or t.get("covered") == "yes"
    bridge = t.get("bridge") not in (None, "no")
    layer = parse_int(t.get("layer")) or 0
    if layer < 0 and not bridge:
        tunnel = True
    if t.get("level", "0").startswith("-"):
        tunnel = True
    return {"geom": r["geom"], "cls": RLC[cls], "layer": layer, "bridge": bridge, "tunnel": tunnel,
            "name": t.get("name"), "service": t.get("service"), "osm": r["id"]}


def ground_class(t):
    lu, nat, lei, am = t.get("landuse"), t.get("natural"), t.get("leisure"), t.get("amenity")
    aw, mm = t.get("aeroway"), t.get("man_made")
    if lei == "swimming_pool" or am == "swimming_pool":
        return "pool"
    if aw == "runway":
        return "runway"
    if aw in ("taxiway",):
        return "taxiway"
    if aw in ("apron", "helipad"):
        return "apron"
    if mm in ("pier", "breakwater", "quay", "jetty") or t.get("waterway") == "dock" and False:
        return "pier"
    if lei == "track" or (lei == "pitch" and t.get("sport") == "athletics" and t.get("surface") in ("tartan", "synthetic")):
        return "track"
    if lei == "pitch":
        sp = t.get("sport", "")
        surf = t.get("surface", "")
        if sp in ("tennis", "basketball", "badminton", "netball", "volleyball", "multi", "futsal", "sepak_takraw", "pickleball") or surf in ("hard", "acrylic", "asphalt", "concrete"):
            return "court"
        return "pitch"
    if lei == "playground":
        return "playground"
    if lei == "golf_course" or t.get("golf") in ("fairway", "green", "tee", "rough"):
        return "golf"
    if am == "parking" and t.get("parking") not in ("multi-storey", "underground", "rooftop") and "building" not in t:
        return "parking"
    if t.get("highway") in ("pedestrian", "footway") or t.get("area:highway") or t.get("place") == "square" or t.get("public_transport") == "platform":
        return "plaza"
    if nat in ("beach", "sand") or lu == "beach":
        return "sand"
    if nat in ("bare_rock", "rock", "scree", "stone"):
        return "rock"
    if nat in ("wood",) or lu == "forest":
        return "forest"
    if nat in ("scrub", "heath", "shrubbery"):
        return "scrub"
    if nat in ("wetland", "mud") or t.get("wetland"):
        return "wetland"
    if nat in ("grassland",) or lu in ("grass", "meadow", "village_green", "recreation_ground", "flowerbed"):
        return "grass"
    if lei in ("park", "nature_reserve", "dog_park", "common", "recreation_ground") or t.get("boundary") == "national_park":
        return "park"
    if lei in ("garden",):
        return "garden"
    if lu in ("farmland", "allotments", "orchard", "plant_nursery", "farmyard", "greenhouse_horticulture", "aquaculture", "vineyard"):
        return "farmland"
    if lu in ("construction", "brownfield", "greenfield", "quarry", "landfill"):
        return "bare"
    if lu == "cemetery" or am == "grave_yard":
        return "cemetery"
    if lu == "military":
        return "military"
    if aw == "aerodrome":
        return "airport"
    if lu in ("port",) or t.get("industrial") == "port":
        return "port"
    if lu in ("industrial", "railway", "depot", "garages", "harbour"):
        return "industrial"
    if lu in ("commercial", "retail"):
        return "commercial"
    if lu in ("residential",):
        return "residential"
    if am in ("school", "university", "college", "kindergarten", "hospital") or lu in ("education", "healthcare", "religious", "institutional"):
        return "institutional"
    if lei in ("sports_centre", "stadium"):
        return "pitch" if lei == "stadium" else "institutional"
    return None


def is_water_area(t):
    if t.get("leisure") == "swimming_pool":
        return None
    if t.get("natural") == "water" or t.get("waterway") in ("riverbank", "dock", "canal", "river") or \
       t.get("landuse") in ("reservoir", "basin") or "water" in t and t.get("natural") != "wetland":
        w = t.get("water", "")
        if t.get("landuse") == "reservoir" or w == "reservoir":
            return "reservoir"
        if w in ("canal", "drain", "ditch") or t.get("waterway") == "canal":
            return "canal"
        if w in ("river",) or t.get("waterway") in ("riverbank", "river"):
            return "river"
        if w in ("pond", "lake", "lagoon", "basin", "oxbow", "fishpond"):
            return "pond"
        return "lake"
    return None


WATERWAY_W = {"river": 18.0, "canal": 10.0, "stream": 3.0, "drain": 4.0, "ditch": 1.6, "tidal_channel": 8.0}


def bridge_profiles(recs, kind):
    """Assign per-vertex deck elevation (m above terrain) to bridge chains.

    Connected bridge ways are merged into chains; each chain gets a plateau at a
    height that depends on what it is (MRT viaduct, flyover, small canal
    bridge) with ramps only at chain ends."""
    br = [r for r in recs if r.get("bridge") and not r.get("tunnel")]
    if not br:
        return
    # endpoint graph
    def key(p):
        return (round(p[0], 1), round(p[1], 1))
    ends = defaultdict(list)
    for i, r in enumerate(br):
        c = r["geom"].coords
        ends[key(c[0])].append(i)
        ends[key(c[-1])].append(i)
    # all non-bridge endpoints (to know whether a chain end lands on the ground)
    ground_nodes = set()
    for r in recs:
        if not r.get("bridge") and not r.get("tunnel"):
            c = r["geom"].coords
            ground_nodes.add(key(c[0]))
            ground_nodes.add(key(c[-1]))
    # union-find chains
    parent = list(range(len(br)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for k, ids in ends.items():
        for j in ids[1:]:
            a, b = find(ids[0]), find(j)
            if a != b:
                parent[a] = b
    chains = defaultdict(list)
    for i in range(len(br)):
        chains[find(i)].append(i)
    for ids in chains.values():
        total = sum(br[i]["geom"].length for i in ids)
        layer = max(max(br[i]["layer"] for i in ids), 1)
        if kind == "rail":
            H = 11.0 + 4.0 * (layer - 1)
        else:
            cls = min(br[i]["cls"] for i in ids)
            major = cls <= RC["tertiary"] or cls in (RC["motorway_link"], RC["link"])
            if total < 70 and layer <= 1:
                H = 1.2 if not major else 2.0
            elif not major:
                H = 4.5 * layer  # pedestrian overhead bridges ~5 m
            else:
                H = 7.0 * layer
        ramp = min(150.0 if kind == "rail" else 110.0, total * 0.35)
        if total < 70:
            ramp = total * 0.3
        for i in ids:
            r = br[i]
            c = np.asarray(r["geom"].coords)
            seg = np.hypot(*np.diff(c, axis=0).T)
            s = np.concatenate([[0], np.cumsum(seg)])
            # ramp only toward ends that touch the ground network or are dangling
            st_ground = key(c[0]) in ground_nodes or len(ends[key(c[0])]) == 1
            en_ground = key(c[-1]) in ground_nodes or len(ends[key(c[-1])]) == 1
            L = s[-1]
            e = np.full(len(c), H, np.float32)
            if st_ground:
                e = np.minimum(e, H * np.clip(s / max(ramp, 1e-3), 0, 1) ** 0.85)
            if en_ground:
                e = np.minimum(e, H * np.clip((L - s) / max(ramp, 1e-3), 0, 1) ** 0.85)
            r["elev"] = np.maximum(e, 0.25)


def run():
    t0 = time.time()
    roads, rails, areas, water, pois = [], [], [], [], []
    for region in ("sg", "jb", "riau"):
        d = osm.load(region)
        for r in d["roads"]:
            if region != "sg" and r["tags"].get("highway") in ("footway", "path", "steps", "corridor", "cycleway", "track", "bridleway"):
                continue
            rec = road_record(r)
            if rec and not rec["tunnel"]:
                rec["region"] = region
                roads.append(rec)
        for r in d["rails"]:
            rec = rail_record(r)
            if rec and not rec["tunnel"]:
                rec["region"] = region
                rails.append(rec)
        for a in d["areas"]:
            t = a["tags"]
            if t.get("tunnel") or t.get("location") == "underground" or (t.get("layer", "0").startswith("-") and "natural" not in t):
                continue
            wk = is_water_area(t)
            g = a["geom"]
            if wk:
                water.append({"geom": g, "kind": wk, "name": t.get("name:en") or t.get("name"), "region": region})
                continue
            gc = ground_class(t)
            if gc:
                areas.append({"geom": g, "ground": GROUND_IDX[gc], "name": t.get("name:en") or t.get("name"),
                              "region": region, "area": g.area})
        for l in d["lines"]:
            t = l["tags"]
            ww = t.get("waterway")
            if ww in WATERWAY_W and t.get("tunnel") in (None, "no") and t.get("covered") != "yes" and t.get("layer", "0")[:1] != "-":
                w = parse_len(t.get("width")) or WATERWAY_W[ww]
                g = l["geom"].buffer(w / 2, cap_style="flat", join_style="round", quad_segs=3)
                water.append({"geom": g, "kind": "canal" if ww in ("canal", "drain", "ditch") else "river",
                              "name": t.get("name"), "region": region, "linear": True})
            if t.get("man_made") in ("pier", "breakwater", "groyne"):
                w = parse_len(t.get("width")) or 4.0
                areas.append({"geom": l["geom"].buffer(w / 2, cap_style="flat"), "ground": GROUND_IDX["pier"],
                              "name": t.get("name"), "region": region, "area": 0})
        # POIs for search / labels (only Singapore + major places elsewhere)
        for p in d["points"]:
            t = p["tags"]
            nm = t.get("name:en") or t.get("name")
            if not nm:
                continue
            typ, imp = poi_type(t)
            if typ is None:
                continue
            if region != "sg" and typ not in ("place", "suburb", "island", "airport"):
                continue
            pois.append({"x": p["x"], "y": p["y"], "type": POI_IDX[typ], "name": nm, "imp": imp,
                         "zh": t.get("name:zh"), "region": region})
        for a in d["areas"]:
            t = a["tags"]
            nm = t.get("name:en") or t.get("name")
            if not nm or region != "sg":
                continue
            typ, imp = poi_type(t)
            if typ is None or typ in ("road",):
                continue
            g = a["geom"]
            if g.area < 2000 and typ in ("park", "water"):
                continue
            c = g.representative_point()
            imp2 = imp + min(3, int(math.log10(max(g.area, 10)) - 2))
            pois.append({"x": c.x, "y": c.y, "type": POI_IDX[typ], "name": nm, "imp": imp2,
                         "zh": t.get("name:zh"), "region": region, "area": g.area})
    # Water levels from the terrain
    h = np.load(CACHE / "height_near.npy")
    n = h.shape[0]
    step = 2 * HALF / n
    for w in water:
        g = w["geom"]
        try:
            pts = shapely.get_coordinates(g.buffer(-min(4.0, math.sqrt(max(g.area, 1)) * 0.1)))
        except Exception:
            pts = shapely.get_coordinates(g)
        if len(pts) == 0:
            pts = shapely.get_coordinates(g)
        if len(pts) > 400:
            pts = pts[:: len(pts) // 400]
        c = np.clip(((pts[:, 0] + HALF) / step).astype(int), 0, n - 1)
        r = np.clip(((HALF - pts[:, 1]) / step).astype(int), 0, n - 1)
        v = h[r, c]
        lvl = float(np.percentile(v, 15)) if len(v) else 0.0
        if w["kind"] in ("canal", "river"):
            lvl -= 1.5  # canals sit in concrete channels below street level
        w["level"] = max(0.0, lvl) if lvl < 2.0 else lvl
    bridge_profiles(roads, "road")
    bridge_profiles(rails, "rail")
    print(f"[feat] roads {len(roads)} rails {len(rails)} areas {len(areas)} water {len(water)} pois {len(pois)} "
          f"in {time.time()-t0:.1f}s")
    pickle.dump({"roads": roads, "rails": rails, "areas": areas, "water": water, "pois": pois},
                open(CACHE / "features.pkl", "wb"), protocol=pickle.HIGHEST_PROTOCOL)


def poi_type(t):
    pl = t.get("place")
    if pl in ("city", "town"):
        return "place", 9
    if pl in ("suburb", "quarter"):
        return "suburb", 7
    if pl in ("neighbourhood", "village", "hamlet", "locality"):
        return "neighbourhood", 5
    if pl in ("island", "islet"):
        return "island", 6
    if t.get("railway") == "station" or t.get("public_transport") == "station":
        if t.get("station") == "light_rail" or t.get("light_rail") == "yes":
            return "station_lrt", 5
        if t.get("station") == "subway" or t.get("subway") == "yes" or t.get("railway") == "station":
            return "station_mrt", 6
    if t.get("aeroway") == "aerodrome":
        return "airport", 8
    if t.get("natural") == "peak":
        return "peak", 5
    if t.get("man_made") == "lighthouse":
        return "lighthouse", 4
    if t.get("natural") == "beach":
        return "beach", 5
    if t.get("tourism") == "museum":
        return "museum", 5
    if t.get("tourism") == "viewpoint":
        return "viewpoint", 4
    if t.get("tourism") in ("attraction", "theme_park", "zoo", "aquarium"):
        return "attraction", 6
    if t.get("historic") in ("monument", "memorial", "building", "castle", "fort", "ruins"):
        return "landmark", 4
    if t.get("leisure") in ("park", "nature_reserve", "garden") or t.get("boundary") == "national_park":
        return "park", 4
    if t.get("leisure") == "stadium":
        return "stadium", 5
    if t.get("shop") == "mall":
        return "mall", 5
    if t.get("amenity") in ("food_court", "marketplace") or "hawker" in (t.get("name") or "").lower():
        return "hawker", 4
    if t.get("amenity") == "place_of_worship":
        return "religious", 3
    if t.get("tourism") == "hotel":
        return "hotel", 3
    if t.get("amenity") in ("university", "college"):
        return "school", 4
    if t.get("amenity") == "hospital":
        return "hospital", 4
    if t.get("natural") == "water" or t.get("landuse") == "reservoir":
        return "water", 4
    if t.get("man_made") == "bridge":
        return "bridge", 4
    return None, 0


if __name__ == "__main__":
    run()
