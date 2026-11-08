"""Projection helpers: WGS84 lon/lat  <->  local SVY21 world frame."""
import numpy as np
import shapely
from pyproj import Transformer

from .config import E0, N0

_fwd = Transformer.from_crs("EPSG:4326", "EPSG:3414", always_xy=True)
_inv = Transformer.from_crs("EPSG:3414", "EPSG:4326", always_xy=True)


def ll_to_local(lon, lat):
    e, n = _fwd.transform(lon, lat)
    return np.asarray(e) - E0, np.asarray(n) - N0


def local_to_ll(x, y):
    lon, lat = _inv.transform(np.asarray(x) + E0, np.asarray(y) + N0)
    return lon, lat


def _xform(coords):
    e, n = _fwd.transform(coords[:, 0], coords[:, 1])
    return np.column_stack([e - E0, n - N0])


def geom_to_local(g):
    """Project a shapely geometry in lon/lat to the local metric frame."""
    return shapely.transform(g, _xform)
