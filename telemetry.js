"use strict";

// Telemetry: records every sensor the app reads and graphs it live, a bit
// like phyphox. Opened with the waveform button in the top bar. Recording
// carries on if you close the sheet (a red dot on the button says so), so you
// can record a walk and look at it afterwards. Export shares a .zip with one
// CSV per sensor.
//
// Uses the app's globals from app.js: heading, raw, targets, bearings,
// angles, wrap180, reduceMotion, $.

(() => {
  // ------------------------------------------------------------- tables --
  // Each sensor writes rows into its own table: a time column and one column
  // per channel, in typed arrays that double in size as they fill.

  const TABLES = {
    heading: { name: "Heading", cols: ["True heading (deg)", "Magnetic heading (deg)", "iOS compass heading (deg)"] },
    tilt: { name: "Tilt", cols: ["Beta, front-back (deg)", "Gamma, left-right (deg)", "Alpha (deg)"] },
    accel: { name: "Acceleration", cols: ["x (m/s^2)", "y (m/s^2)", "z (m/s^2)", "Absolute (m/s^2)"] },
    gravity: { name: "Acceleration with gravity", cols: ["x (m/s^2)", "y (m/s^2)", "z (m/s^2)"] },
    gyro: { name: "Rotation rate", cols: ["Beta (deg/s)", "Gamma (deg/s)", "Alpha (deg/s)"] },
    gps: { name: "Location", precise: true,
      cols: ["Latitude (deg)", "Longitude (deg)", "East (m)", "North (m)", "Altitude (m)", "Speed (m/s)",
        "Course (deg)", "Accuracy (m)", "Altitude accuracy (m)"] },
    target: { name: "Target", cols: ["Distance (m)", "Bearing (deg)", "Arrow on screen (deg)"] },
    fps: { name: "Frame rate", cols: ["Frames per second"] },
    mag: { name: "Magnetometer", cols: ["x (uT)", "y (uT)", "z (uT)"] },
    light: { name: "Ambient light", cols: ["Illuminance (lx)"] },
  };
  const MAX_SECONDS = 3600; // stops itself after an hour

  const data = {};
  let recording = false, startedAt = 0, pausedAt = 0, pausedTotal = 0, startedClock = null;

  const clock = () => (performance.now() - startedAt - pausedTotal) / 1000;
  const elapsed = () => (recording ? clock() : startedAt ? (pausedAt - startedAt - pausedTotal) / 1000 : 0);
  const hasData = () => Object.values(data).some((tb) => tb.n);

  function add(id, values) {
    if (!recording) return;
    let tb = data[id];
    if (!tb) {
      const Arr = TABLES[id].precise ? Float64Array : Float32Array; // lat/lon need doubles
      tb = data[id] = { t: new Float32Array(1024), c: values.map(() => new Arr(1024)), n: 0 };
      setTimeout(showState); // first data: Export and Clear can be used now
    }
    if (tb.n === tb.t.length) {
      const grow = (a) => { const b = new a.constructor(a.length * 2); b.set(a); return b; };
      tb.t = grow(tb.t);
      tb.c = tb.c.map(grow);
    }
    tb.t[tb.n] = clock();
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      tb.c[i][tb.n] = typeof v === "number" && isFinite(v) ? v : NaN;
    }
    tb.n++;
  }

  // ----------------------------------------------------------- sensors --

  let lastAbsolute = 0;
  function orientation(e, gaveHeading) {
    if (!recording) return;
    const now = performance.now();
    // Android sends each reading twice (absolute and relative): keep the absolute one.
    if (e.absolute || typeof e.webkitCompassHeading === "number") lastAbsolute = now;
    else if (now - lastAbsolute < 1000) return;
    add("tilt", [e.beta, e.gamma, e.alpha]);
    if (gaveHeading) {
      add("heading", [heading, raw.mag, typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : NaN]);
    }
  }

  function motion(e) {
    const a = e.acceleration, g = e.accelerationIncludingGravity, r = e.rotationRate;
    if (a && a.x != null) add("accel", [a.x, a.y, a.z, Math.hypot(a.x, a.y, a.z)]);
    if (g && g.x != null) add("gravity", [g.x, g.y, g.z]);
    if (r && r.alpha != null) add("gyro", [r.beta, r.gamma, r.alpha]);
  }

  let origin = null; // first recorded fix; the track is drawn in metres from it
  function position(pos) {
    if (!recording) return;
    const c = pos.coords;
    if (!origin) origin = { lat: c.latitude, lon: c.longitude };
    const east = (c.longitude - origin.lon) * Math.cos((origin.lat * Math.PI) / 180) * 111320;
    const north = (c.latitude - origin.lat) * 110574;
    add("gps", [c.latitude, c.longitude, east, north, c.altitude, c.speed, c.heading, c.accuracy, c.altitudeAccuracy]);
  }

  function target() {
    const t = targets[0];
    if (t) add("target", [t.d, bearings[0], angles[0] === null ? NaN : wrap180(angles[0])]);
  }

  function extra(kind, v) {
    if (kind === "mag") add("mag", [v.x, v.y, v.z]);
    else add("light", [v]);
  }

  // ------------------------------------------------------------ record --

  function start() {
    if (recording) return;
    const now = performance.now();
    if (!startedAt) { startedAt = now; startedClock = new Date(); } else pausedTotal += now - pausedAt;
    recording = true;
    addEventListener("devicemotion", motion);
    startExtraSensors();
    showState();
  }

  function pause() {
    if (!recording) return;
    recording = false;
    pausedAt = performance.now();
    removeEventListener("devicemotion", motion);
    showState();
  }

  function clear() {
    for (const k of Object.keys(data)) delete data[k];
    origin = null;
    startedAt = pausedTotal = 0;
    if (recording) { startedAt = performance.now(); startedClock = new Date(); }
    showState();
  }

  // ----------------------------------------------------------- graphs --
  // One card per graph. Several cards can share a table (speed, altitude and
  // accuracy all come from GPS fixes).

  const VIEWS = [
    { table: "heading", title: "Heading", unit: "°", range: [0, 360], wrap: true,
      lines: [[0, "True", "blue"], [1, "Magnetic", "orange"], [2, "iOS raw", "purple"]] },
    { table: "tilt", title: "Tilt", unit: "°", lines: [[0, "Front–back β", "red"], [1, "Left–right γ", "green"]] },
    { table: "accel", title: "Acceleration (without gravity)", unit: "m/s²",
      lines: [[0, "x", "red"], [1, "y", "green"], [2, "z", "blue"], [3, "|a|", "gray"]] },
    { table: "gravity", title: "Acceleration with gravity", unit: "m/s²", lines: [[0, "x", "red"], [1, "y", "green"], [2, "z", "blue"]] },
    { table: "gyro", title: "Gyroscope", unit: "°/s", lines: [[0, "β", "red"], [1, "γ", "green"], [2, "α", "blue"]] },
    { table: "gps", title: "Track", unit: "m from start", xy: [2, 3] },
    { table: "gps", title: "Speed", unit: "m/s", min0: true, lines: [[5, "Speed", "blue"]] },
    { table: "gps", title: "Altitude", unit: "m", lines: [[4, "Altitude", "teal"]] },
    { table: "gps", title: "GPS accuracy", unit: "m", min0: true, lines: [[7, "Horizontal", "blue"], [8, "Vertical", "orange"]] },
    { table: "target", title: "Distance to target", unit: "m", min0: true, lines: [[0, "Distance", "orange"]] },
    { table: "target", title: "Arrow angle on screen", unit: "°", range: [-180, 180], wrap: true, lines: [[2, "Arrow", "blue"]] },
    { table: "fps", title: "Frame rate", unit: "fps", min0: true, lines: [[0, "Frame rate", "green"]] },
    { table: "mag", title: "Magnetometer", unit: "µT", optional: true, lines: [[0, "x", "red"], [1, "y", "green"], [2, "z", "blue"]] },
    { table: "light", title: "Ambient light", unit: "lx", optional: true, min0: true, lines: [[0, "Light", "yellow"]] },
  ];

  const sheet = $("tm"), body = $("tm-cards"), openBtn = $("tm-open"), recBtn = $("tm-rec"), clockEl = $("tm-clock");
  let isOpen = false, windowSec = 30, colours = {}, dpr = 1, cards = [];

  function readColours() {
    const css = getComputedStyle(document.documentElement);
    for (const k of ["red", "green", "blue", "orange", "purple", "teal", "gray", "yellow", "separator", "label-2", "label-3"]) {
      colours[k] = css.getPropertyValue(`--${k}`).trim();
    }
  }

  function buildCards() {
    cards = VIEWS.map((view) => {
      const el = document.createElement("article");
      el.className = "tm-card" + (view.xy ? " xy" : "");
      const head = document.createElement("header"), h = document.createElement("h2"), u = document.createElement("span");
      h.textContent = view.title; u.className = "unit"; u.textContent = view.unit;
      head.append(h, u);
      const values = document.createElement("div");
      values.className = "tm-values";
      const canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Graph of ${view.title.toLowerCase()} over time`);
      el.append(head, values, canvas);
      body.append(el);
      return { view, el, values, canvas, ctx: canvas.getContext("2d"), w: 0, h: 0, seen: true, shownValues: "" };
    });
    if (window.IntersectionObserver) {
      const io = new IntersectionObserver((es) => es.forEach((e) => { e.target._card.seen = e.isIntersecting; }), { root: body });
      cards.forEach((c) => { c.el._card = c; io.observe(c.el); });
    }
    if (window.ResizeObserver) new ResizeObserver(sizeCanvases).observe(body);
  }

  function sizeCanvases() {
    dpr = Math.min(devicePixelRatio || 1, 3);
    for (const c of cards) {
      const r = c.canvas.getBoundingClientRect();
      if (!r.width) continue;
      c.w = r.width; c.h = r.height;
      c.canvas.width = Math.round(r.width * dpr);
      c.canvas.height = Math.round(r.height * dpr);
    }
  }

  // "Nice" axis ticks: steps of 1, 2 or 5 x 10^n.
  function ticks(lo, hi, count) {
    const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return { out, step };
  }
  const tickText = (v, step) => (step >= 1 ? String(Math.round(v)) : v.toFixed(Math.min(4, -Math.floor(Math.log10(step)))));
  // seconds on short graphs, minutes:seconds on long ones (the same for every label)
  const timeText = (s, span) => (span > 150 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)} s`);

  // First row at or after time t (rows are in time order).
  function firstAt(tb, t) {
    let lo = 0, hi = tb.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tb.t[m] < t) lo = m + 1; else hi = m; }
    return lo;
  }

  function frameText(ctx, text, x, y, align = "left") {
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }

  function drawTimeSeries(c) {
    const { view, ctx, w: W, h: H } = c, tb = data[view.table];
    const L = 38, R = 6, T = 6, B = 18, pw = W - L - R, ph = H - T - B;
    let t1 = elapsed(), t0;
    if (windowSec) { t0 = Math.max(0, t1 - windowSec); t1 = t0 + windowSec; } else { t0 = 0; t1 = Math.max(t1, 5); }
    const span = t1 - t0, i0 = tb ? firstAt(tb, t0) : 0;
    work += tb ? (tb.n - i0) * (view.lines ? view.lines.length : 1) : 0;

    let lo, hi;
    if (view.range) [lo, hi] = view.range;
    else {
      lo = Infinity; hi = -Infinity;
      if (tb) for (const [ci] of view.lines) {
        const col = tb.c[ci];
        for (let i = i0; i < tb.n; i++) { const y = col[i]; if (y < lo) lo = y; if (y > hi) hi = y; }
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (view.min0) lo = Math.min(lo, 0);
      if (hi - lo < 1e-6) { lo -= 1; hi += 1; } else { const pad = (hi - lo) * 0.08; hi += pad; if (!(view.min0 && lo === 0)) lo -= pad; }
    }
    const X = (t) => L + ((t - t0) / span) * pw, Y = (y) => T + (1 - (y - lo) / (hi - lo)) * ph;

    // grid and labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = colours.separator;
    ctx.fillStyle = colours["label-2"];
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const yt = ticks(lo, hi, 4);
    ctx.beginPath();
    for (const v of yt.out) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(L, y); ctx.lineTo(W - R, y); frameText(ctx, tickText(v, yt.step), L - 5, y, "right"); }
    const xt = ticks(t0, t1, Math.max(2, Math.floor(pw / 70)));
    ctx.textBaseline = "top";
    for (const v of xt.out) {
      const x = Math.round(X(v)) + 0.5, label = timeText(v, span), half = ctx.measureText(label).width / 2;
      ctx.moveTo(x, T); ctx.lineTo(x, T + ph);
      frameText(ctx, label, Math.min(Math.max(x, half + 1), W - half - 1), T + ph + 4, "center");
    }
    ctx.stroke();

    if (!tb || !tb.n) {
      ctx.fillStyle = colours["label-3"];
      ctx.textBaseline = "middle";
      frameText(ctx, recording ? "Waiting for data…" : "No data recorded", L + pw / 2, T + ph / 2, "center");
      return;
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    const jump = view.wrap ? (hi - lo) / 2 : Infinity; // angles: don't draw 359 -> 0 across the graph
    for (const [ci, , colour] of view.lines) {
      const col = tb.c[ci];
      ctx.strokeStyle = colours[colour];
      ctx.beginPath();
      if (tb.n - i0 <= pw * 2) {
        let prev = NaN;
        for (let i = i0; i < tb.n; i++) {
          const y = col[i];
          if (y !== y) { prev = NaN; continue; }
          if (prev !== prev || Math.abs(y - prev) > jump) ctx.moveTo(X(tb.t[i]), Y(y)); else ctx.lineTo(X(tb.t[i]), Y(y));
          prev = y;
        }
      } else {
        // Too many points for the width: draw each pixel column's min-max.
        // Angles that wrap (359 -> 0) inside or between columns aren't joined up.
        let px = -1, mn = 0, mx = 0, first = 0, last = 0, prev = NaN;
        const flush = () => {
          if (px < 0) return;
          const x = px + 0.5, join = Math.abs(first - prev) <= jump; // false at the start (prev is NaN)
          if (mx - mn > jump) { // wraps inside this column
            if (join) ctx.lineTo(x, Y(first)); else ctx.moveTo(x, Y(first));
            ctx.moveTo(x, Y(last));
          } else {
            if (join) ctx.lineTo(x, Y(mn)); else ctx.moveTo(x, Y(mn));
            ctx.lineTo(x, Y(mx));
          }
          prev = last;
        };
        for (let i = i0; i < tb.n; i++) {
          const y = col[i];
          if (y !== y) continue;
          const p = Math.floor(X(tb.t[i]));
          if (p !== px) { flush(); px = p; mn = mx = first = y; } else { if (y < mn) mn = y; if (y > mx) mx = y; }
          last = y;
        }
        flush();
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTrack(c) {
    const { view, ctx, w: W, h: H } = c, tb = data[view.table];
    const P = 22, [cx, cy] = view.xy;
    ctx.fillStyle = colours["label-3"];
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    if (!tb || !tb.n) { frameText(ctx, recording ? "Waiting for a GPS fix…" : "No data recorded", W / 2, H / 2, "center"); return; }
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (let i = 0; i < tb.n; i++) {
      const x = tb.c[cx][i], y = tb.c[cy][i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const size = Math.max(x1 - x0, y1 - y0, 20) * 1.1; // same scale both ways, at least 20 m
    const k = Math.min(W - 2 * P, H - 2 * P) / size, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const X = (x) => W / 2 + (x - mx) * k, Y = (y) => H / 2 - (y - my) * k;

    const g = ticks(mx - (W / 2) / k, mx + (W / 2) / k, 4).step;
    ctx.strokeStyle = colours.separator;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = Math.ceil((mx - W / 2 / k) / g) * g; v <= mx + W / 2 / k; v += g) { const x = Math.round(X(v)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let v = Math.ceil((my - H / 2 / k) / g) * g; v <= my + H / 2 / k; v += g) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.fillStyle = colours["label-2"];
    frameText(ctx, `grid ${g >= 1000 ? `${g / 1000} km` : `${g} m`} · N ↑`, 6, 10);

    ctx.strokeStyle = colours.blue;
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < tb.n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(tb.c[cx][i]), Y(tb.c[cy][i]));
    ctx.stroke();
    const dot = (i, colour) => { ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(X(tb.c[cx][i]), Y(tb.c[cy][i]), 4, 0, 7); ctx.fill(); };
    dot(0, colours.green);
    dot(tb.n - 1, colours.red);
  }

  // Latest value of each line, under the card's title.
  function showValues(c) {
    const tb = data[c.view.table];
    let html = "";
    const fmt = (v) => (v !== v ? "–" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
    if (c.view.xy) {
      if (tb && tb.n) {
        const i = tb.n - 1;
        html = `<span>${tb.c[0][i].toFixed(5)}, ${tb.c[1][i].toFixed(5)}</span>` +
          `<span>from start <b>${fmt(Math.hypot(tb.c[2][i], tb.c[3][i]))} m</b></span>`;
      }
    } else {
      for (const [ci, label, colour] of c.view.lines) {
        let v = NaN;
        if (tb) for (let i = tb.n - 1; i >= Math.max(0, tb.n - 50); i--) if (tb.c[ci][i] === tb.c[ci][i]) { v = tb.c[ci][i]; break; }
        html += `<span><i style="background:${colours[colour]}"></i>${label} <b>${fmt(v)}</b></span>`;
      }
    }
    if (html !== c.shownValues) { c.shownValues = html; c.values.innerHTML = html; }
  }

  // ~30 redraws a second normally. A long recording shown whole is tens of
  // thousands of points that barely move between frames, so it's redrawn less
  // often (down to 4 a second) to keep the phone cool.
  let lastDraw = 0, lastValues = 0, work = 0, drawEvery = 33;
  function draw(now) {
    if (now - lastDraw < drawEvery) return;
    lastDraw = now;
    work = 0;
    const values = now - lastValues > 100;
    if (values) lastValues = now;
    for (const c of cards) {
      const tb = data[c.view.table];
      const hide = !!c.view.optional && !(tb && tb.n);
      if (c.el.hidden !== hide) { c.el.hidden = hide; if (!hide) sizeCanvases(); }
      if (hide || !c.seen || !c.w) continue;
      c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.ctx.clearRect(0, 0, c.w, c.h);
      if (c.view.xy) drawTrack(c); else drawTimeSeries(c);
      if (values) showValues(c);
    }
    drawEvery = Math.min(250, Math.max(33, work / 600));
    const s = elapsed();
    const text = `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
    if (clockEl.textContent !== text) clockEl.textContent = text;
  }

  // Frame rate (every quarter second) and the hour limit, from the app's frame loop.
  let fpsFrames = 0, fpsSince = 0;
  function frame(now) {
    fpsFrames++;
    if (!fpsSince) fpsSince = now;
    else if (now - fpsSince >= 250) {
      add("fps", [(fpsFrames * 1000) / (now - fpsSince)]);
      fpsFrames = 0; fpsSince = now;
    }
    if (recording && clock() > MAX_SECONDS) pause();
    if (isOpen) draw(now);
  }

  function showState() {
    openBtn.classList.toggle("recording", recording);
    recBtn.classList.toggle("on", recording);
    recBtn.setAttribute("aria-label", recording ? "Pause recording" : "Record");
    $("tm-export").disabled = !hasData();
    $("tm-clear").disabled = !hasData() && !recording;
  }

  // ------------------------------------------------------------ export --
  // A .zip of CSV files (one per sensor, plus a note about the recording),
  // like phyphox. Written by hand: "stored" zip entries are simple.

  const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder(), parts = [], dir = [];
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const [name, text] of files) {
      const nb = enc.encode(name), bytes = enc.encode(text), crc = crc32(bytes);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true); lh.setUint32(22, bytes.length, true); lh.setUint16(26, nb.length, true);
      parts.push(lh, nb, bytes);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, bytes.length, true); ch.setUint32(24, bytes.length, true); ch.setUint16(28, nb.length, true);
      ch.setUint32(42, offset, true);
      dir.push(ch, nb);
      offset += 30 + nb.length + bytes.length;
    }
    const size = dir.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...dir, end], { type: "application/zip" });
  }

  function csv(id) {
    const tb = data[id], spec = TABLES[id], digits = spec.precise ? 10 : 7;
    const rows = [["Time (s)", ...spec.cols].map((h) => `"${h}"`).join(",")];
    for (let i = 0; i < tb.n; i++) {
      let row = tb.t[i].toFixed(3);
      for (const col of tb.c) { const v = col[i]; row += v === v ? "," + +v.toPrecision(digits) : ","; }
      rows.push(row);
    }
    return "﻿" + rows.join("\n") + "\n"; // BOM so Excel reads it as UTF-8
  }

  async function exportZip() {
    if (!hasData()) return;
    const files = Object.keys(TABLES).filter((id) => data[id] && data[id].n).map((id) => [`${TABLES[id].name}.csv`, csv(id)]);
    const stamp = (startedClock || new Date()).toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
    files.push(["Recording.txt", [
      "Bottlo Compass telemetry",
      `Started: ${(startedClock || new Date()).toString()}`,
      `Length: ${elapsed().toFixed(1)} s (paused time left out)`,
      "Time (s) in each CSV counts from the start of the recording.",
      `Screen: ${screen.width} x ${screen.height} @${devicePixelRatio}x`,
      `Browser: ${navigator.userAgent}`,
      "",
    ].join("\n")]);
    const name = `bottlo-telemetry-${stamp}.zip`;
    const file = new File([zip(files)], name, { type: "application/zip" });
    // The iOS share sheet (AirDrop, Files, Mail...) where there is one; otherwise a download.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Bottlo telemetry" }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const url = URL.createObjectURL(file), a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // -------------------------------------------------------------- sheet --

  function openSheet() {
    // iOS only gives motion data after a tap + permission; this tap counts.
    try { DeviceMotionEvent.requestPermission().catch(() => {}); } catch {}
    if (!cards.length) buildCards();
    readColours();
    if (!recording && !hasData()) start(); // a fresh recording starts straight away
    sheet.hidden = false;
    isOpen = true;
    tm.covering = true;
    sizeCanvases();
    requestAnimationFrame(() => sheet.classList.add("open"));
    $("tm-done").focus({ preventScroll: true });
  }

  function closeSheet() {
    sheet.classList.remove("open");
    tm.covering = false;
    const done = () => { if (!sheet.classList.contains("open")) { sheet.hidden = true; isOpen = false; } };
    if (reduceMotion.matches) setTimeout(done, 250); else sheet.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 700); // in case transitionend doesn't fire
    openBtn.focus({ preventScroll: true });
  }

  openBtn.addEventListener("click", openSheet);
  $("tm-done").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen) closeSheet(); });
  recBtn.addEventListener("click", () => (recording ? pause() : start()));
  $("tm-clear").addEventListener("click", () => {
    if (hasData() && !confirm("Clear the recording?")) return;
    clear();
  });
  $("tm-export").addEventListener("click", exportZip);
  const windowBtns = document.querySelectorAll("#tm-window button");
  windowBtns.forEach((b) => b.addEventListener("click", () => {
    windowSec = +b.dataset.s;
    windowBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  for (const q of ["(prefers-color-scheme: dark)", "(prefers-contrast: more)"]) {
    const mq = matchMedia(q);
    if (mq.addEventListener) mq.addEventListener("change", readColours); else mq.addListener(readColours);
  }

  tm = { orientation, position, target, extra, frame, covering: false };
  showState();
})();
