// Phase Forecast: Monte Carlo over the fitted project model, critical-chain
// attribution, counterfactual interventions with common random numbers, the
// naive velocity projection, and a rolling-origin backtest.

import { simulate, mulberry32, seedOf, phaseStart, phaseEnd } from './engine.mjs';
import { fitHistory, deriveState, sampleBeta, sampleGamma, KM } from './fit.mjs';

export const CATS = ['agent_coding', 'human_coding', 'wait_assignee', 'wait_agent', 'wait_review', 'review', 'rework', 'decision'];

function poisson(lam, rnd) {
  if (lam <= 0) return 0;
  let L = Math.exp(-lam), k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}

/** Build the per-run model: parameter uncertainty is propagated by drawing
 *  probabilities from their Beta posteriors once per run. */
function bootKM(o, r) {
  // Bayesian-bootstrap-style resample of the observed spells (parameter uncertainty)
  const n = o.d.length;
  if (!n) return new KM([], []);
  const d = new Array(n), ob = new Array(n);
  for (let k = 0; k < n; k++) { const j = Math.floor(r() * n); d[k] = o.d[j]; ob[k] = !!o.o[j]; }
  return new KM(d, ob);
}

export function runModel(fit, run, opts = {}) {
  const r = mulberry32(seedOf(run, 7919));
  const boot = opts.bootstrap !== false && run > 0;
  const sp = fit.spells;
  const codeKM = {}, pooledKM = {}, reworkKM = {}, reviewKM = {};
  for (const k of Object.keys(fit.codeKM)) codeKM[k] = boot ? bootKM(sp.code[k], r) : fit.codeKM[k];
  for (const ex of ['agent', 'human']) {
    pooledKM[ex] = boot ? bootKM(sp.pooled[ex], r) : fit.pooledKM[ex];
    reworkKM[ex] = boot && sp.rework[ex] ? bootKM(sp.rework[ex], r) : fit.reworkKM[ex];
    reviewKM[ex] = boot && sp.review[ex] ? bootKM(sp.review[ex], r) : fit.reviewKM[ex];
  }
  const decisionKM = boot ? bootKM(sp.decision, r) : fit.decisionKM;
  const reworkP = {};
  for (const ex of ['agent', 'human']) reworkP[ex] = fit.reworkBeta[ex].map(([a, b]) => sampleBeta(a, b, r));
  const decP = {};
  for (const [ty, [a, b]] of Object.entries(fit.decisionBeta)) decP[ty] = sampleBeta(a, b, r);
  const caps = fit.capDays;
  const extraReviewer = opts.extraReviewer || 0;
  const decisionCap = opts.decisionCap ?? Infinity;
  return {
    rho: opts.independent ? null : fit.rho,
    agentCap: fit.agentCap,
    codeDur: (w, u, age) => (codeKM[`${w.executor}|${w.type}`] || pooledKM[w.executor]).sample(u, age),
    reworkDur: (w, u, age) => reworkKM[w.executor].sample(u, age),
    reviewDur: (w, u, age) => reviewKM[w.executor].sample(u, age),
    decisionDur: (w, u, age) => Math.min(decisionKM.sample(u, age), Math.max(decisionCap, age + 0.05)),
    decisionP: (w) => decP[w.type] ?? 0.1,
    reworkP: (w, round) => reworkP[w.executor][Math.min(round, 1)],
    reviewSlots: (day) => caps[Math.floor(mulberry32(seedOf(run, day, 31))() * caps.length)] + extraReviewer,
  };
}

/** Snapshot of the project as of time t. */
export function snapshot(project, t) {
  const wos = [], state = {};
  for (const w of project.wos) {
    if (w.isParent) continue;
    const st = deriveState(project.events[w.id] || [], t);
    if (!st) continue;
    wos.push(w);
    state[w.id] = st;
  }
  return { wos, state };
}

function unplannedFor(fit, run, t, phases, people) {
  const r = mulberry32(seedOf(run, 104729));
  const U = fit.unplanned;
  const lam0 = sampleGamma(U.shape, r) / U.rate; // posterior draw of the mean rate
  const extra = [];
  for (const p of phases) {
    // overdispersed (negative-binomial) phase-to-phase variation when history shows it
    const lam = Number.isFinite(U.dispersion) ? sampleGamma(U.dispersion, r) * lam0 / U.dispersion : lam0;
    const a = phaseStart(p), b = a + 4.5;
    const lo = Math.max(a, t);
    if (lo >= b) continue;
    const k = poisson(lam * (b - lo) / (b - a), r);
    for (let j = 0; j < k; j++) {
      extra.push({
        id: `U${p}-${j}`, synthetic: true, phase: p, priority: 'High', order: 9000 + j, type: 'Fix',
        executor: r() < fit.unplanned.agentShare ? 'agent' : 'human',
        assignee: people[Math.floor(r() * people.length)], blockedBy: [], availableAt: lo + r() * (b - lo),
      });
    }
  }
  return extra;
}

