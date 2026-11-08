"""Whole-domain overview albedo (the ground as seen from altitude).

Painter's algorithm at 8 m/px (8192^2), then box-downsampled to 4096^2 so edges
are anti-aliased:

  1. ESA WorldCover 2021 (10 m) as the base land cover everywhere
  2. OSM land use / leisure / natural areas in draw order
  3. tree canopy from the CHM (dark green, brightness varies with height)
  4. inland water, road surfaces, building roofs

The same palette (schema.GROUND) drives the live ground rendering in the
browser, so near and far ground match.
"""
import pickle
import time

import numpy as np
import rasterio
import rasterio.features
from rasterio.warp import reproject, Resampling
import shapely
from PIL import Image
from scipy import ndimage

from .config import CACHE, OUT, HALF, WORLDCOVER, E0, N0
from .schema import GROUND, GROUND_IDX, ROAD_CLASSES
from .terrain import affine_for
from .bundles import building_colours, h32, hex_to_rgb
from affine import Affine

N = 8192
STEP = 2 * HALF / N

# WorldCover class -> ground class
WC = {10: "forest", 20: "scrub", 30: "grass", 40: "farmland", 50: "urban", 60: "bare",
      70: "rock", 80: "water", 90: "wetland", 95: "wetland", 100: "grass"}

ROAD_COL = {
    "motorway": "#4b4b4a", "trunk": "#4d4d4c", "primary": "#4f4e4c", "secondary": "#525150",
    "tertiary": "#555452", "minor": "#5a5957", "service": "#62615e", "motorway_link": "#4d4d4c",
    "link": "#504f4d", "pedestrian": "#b3ab9e", "footway": "#b5ab9a", "track": "#9a8a72",
    "busway": "#6a5248", "cycleway": "#8a6a5a", "steps": "#b0aa9e", "raceway": "#454545",
}


def run():
    t0 = time.time()
    tr = affine_for(HALF, N)
    cls = np.zeros((N, N), np.uint8)

    # 1. WorldCover base
    wc = np.zeros((N, N), np.uint8)
    with rasterio.open(WORLDCOVER) as src:
        dst_t = Affine(STEP, 0, -HALF + E0, 0, -STEP, HALF + N0)
        reproject(rasterio.band(src, 1), wc, dst_transform=dst_t, dst_crs="EPSG:3414",
                  resampling=Resampling.nearest)
    for k, v in WC.items():
        cls[wc == k] = GROUND_IDX[v]
    print(f"[ground] worldcover in {time.time()-t0:.0f}s")

    # 2. OSM areas in draw order
    F = pickle.load(open(CACHE / "features.pkl", "rb"))
    areas = sorted(F["areas"], key=lambda a: (GROUND[a["ground"]][3], -a.get("area", 0)))
    shapes = [(a["geom"], a["ground"]) for a in areas if a["geom"].is_valid or True]
    cls = rasterio.features.rasterize(shapes, out=cls, transform=tr, dtype=np.uint8)
    print(f"[ground] areas in {time.time()-t0:.0f}s")

    # colourise classes
    pal = np.array([hex_to_rgb(g[1]) for g in GROUND], np.float32) / 255.0
    img = pal[cls]
    # 3. canopy (16 m grid -> 8 m)
    can = np.load(CACHE / "canopy16.npy")
    can = np.kron(can, np.ones((2, 2), np.float32))[:N, :N]
    can = ndimage.gaussian_filter(can, 0.7)
    cover = np.clip((can - 2.5) / 5.0, 0, 1)[..., None]
    shade = np.clip(0.75 + can / 60.0, 0.75, 1.25)[..., None]
    tree_col = np.array(hex_to_rgb("#35502a"), np.float32) / 255.0
    img = img * (1 - cover * 0.92) + (tree_col * shade) * cover * 0.92
    print(f"[ground] canopy in {time.time()-t0:.0f}s")

    def paint(geoms_cols, alpha=1.0):
        nonlocal img
        if not geoms_cols:
            return
        idx_shapes = [(g, i + 1) for i, (g, _) in enumerate(geoms_cols)]
        # rasterize indices in chunks of 65000 (uint16 ids)
        for s in range(0, len(idx_shapes), 60000):
            chunk = idx_shapes[s:s + 60000]
            chunk = [(g, i - s) for g, i in chunk]
            ids = rasterio.features.rasterize(chunk, out_shape=(N, N), transform=tr, dtype=np.uint16)
            m = ids > 0
            cols = np.array([c for _, c in geoms_cols[s:s + 60000]], np.float32)
            cc = cols[ids[m] - 1]
            img[m] = img[m] * (1 - alpha) + cc * alpha

    # 4a. inland water
    wcol = np.array(hex_to_rgb("#2c4a50"), np.float32) / 255.0
    paint([(w["geom"], wcol) for w in F["water"]])
    # 4b. roads (ground level only), wide first
    roads = [r for r in F["roads"] if not r["bridge"]]
    roads.sort(key=lambda r: -r["cls"])
    road_shapes = []
    for r in roads:
        name = ROAD_CLASSES[r["cls"]]
        w = r["width"]
        if name in ("footway", "steps", "cycleway") and r.get("region") != "sg":
            continue
        g = r["geom"].buffer(max(w, 1.5) / 2, cap_style="flat", quad_segs=2)
        road_shapes.append((g, np.array(hex_to_rgb(ROAD_COL[name]), np.float32) / 255.0))
    paint(road_shapes)
    # elevated decks seen from above
    bridges = [r for r in F["roads"] if r["bridge"]] + [r for r in F["rails"] if r["bridge"]]
    paint([(r["geom"].buffer(max(r.get("width", 9.0), 6.0) / 2, cap_style="flat", quad_segs=2),
            np.array(hex_to_rgb("#8a8984"), np.float32) / 255.0) for r in bridges])
    print(f"[ground] roads in {time.time()-t0:.0f}s")
    # 4c. building roofs
    B = pickle.load(open(CACHE / "buildings.pkl", "rb"))["recs"]
    bl = []
    for r in sorted(B, key=lambda r: r["h"] or 0):
        if r["part"]:
            continue
        seed = h32(r["id"]) & 0xFFFF
        wall, roof, glass, green = building_colours(r, seed)
        bl.append((r["geom"], np.array(roof, np.float32) / 255.0 * 0.92))
    paint(bl)
    print(f"[ground] buildings in {time.time()-t0:.0f}s")

    # sea: leave dark (the ocean is a separate surface); mark via SDF
    sdf = np.load(CACHE / "sdf.npy")
    sea = sdf < 0
    img[sea] = np.array(hex_to_rgb("#24434c"), np.float32) / 255.0

    # downsample 2x (area) -> 4096, and 4x -> 2048
    def down(a):
        return a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2, 3).mean(axis=(1, 3))
    a4 = down(img)
    a2 = down(a4)
    out = OUT / "ground"
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray((np.clip(a4, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out / "overview_4k.jpg", quality=90, optimize=True, progressive=True)
    Image.fromarray((np.clip(a2, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out / "overview_2k.jpg", quality=90, optimize=True, progressive=True)
    Image.fromarray((np.clip(a2, 0, 1) * 255 + 0.5).astype(np.uint8)[::2, ::2]).save(
        "/tmp/claude-0/-home-user-singapore/874e0c59-c396-53b9-8f79-f82901893744/scratchpad/overview_preview.jpg", quality=85)
    print(f"[ground] done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    run()
