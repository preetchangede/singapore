"""Building normalisation and height inference.

Every OSM building outline / part is turned into a normalised record:

    geom      shapely Polygon (local frame, may have holes)
    h, minh   top of walls / base above ground (m)
    roof      roof shape code, roof_h (m)
    levels    storeys (int, 0 if unknown)
    cls       facade class (see CLASSES)
    src       provenance of the height: osm_h, osm_lv, hdb, model
    ...

Heights missing in OSM (~70 % of footprints) are inferred with a gradient
boosted model trained on the buildings that *do* have a known height.  The
model sees footprint geometry, OSM type, URA Master Plan 2019 zoning and plot
ratio (GPR), the plot-ratio-implied storey count, 3D-GloBFP satellite height
estimates, and the heights of the nearest known neighbours.
"""
import csv
import json
import math
import pickle
import re
import time
from collections import Counter, defaultdict

import numpy as np
import shapely
from scipy.spatial import cKDTree

from .config import CACHE, HDB_CSV, MP_LANDUSE, GLOBFP
from .proj import geom_to_local, ll_to_local
from . import osm

# ---------------------------------------------------------------------------
# Facade classes (shared with the web client: src/world/buildingClasses.ts)
# ---------------------------------------------------------------------------
CLASSES = [
    "generic", "house", "terrace", "hdb", "condo", "office", "retail", "industrial",
    "civic", "religious", "hospital", "hotel", "parking", "shophouse", "roof",
    "transport", "tank", "construction", "greenhouse", "sports", "school", "warehouse",
]
C = {n: i for i, n in enumerate(CLASSES)}

ROOF = {"flat": 0, "gabled": 1, "hipped": 2, "pyramidal": 3, "dome": 4, "round": 5,
        "skillion": 6, "onion": 7, "cone": 8, "half-hipped": 2, "mansard": 2,
        "gambrel": 1, "saltbox": 1, "barrel": 5}


def parse_len(v):
    """Parse '12', '12 m', '12m', '40 ft', '12.5;14' -> metres or None."""
    if v is None:
        return None
    v = str(v).strip().lower().replace(",", ".").split(";")[0]
    m = re.match(r"^(-?[0-9]*\.?[0-9]+)\s*(m|ft|')?", v)
    if not m:
        return None
    x = float(m.group(1))
    if m.group(2) in ("ft", "'"):
        x *= 0.3048
    if not math.isfinite(x):
        return None
    return x


def parse_int(v):
    x = parse_len(v)
    if x is None:
        return None
    return int(round(x))


# ---------------------------------------------------------------------------
# HDB matching
# ---------------------------------------------------------------------------
ABBR = {
    'AVENUE': 'AVE', 'STREET': 'ST', 'ROAD': 'RD', 'DRIVE': 'DR', 'CRESCENT': 'CRES',
    'CLOSE': 'CL', 'PLACE': 'PL', 'CENTRAL': 'CTRL', 'NORTH': 'NTH', 'SOUTH': 'STH',
    'JALAN': 'JLN', 'LORONG': 'LOR', 'TANJONG': 'TG', 'BUKIT': 'BT', 'KAMPONG': 'KG',
    'UPPER': 'UPP', 'COMMONWEALTH': "C'WEALTH", 'GARDENS': 'GDNS', 'GARDEN': 'GDN',
    'HEIGHTS': 'HTS', 'PARK': 'PK', 'TERRACE': 'TER', 'SQUARE': 'SQ', 'GROVE': 'GR',
    'MARKET': 'MKT', 'CENTRE': 'CTR', 'INDUSTRIAL': 'IND', 'ESTATE': 'EST',
    'BOULEVARD': 'BLVD', 'HIGHWAY': 'HWAY', 'EXPRESSWAY': 'EXPWY', 'MOUNT': 'MT',
    'GREEN': 'GRN', 'SAINT': 'ST',
}


def norm_street(s):
    s = s.upper().replace("’", "'").replace(".", "")
    s = re.sub(r"[^A-Z0-9' ]", " ", s)
    return " ".join(ABBR.get(t, t) for t in s.split())


def load_hdb():
    out = {}
    for r in csv.DictReader(open(HDB_CSV)):
        out[(r["blk_no"].strip().upper(), norm_street(r["street"]))] = r
    return out