/** Trace the chain of binding constraints that determined `last`'s finish. */
function chainOf(out, idx, byIdx, last, startT) {
  const cats = {};
  const visited = [];
  let cur = last, guard = 0;
  while (cur !== undefined && cur >= 0 && guard++ < 200) {
    visited.push(cur);
    for (const [c, a, b] of out.seg[cur]) {
      const lo = Math.max(a, startT);
      if (b > lo) cats[c] = (cats[c] || 0) + (b - lo);
    }
    const bd = out.bind[cur];
    if (bd && bd.kind === 'dep') cur = bd.i; else break;
  }
  return { cats, visited };
}

/**
 * Run the forecast as of time t.
 * opts: runs, phases (list to report), missions [{id, children}], interventions {extraReviewer, decisionCap, toAgent:[ids], defer:[ids]}
 */
export function forecast(project, t, opts = {}) {
  const runs = opts.runs ?? 1000;
  const fit = opts.fit || fitHistory(project, t);
  const snap = snapshot(project, t);
  const iv = opts.interventions || {};
  let wos = snap.wos.map((w) => ({ ...w }));
  if (iv.toAgent) for (const w of wos) if (iv.toAgent.includes(w.id)) w.executor = 'agent';
  if (iv.defer) for (const w of wos) if (iv.defer.includes(w.id)) { w.phase += 1; w.availableAt = Math.max(w.availableAt ?? 0, phaseStart(w.phase)); }
  const curPhase = Math.floor(t / 5) + 1;
  const phases = opts.phases || [...new Set(wos.filter((w) => snap.state[w.id].kind !== 'done' && w.phase >= curPhase).map((w) => w.phase))].sort((a, b) => a - b);
  const people = project.people.map((p) => p.id);
  const missions = opts.missions || [];
  const res = {
    t, runs, fit, phases,
    phase: Object.fromEntries(phases.map((p) => [p, { done: [], spill: 0, cats: Object.fromEntries(CATS.map((c) => [c, 0])), unplanned: 0 }])),
    mission: Object.fromEntries(missions.map((m) => [m.id, { done: [] }])),
    crit: {},
    woDone: {},
  };
  for (let run = 0; run < runs; run++) {
    const model = runModel(fit, run, iv);
    const extra = unplannedFor(fit, run, t, phases, people);
    const all = wos.concat(extra);
    const out = simulate({ wos: all, state: snap.state, model, now: t, run, trace: true });
    const byPhase = {};
    for (let i = 0; i < all.length; i++) {
      const w = all[i];
      if (snap.state[w.id] && snap.state[w.id].kind === 'done') continue;
      (byPhase[w.phase] ||= []).push(i);
      if (opts.woDone) (res.woDone[w.id] ||= []).push(out.done[i]);
    }
    for (const p of phases) {
      const idx = byPhase[p] || [];
      const R = res.phase[p];
      let last = -1, lt = -Infinity, spill = 0;
      for (const i of idx) {
        if (out.done[i] > lt) { lt = out.done[i]; last = i; }
        if (out.done[i] > phaseEnd(p)) spill++;
        if (all[i].synthetic) R.unplanned++;
      }
      R.done.push(idx.length ? lt : t);
      R.spill += spill;
      if (last >= 0) {
        const { cats, visited } = chainOf(out, null, null, last, Math.max(t, 0));
        for (const [c, v] of Object.entries(cats)) R.cats[c] = (R.cats[c] || 0) + v;
        for (const i of visited) {
          const id = all[i].id;
          if (all[i].synthetic) continue;
          ((res.crit[p] ||= {})[id] = (res.crit[p][id] || 0) + 1);
        }
      }
    }
    for (const m of missions) {
      let lt = t;
      for (let i = 0; i < all.length; i++) if (m.children.includes(all[i].id)) lt = Math.max(lt, out.done[i]);
      res.mission[m.id].done.push(lt);
    }
  }
  for (const p of phases) {
    const R = res.phase[p];
    R.done.sort((a, b) => a - b);
    R.pOnTime = R.done.filter((x) => x <= phaseEnd(p) + 1e-9).length / runs;
    R.q = (pp) => quantile(R.done, pp);
    R.q50 = quantile(R.done, 0.5); R.q10 = quantile(R.done, 0.1); R.q80 = quantile(R.done, 0.8); R.q90 = quantile(R.done, 0.9);
    R.spill /= runs;
    R.unplanned /= runs;
    let tot = 0;
    for (const c of CATS) tot += R.cats[c];
    R.catShare = Object.fromEntries(CATS.map((c) => [c, tot ? R.cats[c] / tot : 0]));
    R.catDays = Object.fromEntries(CATS.map((c) => [c, R.cats[c] / runs]));
    R.critIdx = Object.entries(res.crit[p] || {}).map(([id, k]) => ({ id, ci: k / runs })).sort((a, b) => b.ci - a.ci);
  }
  for (const m of missions) {
    const M = res.mission[m.id];
    M.done.sort((a, b) => a - b);
    M.pOnTime = M.done.filter((x) => x <= m.due + 1e-9).length / runs;
    M.q50 = quantile(M.done, 0.5); M.q80 = quantile(M.done, 0.8); M.q10 = quantile(M.done, 0.1); M.q90 = quantile(M.done, 0.9);
  }
  res.velocity = velocityProjection(project, snap, fit, t, phases);
  return res;
}

