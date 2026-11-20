"use strict";

// ---------------------------------------------------------------- settings --

const ARROWS = 6;         // the nearest shop + the next 5
const ON_TARGET_DEG = 12; // main arrow goes green when you're facing the shop
const UPDATE_MS = 500;    // how often location is requested and distances and the list refresh

// Phones report heading against magnetic north; shop bearings are against true
// north. The gap (declination) is +12.8° in Sydney but -1.5° in Perth, so look
// it up: WMM2025 values for 2027 on a 5° grid, lat -45..-10, lon 110..155.
// Accurate to ~0.4° anywhere in Australia.
const DECLINATION_GRID = [
  [-17.8, -11.7, -6.0, -0.7, 4.1, 8.4, 12.3, 15.6, 18.5, 20.9],
  [-10.7, -6.4, -2.5, 1.1, 4.4, 7.5, 10.3, 12.9, 15.3, 17.3],
  [-6.1, -3.2, -0.5, 1.9, 4.2, 6.5, 8.8, 10.9, 12.9, 14.6],
  [-3.1, -1.2, 0.6, 2.2, 3.9, 5.7, 7.5, 9.3, 11.0, 12.6],
  [-1.2, 0.0, 1.1, 2.2, 3.4, 4.9, 6.4, 7.9, 9.5, 10.9],
  [0.0, 0.7, 1.3, 2.0, 2.9, 4.1, 5.4, 6.9, 8.3, 9.6],
  [0.6, 0.9, 1.2, 1.6, 2.3, 3.3, 4.6, 5.9, 7.3, 8.6],
  [0.8, 0.9, 0.9, 1.1, 1.6, 2.6, 3.8, 5.1, 6.4, 7.7],
];

// data/places.json covers this box (Sydney, Central Coast, Newcastle, Hunter);
// the rest of Australia comes from data/tiles/, and overseas from OpenStreetMap live.
const REGION = { s: -34.25, w: 150.4, n: -32.5, e: 152.3 };
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// ------------------------------------------------------------------- state --

const $ = (id) => document.getElementById(id);
const app = $("app"), dialEl = $("dial");
const distEl = $("dist"), nameEl = $("name"), othersEl = $("others"), hintEl = $("hint");

// ------------------------------------------------------------------ hints --
// When something stops the app working (a permission turned down, location
// off, an app's built-in browser, a bug), say so under the name, with the fix.
// Several can be true at once; the most important one shows, and each kind
// clears itself once the problem goes away.
const HINT_ORDER = ["error", "location", "network", "compass", "precise", "inapp"];
const hints = {};
let hintKind = null;
function showHint() {
  hintKind = HINT_ORDER.find((k) => hints[k]) || null;
  hintEl.hidden = !hintKind;
  if (hintKind && hintEl.textContent !== hints[hintKind]) hintEl.textContent = hints[hintKind];
}
function hint(kind, text) { hints[kind] = text; showHint(); }
function clearHint(kind) { if (hints[kind]) { delete hints[kind]; showHint(); } }
addEventListener("error", (e) => {
  if (!e.message || /ResizeObserver|^Script error/i.test(e.message)) return; // harmless / not ours
  hint("error", `Something went wrong (${e.message}). A screenshot of this helps fix it.`);
});
addEventListener("unhandledrejection", (e) => {
  const m = e.reason && (e.reason.message || String(e.reason));
  if (m && !/Abort|NotAllowed|timed? ?out/i.test(m)) hint("error", `Something went wrong (${m}). A screenshot of this helps fix it.`);
});

// Links opened from Instagram, Facebook, Messenger, Snapchat, TikTok and co.
// open in that app's own browser, which often blocks the compass or location.
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|musical_ly|Bytedance|\bLine\/|MicroMessenger|LinkedInApp|Pinterest/i.test(navigator.userAgent);
const arrowEls = [$("a0"), $("a1"), $("a2"), $("a3"), $("a4"), $("a5")];
const labelEls = [0, 1, 2, 3, 4, 5].map((i) => $("l" + i));
const bearingEls = labelEls.map((g) => g.querySelector(".b"));
const numEls = labelEls.map((g) => g.querySelector(".k"));
const mainBase = arrowEls[0].querySelector(".base");
const mainTints = [...arrowEls[0].querySelectorAll(".tint")];

let shops = [];          // [{lat, lon, name, kind}] - kind: s bottle shop, p pub, b bar, c club
let here = null;         // {lat, lon}
let targets = [];        // nearest ARROWS shops, closest first: [{shop, d}]
let heading = null;      // degrees from true north, smoothed
let hx = 0, hy = 0;      // heading as a unit vector, for smoothing across 359°->0°
let dialAngle = 0;
const angles = new Array(ARROWS).fill(null); // drawn angle of each arrow
const LABEL_EDGE = 43;   // labels stay inside the tick ring (SVG units; arrows reach 32)
const labelW = new Array(ARROWS).fill(0); // measured label widths
const bearings = new Array(ARROWS).fill(0); // true bearing to each shop, whole degrees
const GROUP_DEG = 9;     // arrows closer together than this share one label
let wasOnTarget = false;
let needsTap = false;
let locationOff = false;
let decl = 12.8;         // magnetic declination where you are
let live = null;         // {lat, lon, shops} from OpenStreetMap when outside REGION
let nextLiveFetch = 0;   // don't hammer the free API
let pinned = null;       // a shop picked from the list, or null to follow the nearest
let imperial = false;    // miles and feet instead of km and m
let kinds = new Set("spbc"); // which kinds of place to point at
try {
  pinned = JSON.parse(localStorage.getItem("pinned") || "null");
  imperial = localStorage.getItem("units") === "imperial";
  if (localStorage.getItem("kinds")) kinds = new Set(localStorage.getItem("kinds"));
} catch {}
const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const shopKey = (s) => `${s.lat},${s.lon}`;

