#!/usr/bin/env python3
"""Build data/shops.json: every bottle shop in Sydney, the Central Coast and
Newcastle/Hunter, from two free sources (no API keys):

  1. Liquor & Gaming NSW "licensed premises" list - every packaged liquor
     (bottle shop) licence in the state, with coordinates. Monthly. CC BY 4.0.
  2. OpenStreetMap via the Overpass API - shop=alcohol / shop=wine, which
     adds trading names, opening hours and pub bottle shops. ODbL.

plus data/extra-shops.json for anything you want to add by hand.

    pip install openpyxl
    python3 scripts/update_shops.py            # fetch both sources and rebuild
    python3 scripts/update_shops.py --offline  # rebuild from data/sources/ only

If a source is down, the last good copy in data/sources/ is reused.
"""

import io
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "sources"

# south, west, north, east: Greater Sydney, Blue Mountains, Central Coast,
# Lake Macquarie, Newcastle, Maitland, Port Stephens and the lower Hunter.
REGION = (-34.25, 150.4, -32.5, 152.3)

UA = {"User-Agent": "bottlo-compass/1.0 (hobby project; weekly data refresh)"}

NSW_PAGE = ("https://www.nsw.gov.au/business-and-economy/liquor-and-gaming/"
            "gaming/gaming-machine-data-reports/licensed-premises-data")

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


# --------------------------------------------------------------- helpers ---

def get(url, data=None, timeout=180):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def in_region(lat, lon):
    s, w, n, e = REGION
    return s <= lat <= n and w <= lon <= e


def metres(a, b):
    r = math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371e3 * math.asin(math.sqrt(h))


ACRONYMS = {"BWS", "IGA", "BYO", "NSW", "CBD", "UNSW", "RSL"}


def smart_title(text):
    """'MURRAY'S PORTERS LIQUOR' -> "Murray's Porters Liquor" (str.title would give Murray'S)."""
    def word(w):
        if w.upper() in ACRONYMS:
            return w.upper()
        return "-".join(p[:1].upper() + p[1:].lower() for p in w.split("-"))
    return " ".join(word(w) for w in text.split())


COMPANY = re.compile(r"\b(pty|ltd|limited|holdings|trust|trustee|investments?|"
                     r"enterprises?|corporation|corp|inc|development)\b", re.I)


def tidy(name):
    """Licence/OSM name -> something you'd see on the sign, or None if it's a company name."""
    if not name:
        return None
    n = re.sub(r"\s+", " ", name.replace("’", "'").replace("‘", "'")).strip()
    n = re.sub(r"^(BWS\s*[-\u2013\u2014:]?\s*)?Beer,?\s+Wine,?\s+(and\s+|&\s+)?Spirits\b", "BWS", n, flags=re.I)
    if COMPANY.search(n):
        return None
    if n.isupper() or n.islower():
        n = smart_title(n)
    return n


STOP = set("""the and at of on in by a an liquor liquors cellar cellars bottle bottles
bottleshop bottleshops shop shops store stores wine wines beer beers spirits drive
thru through market plus local supa super centre center""".split())


def tokens(*names, ignore=()):
    out = set()
    for name in names:
        if not name:
            continue
        n = name.lower().replace("’", "").replace("'", "")
        n = re.sub(r"bottle[\s-]?o\b", "bottleo", n)
        out |= {w for w in re.findall(r"[a-z0-9]+", n) if len(w) > 2 and w not in STOP}
    return out - set(ignore)


def cached(name, fetch, minimum):
    """Run fetch(); fall back to the last good result if it fails or looks short."""
    path = CACHE / f"{name}.json"
    try:
        if "--offline" in sys.argv:
            raise RuntimeError("--offline")
        rows = fetch()
        if len(rows) < minimum:
            raise RuntimeError(f"only {len(rows)} rows")
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text("[\n" + ",\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n")
        print(f"{name}: {len(rows)} shops (fresh)")
        return rows
    except Exception as err:  # noqa: BLE001 - any failure means "use the cache"
        if not path.exists():
            raise
        rows = json.loads(path.read_text())
        print(f"{name}: fetch failed ({err}); using {len(rows)} cached shops", file=sys.stderr)
        return rows


# ------------------------------------------------------- source: NSW list ---

