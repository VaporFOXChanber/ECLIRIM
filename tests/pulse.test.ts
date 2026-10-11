import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PulseAnalyser, musicColors } from '../src/engine/pulse.ts';
import { BACK, STEP, TemporalFilter } from '../src/engine/temporal.ts';
import { luminance } from '../src/engine/color.ts';
import { COLOR, DEFAULTS, PULSE } from '../src/shared/settings.ts';
import { ledRow } from '../src/engine/emission.ts';
import { guardField } from '../src/engine/guard.ts';
import type { RGB } from '../src/shared/types.ts';

// A spectrum as AnalyserNode.getFloatFrequencyData gives it: decibels per bin, 1024 bins up to 24 kHz.
const RATE = 48000, BINS = 1024, DT = 1 / 30;
const spectrum = (low = 0, mid = 0, high = 0): Float32Array => {
  const bins = new Float32Array(BINS).fill(-Infinity), put = (hz: number, amplitude: number) => { if (amplitude > 0) bins[Math.round(hz / (RATE / 2 / BINS))] = 20 * Math.log10(amplitude); };
  put(70, low); put(1000, mid); put(6000, high);
  return bins;
};
// A kick drum: a burst of bass every `period` seconds that dies away, over a quiet sustained mid.
const kick = (t: number, period: number, loud = .8) => spectrum(loud * Math.exp(-14 * (t % period)), loud * .06, 0);
const run = (pulse: PulseAnalyser, seconds: number, sound: (t: number) => Float32Array, settings = PULSE, calm = true, each?: (t: number) => void) => {
  for (let i = 0; i < seconds / DT; i++) { pulse.update(sound(i * DT), RATE, DT, settings, calm); each?.(i * DT); }
};
const ON = { ...PULSE, enabled: true };

test('silence and steady sound leave the light alone; only what changes moves it', () => {
  const pulse = new PulseAnalyser();
  run(pulse, 1, () => spectrum());
  assert.equal(pulse.frame.silent, true); assert.deepEqual([...pulse.gains(64, ON)], Array(64).fill(1));
  // A loud, perfectly steady tone in every band: after a few seconds it is the new normal.
  run(pulse, 8, () => spectrum(.7, .7, .7));
  assert.equal(pulse.frame.silent, false); assert.ok(pulse.frame.low > .9, 'it is heard as loud');
  for (const g of pulse.gains(64, ON)) assert.ok(Math.abs(g - 1) < .05, `and hardly moves anything any more: ${g}`);
  run(pulse, 8, () => spectrum(.7, .7, .7));
  for (const g of pulse.gains(64, ON)) assert.ok(Math.abs(g - 1) < .005, `and then nothing: ${g}`);
  assert.equal(pulse.beats, 1, 'only its start counted as an event');
  assert.deepEqual([...new PulseAnalyser().gains(64, { ...ON, depth: 0 })], Array(64).fill(1), 'depth 0 is off');
  // The music stops: a second and a half later the light is back where the picture has it, not held down by what was playing.
  const stopped = new PulseAnalyser();
  run(stopped, 6, t => kick(t, .5)); run(stopped, 1.5, () => spectrum());
  for (const g of stopped.gains(64, ON)) assert.ok(Math.abs(g - 1) < .02, `after the sound has stopped: ${g}`);
});

test('a beat is found at its tempo, lifts the light on the beat, and leans to the bottom edge', () => {
  const pulse = new PulseAnalyser(); let onBeat = 0, offBeat = 9;
  run(pulse, 3, t => kick(t, .5));
  const before = pulse.beats;
  run(pulse, 5, t => kick(t, .5), ON, true, t => {
    const g = pulse.gains(64, ON), phase = t % .5;
    if (phase < .05) onBeat = Math.max(onBeat, g[24]); if (phase > .3 && phase < .45) offBeat = Math.min(offBeat, g[24]);
  });
  assert.ok(pulse.beats - before >= 9 && pulse.beats - before <= 11, `120 BPM for five seconds is ten beats: ${pulse.beats - before}`);
  // Pulse Depth 40%: shown up to 1.6 times as strongly on a beat and down to 0.76 in between. In light that is the square.
  assert.ok(onBeat > 1.9 && onBeat <= 1.6 ** 2 + 1e-6, `on the beat the bottom edge is driven harder: ×${onBeat}`);
  assert.ok(offBeat < .95 && offBeat >= .76 ** 2 - 1e-6, `between beats it rests below: ×${offBeat}`);
  // Where the bass goes, with nothing travelling: the bottom edge more than the top, the sides in between.
  const still = { ...ON, wave: 0 };
  pulse.update(kick(0, .5), RATE, DT, still);
  const g = pulse.gains(64, still);
  assert.ok(g[24] > g[8] && g[8] > 1, 'bass: bottom edge more than top, top still a little');
  assert.ok(g[32] < g[47] && g[47] <= g[24], 'and the sides rise toward the bottom');
  assert.equal(pulse.gains(128, ON).length, 128);
});

