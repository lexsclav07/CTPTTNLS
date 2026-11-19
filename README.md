# Bottlo Compass

A compass that points to the nearest **open** bottle shop. No map, just an
arrow, the distance and the shop's name. Opening hours work across Greater
Sydney, the Central Coast, Newcastle, Lake Macquarie, Maitland, Port Stephens
and the lower Hunter. Anywhere else in Australia (or the world) it still points
to the nearest bottle shop, just without the open/closed filter.

**Live:** https://lexsclav07.github.io/CTPTTNLS/

On your phone, open the link and allow location (and motion on iPhone: tap
once when it says *Tap to start*). Add it to your home screen and it opens
full-screen like an app.

- The arrow turns green when you're facing the shop.
- **Open now** on: only shops that are open right now. Off: every shop.

## How it works

Everything runs in the browser. It doesn't call any paid API.

| | |
|---|---|
| Your position | Browser geolocation (GPS) |
| Your heading | Phone compass (`deviceorientation`), corrected from magnetic to true north using a WMM2025 declination table for Australia (+12.8° in Sydney, −1.5° in Perth) |
| Shop list | `data/shops.json`, about 1,700 shops, rebuilt daily by GitHub Actions. Outside that area, shops within 15 km (or 80 km) are looked up live from OpenStreetMap's free Overpass API |
| Open or closed | Real hours where OpenStreetMap has them (~150 shops). Otherwise it assumes **Mon–Wed 10–8, Thu–Sat 10–9, Sun 10–7**. Everything is treated as closed on Good Friday and Christmas Day, when NSW bottle shops can't trade |

Change the default hours at the top of `app.js`.

## Data

`scripts/update_shops.py` merges three sources into `data/shops.json`:

1. **Liquor & Gaming NSW licensed premises list.** Every packaged-liquor
   licence with a shopfront, with coordinates. © State of New South Wales
   (Department of Creative Industries, Tourism, Hospitality and Sport),
   [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
2. **OpenStreetMap** (`shop=alcohol`, `shop=wine`) through the free Overpass
   API. It adds trading names, opening hours and pub bottle shops.
   © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
3. **`data/extra-shops.json`.** Your own additions as
   `[lat, lon, "Name", "Mo-Su 10:00-21:00"]`. The hours are optional and, if
   given, they override the other sources.

A shop that's missing or has wrong hours can also be fixed on
[openstreetmap.org](https://www.openstreetmap.org). It will show up here after
the next daily refresh.

```sh
pip install openpyxl
python3 scripts/update_shops.py            # fetch fresh data and rebuild
python3 scripts/update_shops.py --offline  # rebuild from the cached copies in data/sources/
python3 -m http.server                     # then open http://localhost:8000
```

(Phones only allow location and compass over HTTPS, so test on the real site
or with your browser's sensor emulation.)

## Deploying

`.github/workflows/deploy.yml` publishes the site to GitHub Pages on every push
to `main`. Once a day it also refreshes the shop list, commits it if anything
changed, and redeploys. One-time setup: **Settings → Pages → Source: GitHub
Actions**.

---

By Lex Sclavos.