// ------------------------------------------------------------------ maths --

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

function metres(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

function bearing(aLat, aLon, bLat, bLon) {
  const dLon = rad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function formatDistance(m) {
  if (imperial) {
    const mi = m / 1609.344;
    if (mi < 0.1) return `${Math.max(10, Math.round((m * 3.28084) / 10) * 10)} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

function declination(lat, lon) {
  const g = DECLINATION_GRID;
  const y = Math.min(Math.max((lat + 45) / 5, 0), g.length - 1.001);
  const x = Math.min(Math.max((lon - 110) / 5, 0), g[0].length - 1.001);
  const i = Math.floor(y), j = Math.floor(x), fy = y - i, fx = x - j;
  return (g[i][j] * (1 - fx) + g[i][j + 1] * fx) * (1 - fy) + (g[i + 1][j] * (1 - fx) + g[i + 1][j + 1] * fx) * fy;
}

// ------------------------------------------------- shops outside the list --
// Outside the built-in area, places come from the Australia-wide tiles the
// daily update builds (1-degree squares served from this site: quick, and
// they don't depend on anyone else's server). Overseas - or if the tiles
// can't be loaded - ask OpenStreetMap live, starting small so a busy server
// still answers quickly.

const inRegion = ({ lat, lon }) => lat >= REGION.s && lat <= REGION.n && lon >= REGION.w && lon <= REGION.e;

async function getJson(url, ms) {
  const res = await fetch(url, AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let tileIndex;              // {"-38_144": number of places, ...}; null if it can't be had
const tileCache = new Map(); // tile -> Promise of its places

function loadTile(key) {
  if (!tileCache.has(key)) {
    tileCache.set(key, getJson(`data/tiles/${key}.json`, 20000)
      .then((rows) => rows.map(([lat, lon, name, kind]) => ({ lat, lon, name, kind })))
      .catch((err) => { tileCache.delete(key); throw err; }));
  }
  return tileCache.get(key);
}

// The 3 x 3 squares around you (about 300 km across), widening in the bush
// until there's enough to point at. [] = no tiles near you (overseas).
async function tilesAround({ lat, lon }) {
  if (tileIndex === undefined) {
    try { tileIndex = (await getJson("data/tiles/index.json", 15000)).tiles; } catch { tileIndex = null; }
  }
  if (!tileIndex) return null;
  const ty = Math.floor(lat), tx = Math.floor(lon);
  let found = [];
  for (let r = 1; r <= 4; r++) {
    const keys = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (tileIndex[`${ty + dy}_${tx + dx}`]) keys.push(`${ty + dy}_${tx + dx}`);
    }
    found = (await Promise.all(keys.map(loadTile))).flat();
    if (found.filter((p) => kinds.has(p.kind)).length > ARROWS || found.length > 6000) break;
  }
  return found;
}

async function overpassAround({ lat, lon }, radius) {
  const near = `(around:${radius},${lat},${lon})`;
  const q = `[out:json][timeout:20];(nwr["shop"~"^(alcohol|wine)$"]${near};nwr["amenity"~"^(pub|bar|nightclub)$"]["name"]${near};);out center tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      return (await getJson(`${url}?data=${encodeURIComponent(q)}`, 15000)).elements.map((el) => {
        const t = el.tags || {};
        let name = t.name || t.brand || "Bottle shop";
        if (t.branch && !name.toLowerCase().includes(t.branch.toLowerCase())) name += ` ${t.branch}`;
        const kind = t.shop ? "s" : { pub: "p", bar: "b", nightclub: "c" }[t.amenity];
        return { lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, name, kind };
      }).filter((shop) => shop.lat != null);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

let lookupFailed = false;
async function fetchNearby() {
  nextLiveFetch = Infinity; // one lookup at a time
  const at = { ...here };
  if (!live && !lookupFailed) { distEl.textContent = ""; status("Searching…"); }
  try {
    let found = await tilesAround(at).catch(() => null), source = "Australia-wide list";
    if (!found || !found.length) {
      source = "OpenStreetMap (live)";
      for (const radius of [4000, 20000, 80000]) { // small first: quick even when servers are busy
        found = await overpassAround(at, radius);
        if (found.length) break;
      }
    }
    live = { ...at, shops: found, source };
    lookupFailed = false;
    clearHint("network");
  } catch {
    lookupFailed = true;
    if (!live) status("No signal");
    hint("network", "Couldn't reach the map server for places near you. It tries again every 30 seconds; " +
      "busy servers usually answer within a minute or two.");
    return;
  } finally {
    nextLiveFetch = Date.now() + (lookupFailed ? 30000 : 2000);
  }
  pickTargets();
}

// ---------------------------------------------------------------- picking --

function pickTargets() {
  if (!here) return;
  const outside = !inRegion(here);
  if (outside) {
    const moved = live && metres(here.lat, here.lon, live.lat, live.lon) > 5000;
    if ((!live || moved) && Date.now() >= nextLiveFetch) fetchNearby();
    if (!live) return;
  }

  // Keep the closest few without sorting the whole list (skipping a picked shop,
  // which always takes the main arrow).
  // Ranking ~3,500 places twice a second: a flat-earth distance (no trig per
  // place) is plenty to sort them; the winners get the exact distance below.
  const best = [];
  const kx = Math.cos(rad(here.lat)), hl = here.lat, hn = here.lon;
  for (const shop of outside ? live.shops : shops) {
    if (!kinds.has(shop.kind) || shop === pinned ||
        (pinned && shop.lat === pinned.lat && shop.lon === pinned.lon)) continue;
    const dx = (shop.lon - hn) * kx, dy = shop.lat - hl;
    const d = dx * dx + dy * dy;
    if (best.length === ARROWS && d >= best[ARROWS - 1].d) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].d > d) i--;
    best.splice(i, 0, { shop, d });
    if (best.length > ARROWS) best.pop();
  }
  for (const b of best) b.d = metres(hl, hn, b.shop.lat, b.shop.lon);
  best.sort((a, b) => a.d - b.d);
  if (pinned) {
    best.unshift({ shop: pinned, d: metres(here.lat, here.lon, pinned.lat, pinned.lon) });
    best.length = Math.min(best.length, ARROWS);
  }
  targets = best; // arrows whose shop changed swing over from where they were
  if ($("nearest").hidden !== !pinned) $("nearest").hidden = !pinned;

  if (best.length) {
    const dist = needsTap ? "" : formatDistance(best[0].d);
    if (distEl.textContent !== dist) distEl.textContent = dist;
    if (needsTap) status("Tap anywhere to start"); else showShop(best[0].shop);
  } else {
    distEl.textContent = "";
    status("None nearby");
  }

  // The next five, smaller, under the main readout. This runs every half
  // second, so if the same shops are listed just update their distances -
  // rebuilding the rows would swallow a tap that lands mid-update.
  const listKey = best.slice(1).map(({ shop }) => shopKey(shop) + shop.kind).join("|");
  if (listKey === shownList) {
    othersEl.querySelectorAll(".d").forEach((el, i) => {
      const text = formatDistance(best[i + 1].d);
      if (el.textContent !== text) el.textContent = text;
    });
    return;
  }
  shownList = listKey;
  othersEl.replaceChildren(...best.slice(1).map(({ shop, d }, i) => {
    const li = document.createElement("li"), btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.slot = i + 1;
    const k = document.createElement("span"), row = document.createElement("span");
    const n = document.createElement("span"), m = document.createElement("span");
    k.className = "i"; k.textContent = i + 1; // same number as its arrow
    row.className = "row";
    n.className = "n"; n.textContent = shop.name;
    row.append(kindIcon(shop.kind));
    m.className = "d"; m.textContent = formatDistance(d);
    row.append(n, m);
    btn.append(k, row);
    li.append(btn);
    return li;
  }));
}

// ---------------------------------------------------------------- heading --

function screenAngle() {
  return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
}

function onHeading(magnetic) {
  if (heading === null) { clearHint("compass"); clearHint("inapp"); } // readings are coming in
  const h = rad(magnetic + decl);
  if (heading === null) { hx = Math.cos(h); hy = Math.sin(h); }
  hx += (Math.cos(h) - hx) * 0.25;
  hy += (Math.sin(h) - hy) * 0.25;
  heading = (deg(Math.atan2(hy, hx)) + 360) % 360;
}

// Raw readings, kept for the landscape sensor panel.
const raw = { ori: null, oriCount: 0, mag: null, pos: null, posCount: 0, motion: null, motionCount: 0, extra: {} };

// Both report where the top of the phone points; adding the screen angle makes
// it where the top of the *screen* points, so landscape works too.
function onOrientation(e) {
  raw.ori = e; raw.oriCount++;
  let mag = null;
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
    mag = e.webkitCompassHeading + screenAngle(); // iOS: already a compass heading
  } else if (e.absolute && typeof e.alpha === "number") {
    mag = 360 - e.alpha + screenAngle(); // Android: alpha runs anticlockwise
  }
  if (mag === null) return;
  raw.mag = ((mag % 360) + 360) % 360;
  onHeading(mag);
}
const onMotion = (e) => { raw.motion = e; raw.motionCount++; }; // only listened to in landscape

// Listen to both: Android sends the compass on "deviceorientationabsolute",
// iPhones on "deviceorientation" (with webkitCompassHeading). onOrientation
// ignores readings that aren't tied to north.
function startCompass() {
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
}

// ----------------------------------------------------------------- motion --
// Apple-style springs: SwiftUI's default (response 0.55 s, damping 0.825)
// for anything that turns. With Reduce Motion on, a quick spring with no
// overshoot and no "pop".

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const TURN = { k: 130, c: 18.9 }, TURN_REDUCED = { k: 400, c: 40 };
const POP = { k: 320, c: 13 };   // a little bouncy, for the "you're facing it" pop
const vel = new Array(ARROWS).fill(0);
let dialVel = 0, pop = 1, popVel = 0, lastFrame = 0;

function spring(x, v, target, dt, { k, c }) {
  for (let t = 0; t < dt; t += 1 / 120) { // small steps keep it stable on slow frames
    const h = Math.min(1 / 120, dt - t);
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
  }
  return [x, v];
}

let shownShop = null; // the shop whose name is showing
let shownList = "";    // which shops the list rows are for

function status(text) {
  nameEl.classList.add("status");
  nameEl.textContent = text;
  shownShop = null;
}

// Cross-fade the name when the nearest shop changes.
// The little bottle / mug / glass / club icon for a place.
function kindIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "kind");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#k-${kind || "s"}`);
  svg.append(use);
  return svg;
}

