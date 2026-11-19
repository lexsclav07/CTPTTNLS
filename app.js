"use strict";

// ---------------------------------------------------------------- settings --

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
// Anywhere else, shops are looked up live from OpenStreetMap, ignoring hours.
const REGION = { s: -34.25, w: 150.4, n: -32.5, e: 152.3 };
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Most shops don't publish hours on OpenStreetMap. For those, assume a
// conservative "almost every bottlo is open by now" window.
const DEFAULT_HOURS = "Mo-We 10:00-20:00; Th-Sa 10:00-21:00; Su 10:00-19:00";

const ON_TARGET_DEG = 12; // arrow goes green when you're facing the shop

// ------------------------------------------------------------------- state --

const $ = (id) => document.getElementById(id);
const app = $("app"), arrowEl = $("arrow"), dialEl = $("dial");
const distEl = $("dist"), nameEl = $("name"), openBtn = $("open");

let shops = [];          // [{lat, lon, name, week}]
let here = null;         // {lat, lon}
let target = null;       // nearest shop we're pointing at
let heading = null;      // degrees from true north, smoothed
let hx = 0, hy = 0;      // heading as a unit vector, for smoothing across 359°->0°
let arrowAngle = 0, dialAngle = 0;
let wasOnTarget = false;
let started = false;
let needsTap = false;
let locationOff = false;
let decl = 12.8;          // magnetic declination where you are
let live = null;         // {lat, lon, shops} from OpenStreetMap when outside REGION
let nextLiveFetch = 0;   // don't hammer the free API
let openOnly = true;
try { openOnly = localStorage.getItem("openOnly") !== "0"; } catch {}

// ---------------------------------------------------------- opening hours --

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// OSM opening_hours -> 7 lists (Mon..Sun) of [startMin, endMin], where end can
// run past 1440 for after-midnight closing. null = couldn't understand it.
function parseHours(text) {
  if (!text) return null;
  text = text.trim();
  if (text === "24/7") return DAYS.map(() => [[0, 1440]]);

  // Lots of shops use "," between rules instead of ";" - normalise that.
  text = text.replace(/(\d|off|closed)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/gi, "$1;");

  const week = DAYS.map(() => []);
  for (const rule of text.split(/\s*;\s*/)) {
    if (!rule) continue;
    const m = rule.match(/^(.*?)\s*((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*,?\s*)+|off|closed)$/i);
    if (!m) return null;

    let days = [], publicHoliday = false;
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      if (part === "PH") { publicHoliday = true; continue; }
      const r = part.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!r) return null; // months, dates, "week 1", sunrise... too fancy
      const a = DAYS.indexOf(r[1]), b = DAYS.indexOf(r[2] || r[1]);
      for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
    }
    if (!m[1].trim()) days = [0, 1, 2, 3, 4, 5, 6];
    if (!days.length && publicHoliday) continue; // a PH-only rule; ignore

    let ranges = [];
    if (!/off|closed/i.test(m[2])) {
      for (const t of m[2].match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g)) {
        const [s, e] = t.split("-").map((x) => {
          const [h, mm] = x.trim().split(":").map(Number);
          return h * 60 + mm;
        });
        ranges.push([s, e <= s ? e + 1440 : e]);
      }
    }
    for (const d of days) week[d] = ranges; // later rules override earlier ones
  }
  return week;
}

const DEFAULT_WEEK = parseHours(DEFAULT_HOURS);

function sydneyNow() {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney", year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(new Date())) parts[p.type] = p.value;
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday),
    min: (+parts.hour % 24) * 60 + +parts.minute,
  };
}

// NSW bottle shops can't trade on Good Friday or Christmas Day.
function closedByLaw({ y, m, d }) {
  if (m === 12 && d === 25) return true;
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = new Date(Date.UTC(y, Math.floor((h + l - 7 * mm + 114) / 31) - 1, ((h + l - 7 * mm + 114) % 31) + 1));
  const goodFriday = new Date(easter.getTime() - 2 * 864e5);
  return m === goodFriday.getUTCMonth() + 1 && d === goodFriday.getUTCDate();
}

function isOpen(shop, now) {
  const week = shop.week || DEFAULT_WEEK;
  const inside = (ranges, min) => ranges.some(([s, e]) => min >= s && min < e);
  return inside(week[now.day], now.min) || inside(week[(now.day + 6) % 7], now.min + 1440);
}

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

// ---------------------------------------------------------------- picking --

function declination(lat, lon) {
  const g = DECLINATION_GRID;
  const y = Math.min(Math.max((lat + 45) / 5, 0), g.length - 1.001);
  const x = Math.min(Math.max((lon - 110) / 5, 0), g[0].length - 1.001);
  const i = Math.floor(y), j = Math.floor(x), fy = y - i, fx = x - j;
  return (g[i][j] * (1 - fx) + g[i][j + 1] * fx) * (1 - fy) + (g[i + 1][j] * (1 - fx) + g[i + 1][j + 1] * fx) * fy;
}

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
  pickTarget();
}

