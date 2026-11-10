// Learn the forecast model from a project's work-order activity history.
// Everything here is estimated from status transitions and linked-PR review
// events as they would appear in a Software Factory project; nothing is read
// from the generator's hidden parameters.

import { phaseStart, phaseEnd, invNorm } from './engine.mjs';

/** Kaplan-Meier survival curve with right-censoring, piecewise-linear between
 *  event times and an exponential tail past the last observation. */
export class KM {
  constructor(durations, observed) {
    const rows = durations.map((d, i) => [Math.max(1e-4, d), observed[i] ? 1 : 0]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    this.n = rows.length;
    this.nEvents = rows.reduce((s, r) => s + r[1], 0);
    this.t = [0];
    this.s = [1];
    let atRisk = rows.length, surv = 1, i = 0;
    while (i < rows.length) {
      const tt = rows[i][0];
      let d = 0, c = 0;
      while (i < rows.length && rows[i][0] === tt) { if (rows[i][1]) d++; else c++; i++; }
      if (d > 0) { surv *= 1 - d / atRisk; this.t.push(tt); this.s.push(surv); }
      atRisk -= d + c;
    }
    this.tMax = rows.length ? rows[rows.length - 1][0] : 0;
    const sLast = this.s[this.s.length - 1];
    const tLast = this.t[this.t.length - 1];
    // constant hazard consistent with the observed decay, used past the data
    this.sLast = sLast;
    this.tLast = tLast;
    this.lambda = sLast > 0 && tLast > 0 ? -Math.log(sLast) / tLast : 0;
    if (sLast > 0 && this.lambda === 0) this.lambda = 1 / Math.max(this.tMax, 0.5);
  }
  S(x) {
    if (x <= 0) return 1;
    const { t, s } = this;
    if (x >= this.tLast) return this.sLast * Math.exp(-this.lambda * (x - this.tLast));
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
    const f = (x - t[lo]) / (t[hi] - t[lo]);
    return s[lo] + f * (s[hi] - s[lo]);
  }
  /** Inverse-transform draw of T given T > age. */
  sample(u, age = 0) {
    const target = Math.max(1e-12, u) * this.S(age);
    const { t, s } = this;
    if (target < this.sLast) {
      if (this.lambda <= 0) return Math.max(age, this.tLast);
      return Math.max(age, this.tLast) + (Math.log(Math.min(this.sLast, this.S(Math.max(age, this.tLast)))) - Math.log(target)) / this.lambda;
    }
    // first index where s <= target
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] > target) lo = m; else hi = m; }
    if (s[hi] > target) return Math.max(age, t[hi]);
    const f = (s[lo] - target) / (s[lo] - s[hi] || 1);
    return Math.max(age + 1e-6, t[lo] + f * (t[hi] - t[lo]));
  }
  quantile(p) { return this.sample(1 - p, 0); }
  mean() {
    // restricted mean to tLast plus the exponential tail
    let m = 0;
    for (let k = 1; k < this.t.length; k++) m += (this.t[k] - this.t[k - 1]) * (this.s[k] + this.s[k - 1]) / 2;
    if (this.lambda > 0) m += this.sLast / this.lambda;
    return m;
  }
}