function showShop(shop) {
  if (shownShop && shopKey(shop) === shopKey(shownShop)) return;
  const first = shownShop === null;
  shownShop = shop;
  nameEl.classList.remove("status");
  nameEl.replaceChildren(kindIcon(shop.kind), shop.name);
  if (first || !nameEl.animate) return;
  nameEl.animate(reduceMotion.matches
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
  { duration: reduceMotion.matches ? 200 : 350, easing: "cubic-bezier(0.2, 0.9, 0.25, 1)" });
}

// Main arrow colour runs through the iOS system colours (they differ in Light
// and Dark Mode, so read them from the CSS).
let palette = [];
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  palette = ["--green", "--yellow", "--orange", "--red"].map((v) => {
    const hex = css.getPropertyValue(v).trim().replace("#", "");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  });
}
function arrowColour(off) { // off: 0 = facing the shop, 180 = behind you
  const x = (Math.min(off, 180) / 180) * (palette.length - 1), i = Math.min(Math.floor(x), palette.length - 2), f = x - i;
  const c = palette[i].map((a, j) => Math.round(a + (palette[i + 1][j] - a) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
for (const q of ["(prefers-color-scheme: dark)", "(prefers-contrast: more)"]) {
  const mq = matchMedia(q);
  if (mq.addEventListener) mq.addEventListener("change", readPalette); else mq.addListener(readPalette);
}

// ---------------------------------------------------------------- drawing --

// Only touch the DOM when a value really changes: every write makes Safari
// redo style work, and display/colour writes can force a redraw.
function setTransform(el, v) { if (el._tf !== v) { el._tf = v; el.style.transform = v; } }
function show(el, on) { if (el._on !== on) { el._on = on; el.style.display = on ? "" : "none"; } }
function setColour(el, prop, v) { if (el._c !== v) { el._c = v; el.style[prop] = v; } }
function setOpacity(el, v) { if (el._o !== v) { el._o = v; el.style.opacity = v; } }

// px per dial unit (the dial is 100 units across); labels are sized from it.
let u = 3.6;
function measureDial() {
  const w = $("wrap").clientWidth;
  if (!w || Math.abs(w / 100 - u) < 0.005) return;
  u = w / 100;
  $("wrap").style.setProperty("--u", `${u}px`);
  labelW.fill(0); // font sizes changed: measure the labels again
}

function frame(now) {
  const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1);
  lastFrame = now;
  const turn = reduceMotion.matches ? TURN_REDUCED : TURN;

  // No compass (e.g. a laptop)? Draw it north-up so the arrows are still bearings.
  const h = heading ?? 0;
  [dialAngle, dialVel] = spring(dialAngle, dialVel, dialAngle + wrap180(-h - dialAngle), dt, turn);
  setTransform(dialEl, `rotate(${dialAngle.toFixed(2)}deg)`);

  for (let i = 0; i < ARROWS; i++) {
    const t = here && targets[i];
    show(arrowEls[i], !!t);
    if (!t) { angles[i] = null; continue; }
    const b = bearing(here.lat, here.lon, t.shop.lat, t.shop.lon);
    const want = b - h;
    if (angles[i] === null) { angles[i] = want; vel[i] = 0; }
    [angles[i], vel[i]] = spring(angles[i], vel[i], angles[i] + wrap180(want - angles[i]), dt, turn);
    const scale = i === 0 && pop !== 1 ? ` scale(${pop.toFixed(4)})` : "";
    setTransform(arrowEls[i], `rotate(${angles[i].toFixed(2)}deg)${scale}`);
    bearings[i] = Math.round(b) % 360;
  }

  placeLabels();
  if (isLandscape && sensorRows) updateSensors();

  // Main arrow: green when you're facing the shop, through yellow and orange,
  // to red when it's behind you.
  const facing = heading !== null && angles[0] !== null;
  const off = facing ? Math.abs(wrap180(angles[0])) : 0;
  // Arrow: show colour stop i, fade stop i+1 in over it (green, yellow, orange, red at 0/60/120/180°).
  const x = facing ? (Math.min(off, 180) / 60) : 0, seg = Math.min(Math.floor(x), 2), f = x - seg;
  setOpacity(mainBase, facing ? "0" : "1");
  mainTints.forEach((el, i) => setOpacity(el, !facing ? "0" : i === seg ? "1" : i === seg + 1 ? f.toFixed(3) : "0"));
  // Label: same colours, but only re-coloured every 5° (text has to be redrawn to change colour).
  setColour(bearingEls[0], "color", facing ? arrowColour(Math.round(off / 5) * 5) : "");

  const on = facing && off < ON_TARGET_DEG;
  if (on && !wasOnTarget) {
    if (navigator.vibrate) navigator.vibrate(25);
    if (!reduceMotion.matches) popVel += 1.1; // a small "got it" pop
  }
  wasOnTarget = on;
  if (pop !== 1 || popVel !== 0) {
    [pop, popVel] = spring(pop, popVel, 1, dt, POP);
    if (Math.abs(pop - 1) < 1e-4 && Math.abs(popVel) < 1e-3) { pop = 1; popVel = 0; }
  }

  requestAnimationFrame(frame);
}

// Labels: bearing near each arrow's tip, plus list numbers on the faint ones.
// Text only changes when you move; measuring happens then, not every frame.
const labelPx = labelEls.map(() => [0, 0]);
const labelH = new Array(ARROWS).fill(0);
function setLabel(i, nums, deg) {
  show(labelEls[i], true);
  const b = `${deg}°`;
  if (numEls[i].textContent === nums && bearingEls[i].textContent === b && labelW[i]) return;
  numEls[i].textContent = nums;
  bearingEls[i].textContent = b;
  const w = labelEls[i].offsetWidth, hgt = labelEls[i].offsetHeight;
  labelPx[i] = [w, hgt];
  labelW[i] = w / u + 1;     // + halo, in dial units
  labelH[i] = hgt / u + 0.4;
}

function placeLabels() {
  const wanted = [false, false, false, false, false, false];
  if (angles[0] !== null) {
    const near = (i, j) => Math.abs(wrap180(angles[i] - angles[j])) < GROUP_DEG;
    const faint = [1, 2, 3, 4, 5].filter((i) => angles[i] !== null);
    const underMain = faint.filter((i) => near(i, 0));
    const groups = [];
    for (const i of faint.filter((i) => !near(i, 0))
      .sort((a, b) => ((angles[a] - angles[0] + 720) % 360) - ((angles[b] - angles[0] + 720) % 360))) {
      const g = groups[groups.length - 1];
      if (g && near(i, g[0])) g.push(i); else groups.push([i]);
    }

    const n = rad(dialAngle); // the N on the dial counts as taken
    const boxes = [{ x: 50 + 45.75 * Math.sin(n), y: 50 - 45.75 * Math.cos(n), w: 4.4, h: 4.4 }];
    const fits = (box) => !boxes.some((o) => Math.abs(o.x - box.x) < (o.w + box.w) / 2 + 0.5 &&
                                             Math.abs(o.y - box.y) < (o.h + box.h) / 2 + 0.5);
    const place = (i, angle, offsets) => {
      const w = labelW[i], h = labelH[i];
      let pick = null;
      search:
      for (const edge of i === 0 ? [LABEL_EDGE] : [LABEL_EDGE, LABEL_EDGE - 10]) {
        for (const off of offsets) {
          if (edge < LABEL_EDGE && Math.abs(wrap180(angle + off - angles[0])) < 25) continue;
          const a = rad(angle + off), ux = Math.sin(a), uy = -Math.cos(a);
          const reach = (w / 2) * Math.abs(ux) + (h / 2) * Math.abs(uy); // centre to edge, along the arrow
          // Outer ring: clear of the arrow tips (r 32) even if it nudges the ticks.
          const r = edge === LABEL_EDGE ? Math.max(edge - reach, 33.5 + reach) : edge - reach;
          const box = { x: 50 + r * ux, y: 50 + r * uy, w, h };
          if (!pick) pick = box;
          if (fits(box)) { pick = box; break search; }
        }
      }
      boxes.push(pick);
      wanted[i] = true;
      const [pw, ph] = labelPx[i];
      setTransform(labelEls[i], `translate3d(${(pick.x * u - pw / 2).toFixed(1)}px, ${(pick.y * u - ph / 2).toFixed(1)}px, 0)`);
    };

    setLabel(0, underMain.join(" "), bearings[0]);
    place(0, angles[0], [0, 7, -7]);
    for (const g of groups) {
      const lead = Math.min(...g);
      const mid = angles[g[0]] + wrap180(angles[g[g.length - 1]] - angles[g[0]]) / 2;
      setLabel(lead, [...g].sort((a, b) => a - b).join(" "), bearings[lead]);
      place(lead, mid, [0, 8, 16, 24, 32, -8, -16, -24, -32]);
    }
  }
  for (let i = 0; i < ARROWS; i++) if (!wanted[i]) show(labelEls[i], false);
}

// --------------------------------------------------------------- location --

function onPosition(pos) {
  // The watch and the half-second request can hand over the same fix.
  if (raw.pos && pos.timestamp === raw.pos.timestamp) return;
  const now = performance.now();
  if (raw.posAt) raw.fixGap = now - raw.posAt;
  raw.pos = pos; raw.posAt = now; raw.posCount++;
  here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  clearHint("location");
  // "Precise Location" off gives a fix kilometres out: the nearest shops will be wrong.
  if (pos.coords.accuracy > 1000) {
    hint("precise", `Your location is only accurate to about ${Math.round(pos.coords.accuracy / 1000)} km, so ` +
      "distances will be off. Turn on Precise Location: Settings › Privacy & Security › Location Services › Safari Websites.");
  } else clearHint("precise");
  decl = declination(here.lat, here.lon);
  pickTargets();
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    locationOff = true;
    distEl.textContent = "";
    status("Location off");
    hint("location", IN_APP
      ? "This app's built-in browser isn't sharing your location. Tap ⋯ or the share button and choose Open in Safari."
      : "Location is blocked for this site. On iPhone: Settings › Privacy & Security › Location Services › " +
        "Safari Websites › While Using the App, then reload. Or open the page menu (ᴀA or ⋯ by the address) › " +
        "Website Settings › Location › Allow.");
  } else if (!here) {
    hint("location", "Can't get a location fix yet. Check Location Services is on, or try near a window or outside.");
  }
}

function startLocation() {
  if (!navigator.geolocation) { status("No location"); return; }
  status("Locating…");
  const fresh = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };
  navigator.geolocation.watchPosition(onPosition, onPositionError, fresh);
  // The watch only fires when the phone feels like it; also ask outright every
  // half second (one request at a time). The phone still decides how often it
  // has a genuinely new fix - usually about once a second.
  let asking = false;
  setInterval(() => {
    // Only once a first fix has arrived, so requests never stack up behind the permission prompt.
    if (asking || locationOff || document.hidden || !raw.posAt || performance.now() - raw.posAt < UPDATE_MS) return;
    asking = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => { asking = false; onPosition(pos); },
      () => { asking = false; },
      { ...fresh, timeout: 5000 });
  }, UPDATE_MS);
}