def fetch_nsw():
    page = get(NSW_PAGE, timeout=60).decode("utf-8", "replace")
    link = re.search(r'href="([^"]*premises-list[^"]*\.xlsx)"', page)
    if not link:
        raise RuntimeError("no premises-list .xlsx link on the page")
    url = urllib.parse.urljoin(NSW_PAGE, link.group(1))
    print(f"nsw: {url}")
    book = openpyxl.load_workbook(io.BytesIO(get(url)), read_only=True)
    sheet = book.worksheets[0]

    rows, col = [], None
    for r in sheet.iter_rows(values_only=True):
        if col is None:
            if r and r[0] == "Licence number":
                col = {h: i for i, h in enumerate(r) if h}
            continue
        if not r or r[col["Licence type"]] != "Liquor - packaged liquor licence":
            continue
        kind = r[col["Business type"]] or ""
        if "Bottle shops" not in kind or "Airport" in kind:
            continue  # "Delivery only" has no shopfront; airport ones are airside duty free
        if r[col["Status"]] != "Current" or r[col["Trading Status"]] != "Trading":
            continue
        lat, lon = r[col["Latitude"]], r[col["Longitude"]]
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if not in_region(lat, lon):
            continue
        rows.append({
            "lat": round(lat, 5), "lon": round(lon, 5),
            "name": (r[col["Licence name"]] or "").strip(),
            "suburb": smart_title((r[col["Suburb"]] or "").strip()),
        })
    return rows


# ------------------------------------------------------ source: OSM ---------

def overpass(bbox):
    s, w, n, e = bbox
    q = f'[out:json][timeout:90];nwr["shop"~"^(alcohol|wine)$"]({s},{w},{n},{e});out center tags;'
    last = None
    for url in OVERPASS:
        try:
            body = json.loads(get(url, urllib.parse.urlencode({"data": q}).encode()))
            if re.search(r"error|timed out", body.get("remark", ""), re.I):
                raise RuntimeError(body["remark"])
            return body["elements"]
        except Exception as err:  # noqa: BLE001
            print(f"  {url}: {err}", file=sys.stderr)
            last = err
    raise last


def overpass_area(bbox, depth=0):
    """Public mirrors often time out on a big box - split it into quarters if so."""
    try:
        return overpass(bbox)
    except Exception:
        if depth >= 2:
            raise
        s, w, n, e = bbox
        mlat, mlon = (s + n) / 2, (w + e) / 2
        out = []
        for part in ((s, w, mlat, mlon), (s, mlon, mlat, e), (mlat, w, n, mlon), (mlat, mlon, n, e)):
            out += overpass_area(part, depth + 1)
        return out


def fetch_osm():
    rows, seen = [], set()
    for el in overpass_area(REGION):
        key = (el["type"], el["id"])
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if key in seen or lat is None:
            continue
        seen.add(key)
        t = el.get("tags", {})
        name = (t.get("name") or t.get("brand") or "").strip()
        branch = (t.get("branch") or "").strip()
        if name and branch and branch.lower() not in name.lower():
            name = f"{name} {branch}"
        rows.append({
            "lat": round(lat, 5), "lon": round(lon, 5), "name": name,
            "brand": t.get("brand", ""),
            "suburb": t.get("addr:suburb") or t.get("addr:city") or "",
            "hours": (t.get("opening_hours") or "").strip(),
        })
    rows.sort(key=lambda r: (r["lat"], r["lon"]))
    return rows


# ------------------------------------------------------------- merging ------

def find_match(shop, entries):
    """The existing entry that is the same physical shop as `shop`, if any."""
    mine = shop["tokens"]
    near = [(metres((shop["lat"], shop["lon"]), (e["lat"], e["lon"])), e) for e in entries]
    same = sorted(((d, e) for d, e in near if d < 750 and mine & (e["tokens"] - e["suburb_tokens"])),
                  key=lambda x: x[0])
    near = sorted(((d, e) for d, e in near if d < 200), key=lambda x: x[0])
    if same and same[0][0] < 200:
        return same[0][1]  # same name, close by
    if len(same) == 1 and same[0][1]["rank"] < 3:
        # The licence register pins big shopping centres a few hundred metres
        # off; one lone 'BWS' licence 500 m from a mapped BWS is the same shop.
        return same[0][1]
    if not near:
        return None
    if not mine:  # unnamed point: only merge if practically on top of a shop
        return near[0][1] if near[0][0] < 50 else None
    lone = [x for x in near if x[0] < 75]
    if len(lone) == 1 and lone[0][0] < 30:
        return lone[0][1]  # licence name and trading name differ, same doorway
    return None