// Gamma(shape, 1) by Marsaglia-Tsang; used for Beta posteriors.
export function sampleGamma(k, rnd) {
  if (k < 1) return sampleGamma(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box-Muller
      const u1 = Math.max(1e-12, rnd()), u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function sampleBeta(a, b, rnd) {
  const x = sampleGamma(a, rnd), y = sampleGamma(b, rnd);
  return x / (x + y);
}

/** Status of one work order as of time t, from its activity log. */
export function deriveState(events, t) {
  const ev = events.filter((e) => e.t < t);
  if (!ev.length) return null; // not created yet
  const last = ev[ev.length - 1];
  const rounds = ev.filter((e) => e.e === 'changes_requested').length;
  switch (last.s) {
    case 'Completed': return { kind: 'done', doneAt: last.t };
    case 'Canceled': return { kind: 'canceled' };
    case 'Backlog': return { kind: 'pending' };
    case 'Blocked': return { kind: 'blocked', age: t - last.t };
    case 'Ready': return { kind: 'ready', round: rounds };
    case 'In Progress':
      if (last.e === 'changes_requested') return { kind: 'ready', round: rounds };
      return { kind: 'coding', round: rounds, age: t - last.t };
    case 'In Review':
      if (last.e === 'review_started') return { kind: 'review', round: rounds, age: t - last.t };
      return { kind: 'review_wait', round: rounds, since: last.t };
    default: return { kind: 'pending' };
  }
}

const TYPES = ['Build', 'Fix', 'Requirements', 'Blueprint', 'Knowledge Base', 'Other'];

/** Fit every component of the forecast model from history strictly before t. */
export function fitHistory(project, t, opts = {}) {
  const capWindow = opts.capWindow ?? 15;
  const wos = project.wos.filter((w) => !w.isParent);
  const code = {}, rework = {}, review = {}, decision = { d: [], o: [] };
  const push = (obj, key, d, o) => { (obj[key] ||= { d: [], o: [] }); obj[key].d.push(d); obj[key].o.push(o); };
  const decCount = {}; // type -> [blocked, eligible]
  const rwCount = { agent: [[0, 0], [0, 0]], human: [[0, 0], [0, 0]] }; // [round0, round1+] -> [changes, reviews]
  const reviewIntervals = []; // [enterQueue, startService, end]
  const unplanned = {}; // phase -> {n, agent}
  const perWo = []; // completed work orders: {codeKey, code, revKey, rev, rw}

  for (const w of wos) {
    const ev = (project.events[w.id] || []).filter((e) => e.t < t);
    if (!ev.length) continue;
    if (w.createdAt > phaseStart(w.phase) + 1e-9) {
      (unplanned[w.phase] ||= { n: 0, agent: 0 });
      unplanned[w.phase].n++;
      if (w.executor === 'agent') unplanned[w.phase].agent++;
    }
    let round = 0, codeStart = null, reviewEnter = null, reviewStart = null, blockedAt = null, leftBacklog = false;
    for (let k = 0; k < ev.length; k++) {
      const e = ev[k];
      if (!leftBacklog && (e.s === 'Blocked' || e.s === 'Ready')) {
        leftBacklog = true;
        (decCount[w.type] ||= [0, 0])[1]++;
        if (e.s === 'Blocked') decCount[w.type][0]++;
      }
      if (e.s === 'Blocked') blockedAt = e.t;
      if (e.s === 'Ready' && blockedAt !== null) { decision.d.push(e.t - blockedAt); decision.o.push(1); blockedAt = null; }
      if (e.s === 'In Progress' && !e.e) codeStart = e.t;
      if (e.s === 'In Progress' && e.e === 'changes_requested') {
        if (reviewStart !== null) { push(review, w.executor, e.t - reviewStart, 1); reviewIntervals.push([reviewEnter, reviewStart, e.t]); }
        rwCount[w.executor][Math.min(round, 1)][0]++;
        rwCount[w.executor][Math.min(round, 1)][1]++;
        round++;
        reviewStart = null; reviewEnter = null; codeStart = null;
      }
      if (e.s === 'In Review' && !e.e) {
        if (codeStart !== null) {
          if (round === 0) push(code, `${w.executor}|${w.type}`, e.t - codeStart, 1);
          else push(rework, w.executor, e.t - codeStart, 1);
        }
        codeStart = null;
        reviewEnter = e.t;
      }
      if (e.e === 'review_started') reviewStart = e.t;
      if (e.s === 'Completed') {
        if (reviewStart !== null) { push(review, w.executor, e.t - reviewStart, 1); reviewIntervals.push([reviewEnter, reviewStart, e.t]); }
        rwCount[w.executor][Math.min(round, 1)][1]++;
        reviewStart = null;
      }
    }
    {
      const fc = ev.findIndex((e) => e.s === 'In Progress' && !e.e);
      const fr = ev.findIndex((e) => e.s === 'In Review' && !e.e);
      const rs = ev.findIndex((e) => e.e === 'review_started');
      const done = ev.find((e) => e.s === 'Completed');
      if (done && fc >= 0 && fr > fc && rs > fr) {
        const end = ev.slice(rs + 1).find((e) => e.e === 'changes_requested' || e.s === 'Completed');
        perWo.push({ codeKey: `${w.executor}|${w.type}`, code: ev[fr].t - ev[fc].t, revKey: w.executor, rev: end.t - ev[rs].t, rw: ev.some((e) => e.e === 'changes_requested') ? 1 : 0 });
      }
    }
    // right-censored spells still open at t
    if (blockedAt !== null) { decision.d.push(t - blockedAt); decision.o.push(0); }
    if (codeStart !== null) {
      if (round === 0) push(code, `${w.executor}|${w.type}`, t - codeStart, 0);
      else push(rework, w.executor, t - codeStart, 0);
    }
    if (reviewStart !== null) { push(review, w.executor, t - reviewStart, 0); reviewIntervals.push([reviewEnter, reviewStart, t]); }
    else if (reviewEnter !== null) reviewIntervals.push([reviewEnter, t, t]);
  }

  // ---- duration curves, with fallback from (executor, type) to executor ----
  const km = (o) => new KM(o.d, o.o.map(Boolean));
  const codeKM = {};
  const pooled = { agent: { d: [], o: [] }, human: { d: [], o: [] } };
  for (const [k, o] of Object.entries(code)) { const ex = k.split('|')[0]; pooled[ex].d.push(...o.d); pooled[ex].o.push(...o.o); }
  const pooledKM = { agent: km(pooled.agent), human: km(pooled.human) };
  const strata = [];
  for (const ex of ['agent', 'human']) for (const ty of TYPES) {
    const o = code[`${ex}|${ty}`];
    const ev = o ? o.o.reduce((a, b) => a + b, 0) : 0;
    if (o && ev >= 12) { codeKM[`${ex}|${ty}`] = km(o); strata.push({ key: `${ex}|${ty}`, n: o.d.length, events: ev, pooled: false }); }
    else if (o) strata.push({ key: `${ex}|${ty}`, n: o.d.length, events: ev, pooled: true });
  }
  const reworkKM = { agent: km(rework.agent || { d: [], o: [] }), human: km(rework.human || { d: [], o: [] }) };
  const reviewKM = { agent: km(review.agent || { d: [], o: [] }), human: km(review.human || { d: [], o: [] }) };
  const decisionKM = km(decision);

  // ---- decision gate probability by type, shrunk toward the overall rate ----
  let tb = 0, te = 0;
  for (const [b, e] of Object.values(decCount)) { tb += b; te += e; }
  const m = (tb + 1) / (te + 2), a0 = 6;
  const decisionBeta = {};
  for (const ty of TYPES) {
    const [b, e] = decCount[ty] || [0, 0];
    decisionBeta[ty] = [a0 * m + b, a0 * (1 - m) + e - b];
  }
  const reworkBeta = {};
  for (const ex of ['agent', 'human']) reworkBeta[ex] = rwCount[ex].map(([k, nn]) => [1 + k, 1 + nn - k]);

  // ---- review capacity, learned on days when PRs were queuing ----
  const capDays = reviewCapacityDays(reviewIntervals, t, capWindow);

  // ---- unplanned work added mid-phase (Gamma-Poisson) ----
  let up = 0, upAgent = 0, phasesSeen = 0;
  for (let p = 1; phaseEnd(p) <= t; p++) {
    phasesSeen++;
    if (unplanned[p]) { up += unplanned[p].n; upAgent += unplanned[p].agent; }
  }

  // ---- recent throughput for the velocity baseline ----
  let recent = 0;
  for (const w of wos) {
    const ev = (project.events[w.id] || []).find((e) => e.s === 'Completed');
    if (ev && ev.t < t && ev.t >= t - 10) recent++;
  }

  const rho = difficultyCorrelation(perWo);
  const upCounts = [];
  for (let p = 1; phaseEnd(p) <= t; p++) upCounts.push(unplanned[p] ? unplanned[p].n : 0);
  const upMean = upCounts.reduce((a, b) => a + b, 0) / Math.max(1, upCounts.length);
  const upVar = upCounts.reduce((a, b) => a + (b - upMean) ** 2, 0) / Math.max(1, upCounts.length - 1);
  return {
    t, codeKM, pooledKM,
    spells: { code, pooled, rework, review, decision },
    rho, reworkKM, reviewKM, decisionKM, decisionBeta, reworkBeta, capDays,
    unplanned: {
      shape: 1 + up, rate: 1 + phasesSeen, agentShare: (upAgent + 1) / (up + 2), perPhase: (1 + up) / (1 + phasesSeen),
      counts: upCounts, mean: upMean, variance: upVar,
      // negative-binomial size when phases vary more than Poisson would allow
      dispersion: upVar > upMean * 1.05 && upMean > 0 ? (upMean * upMean) / (upVar - upMean) : Infinity,
    },
    agentCap: project.settings?.maxConcurrentAgents ?? 6,
    velocity: recent / 10,
    strata,
    counts: {
      codeSpells: Object.values(code).reduce((s, o) => s + o.d.length, 0),
      censored: Object.values(code).reduce((s, o) => s + o.o.filter((x) => !x).length, 0) + decision.o.filter((x) => !x).length + Object.values(review).reduce((s, o) => s + o.o.filter((x) => !x).length, 0),
      reviews: Object.values(review).reduce((s, o) => s + o.d.length, 0),
      decisions: decision.d.length,
    },
  };
}

/** For each working day in the window, the number of reviews in service while
 *  at least one PR was waiting (= that day's review capacity). Days on which
 *  nothing queued only give a lower bound and are used if they hit the max. */
export function reviewCapacityDays(intervals, t, window) {
  const out = [];
  let maxSeen = 0;
  const lower = [];
  for (let day = Math.max(0, Math.floor(t) - window); day < Math.floor(t); day++) {
    const a = day, b = day + 1;
    const pts = new Set([a, b]);
    for (const [q, s, e] of intervals) for (const x of [q, s, e]) if (x > a && x < b) pts.add(x);
    const xs = [...pts].sort((x, y) => x - y);
    let congestedMax = -1, anyMax = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      const mid = (xs[k] + xs[k + 1]) / 2;
      let waiting = 0, service = 0;
      for (const [q, s, e] of intervals) {
        if (q <= mid && mid < s) waiting++;
        else if (s <= mid && mid < e) service++;
      }
      anyMax = Math.max(anyMax, service);
      if (waiting > 0 && xs[k + 1] - xs[k] > 0.02) congestedMax = Math.max(congestedMax, service);
    }
    maxSeen = Math.max(maxSeen, anyMax);
    if (congestedMax >= 1) out.push(congestedMax);
    else lower.push(anyMax);
  }
  for (const l of lower) if (l >= maxSeen && maxSeen > 0) out.push(l);
  if (!out.length) out.push(Math.max(1, maxSeen));
  return out;
}

/** Latent difficulty correlation from completed work orders: normal scores of
 *  within-stratum ranks for build time and review time (Pearson on scores),
 *  and the biserial correlation between build-time score and bouncing in review. */
export function difficultyCorrelation(rows) {
  const ns = (key, val) => {
    const groups = {};
    rows.forEach((r, i) => (groups[r[key]] ||= []).push(i));
    const z = new Array(rows.length);
    for (const idx of Object.values(groups)) {
      idx.sort((a, b) => rows[a][val] - rows[b][val]);
      idx.forEach((i, k) => { z[i] = invNorm((k + 1) / (idx.length + 1)); });
    }
    return z;
  };
  if (rows.length < 12) return { dur: 0, rw: 0, n: rows.length };
  const zc = ns('codeKey', 'code'), zr = ns('revKey', 'rev');
  const pear = (x, y) => {
    const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy || 1);
  };
  const dur = Math.max(0, Math.min(0.8, pear(zc, zr)));
  const y = rows.map((r) => r.rw);
  const p = y.reduce((a, b) => a + b, 0) / y.length;
  let rw = 0;
  if (p > 0.03 && p < 0.97) {
    const rpb = pear(zc, y);
    const h = invNorm(1 - p);
    const phi = Math.exp(-h * h / 2) / Math.sqrt(2 * Math.PI);
    rw = Math.max(0, Math.min(0.8, rpb * Math.sqrt(p * (1 - p)) / phi));
  }
  return { dur, rw, n: rows.length };
}
