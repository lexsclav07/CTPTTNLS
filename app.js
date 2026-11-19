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

// data/shops.json covers this box (Sydney, Central Coast, Newcastle, Hunter).
// Anywhere else, shops are looked up live from OpenStreetMap.
const REGION = { s: -34.25, w: 150.4, n: -32.5, e: 152.3 };
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// ------------------------------------------------------------------- state --

const $ = (id) => document.getElementById(id);
const app = $("app"), dialEl = $("dial");
const distEl = $("dist"), nameEl = $("name"), othersEl = $("others");
const arrowEls = [$("a0"), $("a1"), $("a2"), $("a3"), $("a4"), $("a5")];
const labelEls = [0, 1, 2, 3, 4, 5].map((i) => $("l" + i));
const bearingEls = labelEls.map((g) => g.querySelector(".b"));
const numEls = labelEls.map((g) => g.querySelector(".k"));

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

const inRegion = ({ lat, lon }) => lat >= REGION.s && lat <= REGION.n && lon >= REGION.w && lon <= REGION.e;

async function overpassAround({ lat, lon }, radius) {
  const near = `(around:${radius},${lat},${lon})`;
  const q = `[out:json][timeout:25];(nwr["shop"~"^(alcohol|wine)$"]${near};nwr["amenity"~"^(pub|bar|nightclub)$"]["name"]${near};);out center tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(`${url}?data=${encodeURIComponent(q)}`,
        AbortSignal.timeout ? { signal: AbortSignal.timeout(25000) } : {});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).elements.map((el) => {
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

async function fetchNearby() {
  nextLiveFetch = Infinity; // one lookup at a time
  const at = { ...here };
  if (!live) { distEl.textContent = ""; status("Searching…"); }
  try {
    let found = await overpassAround(at, 15000);
    if (!found.length) found = await overpassAround(at, 80000); // country towns
    live = { ...at, shops: found };
  } catch {
    if (!live) status("No signal");
    return;
  } finally {
    nextLiveFetch = Date.now() + 30000;
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
  const pinKey = pinned && shopKey(pinned);
  const best = [];
  for (const shop of outside ? live.shops : shops) {
    if (!kinds.has(shop.kind) || shop === pinned || (pinKey && shopKey(shop) === pinKey)) continue;
    const d = metres(here.lat, here.lon, shop.lat, shop.lon);
    if (best.length === ARROWS && d >= best[ARROWS - 1].d) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].d > d) i--;
    best.splice(i, 0, { shop, d });
    if (best.length > ARROWS) best.pop();
  }
  if (pinned) {
    best.unshift({ shop: pinned, d: metres(here.lat, here.lon, pinned.lat, pinned.lon) });
    best.length = Math.min(best.length, ARROWS);
  }
  targets = best; // arrows whose shop changed swing over from where they were
  if ($("nearest").hidden !== !pinned) $("nearest").hidden = !pinned;

  if (best.length) {
    const dist = needsTap ? "" : formatDistance(best[0].d);
    if (distEl.textContent !== dist) distEl.textContent = dist;
    if (needsTap) status("Tap to start"); else showShop(best[0].shop);
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
window.addEventListener("devicemotion", (e) => { raw.motion = e; raw.motionCount++; });

function startCompass() {
  if ("ondeviceorientationabsolute" in window) {
    window.addEventListener("deviceorientationabsolute", onOrientation);
  } else {
    window.addEventListener("deviceorientation", onOrientation);
  }
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

function frame(now) {
  const dt = Math.min((now - (lastFrame || now)) / 1000, 0.1);
  lastFrame = now;
  const turn = reduceMotion.matches ? TURN_REDUCED : TURN;

  // No compass (e.g. a laptop)? Draw it north-up so the arrows are still bearings.
  const h = heading ?? 0;
  [dialAngle, dialVel] = spring(dialAngle, dialVel, dialAngle + wrap180(-h - dialAngle), dt, turn);
  dialEl.style.transform = `rotate(${dialAngle}deg)`;

  for (let i = 0; i < ARROWS; i++) {
    const t = here && targets[i];
    arrowEls[i].style.display = t ? "" : "none";
    if (!t) { angles[i] = null; continue; }
    const b = bearing(here.lat, here.lon, t.shop.lat, t.shop.lon);
    const want = b - h;
    if (angles[i] === null) { angles[i] = want; vel[i] = 0; }
    [angles[i], vel[i]] = spring(angles[i], vel[i], angles[i] + wrap180(want - angles[i]), dt, turn);
    const scale = i === 0 && pop !== 1 ? ` translate(50 50) scale(${pop.toFixed(4)}) translate(-50 -50)` : "";
    arrowEls[i].setAttribute("transform", `rotate(${angles[i].toFixed(2)} 50 50)${scale}`);
    bearings[i] = Math.round(b) % 360;
  }

  placeLabels();
  if (isLandscape && sensorRows) updateSensors();

  // Main arrow: green when you're facing the shop, through yellow and orange,
  // to red when it's behind you.
  const facing = heading !== null && angles[0] !== null;
  const off = facing ? Math.abs(wrap180(angles[0])) : 0;
  const colour = facing ? arrowColour(off) : "";
  arrowEls[0].style.fill = colour;
  bearingEls[0].style.fill = colour;

  const on = facing && off < ON_TARGET_DEG;
  if (on && !wasOnTarget) {
    if (navigator.vibrate) navigator.vibrate(25);
    if (!reduceMotion.matches) popVel += 1.1; // a small "got it" pop
  }
  wasOnTarget = on;
  [pop, popVel] = spring(pop, popVel, 1, dt, POP);
  if (Math.abs(pop - 1) < 1e-4 && Math.abs(popVel) < 1e-3) { pop = 1; popVel = 0; }

  requestAnimationFrame(frame);
}

// Labels: bearing near each arrow's tip, plus list numbers on the faint ones.
// Shops in (almost) the same direction - common at shopping centres - share
// one label like "3 4 5 / 340°"; ones hiding under the main arrow put their
// numbers on its label. Labels stay inside the tick ring, off the main arrow
// and the N, and slide around the dial (keeping the arrows' order) if crowded.
function setLabel(i, nums, deg) {
  labelEls[i].style.display = "";
  const b = `${deg}°`;
  if (numEls[i].textContent === nums && bearingEls[i].textContent === b && labelW[i]) return;
  numEls[i].textContent = nums;
  bearingEls[i].textContent = b;
  if (i === 0) bearingEls[0].setAttribute("y", nums ? -2.2 : 0);
  labelW[i] = Math.max(bearingEls[i].getComputedTextLength(),
    nums ? numEls[i].getComputedTextLength() : 0, 2.6) + 1.4; // + halo
}

function placeLabels() {
  for (const g of labelEls) g.style.display = "none";
  if (angles[0] === null) return;

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
  const place = (i, angle, h, offsets) => {
    const w = labelW[i];
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
    labelEls[i].setAttribute("transform", `translate(${pick.x.toFixed(2)} ${pick.y.toFixed(2)})`);
  };

  setLabel(0, underMain.join(" "), bearings[0]);
  place(0, angles[0], underMain.length ? 9.4 : 5, [0, 7, -7]);
  for (const g of groups) {
    const lead = Math.min(...g);
    const mid = angles[g[0]] + wrap180(angles[g[g.length - 1]] - angles[g[0]]) / 2;
    setLabel(lead, [...g].sort((a, b) => a - b).join(" "), bearings[lead]);
    place(lead, mid, 8.6, [0, 8, 16, 24, 32, -8, -16, -24, -32]);
  }
}

// --------------------------------------------------------------- location --

function onPosition(pos) {
  // The watch and the half-second request can hand over the same fix.
  if (raw.pos && pos.timestamp === raw.pos.timestamp) return;
  const now = performance.now();
  if (raw.posAt) raw.fixGap = now - raw.posAt;
  raw.pos = pos; raw.posAt = now; raw.posCount++;
  here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  decl = declination(here.lat, here.lon);
  pickTargets();
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    locationOff = true;
    distEl.textContent = "";
    status("Location off");
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
    if (asking || locationOff || document.hidden) return;
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
  if (want) renderSensors();
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
    ["Source", () => (here && !inRegion(here) ? "OpenStreetMap (live)" : "Built-in list")],
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
        sensorRows.push([dd, get]);
      }
      box.append(h, dl);
    }
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Headings are degrees clockwise from north. Some sensors only exist on some phones.";
    box.append(note);
    startExtraSensors();
  }
}

// Called from frame(), so the panel moves as smoothly as the compass. Only
// values that actually changed are written.
function updateSensors() {
  for (const [dd, get] of sensorRows) {
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
function askForCompass() {
  needsTap = false;
  app.classList.remove("idle");
  try { DeviceOrientationEvent.requestPermission().catch(() => {}); } catch {}
  try { DeviceMotionEvent.requestPermission().catch(() => {}); } catch {} // for the sensor panel
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
      if (here) pickTargets(); else if (!locationOff) status("Tap to start");
      app.addEventListener("click", () => { if (needsTap) askForCompass(); });
    } else {
      app.classList.remove("idle");
    }
  }, 1000);
}

load();