# ---------------------------------------------------------------------------
# URA Master Plan 2019 land use
# ---------------------------------------------------------------------------
LU_CATS = [
    "RESIDENTIAL", "COMMERCIAL", "BUSINESS 1", "BUSINESS 2", "RESIDENTIAL WITH COMMERCIAL AT 1ST STOREY",
    "PARK", "UTILITY", "WATERBODY", "RESIDENTIAL / INSTITUTION", "COMMERCIAL & RESIDENTIAL",
    "OPEN SPACE", "RESERVE SITE", "PLACE OF WORSHIP", "CIVIC & COMMUNITY INSTITUTION",
    "EDUCATIONAL INSTITUTION", "COMMERCIAL / INSTITUTION", "TRANSPORT FACILITIES", "HOTEL",
    "SPORTS & RECREATION", "AGRICULTURE", "BUSINESS PARK", "HEALTH & MEDICAL CARE", "WHITE",
    "SPECIAL USE", "PORT / AIRPORT", "MASS RAPID TRANSIT", "BEACH AREA", "CEMETERY",
    "LIGHT RAPID TRANSIT", "ROAD",
]
LU_IDX = {n: i + 1 for i, n in enumerate(LU_CATS)}


def load_landuse():
    p = CACHE / "mp2019_landuse.pkl"
    if p.exists():
        return pickle.load(open(p, "rb"))
    t0 = time.time()
    d = json.load(open(MP_LANDUSE))
    geoms, lu, gpr = [], [], []
    for f in d["features"]:
        g = shapely.geometry.shape(f["geometry"])
        if g.has_z:
            g = shapely.force_2d(g)
        pr = f["properties"]
        geoms.append(g)
        desc = (pr.get("LU_DESC") or "").strip()
        if desc.endswith(" - WHITE"):
            desc = desc[:-8]
        lu.append(LU_IDX.get(desc, 0))
        try:
            gpr.append(float(pr.get("GPR")))
        except (TypeError, ValueError):
            gpr.append(np.nan)
    geoms = geom_to_local(np.array(geoms, dtype=object))
    res = {"geoms": geoms, "lu": np.array(lu, np.int16), "gpr": np.array(gpr, np.float32)}
    pickle.dump(res, open(p, "wb"))
    print(f"[lu] {len(geoms)} parcels in {time.time()-t0:.1f}s")
    return res


# ---------------------------------------------------------------------------
# Classification of OSM building type -> facade class
# ---------------------------------------------------------------------------
def classify(t, area):
    b = t.get("building") or t.get("building:part") or "yes"
    am = t.get("amenity", "")
    if t.get("residential") == "HDB":
        return C["hdb"]
    if b in ("house", "detached", "semidetached_house", "bungalow", "villa", "cabin", "hut"):
        return C["house"]
    if b in ("terrace",):
        return C["terrace"]
    if b in ("apartments", "residential", "dormitory", "flats"):
        return C["condo"]
    if b in ("office", "commercial", "government"):
        return C["office"]
    if b in ("retail", "supermarket", "kiosk", "mall"):
        return C["retail"]
    if b in ("industrial", "factory", "manufacture"):
        return C["industrial"]
    if b in ("warehouse", "storage", "hangar"):
        return C["warehouse"]
    if b in ("school", "university", "college", "kindergarten") or am in ("school", "university", "college", "kindergarten"):
        return C["school"]
    if b in ("public", "civic", "townhall", "courthouse", "library", "museum", "fire_station", "police", "community_centre"):
        return C["civic"]
    if b in ("temple", "church", "mosque", "shrine", "cathedral", "chapel", "synagogue", "religious", "gurdwara") or am == "place_of_worship":
        return C["religious"]
    if b in ("hospital", "clinic") or am in ("hospital", "clinic"):
        return C["hospital"]
    if b in ("hotel",) or t.get("tourism") == "hotel":
        return C["hotel"]
    if b in ("parking", "garage", "garages", "carport") or am == "parking":
        return C["parking"]
    if b in ("roof", "canopy", "shed", "pavilion", "gazebo", "shelter", "carport", "bridge", "covered_walkway"):
        return C["roof"]
    if b in ("train_station", "transportation", "terminal") or t.get("aeroway") == "terminal":
        return C["transport"]
    if b in ("storage_tank", "silo", "tank") or t.get("man_made") in ("storage_tank", "silo"):
        return C["tank"]
    if b in ("construction",):
        return C["construction"]
    if b in ("greenhouse",):
        return C["greenhouse"]
    if b in ("stadium", "sports_hall", "sports_centre", "grandstand") or t.get("leisure") in ("stadium", "sports_centre"):
        return C["sports"]
    if b in ("service", "transformer_tower", "substation", "toilets", "guardhouse"):
        return C["generic"]
    return C["generic"]