test('Beat Wave: a beat starts at the bottom centre and runs up both sides to the top', () => {
  const pulse = new PulseAnalyser(), wide = { ...ON, wave: 100 };
  run(pulse, 4, t => kick(t, .5), wide);
  // When each zone is at its brightest within one beat (seconds after the beat), for the middle of each edge and the corners.
  const peakAt = (zones: number[], settings: typeof wide) => {
    const p = new PulseAnalyser(), best = zones.map(() => ({ at: 0, gain: 0 }));
    run(p, 4, t => kick(t, .5), settings);
    run(p, .5, t => kick(t, .5), settings, true, t => { const g = p.gains(64, settings); zones.forEach((z, i) => { if (g[z] > best[i].gain + 1e-9) best[i] = { at: t, gain: g[z] }; }); });
    return best;
  };
  // Zones: bottom centre 24, bottom right corner 31, right edge middle 56, top right corner 15, top centre 8 (and the left side, mirrored).
  const [bottom, corner, side, upper, top] = peakAt([24, 31, 56, 15, 8], wide);
  assert.ok(bottom.at < 1e-9, `the bottom centre answers in the frame of the beat: ${bottom.at}`);
  assert.ok(corner.at > bottom.at && side.at > corner.at && upper.at > side.at && top.at > upper.at, `then outward and up: ${[bottom, corner, side, upper, top].map(z => z.at.toFixed(2))}`);
  assert.ok(top.at > .26 && top.at < .36, `the top centre about a third of a second later, slowly enough to follow: ${top.at}`);
  assert.ok(top.gain > 1.2 && top.gain < bottom.gain, 'weaker up there, but there');
  const [left, right] = peakAt([40, 56], wide);
  assert.ok(Math.abs(left.at - right.at) < 1e-9 && Math.abs(left.gain - right.gain) < 1e-6, 'both sides alike');
  // Beat Wave 0: every edge on the beat, as up to 0.9.2.
  for (const zone of peakAt([24, 31, 56, 15, 8], { ...ON, wave: 0 })) assert.ok(zone.at < .04, `no travelling: ${zone.at}`);
  // The mids and the treble do not travel.
  const hats = new PulseAnalyser(); run(hats, 6, t => spectrum(.05, .05, t % .25 < .05 ? .8 : .02), wide); hats.update(spectrum(.05, .05, .8), RATE, DT, wide);
  assert.ok(hats.gains(64, wide)[8] > 1.02, 'a hi-hat is on the top edge the moment it sounds');
});

test('bands are told apart, and each has its own amount', () => {
  const treble = new PulseAnalyser();
  run(treble, 12, t => spectrum(.05, .05, t % .25 < .05 ? .8 : .02));
  assert.equal(treble.beats, 1, 'hi-hats are not beats');
  treble.update(spectrum(.05, .05, .8), RATE, DT, ON);
  const g = treble.gains(64, ON);
  assert.ok(g[8] > g[24] && g[8] > 1.02, `treble leans to the top edge: top ×${g[8]}, bottom ×${g[24]}`);
  const noTreble = treble.gains(64, { ...ON, treble: 0 });
  assert.ok(Math.abs(noTreble[8] - 1) < .02, 'Treble 0: the same sound moves nothing');
  // A blast: bass and mids jump together, near their peak.
  const blast = new PulseAnalyser();
  run(blast, 3, () => spectrum(.05, .05, .01)); blast.update(spectrum(.9, .9, .2), RATE, DT, ON);
  assert.equal(blast.frame.impact, 1); assert.ok(blast.gains(64, ON)[24] > 1.4, 'a blast lifts more than a beat');
  // Its bass travels like a beat's: the top centre has it a moment later, and then more than a plain beat would give.
  const far = { ...ON, wave: 100 }, wide = new PulseAnalyser();
  run(wide, 3, () => spectrum(.05, .05, .01), far); wide.update(spectrum(.9, .9, .2), RATE, DT, far);
  const atOnce = wide.gains(64, far)[8]; run(wide, .34, () => spectrum(.05, .05, .01), far);
  assert.ok(wide.gains(64, far)[8] > atOnce + .3, `a blast reaches the top a moment later: ×${atOnce} → ×${wide.gains(64, far)[8]}`);
  run(blast, 2, () => spectrum(.05, .05, .01)); assert.ok(blast.frame.impact < .01, 'and dies away');
});