export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

/** What a burn-up chart projects: remaining items / recent throughput. */
export function velocityProjection(project, snap, fit, t, phases) {
  const out = {};
  const v = Math.max(fit.velocity, 1e-6);
  for (const p of phases) {
    const remaining = snap.wos.filter((w) => w.phase <= p && snap.state[w.id].kind !== 'done').length;
    const at = t + remaining / v;
    out[p] = { remaining, at, onTime: at <= phaseEnd(p) };
  }
  return out;
}

/** Rolling-origin backtest: forecast phases from past snapshots and score
 *  against what actually happened (only phases fully completed before tNow). */
export function backtest(project, tNow, opts = {}) {
  const runs = opts.runs ?? 400;
  const rows = [];
  const fullyDone = (p) => {
    const ws = project.wos.filter((w) => w.phase === p && !w.isParent);
    let last = -Infinity;
    for (const w of ws) {
      const c = (project.events[w.id] || []).find((e) => e.s === 'Completed' && e.t < tNow);
      if (!c) return null;
      last = Math.max(last, c.t);
    }
    return ws.length ? last : null;
  };
  const firstPhase = opts.firstPhase ?? 3;
  for (let p = firstPhase; ; p++) {
    const actual = fullyDone(p);
    if (actual === null || phaseEnd(p) > tNow) break;
    // snapshots: Tuesday of the week before, Tuesday and Thursday of the phase week
    for (const [lead, off] of opts.origins ?? [[1, 1], [0, 1], [0, 3]]) {
      const s = phaseStart(p - lead) + off;
      if (s < 6) continue;
      const fc = forecast(project, s, { runs, phases: [p] });
      const R = fc.phase[p];
      const cdf = R.done.filter((x) => x <= actual + 1e-9).length / runs;
      const v = fc.velocity[p];
      rows.push({
        phase: p, lead, off, snapshot: s, pOnTime: R.pOnTime, q10: R.q10, q50: R.q50, q90: R.q90, actual,
        onTime: actual <= phaseEnd(p) + 1e-9, pit: cdf, velocityAt: v.at, velocityOnTime: v.onTime,
      });
    }
  }
  const n = rows.length;
  const brier = rows.reduce((s, r) => s + (r.pOnTime - (r.onTime ? 1 : 0)) ** 2, 0) / Math.max(n, 1);
  const brierVel = rows.reduce((s, r) => s + ((r.velocityOnTime ? 1 : 0) - (r.onTime ? 1 : 0)) ** 2, 0) / Math.max(n, 1);
  const cover80 = rows.filter((r) => r.actual >= r.q10 - 1e-9 && r.actual <= r.q90 + 1e-9).length / Math.max(n, 1);
  const maeF = rows.reduce((s, r) => s + Math.abs(r.q50 - r.actual), 0) / Math.max(n, 1);
  const maeV = rows.reduce((s, r) => s + Math.abs(r.velocityAt - r.actual), 0) / Math.max(n, 1);
  return { rows, n, brier, brierVel, cover80, maeF, maeV };
}

/** Split-conformal scale for the simulated completion distribution, learned
 *  from the project's own backtest. Score = residual normalised by the
 *  forecast's half-width on the side the outcome fell; the calibrated band is
 *  q50 +/- s * half-width, with s the ceil((1-alpha)(n+1))-th smallest score. */
export function conformalScale(rows, alpha = 0.2) {
  const scores = rows.map((r) => {
    const hw = r.actual >= r.q50 ? r.q90 - r.q50 : r.q50 - r.q10;
    return Math.abs(r.actual - r.q50) / Math.max(hw, 0.05);
  }).sort((a, b) => a - b);
  const n = scores.length;
  if (!n) return { s: 1, n: 0, scores };
  const k = Math.ceil((1 - alpha) * (n + 1));
  const s = k > n ? scores[n - 1] * 1.25 : scores[k - 1];
  return { s: Math.min(3, Math.max(0.6, s)), raw: s, n, k, scores };
}

/** Apply the conformal scale to a phase's simulated completion times. */
export function calibratePhase(R, deadline, s) {
  const q50 = R.q50;
  const done = R.done.map((x) => q50 + s * (x - q50));
  const pOnTime = done.filter((x) => x <= deadline + 1e-9).length / done.length;
  return { done, pOnTime, q10: quantile(done, 0.1), q50: quantile(done, 0.5), q80: quantile(done, 0.8), q90: quantile(done, 0.9) };
}
