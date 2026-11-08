"""Global configuration for the Singapore reconstruction pipeline.

World frame
-----------
All geometry is projected to SVY21 (EPSG:3414), Singapore's official
Transverse Mercator grid, then shifted so that the domain centre is the
origin.  Pipeline coordinates are (x = east, y = north) in metres; the web
client maps them to three.js as (x, -z) with y up.

The detailed domain is a 65,536 m square (2^16), split into a quadtree:

    bundle   4,096 m   (16 x 16)   network unit: one file per bundle
    tile     1,024 m   (64 x 64)   render / culling unit
"""
from pathlib import Path
import os

REPO = Path(__file__).resolve().parents[2]
WORK = Path(os.environ.get("SG_WORK", "/home/user/singapore-work"))
RAW = WORK / "raw"
CACHE = WORK / "cache"
OUT = Path(os.environ.get("SG_OUT", REPO / "web" / "public" / "data"))

# SVY21 coordinates of the domain centre (≈ 1.3328°N, 103.8333°E, near Toa Payoh)
E0 = 28000.0
N0 = 35000.0
HALF = 32768.0            # domain half size (m)
DOMAIN = 2 * HALF         # 65,536 m
BUNDLE = 4096.0
TILE = 1024.0
NB = int(DOMAIN // BUNDLE)  # 16
NT = int(DOMAIN // TILE)    # 64
TILES_PER_BUNDLE = int(BUNDLE // TILE)  # 4

# Far field (coarse terrain/land mask for the horizon): 262 km square
FAR_HALF = 131072.0

# Geographic bounding boxes (lon_min, lat_min, lon_max, lat_max)
BBOX_DOMAIN_LL = (103.53, 1.03, 104.13, 1.64)
BBOX_JOHOR_LL = (103.45, 1.25, 104.25, 1.68)
BBOX_RIAU_LL = (103.45, 0.98, 104.25, 1.32)

PBF_SG = RAW / "singapore-latest.osm.pbf"
PBF_MY = RAW / "malaysia-latest.osm.pbf"
PBF_RIAU = RAW / "riau_islands-latest.osm.pbf"

FABDEM_DIR = RAW / "fabdem"
CHM_DIR = RAW / "chm"
WORLDCOVER = RAW / "worldcover_N00E102.tif"
GLOBFP = RAW / "globfp" / "sg_region.pkl"
HDB_CSV = RAW / "hdb_property.csv"
MP_LANDUSE = RAW / "mp2019_landuse.geojson"
MP_PLANNING = RAW / "mp2019_planning_area.geojson"
MP_SUBZONE = RAW / "mp2019_subzone.geojson"

for p in (CACHE,):
    p.mkdir(parents=True, exist_ok=True)
