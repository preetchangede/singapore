"""Trees from Meta/WRI's 1 m global canopy height model (CHM v2, CC BY 4.0).

For every 4 km bundle we resample the CHM onto a 2 m grid in the local frame,
detect individual crowns with a height-dependent variable-window local-maximum
filter, and emit one tree per crown with its measured height.  Buildings and
water are masked using OSM footprints and the coastline distance field.

Products:
  cache/trees.npy      structured array (x, y, h, r, kind)
  cache/canopy16.npy   canopy height (m) on a 16 m grid over the whole domain
"""
import glob
import pickle
import time

import numpy as np
import rasterio
import rasterio.features
import shapely
from affine import Affine
from rasterio.warp import reproject, Resampling
from scipy import ndimage

from .config import CACHE, CHM_DIR, HALF, BUNDLE, NB, E0, N0
from . import osm

KINDS = ["broadleaf", "raintree", "palm", "forest", "small", "casuarina"]
K = {n: i for i, n in enumerate(KINDS)}
TREE_DTYPE = np.dtype([("x", "f4"), ("y", "f4"), ("h", "f4"), ("r", "f4"), ("kind", "u1")])

RES = 2.0  # m
MARGIN = 32  # px


def _svy_transform(x0, y1, res):
    """Affine for a north-up grid whose top-left is local (x0, y1)."""
    return Affine(res, 0, x0 + E0, 0, -res, y1 + N0)