# Typical storey heights by class (m)
STOREY = np.full(len(CLASSES), 3.3, np.float32)
for k, v in {"house": 3.2, "terrace": 3.3, "hdb": 2.8, "condo": 3.1, "office": 4.0, "retail": 4.8,
             "industrial": 5.5, "warehouse": 7.0, "civic": 4.2, "religious": 4.5, "hospital": 4.0,
             "hotel": 3.4, "parking": 3.0, "shophouse": 3.8, "roof": 4.0, "transport": 5.0,
             "tank": 5.0, "construction": 3.5, "greenhouse": 4.0, "sports": 6.0, "school": 3.8,
             "generic": 3.3}.items():
    STOREY[C[k]] = v


def levels_to_height(levels, cls):
    s = STOREY[cls]
    if cls == C["hdb"]:
        return 3.6 + (levels - 1) * 2.8 + 1.4  # void deck + typical floors + parapet
    return levels * s + (0.8 if levels > 1 else 0.4)


# ---------------------------------------------------------------------------
# Main normalisation
# ---------------------------------------------------------------------------
def _polys(g):
    g = shapely.make_valid(g) if not g.is_valid else g
    out = []
    for p in shapely.get_parts(g):
        if p.geom_type == "Polygon" and p.area >= 4:
            out.append(shapely.orient_polygons(p) if hasattr(shapely, "orient_polygons") else shapely.geometry.polygon.orient(p))
        elif p.geom_type in ("MultiPolygon", "GeometryCollection"):
            for q in shapely.get_parts(p):
                if q.geom_type == "Polygon" and q.area >= 4:
                    out.append(shapely.geometry.polygon.orient(q))
    return out


def normalise(regions=("sg", "jb", "riau")):
    hdb = load_hdb()
    recs = []
    hdb_hits = 0
    for region in regions:
        d = osm.load(region)
        for b in d["buildings"]:
            t = b["tags"]
            if t.get("location") == "underground" or (parse_len(t.get("layer")) or 0) < 0 and t.get("building") in (None, "yes", "commercial", "retail"):
                if parse_len(t.get("height")) in (None, 0):
                    continue
            if t.get("building") in ("no", "ruins", "demolished", "proposed", "razed", "collapsed"):
                continue
            for p in _polys(b["geom"]):
                area = p.area
                cls = classify(t, area)
                h = parse_len(t.get("height"))
                minh = parse_len(t.get("min_height")) or 0.0
                lv = parse_int(t.get("building:levels"))
                minlv = parse_int(t.get("building:min_level"))
                rh = parse_len(t.get("roof:height"))
                rlv = parse_int(t.get("roof:levels"))
                src = None
                hdb_row = None
                if region == "sg" and "addr:housenumber" in t and "addr:street" in t:
                    k = (t["addr:housenumber"].strip().upper(), norm_street(t["addr:street"]))
                    hdb_row = hdb.get(k)
                if hdb_row is not None:
                    hdb_hits += 1
                    try:
                        hl = int(hdb_row["max_floor_lvl"])
                    except ValueError:
                        hl = None
                    if hdb_row.get("multistorey_carpark") == "Y" and hdb_row.get("residential") != "Y":
                        cls = C["parking"]
                    elif hdb_row.get("residential") == "Y":
                        cls = C["hdb"]
                    elif hdb_row.get("market_hawker") == "Y":
                        cls = C["retail"]
                    if hl and not lv:
                        lv = hl
                if h is not None and h <= 0.5 and t.get("height") is not None:
                    continue  # explicitly zero-height outlines (e.g. Singapore Flyer base)
                if h is not None and h > 0.5:
                    src = "osm_h"
                elif lv:
                    src = "osm_lv" if hdb_row is None else "hdb"
                    h = levels_to_height(lv, cls) + minh
                if minlv and not t.get("min_height"):
                    minh = minlv * STOREY[cls]
                rs = t.get("roof:shape", "")
                recs.append({
                    "id": b["id"], "region": region, "geom": p, "area": area, "cls": cls,
                    "btype": t.get("building") or t.get("building:part") or "yes",
                    "part": b["part"], "h": h, "minh": minh, "levels": lv or 0, "src": src,
                    "roof": ROOF.get(rs, 0) if rs else -1, "roof_h": rh, "roof_lv": rlv,
                    "colour": t.get("building:colour"), "roof_colour": t.get("roof:colour"),
                    "material": t.get("building:material"), "roof_material": t.get("roof:material"),
                    "name": t.get("name:en") or t.get("name"), "hdb": hdb_row is not None,
                    "hdb_year": int(hdb_row["year_completed"]) if hdb_row and hdb_row.get("year_completed", "").isdigit() else 0,
                    "addr": (t.get("addr:housenumber", "") + " " + t.get("addr:street", "")).strip(),
                    "tags": t,
                })
    print(f"[bld] {len(recs)} footprints, hdb matched {hdb_hits}")
    return recs


