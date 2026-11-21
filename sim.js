/*
 * Checkout simulation: the rules with no drawing in it.
 * view.js draws it in the browser; test.js runs it in Node.
 *
 * Time is in store seconds (the clock on the wall). One store day, 8 AM to 10 PM, plays in
 * CONFIG.dayRealSeconds real seconds at 1x.
 *
 * A shopper arrives, shops for a while, then picks a line: an own-line register, the shared
 * snake line, the express lane or self-checkout. "Wait" is the time from joining a line to being
 * called to a register or kiosk. Mood drops once a wait passes a grace period, and a shopper
 * whose patience runs out walks out (unless they're next).
 *
 * Every shopper's traits (items, shopping time, patience, ...) come from one random stream that
 * nothing else draws from, so two stores built with the same seed get exactly the same shoppers
 * whatever their setup. Compare mode will rely on that.
 */
(function (root) {
  'use strict';

  var HOUR = 3600;

  var CONFIG = {
    open: 8 * HOUR,
    close: 22 * HOUR,
    dayRealSeconds: 600,
    maxRegisters: 5,
    kiosks: 4,
    expressLimit: 15,    // items
    selfLimit: 25,       // shoppers with more than this never use self-checkout
    // Shoppers arriving per store hour at "Normal" busyness, at 8 AM, 9 AM, ... 10 PM.
    // Values in between are blended. Lunch bump, then the after-work rush.
    arrivals: [50, 60, 75, 85, 115, 105, 80, 85, 120, 175, 185, 135, 85, 50, 0],
    cashier: { setup: 20, perItem: 2.5, pay: 35 },
    self: { setup: 15, perItem: 5, pay: 30, helpChance: 0.15, helpMin: 30, helpMax: 60 },
    stepUp: 4,           // seconds for the next shopper in an own line to reach the register
    walkUp: 10,          // seconds from the front of the snake to a free register
    shopBase: 240, shopPerItem: 21,
    patienceMin: 360, patienceMax: 840,
    moodGrace: 120,      // waits shorter than this don't hurt mood
    moodPerMin: 8,       // mood points lost per minute of waiting after the grace period
    wage: 16,            // $ per staffed register or attendant, per hour
    kioskCost: 4         // $ per kiosk per hour while self-checkout is on
  };

  // Small fast seeded random generator (mulberry32).
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function arrivalRate(t) {
    var h = (t - CONFIG.open) / HOUR;
    var a = CONFIG.arrivals;
    if (h < 0 || h >= a.length - 1) return 0;
    var i = Math.floor(h), f = h - i;
    return a[i] + (a[i + 1] - a[i]) * f;
  }

  function cashierWork(items) {
    var c = CONFIG.cashier;
    return c.setup + c.perItem * items + c.pay;
  }
  function selfWork(items) {
    var s = CONFIG.self;
    return s.setup + s.perItem * items + s.pay;
  }

  function newDayStats() {
    return { served: 0, walkouts: 0, waits: [], worst: 0, moodSum: 0, moodN: 0, cost: 0,
      hourly: CONFIG.arrivals.map(function () { return { sum: 0, n: 0 }; }) };
  }

  function create(opts) {
    opts = opts || {};
    var sim = {
      t: CONFIG.open,
      day: 1,
      seed: opts.seed || 1,
      settings: {
        registers: opts.registers || 4,
        express: opts.express !== false,
        self: opts.self !== false,
        lineStyle: opts.lineStyle || 'own',   // 'own' (a line per register) or 'shared'
        busyness: opts.busyness || 1
      },
      lanes: [],          // regular registers 0..maxRegisters-1, then the express lane
      kiosks: [],
      sharedQueue: [],    // the snake (regular registers only)
      selfQueue: [],      // one line for all kiosks
      attendantBusyUntil: 0,
      shoppers: [],       // everyone in the store
      nextId: 0,
      entered: 0,
      stats: newDayStats(),
      events: []          // [{type: 'walkout'|'served'|'newDay', ...}] for the view; it clears them
    };
    sim.arr = rng(sim.seed);
    sim.arrAcc = 0;
    sim.nextGap = -Math.log(1 - sim.arr());
    for (var i = 0; i <= CONFIG.maxRegisters; i++) {
      sim.lanes.push({ idx: i, kind: i === CONFIG.maxRegisters ? 'express' : 'reg',
        active: false, queue: [], current: null });
    }
    for (var k = 0; k < CONFIG.kiosks; k++) sim.kiosks.push({ idx: k, current: null });
    sim.selfActive = false;
    applySettings(sim);
    return sim;
  }

  function regLanes(sim) { return sim.lanes.slice(0, CONFIG.maxRegisters); }
  function express(sim) { return sim.lanes[CONFIG.maxRegisters]; }

  // Turn registers, express and self-checkout on or off. A lane switched off stops taking new
  // shoppers but its cashier finishes the line that's already there.
  function applySettings(sim) {
    var s = sim.settings;
    regLanes(sim).forEach(function (l) { l.active = l.idx < s.registers; });
    express(sim).active = s.express;
    sim.selfActive = s.self;
  }

  function set(sim, key, value) {
    var old = sim.settings[key];
    if (old === value) return;
    sim.settings[key] = value;
    if (key === 'lineStyle') switchLineStyle(sim, value);
    applySettings(sim);
  }

  // Move everyone waiting for a regular register into the new kind of line, keeping their place
  // in time and how long they've already waited.
  function switchLineStyle(sim, style) {
    if (style === 'shared') {
      var waiting = [];
      regLanes(sim).forEach(function (l) { waiting = waiting.concat(l.queue); l.queue = []; });
      waiting.sort(function (a, b) { return a.joinT - b.joinT; });
      waiting.forEach(function (p) { p.line = 'shared'; });
      sim.sharedQueue = waiting;
    } else {
      var q = sim.sharedQueue;
      sim.sharedQueue = [];
      applySettings(sim);
      q.forEach(function (p) {
        var best = null, bestEst = Infinity;
        regLanes(sim).forEach(function (l) {
          if (!l.active) return;
          var e = laneEstimate(l) * perception(p, l.idx);
          if (e < bestEst) { bestEst = e; best = l; }
        });
        if (!best) best = sim.lanes[0];
        best.queue.push(p);
        p.line = best.idx;
      });
    }
  }

  function makeShopper(sim) {
    var r = sim.arr;
    var u = r();
    var items = u < 0.35 ? 3 + Math.floor(r() * 13)
      : u < 0.75 ? 16 + Math.floor(r() * 25)
      : 41 + Math.floor(r() * 50);
    var p = {
      id: ++sim.nextId,
      items: items,
      enterT: sim.t,
      shopEnd: sim.t + (CONFIG.shopBase + CONFIG.shopPerItem * items) * (0.7 + 0.6 * r()),
      likesSelf: r() < 0.6,
      patience: CONFIG.patienceMin + (CONFIG.patienceMax - CONFIG.patienceMin) * r(),
      noise: r(),
      needsHelp: r() < CONFIG.self.helpChance,
      helpAt: 0.3 + 0.5 * r(),
      helpDur: CONFIG.self.helpMin + (CONFIG.self.helpMax - CONFIG.self.helpMin) * r(),
      look: Math.floor(r() * 1000),
      phase: 'shopping',   // shopping -> queue -> walking -> service -> gone (or walkout)
      line: null,          // lane index, 'shared' or 'self' while in a line
      server: null,        // the lane or kiosk once called
      joinT: 0, wait: 0, mood: 100,
      work: 0, done: 0, pausedUntil: 0, helped: false, walkLeft: 0
    };
    sim.shoppers.push(p);
    sim.entered++;
    return p;
  }

  // People misjudge lines a little: each shopper sees each line up to 20% longer or shorter.
  function perception(p, key) {
    var x = Math.sin((p.noise * 997 + key * 13.37) * 12.9898) * 43758.5453;
    return 0.8 + 0.4 * (x - Math.floor(x));
  }

  function remaining(server) {
    var c = server.current;
    if (!c) return 0;
    return c.phase === 'walking' ? c.work + c.walkLeft : Math.max(0, c.work - c.done);
  }
  function queueWork(q, fn) {
    var s = 0;
    for (var i = 0; i < q.length; i++) s += fn(q[i].items);
    return s;
  }
  function laneEstimate(l) { return remaining(l) + queueWork(l.queue, cashierWork); }
  function sharedEstimate(sim) {
    var lanes = regLanes(sim).filter(function (l) { return l.active; });
    var busy = lanes.reduce(function (s, l) { return s + remaining(l); }, 0);
    return (busy + queueWork(sim.sharedQueue, cashierWork)) / Math.max(1, lanes.length);
  }
  function selfEstimate(sim) {
    var busy = sim.kiosks.reduce(function (s, k) { return s + remaining(k); }, 0);
    return (busy + queueWork(sim.selfQueue, selfWork)) / sim.kiosks.length;
  }

  // Done shopping: pick the line that looks quickest.
  function chooseLine(sim, p) {
    var best = null, bestEst = Infinity;
    function consider(key, est) {
      est *= perception(p, typeof key === 'number' ? key : key.length + 20);
      if (est < bestEst) { bestEst = est; best = key; }
    }
    var ex = express(sim);
    if (ex.active && p.items <= CONFIG.expressLimit) consider(ex.idx, laneEstimate(ex));
    if (sim.selfActive && p.likesSelf && p.items <= CONFIG.selfLimit) consider('self', selfEstimate(sim));
    if (sim.settings.lineStyle === 'shared') consider('shared', sharedEstimate(sim));
    else regLanes(sim).forEach(function (l) { if (l.active) consider(l.idx, laneEstimate(l)); });
    if (best === null) best = 0;

    p.phase = 'queue';
    p.joinT = sim.t;
    p.line = best;
    if (best === 'self') sim.selfQueue.push(p);
    else if (best === 'shared') sim.sharedQueue.push(p);
    else sim.lanes[best].queue.push(p);
  }

  function call(sim, p, server, isKiosk, delay) {
    p.wait = sim.t - p.joinT;
    p.mood = moodAfter(p.wait);
    p.phase = 'walking';
    p.walkLeft = delay;
    p.server = server;
    p.line = null;
    p.done = 0;
    p.work = isKiosk ? selfWork(p.items) : cashierWork(p.items);
    p.atKiosk = isKiosk;
    server.current = p;
    var st = sim.stats;
    st.waits.push({ t: sim.t, w: p.wait });
    if (p.wait > st.worst) st.worst = p.wait;
    var h = Math.min(st.hourly.length - 1, Math.max(0, Math.floor((sim.t - CONFIG.open) / HOUR)));
    st.hourly[h].sum += p.wait;
    st.hourly[h].n++;
  }

  function moodAfter(wait) {
    return Math.max(0, 100 - Math.max(0, wait - CONFIG.moodGrace) / 60 * CONFIG.moodPerMin);
  }

  function finish(sim, p) {
    p.server.current = null;
    p.phase = 'gone';
    sim.stats.served++;
    sim.stats.moodSum += p.mood;
    sim.stats.moodN++;
    sim.events.push({ type: 'served', id: p.id });
  }

  function walkout(sim, p, queue) {
    queue.splice(queue.indexOf(p), 1);
    p.phase = 'walkout';
    p.wait = sim.t - p.joinT;
    p.mood = 0;
    p.line = null;
    sim.stats.walkouts++;
    sim.stats.moodN++;
    sim.events.push({ type: 'walkout', id: p.id });
  }

  function advanceServer(sim, server, dt) {
    var p = server.current;
    if (!p) return;
    if (p.phase === 'walking') {
      p.walkLeft -= dt;
      if (p.walkLeft > 0) return;
      dt = -p.walkLeft;
      p.walkLeft = 0;
      p.phase = 'service';
    }
    if (p.atKiosk && p.needsHelp && !p.helped) {
      var s = CONFIG.self;
      var helpPoint = s.setup + s.perItem * p.items * p.helpAt;
      if (p.done >= helpPoint) {
        if (sim.attendantBusyUntil > sim.t) return;   // waiting for the attendant
        sim.attendantBusyUntil = sim.t + p.helpDur;
        p.pausedUntil = sim.t + p.helpDur;
        p.helped = true;
      }
    }
    if (p.pausedUntil > sim.t) return;
    p.done += dt;
    if (p.done >= p.work) finish(sim, p);
  }

  function stepOnce(sim, dt) {
    var st = sim.stats;

    // Arrivals (none after closing time).
    if (sim.t < CONFIG.close) {
      sim.arrAcc += arrivalRate(sim.t) * sim.settings.busyness / HOUR * dt;
      while (sim.arrAcc >= sim.nextGap) {
        sim.arrAcc -= sim.nextGap;
        makeShopper(sim);
        sim.nextGap = -Math.log(1 - sim.arr());
      }
    }

    // Done shopping -> into a line.
    for (var i = 0; i < sim.shoppers.length; i++) {
      var p = sim.shoppers[i];
      if (p.phase === 'shopping' && sim.t >= p.shopEnd) chooseLine(sim, p);
    }

    // Registers and kiosks work.
    sim.lanes.forEach(function (l) { advanceServer(sim, l, dt); });
    sim.kiosks.forEach(function (k) { advanceServer(sim, k, dt); });

    // Free registers call the next shopper. A switched-off lane still clears its own line.
    var shared = sim.settings.lineStyle === 'shared';
    sim.lanes.forEach(function (l) {
      if (l.current) return;
      if (l.queue.length) call(sim, l.queue.shift(), l, false, CONFIG.stepUp);
      else if (shared && l.kind === 'reg' && l.active && sim.sharedQueue.length) {
        call(sim, sim.sharedQueue.shift(), l, false, CONFIG.walkUp);
      }
    });
    sim.kiosks.forEach(function (k) {
      if (!k.current && sim.selfQueue.length) call(sim, sim.selfQueue.shift(), k, true, CONFIG.stepUp);
    });

    // Waiting hurts mood; out of patience means walking out, unless you're next.
    function checkPatience(q) {
      for (var j = q.length - 1; j >= 1; j--) {
        var w = q[j];
        w.mood = moodAfter(sim.t - w.joinT);
        if (sim.t - w.joinT >= w.patience) walkout(sim, w, q);
      }
      if (q.length) q[0].mood = moodAfter(sim.t - q[0].joinT);
    }
    sim.lanes.forEach(function (l) { checkPatience(l.queue); });
    checkPatience(sim.sharedQueue);
    checkPatience(sim.selfQueue);

    // Staff cost while the store is open.
    if (sim.t < CONFIG.close) st.cost += costPerHour(sim) * dt / HOUR;

    sim.shoppers = sim.shoppers.filter(function (s) { return s.phase !== 'gone' && s.phase !== 'walkout'; });
    sim.t += dt;

    // After closing, once the last shopper leaves, the next day starts.
    if (sim.t >= CONFIG.close && sim.shoppers.length === 0) {
      sim.events.push({ type: 'newDay', day: sim.day + 1, last: summary(sim) });
      sim.day++;
      sim.t = CONFIG.open;
      sim.stats = newDayStats();
    }
  }

  function step(sim, dt) {
    while (dt > 0) {
      var d = Math.min(1, dt);
      stepOnce(sim, d);
      dt -= d;
    }
  }

  // A lane costs a cashier while it's on or still finishing its line.
  function staffed(l) { return l.active || !!l.current || l.queue.length > 0; }
  function selfStaffed(sim) {
    return sim.selfActive || sim.selfQueue.length > 0 || sim.kiosks.some(function (k) { return !!k.current; });
  }
  function costPerHour(sim) {
    var cashiers = sim.lanes.filter(staffed).length;
    var self = selfStaffed(sim);
    return CONFIG.wage * (cashiers + (self ? 1 : 0)) + (self ? CONFIG.kioskCost * CONFIG.kiosks : 0);
  }

  function avgWaitLastHour(sim) {
    var since = sim.t - HOUR, s = 0, n = 0, w = sim.stats.waits;
    for (var i = w.length - 1; i >= 0 && w[i].t > since; i--) { s += w[i].w; n++; }
    return n ? s / n : 0;
  }

  function summary(sim) {
    var st = sim.stats, n = st.waits.length;
    return {
      served: st.served,
      walkouts: st.walkouts,
      avgWait: n ? st.waits.reduce(function (s, x) { return s + x.w; }, 0) / n : 0,
      worst: st.worst,
      mood: st.moodN ? st.moodSum / st.moodN : 100,
      cost: st.cost
    };
  }

  // Store-clock seconds left before a line clears, as shown above each lane.
  function lineWait(sim, key) {
    if (key === 'shared') return sharedEstimate(sim);
    if (key === 'self') return selfEstimate(sim);
    return laneEstimate(sim.lanes[key]);
  }

  // How many items the cashier has scanned for this shopper so far.
  function scanned(p) {
    if (p.phase !== 'service') return 0;
    var r = p.atKiosk ? CONFIG.self : CONFIG.cashier;
    return Math.max(0, Math.min(p.items, Math.floor((p.done - r.setup) / r.perItem)));
  }

  var api = {
    CONFIG: CONFIG, create: create, step: step, set: set,
    costPerHour: costPerHour, avgWaitLastHour: avgWaitLastHour, summary: summary,
    lineWait: lineWait, scanned: scanned, staffed: staffed, selfStaffed: selfStaffed,
    arrivalRate: arrivalRate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CheckoutSim = api;
})(this);