test('quiet and loud programmes move the light alike; sensitivity decides what counts as a beat', () => {
  const quiet = new PulseAnalyser(), loud = new PulseAnalyser();
  run(quiet, 6, t => kick(t, .5, .02)); run(loud, 6, t => kick(t, .5, .9));
  assert.ok(Math.abs(quiet.beats - loud.beats) <= 1, `${quiet.beats} vs ${loud.beats} beats`);
  // A faint pulse on top of a steady bass: only a sensitive setting calls it a beat.
  const faint = (t: number) => spectrum(.5 + .12 * Math.exp(-14 * (t % .5)), .05, 0);
  const dull = new PulseAnalyser(), keen = new PulseAnalyser();
  run(dull, 6, faint, { ...ON, sensitivity: 0 }); run(keen, 6, faint, { ...ON, sensitivity: 100 });
  assert.ok(keen.beats > dull.beats + 5, `${dull.beats} vs ${keen.beats}`);
});

test('with the Flash Limiter on, beats are never closer than a third of a second', () => {
  const fast = (t: number) => kick(t, .125, .8);       // eight bursts a second
  const calm = new PulseAnalyser(), free = new PulseAnalyser();
  run(calm, 6, fast, ON, true); run(free, 6, fast, ON, false);
  assert.ok(calm.beats <= 6 * 3 + 1, `at most three a second: ${calm.beats} in six seconds`);
  assert.ok(free.beats > calm.beats, 'without it they come as fast as the limiter-free minimum allows');
});

test('sound changes how bright the light is, never its colour, and the Flash Limiter bounds it', () => {
  const colors: RGB[] = Array.from({ length: 64 }, () => [180, 90, 40]);
  const settle = (limiter: boolean) => { const f = new TemporalFilter(), s = { ...DEFAULTS, flashLimiter: limiter }; f.setTarget(colors, s); for (let i = 0; i < 200; i++) f.step(.05, { ...s, flashLimiter: false }); return { f, s }; };
  const { f, s } = settle(false), still = f.step(DT, s)[5];
  const up = f.step(DT, s, new Float32Array(64).fill(1.5))[5], down = f.step(DT, s, new Float32Array(64).fill(.6))[5];
  // A zone already at full strength cannot be driven past it: the gain has nowhere to go.
  const white = new TemporalFilter(); white.setTarget(Array.from({ length: 64 }, () => [255, 255, 255] as RGB), s); for (let i = 0; i < 200; i++) white.step(.05, s);
  for (const v of white.step(DT, s, new Float32Array(64).fill(3))[5]) assert.ok(v <= 255 && v > 250);
  // A lowering is followed exactly. A lift is bent toward the ceiling of the zone (its strongest channel at full), so it
  // comes out a little under what was asked, and never over it.
  const lift = luminance(up) / luminance(still);
  assert.ok(lift > 1.3 && lift < 1.5 && Math.abs(luminance(down) / luminance(still) - .6) < .05, `the light follows the gain: ×${lift}`);
  const small = settle(false), calm = small.f.step(DT, small.s)[5], nudged = small.f.step(DT, small.s, new Float32Array(64).fill(1.1))[5];
  assert.ok(Math.abs(luminance(nudged) / luminance(calm) - 1.1) < .02, 'a small lift is hardly bent at all');
  // However much is asked, no channel goes past full: the lift only comes ever closer to it.
  const most = settle(false).f.step(DT, s, new Float32Array(64).fill(50))[5];
  assert.ok(Math.max(...most) <= 255 && Math.max(...most) > 250 && luminance(most) > luminance(up), `×50 ends at full: ${most}`);
  // Same hue: the channels keep their proportions in linear light.
  const lin = (v: number) => ((v / 255 + .055) / 1.055) ** 2.4, ratio = (rgb: RGB) => lin(rgb[0]) / lin(rgb[1]);
  assert.ok(Math.abs(ratio(up) / ratio(still) - 1) < .03 && Math.abs(ratio(down) / ratio(still) - 1) < .03, `colour kept: ${still} → ${up} / ${down}`);
  f.step(DT, s)[5].forEach((v, c) => assert.ok(Math.abs(v - still[c]) < 1e-9, 'no gain: exactly the light without the Pulse Engine'));
  // With the limiter on, a jump of the gain reaches the screen no faster than the limiter allows.
  const limited = settle(true); let before = luminance(limited.f.step(DT, limited.s, new Float32Array(64).fill(1))[5]);
  for (let i = 0; i < 12; i++) {
    const now = luminance(limited.f.step(DT, limited.s, new Float32Array(64).fill(i < 6 ? 2.5 : .2))[5]);
    assert.ok(now - before <= .55 * DT + 1e-9 && before - now <= .85 * DT + 1e-9, `step ${i}: ${now - before}`);
    before = now;
  }
});

