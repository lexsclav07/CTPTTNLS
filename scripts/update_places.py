#!/usr/bin/env python3
"""Build data/places.json: bottle shops plus pubs, bars and clubs.

Bottle shops come from data/shops.json (run update_shops.py first). Pubs,
bars and clubs come from the same two free sources:

  1. Liquor & Gaming NSW licensed premises list: hotel licences (pubs, and
     "general bar" hotels), small bar licences (bars) and club licences
     (RSLs, leagues, bowling and sailing clubs...). CC BY 4.0.
  2. OpenStreetMap amenity=pub / bar / nightclub. ODbL.

    python3 scripts/update_places.py            # fetch and rebuild
    python3 scripts/update_places.py --offline  # rebuild from data/sources/
"""

import io
import json
import re
import sys
import urllib.parse
from datetime import date
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_shops as u  # noqa: E402

# One letter per kind of place, as stored in places.json.
BOTTLE_SHOP, PUB, BAR, CLUB = "s", "p", "b", "c"
OSM_KIND = {"pub": PUB, "bar": BAR, "nightclub": CLUB}

SUFFIX = re.compile(r"[\s,]*\b(co-?operative|limited|ltd|incorporated|inc|society)\b\.?\s*$", re.I)


def venue_name(name):
    """'Bundeena Bowling & Sports Club Co-operative Limited' -> 'Bundeena Bowling & Sports Club'."""
    if not name:
        return None
    n = re.sub(r"\s+", " ", name.replace("’", "'")).strip()
    while SUFFIX.search(n):
        n = SUFFIX.sub("", n).strip()
    return u.tidy(n)


def fetch_nsw_venues():
    page = u.get(u.NSW_PAGE, timeout=60).decode("utf-8", "replace")
    link = re.search(r'href="([^"]*premises-list[^"]*\.xlsx)"', page)
    if not link:
        raise RuntimeError("no premises-list .xlsx link on the page")
    book = openpyxl.load_workbook(io.BytesIO(u.get(urllib.parse.urljoin(u.NSW_PAGE, link.group(1)))), read_only=True)

    rows, col = [], None
    for r in book.worksheets[0].iter_rows(values_only=True):
        if col is None:
            if r and r[0] == "Licence number":
                col = {h: i for i, h in enumerate(r) if h}
            continue
        licence, business = r[col["Licence type"]], r[col["Business type"]] or ""
        if licence == "Liquor - hotel licence":
            kind = BAR if "General bar" in business else PUB
        elif licence == "Liquor - small bar licence":
            kind = BAR
        elif licence == "Liquor - club licence":
            kind = CLUB
        else:
            continue
        if r[col["Status"]] != "Current" or r[col["Trading Status"]] != "Trading":
            continue
        lat, lon = r[col["Latitude"]], r[col["Longitude"]]
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not u.in_region(lat, lon):
            continue
        rows.append({"lat": round(lat, 5), "lon": round(lon, 5), "kind": kind,
                     "name": (r[col["Licence name"]] or "").strip(),
                     "suburb": u.smart_title((r[col["Suburb"]] or "").strip())})
    return rows


def fetch_osm_venues():
    rows, seen = [], set()
    for el in u.overpass_area(u.REGION, what='"amenity"~"^(pub|bar|nightclub)$"'):
        key = (el["type"], el["id"])
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        t = el.get("tags", {})
        if key in seen or lat is None or not t.get("name"):
            continue  # an unnamed bar isn't much use as a destination
        seen.add(key)
        rows.append({"lat": round(lat, 5), "lon": round(lon, 5), "kind": OSM_KIND[t["amenity"]],
                     "name": t["name"].strip(), "suburb": t.get("addr:suburb") or t.get("addr:city") or ""})
    rows.sort(key=lambda r: (r["lat"], r["lon"]))
    return rows


def main():
    nsw = u.cached("venues-nsw", fetch_nsw_venues, minimum=500)
    try:  # nice to have (names, nightclubs, more bars); the licence list is enough on its own
        osm = u.cached("venues-osm", fetch_osm_venues, minimum=200)
    except Exception as err:  # noqa: BLE001
        print(f"venues-osm: unavailable ({err}); using licences only", file=sys.stderr)
        osm = []

    venues = []
    for r in nsw:
        name = venue_name(r["name"])
        e = u.entry(r["lat"], r["lon"], name, r["suburb"], "", 2 if name else 0, (r["name"],))
        e["kind"] = r["kind"]
        venues.append(e)
    for r in osm:
        e = u.entry(r["lat"], r["lon"], venue_name(r["name"]), r["suburb"], "", 3, (r["name"],))
        hit = u.find_match(e, venues)
        if not hit:
            e["kind"] = r["kind"]
            venues.append(e)
        elif e["rank"] > hit["rank"] and e["name"]:
            hit.update(lat=e["lat"], lon=e["lon"], name=e["name"], rank=e["rank"])

    for e in venues:  # fallbacks for licences with only a company name
        e["name"] = e["name"] or {PUB: "Pub", BAR: "Bar", CLUB: "Club"}[e["kind"]]
    u.display_names(venues)

    places = [[s[0], s[1], s[2], BOTTLE_SHOP] for s in json.loads((u.DATA / "shops.json").read_text())["shops"]]
    seen = set()
    for e in venues:
        key = (e["name"], round(e["lat"], 3), round(e["lon"], 3))
        if key not in seen:
            seen.add(key)
            places.append([e["lat"], e["lon"], e["name"], e["kind"]])
    places.sort(key=lambda p: (p[0], p[1]))

    out = u.DATA / "places.json"
    try:
        if json.loads(out.read_text())["places"] == places:
            print(f"places.json: no changes ({len(places)} places)")
            return
    except (OSError, ValueError, KeyError):
        pass
    body = ",\n".join("  " + json.dumps(p, ensure_ascii=False) for p in places)
    out.write_text(
        '{"updated":"%s",\n"credits":["Liquor & Gaming NSW (CC BY 4.0)","© OpenStreetMap contributors (ODbL)"],\n'
        '"places":[\n%s\n]}\n' % (date.today().isoformat(), body))
    counts = {k: sum(1 for p in places if p[3] == k) for k in (BOTTLE_SHOP, PUB, BAR, CLUB)}
    print(f"places.json: {len(places)} places - {counts[BOTTLE_SHOP]} bottle shops, "
          f"{counts[PUB]} pubs, {counts[BAR]} bars, {counts[CLUB]} clubs")


if __name__ == "__main__":
    main()
