"use strict";

// ---------------------------------------------------------------- settings --

const ARROWS = 6;         // the nearest shop + the next 5
const ON_TARGET_DEG = 12; // main arrow goes green when you're facing the shop

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
const app = $("app"), wrap = $("wrap"), dialEl = $("dial");
const labelEl = $("label"), distEl = $("dist"), nameEl = $("name");
const arrowEls = [$("a0"), $("a1"), $("a2"), $("a3"), $("a4"), $("a5")];

let shops = [];          // [{lat, lon, name}]
let here = null;         // {lat, lon}
let targets = [];        // nearest ARROWS shops, closest first: [{shop, d}]
let heading = null;      // degrees from true north, smoothed
let hx = 0, hy = 0;      // heading as a unit vector, for smoothing across 359°->0°
let dialAngle = 0;
const angles = new Array(ARROWS).fill(null); // drawn angle of each arrow
let wasOnTarget = false;
let needsTap = false;
let locationOff = false;
let decl = 12.8;         // magnetic declination where you are
let live = null;         // {lat, lon, shops} from OpenStreetMap when outside REGION
let nextLiveFetch = 0;   // don't hammer the free API

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
  const q = `[out:json][timeout:25];nwr["shop"~"^(alcohol|wine)$"](around:${radius},${lat},${lon});out center tags;`;
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
        return { lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, name };
      }).filter((shop) => shop.lat != null);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function fetchNearby() {
  nextLiveFetch = Infinity; // one lookup at a time
  const at = { ...here };
  if (!live) { distEl.textContent = ""; nameEl.textContent = "Searching…"; }
  try {
    let found = await overpassAround(at, 15000);
    if (!found.length) found = await overpassAround(at, 80000); // country towns
    live = { ...at, shops: found };
  } catch {
    if (!live) nameEl.textContent = "No signal";
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

  // Keep the closest few without sorting the whole list.
  const best = [];
  for (const shop of outside ? live.shops : shops) {
    const d = metres(here.lat, here.lon, shop.lat, shop.lon);
    if (best.length === ARROWS && d >= best[ARROWS - 1].d) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].d > d) i--;
    best.splice(i, 0, { shop, d });
    if (best.length > ARROWS) best.pop();
  }
  // Arrows whose shop changed swing over from where they were.
  targets = best;

  if (best.length) {
    distEl.textContent = needsTap ? "" : formatDistance(best[0].d);
    nameEl.textContent = needsTap ? "Tap to start" : best[0].shop.name;
  } else {
    distEl.textContent = "";
    nameEl.textContent = "None nearby";
  }
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

function onOrientation(e) {
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
    onHeading(e.webkitCompassHeading); // iOS: already a compass heading
  } else if (e.absolute && typeof e.alpha === "number") {
    onHeading(360 - e.alpha + screenAngle()); // Android: alpha runs anticlockwise
  }
}

function startCompass() {
  if ("ondeviceorientationabsolute" in window) {
    window.addEventListener("deviceorientationabsolute", onOrientation);
  } else {
    window.addEventListener("deviceorientation", onOrientation);
  }
}

// ---------------------------------------------------------------- drawing --

function frame() {
  // No compass (e.g. a laptop)? Draw it north-up so the arrows are still bearings.
  const h = heading ?? 0;
  dialAngle += wrap180(-h - dialAngle) * 0.3;
  dialEl.style.transform = `rotate(${dialAngle}deg)`;

  for (let i = 0; i < ARROWS; i++) {
    const t = here && targets[i];
    arrowEls[i].style.display = t ? "" : "none";
    if (!t) { angles[i] = null; continue; }
    const want = bearing(here.lat, here.lon, t.shop.lat, t.shop.lon) - h;
    angles[i] = angles[i] === null ? want : angles[i] + wrap180(want - angles[i]) * 0.3;
    arrowEls[i].setAttribute("transform", `rotate(${angles[i].toFixed(2)} 50 50)`);
  }

  const on = heading !== null && angles[0] !== null && Math.abs(wrap180(angles[0])) < ON_TARGET_DEG;
  arrowEls[0].classList.toggle("on", on);
  if (on && !wasOnTarget && navigator.vibrate) navigator.vibrate(25);
  wasOnTarget = on;

  placeLabel();
  requestAnimationFrame(frame);
}

// The name + distance tag hangs off the tail of the main arrow, on the far
// side of the centre, pushed out just far enough that it never overlaps it.
function placeLabel() {
  let x = 0, y = 0;
  if (angles[0] !== null) {
    const a = rad(angles[0]), ux = Math.sin(a), uy = -Math.cos(a); // arrow direction
    const gap = wrap.clientWidth * 0.05; // clears the hub in the middle
    const r = (labelEl.offsetWidth / 2) * Math.abs(ux) + (labelEl.offsetHeight / 2) * Math.abs(uy) + gap;
    x = -ux * r; y = -uy * r;
  }
  labelEl.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

// --------------------------------------------------------------- location --

function startLocation() {
  if (!navigator.geolocation) { nameEl.textContent = "No location"; return; }
  nameEl.textContent = "Locating…";
  navigator.geolocation.watchPosition(
    (pos) => {
      here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      decl = declination(here.lat, here.lon);
      pickTargets();
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        locationOff = true;
        distEl.textContent = "";
        nameEl.textContent = "Location off";
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

// ------------------------------------------------------------- wake lock ---

async function keepAwake() {
  try { if (navigator.wakeLock && document.visibilityState === "visible") await navigator.wakeLock.request("screen"); } catch {}
}
// The browser drops the lock whenever the tab is hidden; take it back on return.
document.addEventListener("visibilitychange", keepAwake);

// ------------------------------------------------------------------ start --

// iOS (and some Chrome builds) only send compass data after a tap and a
// permission prompt. Ask for it on the first tap anywhere if nothing arrives.
function askForCompass() {
  needsTap = false;
  app.classList.remove("idle");
  try { DeviceOrientationEvent.requestPermission().catch(() => {}); } catch {}
  keepAwake();
  if (here) pickTargets(); else nameEl.textContent = locationOff ? "Location off" : "Locating…";
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
  requestAnimationFrame(frame);

  try {
    const res = await fetch("data/shops.json", { cache: "no-cache" });
    shops = (await res.json()).shops.map(([lat, lon, name]) => ({ lat, lon, name }));
  } catch {
    nameEl.textContent = "Couldn't load shops";
    return;
  }

  startCompass();
  startLocation();
  keepAwake();
  setInterval(pickTargets, 30000); // re-check for a live lookup if you've moved

  setTimeout(() => {
    const canAsk = typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function";
    if (heading === null && canAsk) {
      needsTap = true;
      app.classList.add("idle");
      if (here) pickTargets(); else if (!locationOff) nameEl.textContent = "Tap to start";
      app.addEventListener("click", () => { if (needsTap) askForCompass(); });
    } else {
      app.classList.remove("idle");
    }
  }, 1000);
}

load();
