import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KM, deriveState, fitHistory, difficultyCorrelation } from '../core/fit.mjs';
import { simulate, mulberry32, phaseEnd, fmtDay, phaseLabel } from '../core/engine.mjs';
import { forecast, backtest, conformalScale, calibratePhase, CATS, runModel } from '../core/forecast.mjs';
import { generate } from '../scripts/synth.mjs';

const P = JSON.parse(readFileSync(new URL('../data/project.json', import.meta.url)));

test('Kaplan-Meier matches the empirical survival curve without censoring', () => {
  const km = new KM([1, 2, 3, 4], [1, 1, 1, 1]);
  assert.equal(km.S(1), 0.75);
  assert.equal(km.S(2), 0.5);
  assert.equal(km.S(4), 0);
  assert.ok(Math.abs(km.quantile(0.5) - 2) < 1e-9);
});

test('Kaplan-Meier handles right-censoring (textbook example)', () => {
  // times 3, 4+, 5, 7+, 8 : S(3)=0.8, S(5)=0.8*2/3, S(8)=0
  const km = new KM([3, 4, 5, 7, 8], [1, 0, 1, 0, 1]);
  assert.ok(Math.abs(km.S(3) - 0.8) < 1e-12);
  assert.ok(Math.abs(km.S(5) - 0.8 * (2 / 3)) < 1e-12);
  assert.equal(km.S(8), 0);
});

test('conditional draws respect elapsed age and the conditional distribution', () => {
  const r = mulberry32(1);
  const d = Array.from({ length: 400 }, () => -Math.log(r()));
  const km = new KM(d, d.map(() => true));
  const age = 0.7;
  const xs = Array.from({ length: 4000 }, () => km.sample(r(), age));
  assert.ok(xs.every((x) => x >= age));
  // P(T <= 1.5 | T > 0.7) = 1 - S(1.5)/S(0.7)
  const emp = xs.filter((x) => x <= 1.5).length / xs.length;
  const want = 1 - km.S(1.5) / km.S(age);
  assert.ok(Math.abs(emp - want) < 0.03, `${emp} vs ${want}`);
});

test('state derivation reads the activity log the way the board shows it', () => {
  const ev = [{ t: 0, s: 'Backlog' }, { t: 1, s: 'Ready' }, { t: 1.2, s: 'In Progress' }, { t: 2, s: 'In Review' }, { t: 2.3, s: 'In Review', e: 'review_started' }, { t: 2.6, s: 'In Progress', e: 'changes_requested' }];
  assert.deepEqual(deriveState(ev, 0.5), { kind: 'pending' });
  assert.equal(deriveState(ev, 1.5).kind, 'coding');
  assert.equal(deriveState(ev, 2.1).kind, 'review_wait');
  assert.equal(deriveState(ev, 2.4).kind, 'review');
  assert.deepEqual(deriveState(ev, 2.7), { kind: 'ready', round: 1 });
  assert.equal(deriveState(ev, -1), null);
});

test('simulator: every work order finishes, dependencies and capacities hold', () => {
  const { wos, out } = generate(42);
  const byId = new Map(wos.map((w, i) => [w.id, i]));
  wos.forEach((w, i) => {
    assert.ok(Number.isFinite(out.done[i]), `${w.id} never finished`);
    const firstReady = out.logs[i].find((e) => e.s === 'Ready' || e.s === 'Blocked');
    for (const b of w.blockedBy) assert.ok(firstReady.t >= out.done[byId.get(b)] - 1e-9, `${w.id} started before ${b} finished`);
    assert.ok(firstReady.t >= w.availableAt - 1e-9, `${w.id} started before its phase`);
  });
  // reconstruct concurrent reviews in service and agent sessions: never above the caps
  const evs = [];
  wos.forEach((w, i) => {
    const L = out.logs[i];
    for (let k = 0; k < L.length; k++) {
      if (L[k].e === 'review_started') { const end = L.slice(k + 1).find((e) => e.e === 'changes_requested' || e.s === 'Completed'); evs.push([L[k].t, 1, 'r'], [end.t, -1, 'r']); }
      if (L[k].s === 'In Progress' && !L[k].e && w.executor === 'agent') { const end = L.slice(k + 1).find((e) => e.s === 'In Review'); evs.push([L[k].t, 1, 'a'], [end.t, -1, 'a']); }
    }
  });
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let r = 0, a = 0, maxR = 0, maxA = 0;
  for (const [, d, k] of evs) { if (k === 'r') r += d; else a += d; maxR = Math.max(maxR, r); maxA = Math.max(maxA, a); }
  assert.ok(maxR <= 2, `reviews in service ${maxR}`);
  assert.ok(maxA <= 6, `agent sessions ${maxA}`);
});

