"""Terrain, land mask and coastline distance field.

Products (all in the local SVY21 frame):
  cache/land.pkl            shapely MultiPolygon of land (OSM coastline, polygonized)
  cache/sdf.npy             signed distance to coast (m, + land / - sea), 8 m grid
  cache/height_near.npy     bare-earth terrain (m), 2048^2 over the 65.5 km domain
  cache/height_far.npy      coarse terrain (m), 2048^2 over 262 km (horizon)
"""
import glob
import pickle
import time

import numpy as np
import rasterio
import rasterio.features
import shapely
from affine import Affine
from scipy import ndimage

from .config import CACHE, FABDEM_DIR, HALF, FAR_HALF
from .proj import local_to_ll
from . import osm


# ----------------------------------------------------------------------------
# FABDEM mosaic sampling
# ----------------------------------------------------------------------------
class DEM:
    def __init__(self):
        self.tiles = {}
        for f in glob.glob(str(FABDEM_DIR / "*_FABDEM_V1-2.tif")):
            name = f.split("/")[-1][:7]
            lat0 = int(name[1:3]) * (1 if name[0] == "N" else -1)
            lon0 = int(name[4:7]) * (1 if name[3] == "E" else -1)
            with rasterio.open(f) as ds:
                a = ds.read(1).astype(np.float32)
            a[a < -1000] = 0
            self.tiles[(lat0, lon0)] = a  # row 0 = north edge (lat0+1)

    def sample(self, lon, lat):
        """Bilinear sample at arrays of lon/lat (pixel-is-area, 1 arcsec)."""
        lon = np.asarray(lon, np.float64)
        lat = np.asarray(lat, np.float64)
        out = np.zeros(lon.shape, np.float32)
        lat0 = np.floor(lat).astype(int)
        lon0 = np.floor(lon).astype(int)
        for (la, lo), a in self.tiles.items():
            m = (lat0 == la) & (lon0 == lo)
            if not m.any():
                continue
            n = a.shape[0]
            c = (lon[m] - lo) * n - 0.5
            r = (la + 1 - lat[m]) * n - 0.5
            c = np.clip(c, 0, n - 1.001)
            r = np.clip(r, 0, n - 1.001)
            c0 = np.floor(c).astype(int)
            r0 = np.floor(r).astype(int)
            fc = (c - c0).astype(np.float32)
            fr = (r - r0).astype(np.float32)
            v = (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr)
                 + a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)
            out[m] = v
        return out


def grid_ll(half, n):
    """lon/lat of pixel centres of an n x n grid covering [-half, half]^2.
    Row 0 is the NORTH edge (image convention)."""
    step = 2 * half / n
    xs = -half + (np.arange(n) + 0.5) * step
    ys = half - (np.arange(n) + 0.5) * step
    X, Y = np.meshgrid(xs, ys)
    lon, lat = local_to_ll(X.ravel(), Y.ravel())
    return lon.reshape(n, n), lat.reshape(n, n)


def affine_for(half, n):
    step = 2 * half / n
    return Affine(step, 0, -half, 0, -step, half)


