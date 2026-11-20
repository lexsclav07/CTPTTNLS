#!/usr/bin/env python3
"""Build data/tiles/: bottle shops, pubs, bars and clubs for all of Australia,
from OpenStreetMap, cut into 1-degree squares (about 100 km across) so the app
only downloads the few around you.

The app uses these outside its built-in Sydney / Central Coast / Newcastle
list (Melbourne, Perth, Tassie...) instead of asking a busy public Overpass
server while you wait.

    python3 scripts/update_tiles.py              # rebuild data/tiles/
    python3 scripts/update_tiles.py --out DIR    # write somewhere else (testing)

If any part of the download fails, the existing tiles are left alone.
"""

import json
import math
import os
import re
import sys
import time
import urllib.parse
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_shops as u  # noqa: E402

AUSTRALIA = (-44.0, 112.5, -9.5, 154.0)  # south, west, north, east: mainland + Tasmania
OSM_KIND = {"pub": "p", "bar": "b", "nightclub": "c"}


def query(bbox, seconds):
    s, w, n, e = bbox
    b = f"({s},{w},{n},{e})"
    return (f'[out:json][timeout:{seconds}];(nwr["shop"~"^(alcohol|wine)$"]{b};'
            f'nwr["amenity"~"^(pub|bar|nightclub)$"]["name"]{b};);out center tags;')


def fetch(bbox, depth=0):
    """Everything in bbox. Ask for it all at once (one request is far quicker than
    many on a busy server); if that fails, try the next server, then quarters."""
    seconds = 600 if depth == 0 else 180
    endpoints = [os.environ["OVERPASS_URL"]] if os.environ.get("OVERPASS_URL") else u.OVERPASS
    last = None
    for url in endpoints:
        for attempt in range(3):
            try:
                body = json.loads(u.get(url, urllib.parse.urlencode({"data": query(bbox, seconds)}).encode(),
                                        timeout=seconds + 60))
                if re.search(r"error|timed out|out of memory", body.get("remark", ""), re.I):
                    raise RuntimeError(body["remark"])
                return body["elements"]
            except Exception as err:  # noqa: BLE001
                last = err
                print(f"  {url.split('/')[2]} {bbox}: {err}", file=sys.stderr)
                if "429" in str(err) and attempt < 2:
                    time.sleep(30)  # rate limited: wait our turn
                    continue
                break
    if depth >= 4:
        raise last
    s, w, n, e = bbox
    mlat, mlon = (s + n) / 2, (w + e) / 2
    out = []
    for part in ((s, w, mlat, mlon), (s, mlon, mlat, e), (mlat, w, n, mlon), (mlat, mlon, n, e)):
        out += fetch(part, depth + 1)
    return out


def place(el):
    t = el.get("tags", {})
    lat = el.get("lat", el.get("center", {}).get("lat"))
    lon = el.get("lon", el.get("center", {}).get("lon"))
    if lat is None or lon is None:
        return None
    kind = "s" if t.get("shop") in ("alcohol", "wine") else OSM_KIND.get(t.get("amenity"))
    if not kind:
        return None
    name = (t.get("name") or t.get("brand") or "").strip()
    branch = (t.get("branch") or "").strip()
    if name and branch and branch.lower() not in name.lower():
        name = f"{name} {branch}"
    if not name:
        if kind != "s":
            return None  # an unnamed pub isn't much use as a destination
        name = "Bottle shop"
    return [round(lat, 5), round(lon, 5), u.tidy(name) or name, kind]


def tile_key(lat, lon):
    return f"{math.floor(lat)}_{math.floor(lon)}"


def main():
    out_dir = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else u.DATA / "tiles"
    elements = fetch(AUSTRALIA)  # any failure ends the run before anything is written
    seen, tiles = set(), {}
    for el in elements:
        key = (el["type"], el["id"])
        if key in seen:
            continue  # split boxes share their edges
        seen.add(key)
        p = place(el)
        if p:
            tiles.setdefault(tile_key(p[0], p[1]), []).append(p)
    print(f"downloaded {len(seen)} OpenStreetMap objects")

    # The same place mapped twice (a point and a building outline): keep one.
    for key, places in tiles.items():
        kept = []
        for p in sorted(places, key=lambda p: (p[0], p[1])):
            if any(q[2].lower() == p[2].lower() and q[3] == p[3] and u.metres(q, p) < 60 for q in kept[-40:]):
                continue
            kept.append(p)
        tiles[key] = kept

    total = sum(len(v) for v in tiles.values())
    index_file = out_dir / "index.json"
    try:
        previous = sum(json.loads(index_file.read_text())["tiles"].values())
    except (OSError, ValueError, KeyError):
        previous = 0
    if total < 5000 or total < previous * 0.8:
        sys.exit(f"Only got {total} places (had {previous}); keeping the old tiles.")

    out_dir.mkdir(parents=True, exist_ok=True)
    changed = 0
    for key, places in tiles.items():
        body = "[\n" + ",\n".join(json.dumps(p, ensure_ascii=False) for p in places) + "\n]\n"
        path = out_dir / f"{key}.json"
        if not path.exists() or path.read_text() != body:
            path.write_text(body)
            changed += 1
    for path in out_dir.glob("*_*.json"):
        if path.stem not in tiles:
            path.unlink()  # nothing there any more
            changed += 1
    if changed or not index_file.exists():
        counts = {k: len(v) for k, v in sorted(tiles.items())}
        index_file.write_text(json.dumps({"updated": date.today().isoformat(), "tiles": counts}, indent=0) + "\n")
    kinds = {k: sum(1 for v in tiles.values() for p in v if p[3] == k) for k in "spbc"}
    print(f"tiles: {total} places in {len(tiles)} tiles ({changed} changed) - {kinds['s']} bottle shops, "
          f"{kinds['p']} pubs, {kinds['b']} bars, {kinds['c']} clubs")


if __name__ == "__main__":
    main()