test('Beat Bloom: on a beat the light swells into the page, the bottom edge first, then the sides, then the top', () => {
  const settings = { ...ON, wave: 100, bloom: 100 }, pulse = new PulseAnalyser();
  run(pulse, 4, t => kick(t, .5), settings);
  // Per side (top, bottom, left, right): when it is swollen most within one beat, and how far.
  const best = [0, 1, 2, 3].map(() => ({ at: 0, swell: 0 })); let rest = [9, 9, 9, 9];
  run(pulse, .5, t => kick(t, .5), settings, true, t => {
    const b = pulse.bloom(settings);
    b.forEach((v, side) => { if (v > best[side].swell + 1e-9) best[side] = { at: t, swell: v }; if (t > .42) rest[side] = Math.min(rest[side], v); });
  });
  const [top, bottom, left, right] = best;
  assert.ok(bottom.at < 1e-9 && bottom.swell > .7 && bottom.swell <= 1, `the bottom edge on the beat: ${JSON.stringify(bottom)}`);
  assert.ok(left.at > .1 && Math.abs(left.at - right.at) < 1e-9 && top.at > left.at + .05, `then the sides together, then the top: ${[bottom, left, right, top].map(b => b.at.toFixed(2))}`);
  assert.ok(rest[1] < bottom.swell * .45, `the bottom edge is back before the next beat: ${rest}`);
  for (const off of [{ ...settings, bloom: 0 }, { ...settings, depth: 0 }, { ...settings, bass: 0 }]) { pulse.update(kick(0, .5), RATE, DT, off); assert.deepEqual([...pulse.bloom(off)], [0, 0, 0, 0]); }
  assert.ok(pulse.bloom({ ...settings, bloom: 50 })[1] < pulse.bloom(settings)[1] * .55, 'half the setting, half the swell');
  // Nothing swells without a beat: a steady tone, hi-hats, silence.
  const steady = new PulseAnalyser(); run(steady, 8, () => spectrum(.7, .7, .7), settings);
  assert.ok(Math.max(...steady.bloom(settings)) < .02, `a steady tone: ${[...steady.bloom(settings)]}`);
  assert.deepEqual([...new PulseAnalyser().bloom(settings)], [0, 0, 0, 0]);
});

test('UI Guard and Beat Bloom: whatever the light is scaled to, what lands on a control is held', () => {
  // The top edge, 135 px deep, uniformly bright; a button 60–90 px in. Limit: 30% of full opacity.
  const LENGTH = 512, ROWS = 96, depth = 135, view = { width: 1280, height: 900 }, button = { x: 600, y: 60, width: 80, height: 30 };
  const base = new Float32Array(LENGTH * ROWS).fill(200), plain = new Float32Array(LENGTH * ROWS), held = new Float32Array(LENGTH * ROWS);
  guardField(base, plain, LENGTH, ROWS, 0, [button], view, depth, [.3]);
  guardField(base, held, LENGTH, ROWS, 0, [button], view, depth, [.3], 0, undefined, 1.8);
  const along = Math.floor(640 / view.width * LENGTH), at = (field: Float32Array, px: number) => field[Math.min(ROWS - 1, Math.floor(px / depth * ROWS)) * LENGTH + along];
  // Scaled by k from the edge, the light seen `screen` px in is the row that lies screen / k px in.
  const worst = (field: Float32Array, k: number) => { let most = 0; for (let screen = 60; screen <= 90; screen += 2) most = Math.max(most, at(field, screen / k)); return most; };
  assert.ok(worst(plain, 1) <= .3 * 255 + 1e-3, 'not scaled: held, as before');
  assert.ok(worst(plain, 1.8) > 150, `the plain hold does not reach the rows a swollen light brings over the button: ${worst(plain, 1.8)}`);
  for (const k of [1, 1.2, 1.5, 1.8]) assert.ok(worst(held, k) <= .3 * 255 + 1e-3, `scaled ${k}: ${worst(held, k)}`);
  assert.equal(at(held, 1), 200, 'right at the edge the light is as it was'); assert.equal(at(held, 125), 200, 'and well past the button too');
});