// ------------------------------------------------------------- wake lock ---

let wakeLock = null;
async function keepAwake() {
  try { if (navigator.wakeLock && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
// The browser drops the lock whenever the tab is hidden; take it back on return.
document.addEventListener("visibilitychange", keepAwake);

// -------------------------------------------------------------- landscape --
// Turn the phone sideways and the page glides into two columns: compass on the
// left, list on the right. FLIP: note where things are, switch the layout,
// then animate each piece from its old spot to its new one.

const landscapeMq = matchMedia("(orientation: landscape)");
let isLandscape = null;

function applyLayout(animate) {
  const want = landscapeMq.matches;
  if (want === isLandscape) return;
  const els = [$("wrap"), $("readout"), othersEl];
  const before = els.map((el) => el.getBoundingClientRect());
  isLandscape = want;
  app.classList.toggle("landscape", want);
  if (want) { renderSensors(); addEventListener("devicemotion", onMotion); } else removeEventListener("devicemotion", onMotion);
  if (!animate || !app.animate) return;

  if (reduceMotion.matches) {
    document.querySelector(".content").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
    return;
  }
  els.forEach((el, i) => {
    const a = before[i], b = el.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const scale = i === 0 ? ` scale(${a.width / b.width})` : ""; // only the compass changes size
    el.animate([
      { transformOrigin: "0 0", transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)${scale}` },
      { transformOrigin: "0 0", transform: "none" },
    ], { duration: 750, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
  });
  if (want) $("sensors").animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }],
    { duration: 500, delay: 300, easing: "cubic-bezier(0.2, 0.9, 0.25, 1)", fill: "backwards" });
}
if (landscapeMq.addEventListener) landscapeMq.addEventListener("change", () => applyLayout(true));
else landscapeMq.addListener(() => applyLayout(true));

// ---------------------------------------------------------------- sensors --
// Everything the page reads, redrawn every frame while it's showing.

const num = (v, d = 1, unit = "") => (typeof v === "number" && isFinite(v) ? `${v.toFixed(d)}${unit}` : "—");
const xyz = (o, d = 2) => (o && o.x !== null && o.x !== undefined ? `${num(o.x, d)}  ${num(o.y, d)}  ${num(o.z, d)}` : "—");
const yesNo = (v) => (v === undefined || v === null ? "—" : v ? "yes" : "no");

const SENSORS = [
  ["Location (GPS)", [
    ["Latitude", () => num(raw.pos?.coords.latitude, 6, "°")],
    ["Longitude", () => num(raw.pos?.coords.longitude, 6, "°")],
    ["Accuracy", () => num(raw.pos?.coords.accuracy, 0, " m")],
    ["Altitude", () => num(raw.pos?.coords.altitude, 1, " m")],
    ["Altitude accuracy", () => num(raw.pos?.coords.altitudeAccuracy, 0, " m")],
    ["Speed", () => (raw.pos?.coords.speed == null ? "—" : `${num(raw.pos.coords.speed, 1, " m/s")}  (${num(raw.pos.coords.speed * 3.6, 0, " km/h")})`)],
    ["GPS course", () => num(raw.pos?.coords.heading, 0, "°")],
    ["Since last fix", () => (raw.posAt ? `${((performance.now() - raw.posAt) / 1000).toFixed(2)} s` : "—")],
    ["Time between fixes", () => (raw.fixGap ? `${(raw.fixGap / 1000).toFixed(2)} s` : "—")],
    ["Location requested", () => `every ${UPDATE_MS / 1000} s`],
    ["Fixes", () => String(raw.posCount)],
  ]],
  ["Compass (device orientation)", [
    ["Event", () => (raw.ori ? raw.ori.type : "—")],
    ["Alpha (z)", () => num(raw.ori?.alpha, 1, "°")],
    ["Beta (x, tilt)", () => num(raw.ori?.beta, 1, "°")],
    ["Gamma (y, roll)", () => num(raw.ori?.gamma, 1, "°")],
    ["Absolute", () => yesNo(raw.ori?.absolute)],
    ["iOS compass heading", () => num(raw.ori?.webkitCompassHeading, 1, "°")],
    ["iOS compass accuracy", () => (raw.ori?.webkitCompassAccuracy >= 0 ? `±${raw.ori.webkitCompassAccuracy.toFixed(0)}°` : "—")],
    ["Screen angle", () => `${screenAngle()}°`],
    ["Magnetic heading", () => num(raw.mag, 1, "°")],
    ["Declination", () => num(decl, 1, "°")],
    ["True heading (smoothed)", () => num(heading, 1, "°")],
    ["Events", () => String(raw.oriCount)],
  ]],
  ["Motion", [
    ["Acceleration x y z", () => xyz(raw.motion?.acceleration) + (raw.motion?.acceleration?.x != null ? " m/s²" : "")],
    ["With gravity x y z", () => xyz(raw.motion?.accelerationIncludingGravity) + (raw.motion?.accelerationIncludingGravity?.x != null ? " m/s²" : "")],
    ["Rotation α β γ", () => { const r = raw.motion?.rotationRate; return r && r.alpha != null ? `${num(r.alpha, 0)}  ${num(r.beta, 0)}  ${num(r.gamma, 0)} °/s` : "—"; }],
    ["Interval", () => num(raw.motion?.interval, 0, " ms")],
    ["Events", () => String(raw.motionCount)],
    ["Magnetometer", () => (raw.extra.mag ? `${xyz(raw.extra.mag, 0)} µT` : raw.extra.magErr || "—")],
    ["Ambient light", () => (raw.extra.lux != null ? `${raw.extra.lux.toFixed(0)} lx` : raw.extra.luxErr || "—")],
  ]],
  ["Pointing at", [
    ["Place", () => (targets[0] ? targets[0].shop.name : "—")],
    ["Kind", () => (targets[0] ? { s: "Bottle shop", p: "Pub", b: "Bar", c: "Club" }[targets[0].shop.kind] : "—")],
    ["Coordinates", () => (targets[0] ? `${targets[0].shop.lat.toFixed(5)}, ${targets[0].shop.lon.toFixed(5)}` : "—")],
    ["Distance", () => (targets[0] ? num(targets[0].d, 0, " m") : "—")],
    ["Bearing", () => (targets[0] ? `${bearings[0]}°` : "—")],
    ["Arrow angle on screen", () => num(angles[0] === null ? null : wrap180(angles[0]), 1, "°")],
    ["Picked by you", () => yesNo(!!pinned)],
  ]],
  ["Data", [
    ["Source", () => (here && !inRegion(here) ? live?.source ?? (lookupFailed ? "unreachable" : "loading") : "Built-in list")],
    ["Places loaded", () => String(here && !inRegion(here) ? live?.shops.length ?? 0 : shops.length)],
    ["List updated", () => raw.extra.updated || "—"],
    ["Showing", () => [...kinds].map((k) => ({ s: "bottle shops", p: "pubs", b: "bars", c: "clubs" }[k])).join(", ")],
    ["Units", () => (imperial ? "imperial" : "metric")],
  ]],
  ["Device", [
    ["Orientation", () => (screen.orientation ? `${screen.orientation.type} (${screen.orientation.angle}°)` : `${window.orientation ?? 0}°`)],
    ["Viewport", () => `${innerWidth} × ${innerHeight} @${devicePixelRatio}x`],
    ["Screen awake", () => (wakeLock ? yesNo(!wakeLock.released) : "not available")],
    ["Online", () => yesNo(navigator.onLine)],
    ["Network", () => (navigator.connection ? `${navigator.connection.effectiveType || "?"}, ${navigator.connection.downlink ?? "?"} Mb/s` : "not available")],
    ["Battery", () => (raw.extra.battery ? `${Math.round(raw.extra.battery.level * 100)}%${raw.extra.battery.charging ? ", charging" : ""}` : "not available")],
    ["Appearance", () => `${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}${reduceMotion.matches ? ", reduce motion" : ""}`],
  ]],
];

let sensorRows = null;
function renderSensors() {
  const box = $("sensors");
  if (!sensorRows) {
    sensorRows = [];
    for (const [title, rows] of SENSORS) {
      const h = document.createElement("h2"), dl = document.createElement("dl");
      h.textContent = title;
      for (const [label, get] of rows) {
        const r = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
        r.className = "r"; dt.textContent = label;
        r.append(dt, dd); dl.append(r);
        sensorRows.push([dd, get, r]);
      }
      box.append(h, dl);
    }
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Headings are degrees clockwise from north. Some sensors only exist on some phones.";
    box.append(note);
    startExtraSensors();
    // Only rows you can see get updated (the column scrolls).
    if (window.IntersectionObserver) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) e.target._seen = e.isIntersecting;
      }, { root: $("side") });
      for (const [, , r] of sensorRows) { r._seen = true; io.observe(r); }
    }
  }
}

// Called from frame(), so the panel moves as smoothly as the compass. Only
// values that actually changed are written.
function updateSensors() {
  for (const [dd, get, r] of sensorRows) {
    if (r._seen === false) continue;
    let v; try { v = get(); } catch { v = "—"; }
    if (dd.textContent !== v) dd.textContent = v;
  }
}

// Extras some browsers have (mostly Chrome on Android): battery, magnetometer, light.
function startExtraSensors() {
  if (navigator.getBattery) navigator.getBattery().then((b) => { raw.extra.battery = b; }).catch(() => {});
  for (const [name, key, onRead] of [
    ["Magnetometer", "magErr", (s) => { raw.extra.mag = { x: s.x, y: s.y, z: s.z }; }],
    ["AmbientLightSensor", "luxErr", (s) => { raw.extra.lux = s.illuminance; }],
  ]) {
    if (!(name in window)) { raw.extra[key] = "not available"; continue; }
    try {
      const sensor = new window[name]({ frequency: 5 });
      sensor.addEventListener("reading", () => onRead(sensor));
      sensor.addEventListener("error", (e) => { raw.extra[key] = e.error?.name === "NotAllowedError" ? "not allowed" : "not available"; });
      sensor.start();
    } catch { raw.extra[key] = "not available"; }
  }
}

// ------------------------------------------------------------------ start --

// iOS (and some Chrome builds) only send compass data after a tap and a
// permission prompt. Ask for it on the first tap anywhere if nothing arrives.
function compassBlocked() {
  // Only if readings really aren't coming (some browsers say "denied" but still send them).
  setTimeout(() => {
    if (heading === null) hint("compass", "Compass access was turned down, so the arrows can't follow your phone. " +
      "Fully close Safari (swipe it away), open the link again and tap Allow.");
  }, 600);
}

function askForCompass() {
  needsTap = false;
  app.classList.remove("idle");
  try {
    DeviceOrientationEvent.requestPermission()
      .then((answer) => { if (answer !== "granted") compassBlocked(); })
      .catch(compassBlocked);
  } catch { compassBlocked(); }
  try { DeviceMotionEvent.requestPermission().catch(() => {}); } catch {} // for the sensor panel
  setTimeout(() => {
    if (heading === null && !hints.compass) {
      hint("compass", IN_APP
        ? "No compass in this app's built-in browser. Tap ⋯ or the share button and choose Open in Safari."
        : "No compass readings yet. Move your phone in a figure-8 to wake the compass up.");
    }
  }, 3000);
  keepAwake();
  if (here) pickTargets(); else status(locationOff ? "Location off" : "Locating…");
}

async function load() {
  // Tick marks around the dial.
  const ticks = $("ticks");
  for (let i = 0; i < 72; i++) {
    const a = rad(i * 5), major = i % 6 === 0, r1 = 48, r2 = major ? 43.5 : 45.5;
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", 50 + r1 * Math.sin(a)); l.setAttribute("y1", 50 - r1 * Math.cos(a));
    l.setAttribute("x2", 50 + r2 * Math.sin(a)); l.setAttribute("y2", 50 - r2 * Math.cos(a));
    if (major) l.setAttribute("class", "major");
    if (i !== 0) ticks.appendChild(l); // the N sits here
  }
  readPalette();
  applyLayout(false);
  measureDial();
  if (window.ResizeObserver) new ResizeObserver(measureDial).observe($("wrap"));
  else addEventListener("resize", measureDial);
  requestAnimationFrame(frame);

  try {
    // places.json has pubs, bars and clubs too; fall back to the bottle shop list.
    let res = await fetch("data/places.json", { cache: "no-cache" });
    if (!res.ok) res = await fetch("data/shops.json", { cache: "no-cache" });
    const data = await res.json();
    raw.extra.updated = data.updated;
    shops = (data.places || data.shops).map(([lat, lon, name, kind]) =>
      ({ lat, lon, name, kind: data.places ? kind : "s" }));
  } catch {
    status("Couldn't load shops");
    return;
  }

  startCompass();
  startLocation();
  if (IN_APP) hint("inapp", "Opened inside another app? Its built-in browser can block the compass and location. " +
    "If the arrows don't move, tap ⋯ or the share button and choose Open in Safari.");
  keepAwake();
  setInterval(pickTargets, UPDATE_MS); // distances, nearest places and list, twice a second

  // Tap a shop in the list to point the main arrow at it.
  othersEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-slot]");
    const t = btn && targets[+btn.dataset.slot];
    if (!t) return;
    pinned = { lat: t.shop.lat, lon: t.shop.lon, name: t.shop.name, kind: t.shop.kind };
    save("pinned", JSON.stringify(pinned));
    pickTargets();
  });
  $("nearest").addEventListener("click", () => {
    pinned = null;
    save("pinned", "null");
    pickTargets();
  });

  // km / mi
  const unitBtns = document.querySelectorAll(".units button");
  const showUnits = () => unitBtns.forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.units === "imperial") === imperial)));
  unitBtns.forEach((b) => b.addEventListener("click", () => {
    imperial = b.dataset.units === "imperial";
    save("units", imperial ? "imperial" : "metric");
    showUnits();
    pickTargets();
  }));
  showUnits();

  // Which kinds of place: a pull-down menu with checkmarks, like iOS.
  const filterBtn = $("filter"), menu = $("menu");
  const items = menu.querySelectorAll("[data-kind]");
  const showKinds = () => {
    items.forEach((b) => b.setAttribute("aria-checked", String(kinds.has(b.dataset.kind))));
    filterBtn.classList.toggle("active", kinds.size < items.length);
  };
  const openMenu = (open) => {
    menu.classList.toggle("open", open);
    filterBtn.setAttribute("aria-expanded", String(open));
  };
  filterBtn.addEventListener("click", (e) => { e.stopPropagation(); openMenu(!menu.classList.contains("open")); });
  items.forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const k = b.dataset.kind;
    if (kinds.has(k) && kinds.size === 1) return; // keep at least one
    if (kinds.has(k)) kinds.delete(k); else kinds.add(k);
    save("kinds", [...kinds].join(""));
    showKinds();
    pickTargets();
  }));
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) openMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openMenu(false); });
  showKinds();

  setTimeout(() => {
    const canAsk = typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function";
    if (heading === null && canAsk) {
      needsTap = true;
      app.classList.add("idle");
      if (here) pickTargets(); else if (!locationOff) status("Tap anywhere to start");
      app.addEventListener("click", () => { if (needsTap) askForCompass(); });
    } else {
      app.classList.remove("idle");
    }
  }, 1000);
}

load();
