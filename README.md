# Bottlo Compass

A compass that points to the nearest bottle shops. There's no map: a big
arrow points to the closest one and five faint arrows point to the next five.
Underneath are the nearest shop's distance and name, then a smaller list of the
next five. It has a built-in list for Greater Sydney,
the Central Coast, Newcastle, Lake Macquarie, Maitland, Port Stephens and the
lower Hunter. Anywhere else (WA, Tasmania, overseas) it looks shops up live.

**Live:** https://lexsclav07.github.io/CTPTTNLS/

On your phone, open the link and allow location (and motion on iPhone: tap
once when it says *Tap to start*). Add it to your home screen and it opens
full-screen like an app.

- The main arrow is green when you're facing the shop and shades through
  yellow and orange to red when it's behind you.
- Every arrow shows the shop's compass bearing (degrees from true north). The
  faint arrows are numbered to match the list.

## How it works

Everything runs in the browser. It doesn't call any paid API.

| | |
|---|---|
| Your position | Browser geolocation (GPS) |
| Your heading | Phone compass (`deviceorientation`), corrected from magnetic to true north using a WMM2025 declination table for Australia (+12.8° in Sydney, −1.5° in Perth) |
| Shop list | `data/shops.json`, about 1,700 shops, rebuilt daily by GitHub Actions. Outside that area, shops within 15 km (or 80 km) are looked up live from OpenStreetMap's free Overpass API |

## Data

`scripts/update_shops.py` merges three sources into `data/shops.json`:

1. **Liquor & Gaming NSW licensed premises list.** Every packaged-liquor
   licence with a shopfront, with coordinates. © State of New South Wales
   (Department of Creative Industries, Tourism, Hospitality and Sport),
   [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
2. **OpenStreetMap** (`shop=alcohol`, `shop=wine`) through the free Overpass
   API. It adds trading names and pub bottle shops. (Opening hours are
   collected too, but the app doesn't use them.)
   © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
3. **`data/extra-shops.json`.** Your own additions as `[lat, lon, "Name"]`.

A missing shop can also be added on
[openstreetmap.org](https://www.openstreetmap.org). Outside the built-in area
it shows up straight away, and inside it after the next daily refresh.

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