test('a beat lifts what is shown toward full, also where the tone curve has no room left, and never lights a dark zone', () => {
  const settings = { ...ON, depth: 100, wave: 0 }, pulse = new PulseAnalyser();
  run(pulse, 4, t => kick(t, .5), settings); pulse.update(kick(0, .5), RATE, DT, settings); pulse.gains(64, settings);
  assert.ok(pulse.lift[24] > .5 && pulse.lift[24] <= .851 && pulse.lift[8] > 0 && pulse.lift[8] < pulse.lift[24], `on the beat, most along the bottom: ${pulse.lift[24]} / ${pulse.lift[8]}`);
  run(pulse, .4, t => kick(t + DT, .5), settings); pulse.gains(64, settings);
  assert.equal(pulse.lift[24], 0, 'between beats there is nothing to lift');
  // The same zones painted without and with a lift of 0.6: a bright zone, a dim one, a dark one.
  // The bottom edge (zones 16–31): five bright zones, six dim ones, five dark ones. Read at the middle of each stretch.
  const flat: RGB[] = Array.from({ length: 64 }, (_, z) => { const j = z % 16; return j < 5 ? [250, 250, 250] : j < 11 ? [40, 50, 70] : [0, 0, 0]; });
  const paint = (lift: number) => ledRow(flat, 1, 160, .96, 1.1, undefined, undefined, COLOR, 0, lift ? new Float32Array(64).fill(lift) : null);
  const plain = paint(0), lifted = paint(.6), alpha = (row: Uint8ClampedArray, at: number) => row[at * 4 + 3];
  assert.ok(alpha(plain, 25) > 190 && alpha(plain, 25) < 235, `a bright zone sits under the ceiling of the tone curve: ${alpha(plain, 25)}`);
  assert.ok(alpha(lifted, 25) > alpha(plain, 25) + 12 && alpha(lifted, 25) <= 255, `and is lifted past it: ${alpha(plain, 25)} → ${alpha(lifted, 25)}`);
  assert.ok(alpha(lifted, 80) > alpha(plain, 80) && alpha(lifted, 80) - alpha(plain, 80) < 255 - alpha(plain, 80), `a dim zone is lifted part of the way: ${alpha(plain, 80)} → ${alpha(lifted, 80)}`);
  assert.equal(alpha(lifted, 140), 0, 'a dark zone stays dark');
  // The colour of a lifted zone is the colour it had.
  const hue = (row: Uint8ClampedArray, at: number) => row[at * 4] / Math.max(1, row[at * 4 + 2]);
  assert.ok(Math.abs(hue(lifted, 80) - hue(plain, 80)) < .03, 'same colour');
});