def resolve_parts(recs):
    """Mark outlines that are covered by building:parts so that only the parts
    are extruded (Simple 3D Buildings convention)."""
    parts = [i for i, r in enumerate(recs) if r["part"]]
    outl = [i for i, r in enumerate(recs) if not r["part"]]
    if not parts:
        return
    pg = np.array([recs[i]["geom"] for i in parts], dtype=object)
    tree = shapely.STRtree(pg)
    og = np.array([recs[i]["geom"] for i in outl], dtype=object)
    pairs = tree.query(og, predicate="intersects")
    cover = defaultdict(float)
    tall = defaultdict(float)
    for oi, pi in zip(*pairs):
        o = recs[outl[oi]]
        p = recs[parts[pi]]
        try:
            a = o["geom"].intersection(p["geom"]).area
        except Exception:
            continue
        if a > 0.2 * p["area"]:
            cover[oi] += a
            tall[oi] = max(tall[oi], p["h"] or 0)
    n = 0
    for oi, a in cover.items():
        o = recs[outl[oi]]
        o["has_parts"] = True
        if a >= 0.55 * o["area"]:
            o["skip3d"] = True
            n += 1
    print(f"[bld] {n} outlines replaced by their parts")


# ---------------------------------------------------------------------------
# Feature engineering + model
# ---------------------------------------------------------------------------
def features(recs, lu):
    t0 = time.time()
    n = len(recs)
    geoms = np.array([r["geom"] for r in recs], dtype=object)
    cent = shapely.centroid(geoms)
    cx = shapely.get_x(cent)
    cy = shapely.get_y(cent)
    area = np.array([r["area"] for r in recs], np.float32)
    perim = shapely.length(geoms).astype(np.float32)
    mrr = shapely.minimum_rotated_rectangle(geoms)
    # side lengths of min rotated rectangle
    coords = [np.asarray(m.exterior.coords) if m.geom_type == "Polygon" else np.zeros((5, 2)) for m in mrr]
    side_a = np.array([np.hypot(*(c[1] - c[0])) for c in coords], np.float32)
    side_b = np.array([np.hypot(*(c[2] - c[1])) for c in coords], np.float32)
    w = np.minimum(side_a, side_b)
    l = np.maximum(side_a, side_b)
    nverts = np.array([len(r["geom"].exterior.coords) for r in recs], np.float32)
    nholes = np.array([len(r["geom"].interiors) for r in recs], np.float32)
    compact = (4 * np.pi * area / np.maximum(perim, 1e-3) ** 2).astype(np.float32)
    fill = (area / np.maximum(w * l, 1e-3)).astype(np.float32)
    cls = np.array([r["cls"] for r in recs], np.int16)
    region = np.array([{"sg": 0, "jb": 1, "riau": 2}[r["region"]] for r in recs], np.int8)
    named = np.array([1 if r["name"] else 0 for r in recs], np.int8)
    part = np.array([1 if r["part"] else 0 for r in recs], np.int8)
    btypes = Counter(r["btype"] for r in recs)
    top = [b for b, _ in btypes.most_common(40)]
    bt_idx = {b: i + 1 for i, b in enumerate(top)}
    btype = np.array([bt_idx.get(r["btype"], 0) for r in recs], np.int16)
    has_amen = np.array([1 if ("amenity" in r["tags"] or "shop" in r["tags"]) else 0 for r in recs], np.int8)

    # URA land use parcel join
    ptree = shapely.STRtree(lu["geoms"])
    bi, pi = ptree.query(cent, predicate="within")
    lu_c = np.zeros(n, np.int16)
    gpr = np.full(n, np.nan, np.float32)
    par = np.full(n, -1, np.int64)
    lu_c[bi] = lu["lu"][pi]
    gpr[bi] = lu["gpr"][pi]
    par[bi] = pi
    # parcel site coverage -> implied storeys = GPR / coverage
    cov = np.full(n, np.nan, np.float32)
    parcel_area = shapely.area(lu["geoms"])
    acc = defaultdict(float)
    for i in np.nonzero(par >= 0)[0]:
        if not recs[i]["part"]:
            acc[par[i]] += area[i]
    for i in np.nonzero(par >= 0)[0]:
        pa = parcel_area[par[i]]
        if pa > 0:
            cov[i] = min(acc[par[i]] / pa, 1.0)
    implied = (gpr / np.maximum(cov, 0.05)).astype(np.float32)

    # 3D-GloBFP join (satellite-derived height estimates)
    gl = pickle.load(open(GLOBFP, "rb"))
    gx, gy, gh = [], [], []
    for pts, parts, rec in gl:
        a = np.asarray(pts)
        gx.append(a[:, 0].mean()); gy.append(a[:, 1].mean()); gh.append(rec[-1])
    gxl, gyl = ll_to_local(np.array(gx), np.array(gy))
    gh = np.array(gh, np.float32)
    gpts = shapely.points(gxl, gyl)
    gtree = shapely.STRtree(gpts)
    bi, gi = gtree.query(geoms, predicate="contains")
    g_sum = np.zeros(n, np.float64); g_cnt = np.zeros(n, np.float64); g_max = np.zeros(n, np.float32)
    np.add.at(g_sum, bi, gh[gi]); np.add.at(g_cnt, bi, 1)
    np.maximum.at(g_max, bi, gh[gi])
    g_mean = np.where(g_cnt > 0, g_sum / np.maximum(g_cnt, 1), np.nan).astype(np.float32)
    g_max = np.where(g_cnt > 0, g_max, np.nan).astype(np.float32)
    # nearest GloBFP within 15 m when nothing is contained
    miss = np.nonzero(g_cnt == 0)[0]
    if len(miss):
        kd = cKDTree(np.column_stack([gxl, gyl]))
        dd, ii = kd.query(np.column_stack([cx[miss], cy[miss]]), k=1, distance_upper_bound=15)
        ok = np.isfinite(dd)
        g_mean[miss[ok]] = gh[ii[ok]]
    print(f"[feat] globfp matched {(g_cnt>0).mean()*100:.1f}% contained, {np.isfinite(g_mean).mean()*100:.1f}% any")

    # distance to CBD (Raffles Place) and density
    rx, ry = ll_to_local(103.8514, 1.2840)
    dcbd = np.hypot(cx - rx, cy - ry).astype(np.float32)
    kd_all = cKDTree(np.column_stack([cx, cy]))
    dens = np.array([len(x) for x in kd_all.query_ball_point(np.column_stack([cx, cy]), r=100)], np.float32)

    X = {
        "area": np.log1p(area), "perim": np.log1p(perim), "w": w, "l": l, "nverts": nverts,
        "nholes": nholes, "compact": compact, "fill": fill, "cls": cls, "btype": btype,
        "region": region, "named": named, "part": part, "amen": has_amen, "lu": lu_c,
        "gpr": gpr, "cov": cov, "implied": implied, "g_mean": g_mean, "g_max": g_max,
        "g_cnt": g_cnt.astype(np.float32), "dcbd": np.log1p(dcbd), "dens": dens,
    }
    print(f"[feat] base features in {time.time()-t0:.1f}s")
    return X, cx, cy


