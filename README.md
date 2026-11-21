# Checkout

A little grocery-store checkout simulation, made to watch rather than win. Shoppers come in,
wander the aisles, then pick the checkout line that looks quickest. A store day (8 AM to 10 PM)
plays in 10 minutes at 1×, with a lunch bump and an after-work rush.

Live at https://mattrudy13.github.io/checkout-sim/ , or open `index.html` in a browser. There's no
build step and nothing to install.

## What you can change

- **Line style:** a line per register, or one shared snake line where the front goes to the next
  free register. Express and self-checkout keep their own lines either way.
- **Registers open:** 1 to 5. A register switched off finishes the line it already has.
- **Express lane** (15 items or fewer) and **self-checkout** (4 kiosks and an attendant), on or off.
- **Shoppers:** Quiet, Normal or Packed.
- **Speed:** 1×, 2×, 4×, and pause (Space).

Settings are remembered on the device. On a phone, a slim bar shows the main numbers and
**Controls** opens the rest in a pull-up sheet.

## The scoreboard

Average wait over the last store hour, worst wait today, staff cost per hour, mood, walkouts and
how many people are in the store, plus a bar chart of the average wait for each hour today.

"Wait" is the time from joining a line to being called to a register. Mood starts at 100% and
drops 8 points a minute once a wait passes 2 minutes. A shopper who runs out of patience (6 to
14 minutes) walks out, unless they're next. Costs are $16/hr per cashier or attendant and $4/hr per
kiosk. All of these numbers are made up but kept roughly realistic; they live in `CONFIG` at the
top of `sim.js`.

## Files

- `sim.js`: the rules (arrivals, line choice, service, mood, costs) with no drawing. Every
  shopper's traits come from one seeded random stream, so two stores with the same seed get the
  same shoppers. A future compare mode depends on that.
- `view.js`: draws the store on a canvas and wires up the controls.
- `index.html`, `style.css`: the page.
- `test.js`: checks the rules in Node. Run `node test.js` (add `--hours` for the wait by hour).

## What the sim shows so far

On the same shoppers, one shared line cuts the worst waits a lot (about 11 vs 14 minutes over a
default day) but the average only a little, because people in separate lines already pick the
shortest one. When the store is badly understaffed, the shared line can lose more people to
walkouts, since everyone ends up waiting about the same long time.