function pickTarget() {
  if (!here) return;
  const outside = !inRegion(here);
  app.classList.toggle("anywhere", outside); // opening hours only work in NSW
  if (outside) {
    const moved = live && metres(here.lat, here.lon, live.lat, live.lon) > 5000;
    if ((!live || moved) && Date.now() >= nextLiveFetch) fetchNearby();
    if (!live) return;
  }
  const list = outside ? live.shops : shops;
  const filter = openOnly && !outside;
  const now = sydneyNow();
  const lawClosed = closedByLaw(now);
  let best = null, bestD = Infinity;
  for (const s of list) {
    if (filter && (lawClosed || !isOpen(s, now))) continue;
    const d = metres(here.lat, here.lon, s.lat, s.lon);
    if (d < bestD) { bestD = d; best = s; }
  }
  target = best;
  if (best) {
    distEl.textContent = formatDistance(bestD);
    nameEl.textContent = needsTap ? "Tap to start" : best.name;
  } else {
    distEl.textContent = "—";
    nameEl.textContent = outside ? "None nearby" : "Nothing open";
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
  // No compass (e.g. a laptop)? Draw it north-up so the arrow is still a bearing.
  const h = heading ?? 0;
  dialAngle += wrap180(-h - dialAngle) * 0.3;
  dialEl.style.transform = `rotate(${dialAngle}deg)`;

  if (target && here) {
    const want = bearing(here.lat, here.lon, target.lat, target.lon) - h;
    arrowAngle += wrap180(want - arrowAngle) * 0.3;
    arrowEl.style.transform = `rotate(${arrowAngle}deg)`;
    const on = heading !== null && Math.abs(wrap180(arrowAngle)) < ON_TARGET_DEG;
    arrowEl.classList.toggle("on", on);
    if (on && !wasOnTarget && navigator.vibrate) navigator.vibrate(25);
    wasOnTarget = on;
  }
  arrowEl.classList.toggle("none", started && !target);
  requestAnimationFrame(frame);
}

// --------------------------------------------------------------- location --

function startLocation() {
  if (!navigator.geolocation) { nameEl.textContent = "No location"; return; }
  nameEl.textContent = "Locating…";
  navigator.geolocation.watchPosition(
    (pos) => {
      here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      decl = declination(here.lat, here.lon);
      pickTarget();
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

let wakeLock = null;
async function keepAwake() {
  try { if (navigator.wakeLock && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
// The browser drops the lock whenever the tab is hidden; take it back on return.
document.addEventListener("visibilitychange", () => { if (started) keepAwake(); });

// ------------------------------------------------------------------ start --

// iOS (and some Chrome builds) only send compass data after a tap and a
// permission prompt. Ask for it on the first tap anywhere if nothing arrives.
function askForCompass() {
  needsTap = false;
  app.classList.remove("idle");
  try { DeviceOrientationEvent.requestPermission().catch(() => {}); } catch {}
  keepAwake();
  if (here) pickTarget(); else nameEl.textContent = locationOff ? "Location off" : "Locating…";
}

function renderToggle() {
  openBtn.setAttribute("aria-pressed", String(openOnly));
}

openBtn.addEventListener("click", (e) => {
  if (needsTap) askForCompass();
  e.stopPropagation();
  openOnly = !openOnly;
  try { localStorage.setItem("openOnly", openOnly ? "1" : "0"); } catch {}
  renderToggle();
  pickTarget();
});

async function load() {
  // Tick marks around the dial.
  const ticks = $("ticks");
  for (let i = 0; i < 72; i++) {
    const a = rad(i * 5), major = i % 6 === 0, r1 = 47, r2 = major ? 42 : 44.5;
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", 50 + r1 * Math.sin(a)); l.setAttribute("y1", 50 - r1 * Math.cos(a));
    l.setAttribute("x2", 50 + r2 * Math.sin(a)); l.setAttribute("y2", 50 - r2 * Math.cos(a));
    if (major) l.setAttribute("class", "major");
    if (i !== 0) ticks.appendChild(l); // leave room for the N
  }
  renderToggle();
  requestAnimationFrame(frame);

  try {
    const res = await fetch("data/shops.json", { cache: "no-cache" });
    shops = (await res.json()).shops.map(([lat, lon, name, hours]) => ({ lat, lon, name, week: parseHours(hours) }));
  } catch {
    nameEl.textContent = "Couldn't load shops";
    return;
  }

  started = true;
  startCompass();
  startLocation();
  keepAwake();
  setInterval(pickTarget, 30000); // shops open and close while you walk

  setTimeout(() => {
    const canAsk = typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function";
    if (heading === null && canAsk) {
      needsTap = true;
      app.classList.add("idle");
      if (here) pickTarget(); else if (!locationOff) nameEl.textContent = "Tap to start";
      app.addEventListener("click", () => { if (needsTap) askForCompass(); });
    } else {
      app.classList.remove("idle");
    }
  }, 1000);
}

load();