test('Flash Limiter on: a beat may lift the light by a small step at once and let it back down by one, and nothing else may', () => {
  const dim: RGB[] = Array.from({ length: 64 }, () => [70, 80, 110]);
  const fresh = () => { const f = new TemporalFilter(), s = { ...DEFAULTS, flashLimiter: true }; f.setTarget(dim, s); for (let i = 0; i < 200; i++) f.step(.05, { ...s, flashLimiter: false }); return { f, s }; };
  const gain = (v: number) => new Float32Array(64).fill(v);
  // One beat, then the gain stays up, then goes right down: how far the light moves frame by frame.
  const { f, s } = fresh(), start = luminance(f.step(DT, s, gain(1))[5]); let before = start, rose = 0, largest = 0;
  for (let i = 0; i < 9; i++) {
    const now = luminance(f.step(DT, s, gain(4), i === 0)[5]), moved = now - before;
    if (i === 0) assert.ok(moved > STEP * .9 && moved <= STEP + .55 * DT + 1e-7, `the beat's frame: one step and the usual rate, ${moved}`);
    else assert.ok(moved <= .55 * DT + 1e-7, `after it, the usual rate again: frame ${i}, ${moved}`);
    rose += Math.max(0, moved); largest = Math.max(largest, moved); before = now;
  }
  assert.ok(rose <= STEP + .55 * 9 * DT + 1e-7, `one beat, nine frames: ${rose}`);
  let fell = 0;
  for (let i = 0; i < 9; i++) {
    const now = luminance(f.step(DT, s, gain(.05))[5]), moved = before - now;
    if (i === 0) assert.ok(moved > BACK * .9 && moved <= BACK + .85 * DT + 1e-7, `the way back: one step and the usual rate, ${moved}`);
    else assert.ok(moved <= .85 * DT + 1e-7, `then the usual rate: frame ${i}, ${moved}`);
    fell += moved; before = now;
  }
  assert.ok(fell <= BACK + .85 * 9 * DT + 1e-7); assert.ok(STEP < .1 && BACK < .13, 'the steps are small');
  // The step is the beat's alone: a second jump without a beat gets none, and an unused step does not wait for long.
  const second = fresh(); second.f.step(DT, second.s, gain(1), true);
  for (let i = 0; i < 16; i++) second.f.step(DT, second.s, gain(1));                       // half a second: nothing asked for
  before = luminance(second.f.step(DT, second.s, gain(1))[5]);
  assert.ok(luminance(second.f.step(DT, second.s, gain(4))[5]) - before <= .55 * DT + 1e-7, 'a step that was not used on the beat is gone');
  // Three beats a second, as fast as the Pulse Engine counts them with the limiter on: per beat one step up and one down.
  const fast = fresh(); before = luminance(fast.f.step(DT, fast.s, gain(1))[5]); let up = 0, down = 0;
  for (let i = 0; i < 90; i++) {
    const now = luminance(fast.f.step(DT, fast.s, gain(i % 10 < 4 ? 5 : .05), i % 10 === 0)[5]);
    up += Math.max(0, now - before); down += Math.max(0, before - now); before = now;
  }
  assert.ok(up <= .55 * 3 + 9 * STEP + 1e-6 && down <= .85 * 3 + 9 * BACK + 1e-6, `three seconds, nine beats: up ${up}, down ${down}`);
  // Without the limiter the same beat is there at once.
  const free = fresh(), open = { ...free.s, flashLimiter: false }; before = luminance(free.f.step(DT, open, gain(1))[5]);
  assert.ok(luminance(free.f.step(DT, open, gain(4), true)[5]) - before > STEP * 1.5, 'limiter off: no bound');
});

test('Music Mode: colours from the sound alone, dark in silence', () => {
  const pulse = new PulseAnalyser();
  assert.ok(musicColors(pulse.frame, 64, 0).every(c => c.every(v => v === 0)), 'silence is dark');
  // How strongly an edge is lit: its strongest channel, since a blue edge is as lit as a red one.
  const lum = (colors: RGB[], from: number) => colors.slice(from, from + 16).reduce((n, c) => n + Math.max(...c), 0);
  run(pulse, 2, () => spectrum(.8, .02, .01));
  const bass = musicColors(pulse.frame, 64, 0);
  assert.equal(bass.length, 64); assert.ok(lum(bass, 16) > lum(bass, 0) * 1.25, 'bass lights the bottom edge more than the top');
  assert.ok(bass[24][0] > bass[24][2], 'which is warm');
  const high = new PulseAnalyser(); run(high, 2, () => spectrum(.01, .02, .8));
  const treble = musicColors(high.frame, 64, 0);
  assert.ok(lum(treble, 0) > lum(treble, 16) * 1.25 && treble[8][2] > treble[8][0], 'treble lights the top edge more, and it is cool');
  for (const c of [...bass, ...treble, ...musicColors(high.frame, 128, 500)]) for (const v of c) assert.ok(v >= 0 && v <= 255);
  assert.notDeepEqual(musicColors(high.frame, 64, 0)[8], musicColors(high.frame, 64, 10)[8], 'the palette sways');
  for (const t of [0, 10, 30, 1000]) { const c = musicColors(high.frame, 64, t)[8]; assert.ok(c[2] > c[0], 'but the top stays cool'); }
});