def neighbour_features(X, cx, cy, y_known):
    """IDW mean / max of log-height of nearest buildings with known height."""
    kn = np.nonzero(np.isfinite(y_known))[0]
    kd = cKDTree(np.column_stack([cx[kn], cy[kn]]))
    k = 12
    dd, ii = kd.query(np.column_stack([cx, cy]), k=k + 1)
    # drop self matches
    nb_mean = np.zeros(len(cx), np.float32)
    nb_max = np.zeros(len(cx), np.float32)
    nb_d = np.zeros(len(cx), np.float32)
    ly = np.log(np.maximum(y_known[kn], 1.0))
    for j in range(len(cx)):
        idx = kn[ii[j]]
        m = idx != j
        d = dd[j][m][:k]
        v = ly[ii[j][m][:k]]
        wgt = 1.0 / np.maximum(d, 5.0) ** 1.5
        nb_mean[j] = (v * wgt).sum() / wgt.sum()
        nb_max[j] = v.max()
        nb_d[j] = d[0]
    X["nb_mean"] = nb_mean
    X["nb_max"] = nb_max
    X["nb_d"] = np.log1p(nb_d)


def train_and_predict(recs, X, cx, cy):
    import lightgbm as lgb
    y = np.array([r["h"] if r["h"] is not None else np.nan for r in recs], np.float32)
    names = list(X.keys())
    M = np.column_stack([X[k].astype(np.float32) for k in names])
    known = np.isfinite(y) & (y > 1.0) & (y < 400)
    # spatial block CV (2 km blocks) so neighbour features cannot leak across folds
    gx = np.floor(cx / 2000).astype(int)
    gy = np.floor(cy / 2000).astype(int)
    block = (gx * 1000 + gy)
    folds = (np.abs(block * 2654435761) % 5)
    params = dict(objective="regression_l1", learning_rate=0.05, num_leaves=63, min_data_in_leaf=20,
                  feature_fraction=0.85, bagging_fraction=0.85, bagging_freq=1, verbose=-1,
                  num_threads=4)
    cat = [names.index(c) for c in ("cls", "btype", "region", "lu")]
    feat_names = names
    logy = np.log(np.clip(y, 1, 400))
    oof = np.full(len(y), np.nan, np.float32)
    for f in range(5):
        tr = known & (folds != f)
        te = known & (folds == f)
        ds = lgb.Dataset(M[tr], logy[tr], categorical_feature=cat, feature_name=feat_names, free_raw_data=False)
        mdl = lgb.train(params, ds, num_boost_round=600)
        oof[te] = np.exp(mdl.predict(M[te]))
    err = oof[known] - y[known]
    rmse = float(np.sqrt(np.nanmean(err ** 2)))
    mae = float(np.nanmean(np.abs(err)))
    rel = float(np.nanmedian(np.abs(err) / y[known]))
    # baselines
    base_type = np.array([levels_to_height(2 if r["cls"] in (C["house"], C["terrace"]) else 3, r["cls"]) for r in recs])
    b_err = base_type[known] - y[known]
    g = X["g_mean"]
    gm = known & np.isfinite(g)
    print(f"[model] spatial-CV  RMSE {rmse:.2f} m  MAE {mae:.2f} m  median rel err {rel*100:.1f}%  (n={known.sum()})")
    print(f"[model] baseline type-default RMSE {np.sqrt(np.mean(b_err**2)):.2f} m, "
          f"globfp-only RMSE {np.sqrt(np.mean((g[gm]-y[gm])**2)):.2f} m (n={gm.sum()})")
    ds = lgb.Dataset(M[known], logy[known], categorical_feature=cat, feature_name=feat_names)
    mdl = lgb.train(params, ds, num_boost_round=600)
    pred = np.exp(mdl.predict(M)).astype(np.float32)
    imp = sorted(zip(mdl.feature_importance("gain"), feat_names), reverse=True)[:12]
    print("[model] top features:", ", ".join(f"{n}" for _, n in imp))
    stats = {"rmse": rmse, "mae": mae, "median_rel": rel, "n_train": int(known.sum()),
             "baseline_rmse": float(np.sqrt(np.mean(b_err ** 2)))}
    return pred, stats