# ----------------------------------------------------------------------------
# Land polygons from OSM coastline
# ----------------------------------------------------------------------------
def build_land(dem):
    t0 = time.time()
    lines = []
    for region in ("sg", "jb", "riau"):
        d = osm.load(region)
        for l in d["lines"]:
            if l["tags"].get("natural") == "coastline":
                lines.append(l["geom"])
    print(f"[land] {len(lines)} coastline ways")
    box = shapely.box(-HALF - 2000, -HALF - 2000, HALF + 2000, HALF + 2000)
    merged = shapely.unary_union(lines + [box.boundary])
    merged = shapely.intersection(merged, box.buffer(1))
    polys = list(shapely.get_parts(shapely.polygonize(shapely.get_parts(merged))))
    print(f"[land] {len(polys)} faces in {time.time()-t0:.1f}s")
    land = []
    for p in polys:
        if p.area < 50:
            continue
        # sample several interior points against FABDEM
        pts = [p.representative_point()]
        minx, miny, maxx, maxy = p.bounds
        rng = np.random.default_rng(1)
        cand = np.column_stack([rng.uniform(minx, maxx, 64), rng.uniform(miny, maxy, 64)])
        inside = shapely.contains_xy(p, cand[:, 0], cand[:, 1])
        cand = cand[inside][:24]
        xs = np.concatenate([[pts[0].x], cand[:, 0]])
        ys = np.concatenate([[pts[0].y], cand[:, 1]])
        lon, lat = local_to_ll(xs, ys)
        h = dem.sample(lon, lat)
        frac_land = float((h > 0.05).mean())
        if frac_land > 0.5:
            land.append(p)
    land = shapely.unary_union(land)
    print(f"[land] land area {land.area/1e6:.1f} km2 in {time.time()-t0:.1f}s")
    return land


def rasterize(geoms, half, n, all_touched=False, dtype=np.uint8):
    return rasterio.features.rasterize(
        [(g, 1) for g in geoms if g is not None and not g.is_empty],
        out_shape=(n, n), transform=affine_for(half, n), fill=0,
        all_touched=all_touched, dtype=dtype)


def build_sdf(land, n=8192):
    """Signed distance to coast in metres on an n x n grid (8 m)."""
    t0 = time.time()
    step = 2 * HALF / n
    m = rasterize(shapely.get_parts(land), HALF, n).astype(bool)
    d_in = ndimage.distance_transform_edt(m) * step
    d_out = ndimage.distance_transform_edt(~m) * step
    sdf = np.where(m, d_in - 0.5 * step, -(d_out - 0.5 * step)).astype(np.float32)
    print(f"[sdf] {n}^2 in {time.time()-t0:.1f}s")
    return sdf, m


def build_height_near(dem, sdf, n=2048):
    t0 = time.time()
    lon, lat = grid_ll(HALF, n)
    h = dem.sample(lon, lat)
    # light smoothing to remove 30 m stair-steps (keeps hills)
    h = ndimage.gaussian_filter(h, 0.6)
    # downsample sdf to this grid
    k = sdf.shape[0] // n
    s = sdf.reshape(n, k, n, k).mean(axis=(1, 3))
    # Sea floor: shallow shelf deepening away from the coast
    sea = s < 0
    depth = np.minimum(1.5 + (-s) * 0.03, 22.0)
    h = np.where(sea, -depth, h)
    # Land near the coast: keep at least slightly above sea level
    h = np.where(~sea, np.maximum(h, np.clip(s * 0.05, 0.3, 1.5)), h)
    print(f"[height] near {n}^2 range {h.min():.1f}..{h.max():.1f} in {time.time()-t0:.1f}s")
    return h.astype(np.float32)


def build_height_far(dem, n=2048):
    t0 = time.time()
    lon, lat = grid_ll(FAR_HALF, n)
    h = dem.sample(lon, lat)
    h = ndimage.gaussian_filter(h, 0.8)
    land = h > 0.2
    d = ndimage.distance_transform_edt(~land) * (2 * FAR_HALF / n)
    h = np.where(land, h, -np.minimum(2 + d * 0.01, 40))
    print(f"[height] far {n}^2 in {time.time()-t0:.1f}s")
    return h.astype(np.float32)


def run():
    dem = DEM()
    print(f"[dem] tiles: {sorted(dem.tiles)}")
    lp = CACHE / "land.pkl"
    if lp.exists():
        land = pickle.load(open(lp, "rb"))
    else:
        land = build_land(dem)
        pickle.dump(land, open(lp, "wb"))
    sdf, _ = build_sdf(land)
    np.save(CACHE / "sdf.npy", sdf)
    np.save(CACHE / "height_near.npy", build_height_near(dem, sdf))
    np.save(CACHE / "height_far.npy", build_height_far(dem))


if __name__ == "__main__":
    run()