def run():
    t0 = time.time()
    srcs = [rasterio.open(f) for f in sorted(glob.glob(str(CHM_DIR / "*.tif")))]
    print(f"[veg] CHM sources: {len(srcs)}")
    bld = pickle.load(open(CACHE / "buildings.pkl", "rb"))["recs"]
    bgeoms = np.array([r["geom"] for r in bld], dtype=object)
    btree = shapely.STRtree(bgeoms)
    sdf = np.load(CACHE / "sdf.npy")  # 8 m grid, row 0 = north
    sdf_res = 2 * HALF / sdf.shape[0]
    land = pickle.load(open(CACHE / "land.pkl", "rb"))
    # OSM areas used to type trees (forests, beaches, parks)
    sg = osm.load("sg")
    forest_g, park_g = [], []
    for a in sg["areas"]:
        t = a["tags"]
        if t.get("landuse") == "forest" or t.get("natural") in ("wood",) or t.get("boundary") == "protected_area":
            forest_g.append(a["geom"])
        elif t.get("leisure") in ("park", "garden", "nature_reserve") or t.get("landuse") in ("grass", "recreation_ground"):
            park_g.append(a["geom"])
    forest_u = shapely.unary_union(forest_g) if forest_g else None
    park_u = shapely.unary_union(park_g) if park_g else None
    # major road centrelines for "street tree" typing
    road_lines = [r["geom"] for r in sg["roads"] if r["tags"].get("highway") in (
        "primary", "secondary", "tertiary", "trunk", "residential", "unclassified", "primary_link", "secondary_link")]
    rtree = shapely.STRtree(np.array(road_lines, dtype=object))

    n = int(BUNDLE / RES)
    size = n + 2 * MARGIN
    canopy16 = np.zeros((int(2 * HALF / 16), int(2 * HALF / 16)), np.float32)
    all_trees = []
    rng = np.random.default_rng(7)
    for by in range(NB):
        for bx in range(NB):
            x0 = -HALF + bx * BUNDLE
            y0 = -HALF + by * BUNDLE
            box = shapely.box(x0, y0, x0 + BUNDLE, y0 + BUNDLE)
            if not land.intersects(box):
                continue
            tl_x = x0 - MARGIN * RES
            tl_y = y0 + BUNDLE + MARGIN * RES
            dst = np.zeros((size, size), np.float32)
            dt = _svy_transform(tl_x, tl_y, RES)
            for s in srcs:
                tmp = np.zeros_like(dst)
                reproject(rasterio.band(s, 1), tmp, dst_transform=dt, dst_crs="EPSG:3414",
                          resampling=Resampling.bilinear, src_nodata=255, dst_nodata=0)
                dst = np.maximum(dst, tmp)
            chm = dst
            if chm.max() < 3:
                continue
            # mask: buildings (dilated 1 px), sea
            q = btree.query(shapely.box(tl_x, tl_y - size * RES, tl_x + size * RES, tl_y))
            bmask = np.zeros_like(chm, dtype=np.uint8)
            if len(q):
                bmask = rasterio.features.rasterize(
                    [(bgeoms[i], 1) for i in q], out_shape=chm.shape,
                    transform=Affine(RES, 0, tl_x, 0, -RES, tl_y), fill=0, dtype=np.uint8)
            # coastline distance (nearest sample from 8 m grid)
            ys = tl_y - (np.arange(size) + 0.5) * RES
            xs = tl_x + (np.arange(size) + 0.5) * RES
            ri = np.clip(((HALF - ys) / sdf_res).astype(int), 0, sdf.shape[0] - 1)
            ci = np.clip(((xs + HALF) / sdf_res).astype(int), 0, sdf.shape[1] - 1)
            sd = sdf[np.ix_(ri, ci)]
            chm = np.where(sd > -2, chm, 0)
            sm = ndimage.gaussian_filter(chm, 0.9)
            # canopy raster (16 m) for the overview / forest shell
            inner = sm[MARGIN:MARGIN + n, MARGIN:MARGIN + n]
            k = int(16 / RES)
            c16 = inner.reshape(n // k, k, n // k, k).mean(axis=(1, 3))
            r0 = int((HALF - (y0 + BUNDLE)) / 16)
            c0 = int((x0 + HALF) / 16)
            canopy16[r0:r0 + c16.shape[0], c0:c0 + c16.shape[1]] = c16
            # variable-window local maxima
            peaks = np.zeros(sm.shape, bool)
            bands = [(3, 7, 2), (7, 12, 3), (12, 20, 4), (20, 99, 5)]
            for lo, hi, rad in bands:
                fp = np.hypot(*np.mgrid[-rad:rad + 1, -rad:rad + 1]) <= rad
                mx = ndimage.maximum_filter(sm, footprint=fp, mode="nearest")
                peaks |= (sm >= mx - 1e-4) & (sm >= lo) & (sm < hi)
            peaks &= bmask == 0
            peaks[:MARGIN, :] = False
            peaks[-MARGIN:, :] = False
            peaks[:, :MARGIN] = False
            peaks[:, -MARGIN:] = False
            rr, cc = np.nonzero(peaks)
            if len(rr) == 0:
                continue
            h = sm[rr, cc]
            # sub-pixel jitter so trees don't sit on a 2 m lattice
            px = tl_x + (cc + 0.5 + rng.uniform(-0.45, 0.45, len(cc))) * RES
            py = tl_y - (rr + 0.5 + rng.uniform(-0.45, 0.45, len(rr))) * RES
            # crown radius from a Voronoi segmentation of the canopy: every canopy pixel
            # (> 40% of the local peak height, > 2.5 m) belongs to its nearest detected peak
            lab = np.zeros(sm.shape, np.int32)
            lab[rr, cc] = np.arange(1, len(rr) + 1)
            _, (ir, ic) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
            owner = lab[ir, ic]
            peak_h = np.zeros(len(rr) + 1, np.float32)
            peak_h[1:] = h
            dist_px = np.hypot(ir - np.arange(sm.shape[0])[:, None], ic - np.arange(sm.shape[1])[None, :])
            canopy = (sm > 2.5) & (sm > 0.4 * peak_h[owner]) & (dist_px * RES < 14.0)
            area = np.bincount(owner[canopy].ravel(), minlength=len(rr) + 1)[1:] * RES * RES
            r_seg = np.sqrt(area / np.pi)
            r_allo = np.clip(0.22 * h + 1.0, 1.6, 9.5)
            r = np.clip(np.where(area > 0, 0.85 * r_seg + 0.15 * r_allo, r_allo), 1.5, 12.0)
            t = np.zeros(len(h), TREE_DTYPE)
            t["x"], t["y"], t["h"], t["r"] = px, py, h, r
            all_trees.append(t)
            print(f"[veg] bundle {bx},{by}: {len(t)} trees  (t={time.time()-t0:.0f}s)")
    trees = np.concatenate(all_trees)
    # dedupe across bundle seams (shouldn't happen given margins, but be safe)
    print(f"[veg] total {len(trees)} crowns, typing...")
    pts = shapely.points(trees["x"], trees["y"])
    kind = np.full(len(trees), K["broadleaf"], np.uint8)
    if forest_u is not None:
        inf = shapely.contains_xy(forest_u, trees["x"], trees["y"])
        kind[inf] = K["forest"]
    # beach-side palms: near the coast inside parks
    ri = np.clip(((HALF - trees["y"]) / sdf_res).astype(int), 0, sdf.shape[0] - 1)
    ci = np.clip(((trees["x"] + HALF) / sdf_res).astype(int), 0, sdf.shape[1] - 1)
    dcoast = sdf[ri, ci]
    coastal = (dcoast > 0) & (dcoast < 120) & (kind != K["forest"])
    u = rng.random(len(trees))
    kind[coastal & (u < 0.45)] = K["palm"]
    kind[coastal & (u >= 0.45) & (u < 0.6)] = K["casuarina"]
    # street trees near major roads -> rain trees (broad umbrella crowns)
    near = rtree.query(pts, predicate="dwithin", distance=14)
    is_street = np.zeros(len(trees), bool)
    is_street[near[0]] = True
    sel = is_street & (kind == K["broadleaf"]) & (trees["h"] > 9)
    kind[sel & (u < 0.7)] = K["raintree"]
    kind[(trees["h"] < 6) & (kind == K["broadleaf"])] = K["small"]
    trees["kind"] = kind
    np.save(CACHE / "trees.npy", trees)
    np.save(CACHE / "canopy16.npy", canopy16)
    from collections import Counter
    print("[veg] kinds:", {KINDS[k]: v for k, v in Counter(kind.tolist()).items()})
    print(f"[veg] done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    run()