def finalize(recs, pred):
    """Fill missing heights with model predictions + sanity clamps; derive levels and roofs."""
    rng = np.random.default_rng(42)
    for i, r in enumerate(recs):
        cls = r["cls"]
        if r["h"] is None:
            h = float(pred[i])
            if cls in (C["house"],):
                h = float(np.clip(h, 5.5, 13.5))
            elif cls == C["terrace"]:
                h = float(np.clip(h, 6.0, 13.0))
            elif cls == C["roof"]:
                h = float(np.clip(h, 3.0, 9.0))
            elif cls == C["tank"]:
                h = float(np.clip(h, 6.0, 30.0))
            r["h"] = max(h, r["minh"] + 2.5)
            r["src"] = "model"
        else:
            r["h"] = float(max(r["h"], r["minh"] + 1.0))
        if not r["levels"]:
            r["levels"] = max(1, int(round((r["h"] - r["minh"]) / STOREY[cls])))
        # roof shape defaults for landed housing (Singapore: mostly hipped / gabled clay tiles)
        if r["roof"] < 0:
            if cls in (C["house"], C["terrace"], C["shophouse"]) and r["area"] < 900:
                u = rng.random()
                r["roof"] = ROOF["hipped"] if u < 0.55 else (ROOF["gabled"] if u < 0.85 else ROOF["flat"])
            else:
                r["roof"] = 0
        if r["roof"] in (1, 2, 3, 6) and not r["roof_h"]:
            r["roof_h"] = float(min(3.2, max(1.6, math.sqrt(r["area"]) * 0.18)))
        if r["roof"] in (4, 5, 7, 8) and not r["roof_h"]:
            r["roof_h"] = float(min(30.0, max(2.0, math.sqrt(r["area"]) * 0.35)))


