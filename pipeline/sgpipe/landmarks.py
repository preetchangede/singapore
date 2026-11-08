"""Landmark curation.

OSM models some icons as stacks of solid building:parts (the Singapore Flyer is
29 vertical slices; the Supertrees are stacked green blocks).  Here we:

  * hide those parts and emit parameters for procedural models (landmarks.json)
  * fix materials / shapes OSM cannot express (Marina Bay Sands' pale glass,
    gridshell glass domes, the Esplanade's spiky sunshades, the stadium dome)

Run after `heights`, before `bundles`.
"""
import json
import math
import pickle
from collections import defaultdict

import numpy as np
import shapely

from .config import CACHE, OUT
from .heights import C
from .proj import ll_to_local
from . import osm

# extra facade classes understood by the web client
CLS_DURIAN = 30     # Esplanade sunshade lattice
CLS_GRIDSHELL = 31  # glass gridshell domes


def near(recs, x, y, r):
    return [b for b in recs if b["region"] == "sg" and math.hypot(b["cx"] - x, b["cy"] - y) < r]


def run():
    data = pickle.load(open(CACHE / "buildings.pkl", "rb"))
    recs = data["recs"]
    by_id = defaultdict(list)
    for b in recs:
        by_id[b["id"]].append(b)
    out = {}

    # --- Singapore Flyer: hide the slice stack, fit the wheel plane
    fx, fy = 3317, -4798
    slices = [b for b in near(recs, fx, fy, 110) if b["part"] and b["area"] < 60 and b["h"] > 100]
    if slices:
        pts = np.array([[b["cx"], b["cy"]] for b in slices])
        c = pts.mean(axis=0)
        u, s, vt = np.linalg.svd(pts - c)
        d = vt[0]
        span = (pts - c) @ d
        for b in slices:
            b["landmark"] = True
        out["flyer"] = {"x": float(c[0]), "y": float(c[1]), "dir": [float(d[0]), float(d[1])],
                        "radius": float((span.max() - span.min()) / 2 + 3), "top": 165.0}
    # the solid podium/hub parts of the wheel itself
    for b in near(recs, fx, fy, 60):
        if b["part"] and b["h"] >= 160:
            b["landmark"] = True

    # --- Supertrees: cluster the stacked green parts
    trees = defaultdict(list)
    for b in recs:
        if b["region"] != "sg" or not b["part"]:
            continue
        col = (b.get("colour") or "").lower()
        if col != "#76c82e":
            continue
        key = (round(b["cx"] / 3), round(b["cy"] / 3))
        trees[key].append(b)
    st = []
    for parts in trees.values():
        cx = float(np.mean([p["cx"] for p in parts]))
        cy = float(np.mean([p["cy"] for p in parts]))
        top = max(p["h"] for p in parts)
        canopy = max(p["area"] for p in parts)
        for p in parts:
            p["landmark"] = True
        st.append({"x": cx, "y": cy, "h": float(top), "r": float(math.sqrt(canopy / math.pi))})
    # merge clusters split across rounding cells
    merged = []
    for t in sorted(st, key=lambda t: -t["h"]):
        if any(math.hypot(t["x"] - m["x"], t["y"] - m["y"]) < 6 for m in merged):
            continue
        merged.append(t)
    out["supertrees"] = merged

    # --- Helix Bridge axis from its bridge outline
    sg = osm.load("sg")
    for a in sg["areas"]:
        t = a["tags"]
        if t.get("man_made") == "bridge" and "Helix" in (t.get("name") or ""):
            g = a["geom"]
            mrr = g.minimum_rotated_rectangle
            cc = np.asarray(mrr.exterior.coords)[:4]
            e0 = cc[1] - cc[0]
            e1 = cc[2] - cc[1]
            e = e0 if np.hypot(*e0) > np.hypot(*e1) else e1
            L = float(np.hypot(*e))
            c = g.centroid
            out["helix"] = {"x": c.x, "y": c.y, "dir": [float(e[0] / L), float(e[1] / L)], "length": L}

    # --- material & shape fixes
    def restyle(name_sub, **kw):
        n = 0
        for b in recs:
            if b["region"] == "sg" and b.get("name") and name_sub in b["name"]:
                b.update(kw)
                n += 1
        return n
    for tid in ("w116801004", "w172307471", "w172307472"):
        for b in by_id.get(tid, []):
            b["colour"] = "#c7ccd0"
            b["material"] = "glass"
            b["cls"] = C["hotel"]
    restyle("Esplanade Concert Hall", cls=CLS_DURIAN, colour="#8f8f86")
    restyle("Esplanade Theatre", cls=CLS_DURIAN, colour="#8f8f86")
    restyle("Flower Dome", cls=CLS_GRIDSHELL, colour="#cfd9d8")
    restyle("Cloud Forest", cls=CLS_GRIDSHELL, colour="#cfd9d8")
    restyle("Jewel Changi Airport", cls=CLS_GRIDSHELL, colour="#cdd6d9", roof_h=33.0, h=40.0)
    for b in near(recs, 4566, -3136, 40):
        if b.get("name") == "National Stadium":
            b.update({"h": 82.0, "roof": 4, "roof_h": 70.0, "cls": CLS_GRIDSHELL, "colour": "#d6d8d6"})

    # landmark positions for search & labels
    (OUT / "landmarks.json").write_text(json.dumps(out, separators=(",", ":")))
    pickle.dump(data, open(CACHE / "buildings.pkl", "wb"), protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[landmarks] flyer={'flyer' in out} supertrees={len(out.get('supertrees', []))} helix={'helix' in out}")


if __name__ == "__main__":
    run()
