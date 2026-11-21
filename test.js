// Checks the simulation rules with no browser. Run with:  node test.js
// Add "--hours" to also print the average wait for each hour of a default day (for tuning).
var Sim = require('./sim.js');
var C = Sim.CONFIG;
var failures = 0;

function check(ok, msg) {
  console.log((ok ? 'pass  ' : 'FAIL  ') + msg);
  if (!ok) failures++;
}
function fmt(sec) { return Math.floor(sec / 60) + ':' + String(Math.round(sec % 60)).padStart(2, '0'); }

// Runs one whole store day and returns that day's summary plus the shopper count.
function runDay(opts, during) {
  var sim = Sim.create(opts);
  var last = null, t = 0;
  while (!last && t < 30 * 3600) {
    Sim.step(sim, 5);
    t += 5;
    if (during) during(sim, t);
    sim.events.forEach(function (e) { if (e.type === 'newDay') last = e.last; });
    sim.events.length = 0;
  }
  return { sim: sim, day: last };
}

// 1. Nobody goes missing: everyone who came in was served or walked out by closing.
var r = runDay({ seed: 7 });
check(r.day && r.day.served + r.day.walkouts === r.sim.entered,
  'every shopper is served or walks out (' + r.sim.entered + ' shoppers)');

// 2. Same seed, same day.
var a = runDay({ seed: 11 }).day, b = runDay({ seed: 11 }).day;
check(JSON.stringify(a) === JSON.stringify(b), 'same seed gives the same day');

// 3. The lesson: on the same shoppers, one shared line beats a line per register,
// especially for the unlucky ones (worst wait), over several seeds.
var ownAvg = 0, sharedAvg = 0, ownWorst = 0, sharedWorst = 0, n = 5;
for (var s = 1; s <= n; s++) {
  var own = runDay({ seed: s, lineStyle: 'own' }).day;
  var sh = runDay({ seed: s, lineStyle: 'shared' }).day;
  ownAvg += own.avgWait / n; sharedAvg += sh.avgWait / n;
  ownWorst += own.worst / n; sharedWorst += sh.worst / n;
}
check(sharedWorst < ownWorst, 'shared line has a lower worst wait (' + fmt(sharedWorst) + ' vs ' + fmt(ownWorst) + ')');
check(sharedAvg <= ownAvg * 1.05, 'shared line average wait is no worse (' + fmt(sharedAvg) + ' vs ' + fmt(ownAvg) + ')');

// 4. Flipping settings mid-day never loses or duplicates anyone.
var flips = 0, dupes = 0;
var live = runDay({ seed: 3 }, function (sim, t) {
  if (t % 1800 !== 0) return;
  flips++;
  Sim.set(sim, 'lineStyle', flips % 2 ? 'shared' : 'own');
  Sim.set(sim, 'registers', 1 + (flips % 5));
  Sim.set(sim, 'express', flips % 3 !== 0);
  Sim.set(sim, 'self', flips % 4 !== 1);
  var seen = {};
  function mark(p) { if (seen[p.id]) dupes++; seen[p.id] = true; }
  sim.lanes.forEach(function (l) { l.queue.forEach(mark); if (l.current) mark(l.current); });
  sim.kiosks.forEach(function (k) { if (k.current) mark(k.current); });
  sim.sharedQueue.forEach(mark);
  sim.selfQueue.forEach(mark);
});
check(dupes === 0, 'no shopper is in two places after ' + flips + ' setting changes');
check(live.day && live.day.served + live.day.walkouts === live.sim.entered, 'everyone still accounted for after changes');

// 5. The default day should be calm in the morning and have real lines at the evening rush.
// Sample the hourly stats each step, since they reset when the day rolls over.
var hours = C.arrivals.map(function () { return { s: 0, n: 0 }; });
var sim = Sim.create({ seed: 101 }), prevDay = 1;
while (sim.day === prevDay) {
  Sim.step(sim, 5);
  sim.events.length = 0;
  if (sim.day !== prevDay) break;
  var st = sim.stats.hourly;
  for (var h = 0; h < st.length; h++) { hours[h].s = st[h].sum; hours[h].n = st[h].n; }
}
var morning = hours[1].n ? hours[1].s / hours[1].n : 0;     // 9 AM
var rush = hours[9].n ? hours[9].s / hours[9].n : 0;        // 5 PM
var rush2 = hours[10].n ? hours[10].s / hours[10].n : 0;    // 6 PM
check(morning < 60, 'mornings are calm (9 AM avg wait ' + fmt(morning) + ')');
check(Math.max(rush, rush2) > 120, 'the evening rush has real lines (5-6 PM avg wait ' + fmt(Math.max(rush, rush2)) + ')');

if (process.argv.indexOf('--hours') >= 0) {
  hours.forEach(function (x, i) {
    if (!x.n) return;
    console.log('  ' + String(8 + i).padStart(2) + ':00  ' + String(x.n).padStart(4) + ' shoppers  avg wait ' + fmt(x.s / x.n));
  });
  console.log('  day: ' + JSON.stringify(r.day, function (k, v) { return typeof v === 'number' ? Math.round(v) : v; }));
}

console.log(failures ? failures + ' failed' : 'all passed');
process.exitCode = failures ? 1 : 0;