def detect_shophouses(recs):
    """Shophouses: narrow deep footprints (4-7.5 m wide, 12-45 m deep) packed in
    rows, 2-4 storeys, in mixed / commercial zones.  Iconic in Chinatown, Little
    India, Kampong Glam, Joo Chiat, Tanjong Pagar, Geylang, Emerald Hill."""
    cand = []
    for i, r in enumerate(recs):
        if r["region"] != "sg" or r["part"]:
            continue
        if r["cls"] not in (C["generic"], C["retail"], C["office"], C["terrace"], C["condo"], C["house"], C["hotel"]):
            continue
        if not (50 <= r["area"] <= 420):
            continue
        cand.append(i)
    if not cand:
        return
    g = np.array([recs[i]["geom"] for i in cand], dtype=object)
    mrr = shapely.minimum_rotated_rectangle(g)
    ok = []
    for j, m in enumerate(mrr):
        c = np.asarray(m.exterior.coords)
        a, b = np.hypot(*(c[1] - c[0])), np.hypot(*(c[2] - c[1]))
        w, l = min(a, b), max(a, b)
        if 3.8 <= w <= 7.8 and 11 <= l <= 48 and l / w >= 2.0:
            ok.append(j)
    ok = np.array(ok)
    if len(ok) == 0:
        return
    gg = g[ok]
    tree = shapely.STRtree(gg)
    pairs = tree.query(gg, predicate="dwithin", distance=0.8)
    nb = Counter(pairs[0][pairs[0] != pairs[1]])
    shop_zones = {LU_IDX[k] for k in (
        "COMMERCIAL", "RESIDENTIAL WITH COMMERCIAL AT 1ST STOREY", "COMMERCIAL & RESIDENTIAL",
        "HOTEL", "COMMERCIAL / INSTITUTION", "WHITE", "PLACE OF WORSHIP")}
    n = 0
    for j, cnt in nb.items():
        if cnt >= 1:
            r = recs[cand[ok[j]]]
            if r.get("_lu", 0) not in shop_zones or r["cls"] == C["house"]:
                continue
            r["cls"] = C["shophouse"]
            n += 1
    print(f"[bld] shophouses detected: {n}")


def run():
    t0 = time.time()
    recs = normalise()
    resolve_parts(recs)
    lu = load_landuse()
    X, cx, cy = features(recs, lu)
    for i, r in enumerate(recs):
        r["_lu"] = int(X["lu"][i])
    detect_shophouses(recs)
    X["cls"] = np.array([r["cls"] for r in recs], np.int16)
    y = np.array([r["h"] if r["h"] is not None else np.nan for r in recs], np.float32)
    neighbour_features(X, cx, cy, y)
    pred, stats = train_and_predict(recs, X, cx, cy)
    finalize(recs, pred)
    src = Counter(r["src"] for r in recs)
    print(f"[bld] height sources: {dict(src)}")
    for i, r in enumerate(recs):
        r["cx"], r["cy"] = float(cx[i]), float(cy[i])
        r["globfp"] = float(X["g_mean"][i]) if np.isfinite(X["g_mean"][i]) else None
        r.pop("tags", None)
    pickle.dump({"recs": recs, "stats": stats}, open(CACHE / "buildings.pkl", "wb"), protocol=pickle.HIGHEST_PROTOCOL)
    json.dump(stats, open(CACHE / "height_model_stats.json", "w"), indent=2)
    print(f"[bld] done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    run()