def entry(lat, lon, name, suburb, hours, rank, raw_names=()):
    return {
        "lat": lat, "lon": lon, "name": name, "suburb": suburb, "hours": hours,
        "rank": rank,  # how much we trust the name: osm 3 > nsw 2 > hand-made 1
        "tokens": tokens(name, *raw_names),
        "suburb_tokens": tokens(suburb),
    }


def merge(nsw, osm, extras):
    entries = [entry(r["lat"], r["lon"], tidy(r["name"]), r["suburb"], "",
                     2 if tidy(r["name"]) else 0, (r["name"],)) for r in nsw]

    for r in osm:
        if re.search(r"heinemann|duty free", r["name"], re.I):
            continue  # airside at the airport
        shop = entry(r["lat"], r["lon"], tidy(r["name"]), smart_title(r["suburb"]) if r["suburb"].isupper() else r["suburb"],
                     r["hours"], 3 if tidy(r["name"]) else 0, (r["name"], r["brand"]))
        hit = find_match(shop, entries)
        if not hit:
            entries.append(shop)
            continue
        hit["hours"] = hit["hours"] or shop["hours"]
        if shop["rank"] > hit["rank"]:
            # OSM has the trading name and usually a more precise pin.
            hit.update(lat=shop["lat"], lon=shop["lon"], name=shop["name"], rank=shop["rank"])
        hit["tokens"] |= shop["tokens"]
        hit["suburb"] = hit["suburb"] or shop["suburb"]

    for r in extras:
        lat, lon, name, *rest = r
        shop = entry(lat, lon, tidy(name), "", rest[0] if rest else "", 1)
        hit = find_match(shop, entries)
        if not hit:
            entries.append(shop)
        else:
            if shop["hours"]:
                hit["hours"] = shop["hours"]  # hand-entered hours win
            if hit["rank"] < 1:
                hit.update(name=shop["name"], rank=1)
    return entries


def display_names(entries):
    """Chains get their suburb added: 'BWS' -> 'BWS Cameron Park'."""
    for e in entries:
        e["name"] = e["name"] or "Bottle Shop"
    count = {}
    for e in entries:
        count[e["name"].lower()] = count.get(e["name"].lower(), 0) + 1
    for e in entries:
        if count[e["name"].lower()] > 1 and e["suburb"] and e["suburb"].lower() not in e["name"].lower():
            e["name"] = f"{e['name']} {e['suburb']}"


def main():
    nsw = cached("nsw", fetch_nsw, minimum=500)
    osm = cached("osm", fetch_osm, minimum=100)
    extras = json.loads((DATA / "extra-shops.json").read_text())

    entries = merge(nsw, osm, extras)
    display_names(entries)

    # Same shop listed twice under one licence/name: keep one.
    shops = []
    for e in sorted(entries, key=lambda e: (not e["hours"], e["lat"], e["lon"])):
        if any(s[2] == e["name"] and metres((s[0], s[1]), (e["lat"], e["lon"])) < 80 for s in shops):
            continue
        shops.append([e["lat"], e["lon"], e["name"], e["hours"]])
    shops.sort(key=lambda s: (s[0], s[1]))

    out = DATA / "shops.json"
    try:
        if json.loads(out.read_text())["shops"] == shops:
            print(f"shops.json: no changes ({len(shops)} shops)")
            return
    except (OSError, ValueError, KeyError):
        pass

    body = ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in shops)
    out.write_text(
        '{"updated":"%s",\n"credits":["Liquor & Gaming NSW (CC BY 4.0)","© OpenStreetMap contributors (ODbL)"],\n'
        '"shops":[\n%s\n]}\n' % (date.today().isoformat(), body))
    print(f"shops.json: {len(shops)} shops, {sum(1 for s in shops if s[3])} with opening hours")


if __name__ == "__main__":
    main()
