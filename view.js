/*
 * Draws the store and wires up the controls. All the rules live in sim.js.
 *
 * The engine only knows who is in which line; this file decides where everyone stands and
 * walks them there. Walking is just for looks: it doesn't cost store time.
 */
(function () {
  'use strict';

  var Sim = window.CheckoutSim;
  var C = Sim.CONFIG;
  var NREG = C.maxRegisters;
  var NLANES = NREG + 1;                       // regular registers + express
  var GAME_RATE = (C.close - C.open) / C.dayRealSeconds;   // store seconds per real second at 1x
  var PALETTE = ['#e8604c', '#ffc93c', '#5aa9e6', '#7cc576', '#c084fc', '#f59e0b'];
  var COL = {
    grid: '#eef0ea', shelf: '#d6e3d3', shelfEdge: '#c0cfbc', edge: '#9aa597',
    belt1: '#9aa597', belt2: '#c3cbc0', off: '#e3e7e0', bag: '#eef1ec', tan: '#d8c7a8',
    ink: '#14201a', lampOn: '#ffc93c', lampOff: '#4c5a52', shopper: '#e8604c', gone: '#9aa39d',
    staff: '#0f6b36', rope: '#b9c3b5', cart: '#6b766f', label: '#3d4741', green: '#0f6b36',
    warn: '#c2410c', screen: '#5aa9e6', exitBg: '#dfe5dc', muted: '#56615a', floor: '#fbfbf7'
  };

  // ---------- settings (remembered on this device) ----------
  function load(key, fallback) {
    try {
      var v = localStorage.getItem('checkout.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem('checkout.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  var sim = Sim.create({
    seed: (Date.now() % 2147483647) || 1,
    registers: load('registers', 4),
    express: load('express', true),
    self: load('self', true),
    lineStyle: load('lineStyle', 'own'),
    busyness: load('busyness', 1)
  });
  var speed = load('speed', 1);
  var paused = false;

  // ---------- canvas + layout ----------
  var floorEl = document.getElementById('floor');
  var canvas = document.getElementById('store');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, L = null;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function layout(w, h) {
    var phone = w < 560;
    var pad = phone ? 6 : 20;
    var exitH = phone ? 26 : 34;
    var selfUnits = 1.45;
    var U = (w - 2 * pad) / (NLANES + selfUnits);
    var r = clamp(U * 0.08, 4.5, 8);
    var bottom = h - exitH - (phone ? 10 : 14);
    var bagH = clamp(U * 0.42, 24, 48);
    var regH = clamp(U * 0.3, 18, 34);
    var regTop = bottom - bagH - regH;
    var beltLen = clamp(h * 0.17, 46, 116);
    var cw = clamp(U * 0.27, 13, 34);
    var lampH = phone ? 15 : 22;
    // Keep room for about a dozen people in line above the counters; the aisles get the rest,
    // so tall screens don't end up with an empty middle.
    var queueRoom = 12 * (r * 3.8 + 5);
    var counterStack = beltLen + regH + bagH + lampH + 50 + exitH;
    var aisleH = Math.round(clamp(h - counterStack - queueRoom, h * 0.2, h * 0.42));
    var lanes = [];
    for (var i = 0; i < NLANES; i++) {
      var x0 = pad + i * U;
      var bl = i === NREG ? beltLen * 0.7 : beltLen;
      var cx = x0 + U * 0.44;
      var beltTop = regTop - bl;
      lanes.push({
        x0: x0, cx: cx, cw: cw, qx: x0 + U * 0.2,
        beltTop: beltTop, beltLen: bl, regTop: regTop, bagTop: regTop + regH, bottom: bottom,
        lampY: beltTop - lampH - (phone ? 6 : 8), lampH: lampH,
        staffX: cx + cw + U * 0.15, staffY: regTop + regH / 2,
        serveY: regTop + regH / 2, firstQ: beltTop + bl * 0.45
      });
    }
    // Self-checkout pod: four kiosks in a square, the attendant in the middle, one line above.
    var sx0 = pad + NLANES * U, sw = selfUnits * U;
    var ks = clamp(U * 0.36, 20, 42);
    var colL = sx0 + sw * 0.06, colR = sx0 + sw * 0.94 - ks;
    var rowB = bottom - ks, rowA = rowB - ks - (phone ? 10 : 16);
    var kiosks = [[colL, rowA, 'L'], [colR, rowA, 'R'], [colL, rowB, 'L'], [colR, rowB, 'R']].map(function (k) {
      return { x: k[0], y: k[1], spotX: k[2] === 'L' ? k[0] + ks + r + 3 : k[0] - r - 3, spotY: k[1] + ks / 2 };
    });
    // Aisles: tall shelves with walking corridors between them.
    var shelfW = phone ? 16 : 28;
    var nShelves = Math.max(4, Math.floor((w - 2 * pad) / (phone ? 58 : 104)));
    var spacing = (w - 2 * pad) / nShelves;
    var shelfTop = phone ? 20 : 30, shelfBottom = aisleH - (phone ? 18 : 24);
    var shelves = [], corridors = [];
    for (var s = 0; s < nShelves; s++) shelves.push(pad + spacing * (s + 0.5) - shelfW / 2);
    for (var c = 0; c <= nShelves; c++) corridors.push(clamp(pad + spacing * c, pad + r + 3, w - pad - r - 3));
    var snTop = aisleH + r + 10;
    // Leave room under the snake for its "Next" sign and the lane labels (stacked on narrow lanes).
    var minLamp = Math.min.apply(null, lanes.slice(0, NREG).map(function (l) { return l.lampY; }));
    var snBottom = minLamp - (U < 104 ? (phone ? 32 : 40) : 28);
    return {
      phone: phone, pad: pad, U: U, r: r, exitH: exitH, aisleH: aisleH, bottom: bottom,
      lanes: lanes, kiosks: kiosks, ks: ks, sx0: sx0, sw: sw,
      attX: sx0 + sw / 2, attY: rowA + ks + (phone ? 5 : 8),
      selfQX: sx0 + sw / 2, selfFirst: rowA - (phone ? 12 : 16) - r,
      shelves: shelves, shelfW: shelfW, shelfTop: shelfTop, shelfBottom: shelfBottom, corridors: corridors,
      crossTop: Math.max(r + 3, shelfTop - (phone ? 9 : 13)), crossBottom: shelfBottom + (aisleH - shelfBottom) / 2,
      walkwayY: aisleH + r + 4,
      snTop: snTop, snBottom: snBottom, snLeft: pad + 6, snRight: pad + NREG * U - 6,
      exitY: h - exitH / 2, font: phone ? 10 : 12
    };
  }

  function resize() {
    var rect = floorEl.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    W = Math.max(200, rect.width);
    H = Math.max(240, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L = layout(W, H);
    sprites.forEach(function (s) { s.wp = []; });   // old routes point at the old layout
  }

  // ---------- where people stand ----------
  function cartH() { return L.r * 1.8; }
  function queueSpacing() { return L.r * 2 + cartH() + 5; }

  function columnSlot(x, firstY, k, n) {
    var sp = queueSpacing(), minY = L.r + 8;
    if (n > 1 && firstY - (n - 1) * sp < minY) sp = (firstY - minY) / (n - 1);
    return { x: x, y: firstY - k * sp };
  }

  function snakeGeometry(n) {
    var hs = L.r * 2 + L.r * 2 + 8, rowH = L.r * 2 + (L.phone ? 8 : 12);
    var perRow = Math.max(2, Math.floor((L.snRight - L.snLeft) / hs));
    var rowsAvail = Math.max(1, Math.floor((L.snBottom - L.snTop) / rowH));
    return { hs: hs, rowH: rowH, perRow: perRow, rowsAvail: rowsAvail,
      rowsUsed: clamp(Math.ceil(n / perRow), 2, rowsAvail) };
  }
  // Slot 0 is the front: the right end of the bottom row. The line zigzags back and up.
  function snakeSlot(k, g) {
    var row = Math.floor(k / g.perRow), j = k % g.perRow;
    var y = L.snBottom - g.rowH / 2 - row * g.rowH;
    var x = row % 2 === 0 ? L.snRight - g.hs / 2 - j * g.hs : L.snLeft + g.hs / 2 + j * g.hs;
    return { x: x, y: Math.max(L.r + 6, y) };
  }

  function targetFor(p) {
    if (p.phase === 'queue') {
      if (p.line === 'shared') {
        var q = sim.sharedQueue;
        return snakeSlot(q.indexOf(p), snakeGeometry(q.length));
      }
      if (p.line === 'self') return columnSlot(L.selfQX, L.selfFirst, sim.selfQueue.indexOf(p), sim.selfQueue.length);
      var lane = sim.lanes[p.line], g = L.lanes[p.line];
      return columnSlot(g.qx, g.firstQ, lane.queue.indexOf(p), lane.queue.length);
    }
    if (p.phase === 'walking' || p.phase === 'service') {
      if (p.atKiosk) { var k = L.kiosks[p.server.idx]; return { x: k.spotX, y: k.spotY }; }
      var gl = L.lanes[p.server.idx];
      return { x: gl.qx, y: gl.serveY };
    }
    return null;
  }

  // ---------- sprites: the dots on screen ----------
  var sprites = new Map();

  function pickWander(s) {
    var cs = L.corridors;
    var c = Math.floor(Math.random() * cs.length);
    var y = L.shelfTop + Math.random() * (L.shelfBottom - L.shelfTop);
    if (c !== s.corr) {
      var crossY = Math.random() < 0.5 ? L.crossTop : L.crossBottom;
      s.wp.push({ x: s.x, y: crossY }, { x: cs[c], y: crossY });
    }
    s.wp.push({ x: cs[c], y: y });
    s.corr = c;
    s.pause = 0.3 + Math.random() * 1.4;
  }

  function newSprite(p) {
    var s = { id: p.id, p: p, x: -14, y: L.crossBottom, wp: [], corr: -1, pause: 0, key: 'shop',
      alpha: 1, leaving: null, jit: (p.look % 5) - 2 };
    sprites.set(p.id, s);
    // Someone we haven't drawn yet who is already in a line (after a resize or a jump in time)
    // appears in place rather than walking in from the door.
    var t = targetFor(p);
    if (t) { s.x = t.x; s.y = t.y; s.key = keyOf(p); return s; }
    if (sim.t - p.enterT > 60) {
      var c = p.look % L.corridors.length;
      s.x = L.corridors[c]; s.y = L.shelfTop + (p.look % 97) / 97 * (L.shelfBottom - L.shelfTop); s.corr = c;
      return s;
    }
    s.wp.push({ x: L.corridors[0], y: L.crossBottom });
    return s;
  }

  function keyOf(p) {
    if (p.phase === 'queue') return 'q:' + p.line;
    if (p.phase === 'walking' || p.phase === 'service') return 'srv';
    return 'shop';
  }

  function moveToward(s, tx, ty, dist) {
    var dx = tx - s.x, dy = ty - s.y, d = Math.hypot(dx, dy);
    if (d <= dist) { s.x = tx; s.y = ty; return true; }
    s.x += dx / d * dist; s.y += dy / d * dist;
    return false;
  }

  function updateSprites(dtReal) {
    var walkouts = {};
    sim.events.forEach(function (e) {
      if (e.type === 'walkout') walkouts[e.id] = true;
      if (e.type === 'newDay') newDayToast(e);
    });
    sim.events.length = 0;

    var live = {};
    sim.shoppers.forEach(function (p) {
      live[p.id] = true;
      var s = sprites.get(p.id) || newSprite(p);
      s.p = p;
      var key = keyOf(p);
      if (key !== s.key) {
        s.wp = [];
        if (s.key === 'shop') s.wp.push({ x: s.x, y: L.crossBottom });   // out of the aisle first
        s.key = key;
      }
    });
    sprites.forEach(function (s) {
      if (live[s.id] || s.leaving) return;
      s.wp = [];
      if (walkouts[s.id]) {
        s.leaving = 'walkout';
        s.wp.push({ x: s.x, y: L.walkwayY }, { x: -16, y: L.walkwayY });
      } else {
        s.leaving = 'served';
        s.wp.push({ x: s.x, y: L.exitY });
      }
    });

    var mult = speed === 1 ? 1 : speed === 2 ? 1.6 : 2.4;
    var step = (L.phone ? 85 : 130) * mult * dtReal;
    sprites.forEach(function (s) {
      if (s.wp.length) {
        if (moveToward(s, s.wp[0].x, s.wp[0].y, step * (s.key === 'shop' && !s.leaving ? 0.7 : 2))) s.wp.shift();
      } else if (s.leaving) {
        s.alpha -= dtReal * 2.5 * mult;
        if (s.alpha <= 0) sprites.delete(s.id);
      } else if (s.key === 'shop') {
        s.pause -= dtReal * mult;
        if (s.pause <= 0) pickWander(s);
      } else {
        var t = targetFor(s.p);
        if (t) moveToward(s, t.x + (s.key === 'q:shared' ? 0 : s.jit), t.y, step * 2.4);
      }
    });
  }

  // ---------- drawing ----------
  function rect(x, y, w, h, fill, stroke) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
  }
  function rrect(x, y, w, h, rad, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, rad) : ctx.rect(x, y, w, h);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function dashed(x1, y1, x2, y2, color, width, dash) {
    ctx.save();
    ctx.setLineDash(dash || [6, 5]);
    ctx.strokeStyle = color; ctx.lineWidth = width || 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.restore();
  }
  function text(str, x, y, opts) {
    opts = opts || {};
    ctx.font = (opts.weight || 700) + ' ' + (opts.size || L.font) + 'px Archivo, system-ui, sans-serif';
    ctx.fillStyle = opts.color || COL.label;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.base || 'middle';
    if (opts.bg) {
      var m = ctx.measureText(str).width, px = opts.align === 'center' ? x - m / 2 : opts.align === 'right' ? x - m : x;
      rrect(px - 3, y - (opts.size || L.font) / 2 - 3, m + 6, (opts.size || L.font) + 6, 4, opts.bg);
      ctx.fillStyle = opts.color || COL.label;
    }
    ctx.fillText(str, x, y);
  }
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function drawFloor() {
    ctx.fillStyle = COL.floor;
    ctx.fillRect(0, 0, W, H);
    var g = L.phone ? 22 : 28;
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = g; x < W; x += g) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (var y = g; y < H; y += g) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
    L.shelves.forEach(function (x) {
      rrect(x, L.shelfTop, L.shelfW, L.shelfBottom - L.shelfTop, 5, COL.shelf, COL.shelfEdge);
    });
    text('AISLES', L.pad + 4, L.phone ? 10 : 15, { size: L.phone ? 9 : 11, weight: 600, color: COL.muted });
    dashed(L.pad, L.aisleH, W - L.pad, L.aisleH, '#cdd4c9', 2);
    // Exit strip with a small key.
    rect(0, H - L.exitH, W, L.exitH, COL.exitBg);
    var ey = H - L.exitH / 2;
    if (L.phone) {
      text('EXIT', W / 2, ey, { size: 10, weight: 600, color: COL.muted, align: 'center' });
    } else {
      dot(W / 2 - 128, ey, 5, COL.shopper, 1);
      text('SHOPPER', W / 2 - 118, ey, { size: 11, weight: 600, color: COL.muted });
      dot(W / 2 - 38, ey, 5, COL.staff, 1);
      text('STAFF', W / 2 - 28, ey, { size: 11, weight: 600, color: COL.muted });
      text('EXIT ↓', W / 2 + 40, ey, { size: 11, weight: 600, color: COL.muted });
    }
  }

  function dot(x, y, r, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(x, y + 1, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.globalAlpha = 1;
  }

  function laneLabel(lane, key) {
    var shared = sim.settings.lineStyle === 'shared';
    if (lane.active) return shared && lane.kind === 'reg' ? '' : fmt(Sim.lineWait(sim, key));
    return Sim.staffed(lane) ? 'Closing' : 'Closed';
  }

  function drawLanes() {
    var shared = sim.settings.lineStyle === 'shared';
    sim.lanes.forEach(function (lane, i) {
      var g = L.lanes[i], on = Sim.staffed(lane), p = lane.current;
      // Belt, register, bagging.
      if (on) {
        ctx.save();
        rrect(g.cx, g.beltTop, g.cw, g.beltLen, [5, 5, 0, 0], COL.belt2, COL.edge);
        ctx.clip();
        ctx.fillStyle = COL.belt1;
        for (var y = g.beltTop; y < g.regTop; y += L.phone ? 6 : 9) ctx.fillRect(g.cx, y, g.cw, L.phone ? 2 : 3);
        ctx.restore();
      } else {
        rrect(g.cx, g.beltTop, g.cw, g.beltLen, [5, 5, 0, 0], COL.off, COL.edge);
      }
      rect(g.cx, g.regTop, g.cw, g.bagTop - g.regTop, on ? '#ffffff' : COL.off, COL.edge);
      rrect(g.cx + g.cw * 0.18, g.regTop + 4, g.cw * 0.64, (g.bagTop - g.regTop) * 0.4, 2, on ? COL.screen : COL.belt2);
      rrect(g.cx, g.bagTop, g.cw, g.bottom - g.bagTop, [0, 0, 5, 5], COL.bag, COL.edge);

      // Groceries still on the belt, and bags filling up.
      if (p) {
        var sz = L.phone ? 5 : 8, gap = L.phone ? 2 : 3;
        var done = Sim.scanned(p), left = p.items - done;
        var rows = Math.max(1, Math.floor((g.beltLen - 6) / (sz + gap)));
        var show = Math.min(left, rows * 2);
        for (var k = 0; k < show; k++) {
          var col = k % 2, row = Math.floor(k / 2);
          rect(g.cx + g.cw / 2 - sz - 1 + col * (sz + 2), g.regTop - 3 - sz - row * (sz + gap), sz, sz, PALETTE[(p.look + k) % 6]);
        }
        var bags = Math.min(4, Math.ceil(done / 10));
        for (var b = 0; b < bags; b++) {
          var bw = L.phone ? 6 : 11, bh = L.phone ? 7 : 13;
          rrect(g.cx + 3 + (b % 2) * (bw + 2), g.bagTop + 4 + Math.floor(b / 2) * (bh + 2), bw, bh, 2, COL.tan);
        }
      }

      // Cashier in their stall.
      if (on) {
        if (!L.phone) {
          ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = COL.belt2; ctx.lineWidth = 1;
          ctx.strokeRect(g.cx + g.cw + 0.5, g.regTop - 10.5, L.U * 0.28, g.bagTop - g.regTop + 20);
          ctx.restore();
        }
        dot(g.staffX, g.staffY, L.r, COL.staff, 1);
      }

      // Lane light with its number, and the wait above it.
      var lampW = g.cw + (L.phone ? 6 : 0);
      rrect(g.cx + g.cw / 2 - lampW / 2, g.lampY, lampW, g.lampH, 4, COL.ink);
      text(String(i + 1), g.cx + g.cw / 2, g.lampY + g.lampH / 2 + 0.5,
        { size: L.phone ? 10 : 14, weight: 900, color: lane.active ? COL.lampOn : on ? '#c98a2c' : COL.lampOff, align: 'center' });
      var label = laneLabel(lane, i);
      // Wide lanes put the wait beside the light; narrow ones stack it above.
      var above = L.U < 104;
      if (label) {
        if (above) text(label, g.x0 + L.U / 2, g.lampY - (L.phone ? 8 : 10), { size: L.phone ? 10 : 12, align: 'center', color: lane.active ? COL.label : COL.warn });
        else text(label, g.cx + g.cw + 5, g.lampY + g.lampH / 2, { size: 12, color: lane.active ? COL.label : COL.warn });
      }
      if (lane.kind === 'express') {
        text(L.U < 80 ? 'EXPRESS' : '15 items or fewer', g.x0 + L.U / 2, g.lampY - (above ? (L.phone ? 20 : 25) : 12),
          { size: L.phone ? 8 : 10, color: COL.green, align: 'center' });
      }
      // Chain across a closed lane.
      if (!lane.active && !(shared && lane.kind === 'reg' && on)) {
        dashed(g.x0 + 3, g.beltTop + 6, g.cx, g.beltTop + 6, COL.warn, L.phone ? 2 : 3, [4, 3]);
      }
    });
  }

  function drawSnake() {
    var shared = sim.settings.lineStyle === 'shared';
    if (!shared) return;
    var g = snakeGeometry(sim.sharedQueue.length);
    var top = L.snBottom - g.rowsUsed * g.rowH;
    ctx.save();
    ctx.setLineDash([6, 5]); ctx.strokeStyle = COL.rope; ctx.lineWidth = L.phone ? 1.5 : 2;
    ctx.strokeRect(L.snLeft, top, L.snRight - L.snLeft, g.rowsUsed * g.rowH);
    for (var b = 1; b < g.rowsUsed; b++) {
      var y = L.snBottom - b * g.rowH;
      ctx.beginPath();
      if (b % 2 === 1) { ctx.moveTo(L.snLeft + g.hs * 0.9, y); ctx.lineTo(L.snRight, y); }
      else { ctx.moveTo(L.snLeft, y); ctx.lineTo(L.snRight - g.hs * 0.9, y); }
      ctx.stroke();
    }
    ctx.restore();
    text((L.phone ? 'One line · ' : 'One line · go to the next free register · about ') + fmt(Sim.lineWait(sim, 'shared')),
      L.snLeft, top - (L.phone ? 8 : 11), { size: L.phone ? 10 : 11, color: COL.green, bg: COL.floor });
    var front = snakeSlot(0, g);
    text('Next ▸', front.x, L.snBottom + (L.phone ? 8 : 11), { size: L.phone ? 9 : 11, color: COL.green, align: 'center' });
  }

  function drawSelf() {
    var on = Sim.selfStaffed(sim);
    var helping = null;
    sim.kiosks.forEach(function (k, i) {
      var g = L.kiosks[i];
      rrect(g.x, g.y, L.ks, L.ks, 6, on ? '#ffffff' : COL.off, COL.edge);
      rrect(g.x + L.ks * 0.22, g.y + L.ks * 0.14, L.ks * 0.56, L.ks * 0.32, 2, on ? COL.screen : COL.belt2);
      rrect(g.x + L.ks * 0.1, g.y + L.ks * 0.58, L.ks * 0.8, L.ks * 0.3, 2, COL.bag);
      var p = k.current;
      if (p && p.pausedUntil > sim.t) helping = g;
      if (p && p.phase === 'service') {
        var done = Sim.scanned(p);
        for (var b = 0; b < Math.min(3, Math.ceil(done / 8)); b++) {
          rect(g.x + L.ks * 0.14 + b * (L.ks * 0.25), g.y + L.ks * 0.62, L.ks * 0.2, L.ks * 0.22, COL.tan);
        }
      }
    });
    if (on) {
      var ax = helping ? (helping.x < L.attX ? helping.x + L.ks + L.r * 3.4 : helping.x - L.r * 3.4) : L.attX;
      var ay = helping ? helping.y + L.ks * 0.2 : L.attY;
      dot(ax, ay, L.r, COL.staff, 1);
    }
    // The roped line above the kiosks.
    var sp = queueSpacing(), w = L.r * 2 + 12;
    ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = COL.rope; ctx.lineWidth = L.phone ? 1.5 : 2;
    ctx.beginPath();
    ctx.moveTo(L.selfQX - w / 2, L.selfFirst + sp * 0.55); ctx.lineTo(L.selfQX - w / 2, L.selfFirst - sp * 3.4);
    ctx.moveTo(L.selfQX + w / 2, L.selfFirst + sp * 0.55); ctx.lineTo(L.selfQX + w / 2, L.selfFirst - sp * 3.4);
    ctx.stroke(); ctx.restore();
    if (!sim.selfActive) dashed(L.selfQX - w / 2, L.selfFirst - sp * 3.4, L.selfQX + w / 2, L.selfFirst - sp * 3.4, COL.warn, 3, [4, 3]);
    var label = sim.selfActive ? fmt(Sim.lineWait(sim, 'self')) : on ? 'Closing' : 'Closed';
    text(label, L.selfQX, L.selfFirst - sp * 3.4 - (L.phone ? 8 : 11),
      { size: L.phone ? 10 : 12, align: 'center', color: sim.selfActive ? COL.label : COL.warn, bg: COL.floor });
    text(L.phone ? 'SELF' : 'Self-checkout', L.sx0 + L.sw / 2, L.bottom + (L.phone ? 6 : 8),
      { size: L.phone ? 8 : 10, color: COL.green, align: 'center' });
  }

  function drawPeople() {
    var r = L.r, ch = cartH();
    sprites.forEach(function (s) {
      var p = s.p, a = Math.max(0, s.alpha);
      var inLine = !s.leaving && (s.key !== 'shop');
      var basket = p.items <= C.expressLimit;
      if (s.leaving === 'served') {
        ctx.globalAlpha = a;
        if (!basket) { rrect(s.x - r, s.y + r + 2, r * 2, ch, 2, COL.tan, COL.cart); }
        else rrect(s.x + r + 2, s.y - r * 0.4, r * 1.3, r * 1.2, 2, COL.tan, COL.cart);
        ctx.globalAlpha = 1;
      } else if (inLine) {
        var fill = p.items / 90;
        if (p.phase === 'service' && !p.atKiosk) fill *= 1 - Sim.scanned(p) / p.items;
        var color = PALETTE[(p.look + 2) % 6];
        if (basket) {
          var bw = r * 1.4, bh = r * 1.3;
          drawContainer(s.x + r + 2, s.y - bh / 2, bw, bh, Math.min(1, fill * 5), color);
        } else if (s.key === 'q:shared') {
          drawContainer(s.x + r + 2, s.y - r * 0.9, r * 2, r * 1.8, fill, color);
        } else {
          drawContainer(s.x - r, s.y + r + 2, r * 2, ch, fill, color);
        }
      }
      dot(s.x, s.y, r, s.leaving === 'walkout' ? COL.gone : COL.shopper, a);
    });
  }

  function drawContainer(x, y, w, h, fill, color) {
    rrect(x, y, w, h, 2, '#ffffff');
    if (fill > 0.02) {
      var fh = Math.max(1, (h - 2) * Math.min(1, fill));
      rect(x + 1, y + h - 1 - fh, w - 2, fh, color);
    }
    rrect(x, y, w, h, 2, null, COL.cart);
  }

  function draw() {
    if (!L) return;
    drawFloor();
    drawSnake();
    drawLanes();
    drawSelf();
    drawPeople();
  }

  // ---------- scoreboard ----------
  var el = function (id) { return document.getElementById(id); };
  var chartEl = el('chart');
  var bars = C.arrivals.slice(0, -1).map(function () {
    var b = document.createElement('span');
    chartEl.appendChild(b);
    return b;
  });

  function clockParts(t) {
    var mins = Math.floor(t / 60), h = Math.floor(mins / 60) % 24, m = mins % 60;
    var ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
    return { time: h12 + ':' + (m < 10 ? '0' : '') + m, ap: ap, h: h };
  }
  function period(h) {
    if (sim.t >= C.close) return 'Closing up';
    if (h < 11) return 'Morning';
    if (h < 14) return 'Lunch';
    if (h < 16) return 'Afternoon';
    if (h < 19) return 'After-work rush';
    return 'Evening';
  }

  function updateBoard() {
    var st = sim.stats, c = clockParts(sim.t);
    el('clock').innerHTML = c.time + ' <span>' + c.ap + '</span>';
    el('sub').textContent = 'Day ' + sim.day + ' · ' + period(c.h);
    var avg = fmt(Sim.avgWaitLastHour(sim));
    var mood = Math.round(st.moodN ? st.moodSum / st.moodN : 100) + '%';
    var cost = Sim.costPerHour(sim);
    el('sAvg').textContent = avg; el('bAvg').textContent = avg;
    el('sWorst').textContent = fmt(st.worst);
    el('sCost').textContent = '$' + cost + '/hr'; el('bCost').textContent = '$' + cost + '/h';
    el('sMood').textContent = mood; el('bMood').textContent = mood;
    el('sWalk').textContent = st.walkouts;
    el('sIn').textContent = sim.shoppers.length;
    var top = 300;
    st.hourly.forEach(function (x) { if (x.n) top = Math.max(top, x.sum / x.n); });
    var nowH = Math.floor((sim.t - C.open) / 3600);
    bars.forEach(function (b, i) {
      var x = st.hourly[i], v = x && x.n ? x.sum / x.n : 0;
      b.style.height = Math.max(2, v / top * 60) + 'px';
      b.className = i === nowH ? 'now' : '';
    });
  }

  var toastEl = el('toast'), toastTimer = 0;
  function newDayToast(e) {
    var d = e.last;
    toastEl.textContent = 'Day ' + e.day + ' · yesterday: ' + d.served.toLocaleString() + ' served, avg wait ' +
      fmt(d.avgWait) + ', ' + d.walkouts + ' walkouts';
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 5000);
  }

  // ---------- controls ----------
  function syncControls() {
    var s = sim.settings;
    document.querySelectorAll('[data-line]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.line === s.lineStyle);
      b.setAttribute('aria-pressed', b.dataset.line === s.lineStyle);
    });
    document.querySelectorAll('[data-busy]').forEach(function (b) {
      var on = Number(b.dataset.busy) === s.busyness;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    });
    document.querySelectorAll('[data-speed]').forEach(function (b) {
      var on = Number(b.dataset.speed) === speed;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    });
    el('speedCycle').textContent = speed + '×';
    el('regCount').textContent = s.registers;
    el('regMinus').disabled = s.registers <= 1;
    el('regPlus').disabled = s.registers >= NREG;
    el('express').checked = s.express;
    el('self').checked = s.self;
    el('pause').textContent = paused ? 'Play' : 'Pause';
    el('pauseBar').setAttribute('aria-label', paused ? 'Play' : 'Pause');
    el('pauseBar').innerHTML = paused
      ? '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor"/></svg>';
  }

  function setting(key, value) {
    Sim.set(sim, key, value);
    save(key, value);
    syncControls();
  }
  function setSpeed(v) { speed = v; save('speed', v); syncControls(); }
  function togglePause() { paused = !paused; syncControls(); }

  document.querySelectorAll('[data-line]').forEach(function (b) {
    b.addEventListener('click', function () { setting('lineStyle', b.dataset.line); });
  });
  document.querySelectorAll('[data-busy]').forEach(function (b) {
    b.addEventListener('click', function () { setting('busyness', Number(b.dataset.busy)); });
  });
  document.querySelectorAll('[data-speed]').forEach(function (b) {
    b.addEventListener('click', function () { setSpeed(Number(b.dataset.speed)); });
  });
  el('speedCycle').addEventListener('click', function () { setSpeed(speed === 1 ? 2 : speed === 2 ? 4 : 1); });
  el('regMinus').addEventListener('click', function () { setting('registers', Math.max(1, sim.settings.registers - 1)); });
  el('regPlus').addEventListener('click', function () { setting('registers', Math.min(NREG, sim.settings.registers + 1)); });
  el('express').addEventListener('change', function (e) { setting('express', e.target.checked); });
  el('self').addEventListener('change', function (e) { setting('self', e.target.checked); });
  el('pause').addEventListener('click', togglePause);
  el('pauseBar').addEventListener('click', togglePause);

  var panel = el('panel'), scrim = el('scrim'), openBtn = el('openSheet');
  function sheet(open) {
    panel.classList.toggle('open', open);
    scrim.hidden = !open;
    openBtn.setAttribute('aria-expanded', open);
    if (open) el('closeSheet').focus(); else openBtn.focus();
  }
  openBtn.addEventListener('click', function () { sheet(true); });
  el('closeSheet').addEventListener('click', function () { sheet(false); });
  scrim.addEventListener('click', function () { sheet(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) sheet(false);
    var tag = (e.target.tagName || '').toLowerCase();
    if (e.code === 'Space' && tag !== 'button' && tag !== 'input' && tag !== 'summary') { e.preventDefault(); togglePause(); }
  });

  // ---------- main loop ----------
  var last = performance.now(), boardAt = 0;
  function frame(now) {
    var dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) {
      Sim.step(sim, dt * GAME_RATE * speed);
      updateSprites(dt);
    }
    draw();
    if (now - boardAt > 250) { updateBoard(); boardAt = now; }
    requestAnimationFrame(frame);
  }

  new ResizeObserver(resize).observe(floorEl);
  resize();
  syncControls();
  updateBoard();
  requestAnimationFrame(frame);

  // For poking at it from the console.
  window.checkout = { sim: sim, sprites: sprites };
})();