test('fit recovers the hidden process within tolerance', () => {
  const f = fitHistory(P, P.now);
  // human Build coding median: truth 1.3 days x complexity (median 1)
  const hb = f.codeKM['human|Build'].quantile(0.5);
  assert.ok(hb > 0.8 && hb < 1.9, `human build median ${hb}`);
  const ab = f.codeKM['agent|Build'].quantile(0.5);
  assert.ok(ab > 0.15 && ab < 0.6, `agent build median ${ab}`);
  // review capacity: truth is 2 reviewers, 1 on ~30% of days
  const mean = f.capDays.reduce((s, x) => s + x, 0) / f.capDays.length;
  assert.ok(mean > 1.4 && mean < 2.05, `capacity ${mean}`);
  // agents bounce more often in review than humans (truth 0.40 vs 0.14 first round)
  const [aa, ab2] = f.reworkBeta.agent[0], [ha, hb2] = f.reworkBeta.human[0];
  assert.ok(aa / (aa + ab2) > ha / (ha + hb2));
});

test('difficulty correlation is ~0 for independent stages and positive for coupled ones', () => {
  const r = mulberry32(3);
  const mk = (rho) => Array.from({ length: 400 }, () => {
    const z = -Math.log(r()) - 1, e1 = -Math.log(r()) - 1, e2 = -Math.log(r()) - 1;
    return { codeKey: 'a', code: Math.exp(Math.sqrt(rho) * z + Math.sqrt(1 - rho) * e1), revKey: 'a', rev: Math.exp(Math.sqrt(rho) * z + Math.sqrt(1 - rho) * e2), rw: r() < 0.3 ? 1 : 0 };
  });
  assert.ok(difficultyCorrelation(mk(0)).dur < 0.12);
  assert.ok(difficultyCorrelation(mk(0.5)).dur > 0.3);
});

test('forecast outputs are internally consistent', () => {
  const fc = forecast(P, P.now, { runs: 300 });
  for (const p of fc.phases) {
    const R = fc.phase[p];
    assert.equal(R.done.length, 300);
    assert.ok(R.q10 <= R.q50 && R.q50 <= R.q90);
    assert.ok(R.pOnTime >= 0 && R.pOnTime <= 1);
    const share = CATS.reduce((s, c) => s + R.catShare[c], 0);
    assert.ok(Math.abs(share - 1) < 1e-9 || share === 0);
    assert.ok(R.critIdx.every((c) => c.ci >= 0 && c.ci <= 1));
    // empirical P(on time) equals the CDF at the deadline
    assert.equal(R.pOnTime, R.done.filter((x) => x <= phaseEnd(p) + 1e-9).length / 300);
  }
});

test('common random numbers: a no-op intervention reproduces the baseline exactly; more reviewers never hurt on average', () => {
  const a = forecast(P, P.now, { runs: 200, phases: [10, 11] });
  const b = forecast(P, P.now, { runs: 200, phases: [10, 11], interventions: { toAgent: [] } });
  assert.deepEqual(a.phase[10].done, b.phase[10].done);
  const c = forecast(P, P.now, { runs: 200, phases: [10, 11], interventions: { extraReviewer: 1 } });
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  assert.ok(mean(c.phase[11].done) <= mean(a.phase[11].done) + 1e-9);
});

test('conformal scale: covers the requested share of past forecasts', () => {
  const rows = Array.from({ length: 19 }, (_, i) => ({ q10: -1, q50: 0, q90: 1, actual: (i + 1) / 10 }));
  const cs = conformalScale(rows, 0.2);
  // scores are 0.1..1.9; k = ceil(0.8*20) = 16 -> s = 1.6
  assert.ok(Math.abs(cs.raw - 1.6) < 1e-9);
  const R = { q50: 10, done: [8, 9, 10, 11, 12] };
  const C = calibratePhase(R, 11, 2);
  assert.deepEqual(C.done, [6, 8, 10, 12, 14]);
  assert.equal(C.pOnTime, 0.6);
});

test('backtest only scores phases that finished before the snapshot', () => {
  const bt = backtest(P, P.now, { runs: 120 });
  assert.ok(bt.n >= 10);
  for (const r of bt.rows) {
    assert.ok(r.actual < P.now);
    assert.ok(r.snapshot < r.actual + 5);
    assert.ok(r.pit >= 0 && r.pit <= 1);
  }
});

test('calendar helpers', () => {
  assert.equal(phaseLabel(10), 'Nov 9 - 15');
  assert.equal(phaseLabel(12), 'Nov 23 - 29');
  assert.equal(phaseLabel(13), 'Nov 30 - Dec 6');
  assert.equal(fmtDay(50, true), 'Fri Nov 13');
  assert.equal(fmtDay(46.2), 'Nov 10');
});

test('multi-seed: calibrated forecasts beat the velocity projection on unseen futures', async () => {
  const { calibrate } = await import('../scripts/calibration.mjs');
  const r = calibrate(8, 300);
  assert.ok(r.calibrated.brier < r.velocity.brier, `brier ${r.calibrated.brier} vs ${r.velocity.brier}`);
  assert.ok(r.calibrated.cover80 >= 0.65 && r.calibrated.cover80 <= 0.97, `coverage ${r.calibrated.cover80}`);
  assert.ok(r.calibrated.mae < r.velocity.mae);
});
