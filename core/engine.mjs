// Discrete-event simulator for a Software Factory project: work orders move
// Backlog -> (Blocked on a decision) -> Ready -> In Progress -> In Review
// -> (changes requested -> In Progress -> In Review)* -> Completed,
// competing for three resources: each human's coding slot, a pool of
// concurrent coding-agent sessions, and a pool of human review slots.
//
// The same engine runs the "true" process in scripts/generate.mjs and the
// fitted forecast model in core/forecast.mjs; only the `model` differs.
// Time is measured in working days: day k = [k, k+1), day 0 = Mon Sep 7 2026.

export const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3, 'No Priority': 4 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 2246822519) >>> 0;
  }
  return h >>> 0;
}

// Acklam's inverse normal CDF (abs error < 1.2e-9).
export function invNorm(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

class Heap {
  constructor() { this.a = []; this.seq = 0; }
  push(t, type, id) {
    const a = this.a;
    a.push({ t, s: this.seq++, type, id });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  static lt(x, y) { return x.t < y.t || (x.t === y.t && x.s < y.s); }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.lt(a[l], a[m])) m = l;
        if (r < a.length && Heap.lt(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

export const phaseStart = (p) => 5 * (p - 1);
export const phaseEnd = (p) => 5 * p; // end of Friday

// Per-work-order uniform draws, pre-allocated so that an intervention which
// changes one work order's path leaves every other work order's draws intact
// (common random numbers across scenarios).
const ROUNDS = 6;
export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf, abs error < 1.5e-7
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
// A per-work-order latent "difficulty" z couples its stage draws through a
// Gaussian copula: hard work orders take longer to build, longer to review
// and are more likely to bounce. rho = {dur, rw} (0 = independent stages).
function drawsFor(run, idx, salt, rho) {
  const r = mulberry32(seedOf(run, idx, salt));
  const z = invNorm(Math.min(0.999999, Math.max(1e-6, r())));
  const a = Math.sqrt(Math.max(0, rho?.dur || 0)), b = Math.sqrt(1 - a * a);
  const ap = Math.sqrt(Math.max(0, rho?.rw || 0)), bp = Math.sqrt(1 - ap * ap);
  const cu = () => { const u = r(); return a ? normCdf(a * z + b * invNorm(Math.min(0.999999, Math.max(1e-6, u)))) : u; };
  const cp = () => { const u = r(); return ap ? 1 - normCdf(ap * z + bp * invNorm(Math.min(0.999999, Math.max(1e-6, u)))) : u; };
  const d = { code: cu(), decP: r(), dec: r(), rev: [], rwP: [], rw: [], z };
  for (let k = 0; k < ROUNDS; k++) { d.rev.push(cu()); d.rwP.push(cp()); d.rw.push(cu()); }
  return d;
}

/**
 * Simulate one run.
 * @param {object} o
 *   wos:     [{id, phase, priority, order, assignee, executor:'agent'|'human', type, blockedBy:[], availableAt}]
 *   state:   {id -> snapshot state} (see core/fit.mjs deriveState); missing = pending
 *   model:   {codeDur(w,u,age), reviewDur(w,u,age), reworkDur(w,u,age), decisionDur(w,u,age),
 *             decisionP(w), reworkP(w,round), reviewSlots(day), agentCap}
 *   now:     start time (working days)
 *   run:     integer seed for this run
 *   log:     if true, record a status log per work order (used by the generator)
 *   trace:   if true, record segments and binding constraints for critical-chain analysis
 */
export function simulate(o) {
  const { wos, model, now, run = 0, log = false, trace = false, salt = 0 } = o;
  const state = o.state || {};
  const horizon = o.horizon ?? now + 400;
  const byId = new Map(wos.map((w, i) => [w.id, i]));
  const n = wos.length;
  const S = new Array(n);
  const heap = new Heap();
  const out = { done: new Float64Array(n).fill(Infinity), seg: trace ? [] : null, bind: trace ? [] : null, logs: log ? [] : null };
  const humanBusy = new Map(); // person -> count of active human coding tasks
  let agentBusy = 0, reviewBusy = 0, left = 0;
  const readyHuman = new Set(), readyAgent = new Set();
  const reviewQueue = []; // [{i, since}]
  const dependents = Array.from({ length: n }, () => []);

  const L = (i, t, s, extra) => { if (log) out.logs[i].push(extra ? { t, s, ...extra } : { t, s }); };
  const seg = (i, cat, t0, t1) => { if (trace && t1 > t0) out.seg[i].push([cat, t0, t1]); };

  for (let i = 0; i < n; i++) {
    const w = wos[i];
    if (trace) { out.seg.push([]); out.bind.push(null); }
    if (log) out.logs.push([]);
    const st = state[w.id] || { kind: 'pending' };
    const d = drawsFor(run, seedOf(...[...w.id].map((c) => c.charCodeAt(0))), salt, model.rho);
    S[i] = { w, st, d, round: st.round || 0, depsLeft: 0, avail: false, phase: 'pending', t0: now, waitSince: null, waitCat: null };
    for (const b of w.blockedBy || []) {
      const j = byId.get(b);
      if (j === undefined) continue;
      const sb = state[b];
      if (sb && sb.kind === 'done') continue;
      S[i].depsLeft++;
      dependents[j].push(i);
    }
  }

  const prioKey = (i) => {
    const w = wos[i];
    return w.phase * 100000 + (PRIORITY_RANK[w.priority] ?? 4) * 10000 + (w.order ?? 0);
  };
  const pickBest = (set, pred) => {
    let best = -1, bk = Infinity;
    for (const i of set) { if (pred && !pred(i)) continue; const k = prioKey(i); if (k < bk) { bk = k; best = i; } }
    return best;
  };

  function becomeReady(i, t, viaDecision) {
    const s = S[i];
    s.phase = 'ready';
    s.waitSince = t;
    if (log) L(i, t, 'Ready');
    if (s.w.executor === 'agent') readyAgent.add(i); else readyHuman.add(i);
  }

  function becomeEligible(i, t, binder) {
    const s = S[i];
    if (s.phase !== 'pending') return;
    if (trace) out.bind[i] = binder;
    const w = s.w;
    // Decision gate: with probability q the work order first waits on a decision.
    if (s.d.decP < model.decisionP(w)) {
      s.phase = 'blocked';
      if (log) L(i, t, 'Blocked');
      const dur = model.decisionDur(w, s.d.dec, 0);
      seg(i, 'decision', t, t + dur);
      heap.push(t + dur, 'decisionDone', i);
    } else {
      becomeReady(i, t);
    }
  }

  function checkEligible(i, t, binder) {
    const s = S[i];
    if (s.phase === 'pending' && s.avail && s.depsLeft === 0) becomeEligible(i, t, binder);
  }

  function startCoding(i, t) {
    const s = S[i];
    const w = s.w;
    if (w.executor === 'agent') { readyAgent.delete(i); agentBusy++; } else { readyHuman.delete(i); humanBusy.set(w.assignee, (humanBusy.get(w.assignee) || 0) + 1); }
    if (s.waitSince !== null) seg(i, w.executor === 'agent' ? 'wait_agent' : 'wait_assignee', s.waitSince, t);
    s.phase = 'coding';
    if (log) L(i, t, 'In Progress');
    const dur = s.round === 0 ? model.codeDur(w, s.d.code, 0) : model.reworkDur(w, s.d.rw[Math.min(s.round - 1, ROUNDS - 1)], 0);
    seg(i, s.round === 0 ? (w.executor === 'agent' ? 'agent_coding' : 'human_coding') : 'rework', t, t + dur);
    heap.push(t + dur, 'codeDone', i);
  }

  function enterReview(i, t) {
    const s = S[i];
    s.phase = 'review_wait';
    s.waitSince = t;
    if (log) L(i, t, 'In Review');
    reviewQueue.push({ i, since: t });
  }

  function startReview(i, t) {
    const s = S[i];
    reviewBusy++;
    seg(i, 'wait_review', s.waitSince, t);
    s.phase = 'review';
    if (log) L(i, t, 'In Review', { e: 'review_started' });
    const dur = model.reviewDur(s.w, s.d.rev[Math.min(s.round, ROUNDS - 1)], 0);
    seg(i, 'review', t, t + dur);
    heap.push(t + dur, 'reviewDone', i);
  }

  function complete(i, t) {
    const s = S[i];
    s.phase = 'done';
    out.done[i] = t;
    left--;
    if (log) L(i, t, 'Completed');
    for (const j of dependents[i]) {
      S[j].depsLeft--;
      if (S[j].depsLeft === 0) checkEligible(j, t, { kind: 'dep', i });
    }
  }

  function dispatch(t) {
    // Humans: one coding slot each.
    if (readyHuman.size) {
      const people = new Set([...readyHuman].map((i) => wos[i].assignee));
      for (const p of people) {
        if ((humanBusy.get(p) || 0) >= 1) continue;
        const i = pickBest(readyHuman, (k) => wos[k].assignee === p);
        if (i >= 0) startCoding(i, t);
      }
    }
    while (agentBusy < model.agentCap && readyAgent.size) {
      const i = pickBest(readyAgent);
      startCoding(i, t);
    }
    const slots = model.reviewSlots(Math.floor(t));
    while (reviewBusy < slots && reviewQueue.length) {
      const q = reviewQueue.shift();
      startReview(q.i, t);
    }
  }

  // ---- initialise from snapshot state ----
  left = n;
  for (let i = 0; i < n; i++) {
    const s = S[i];
    const w = s.w;
    const st = s.st;
    if (st.kind === 'done') { s.phase = 'done'; out.done[i] = st.doneAt ?? -1; left--; continue; }
    if (st.kind === 'canceled') { s.phase = 'done'; out.done[i] = -1; left--; continue; }
    if (st.kind === 'pending') {
      const at = Math.max(w.availableAt ?? 0, now);
      if (at <= now) s.avail = true; else heap.push(at, 'avail', i);
      continue;
    }
    s.avail = true;
    if (trace) out.bind[i] = { kind: 'now' };
    if (st.kind === 'blocked') {
      s.phase = 'blocked';
      const dur = Math.max(1e-4, model.decisionDur(w, s.d.dec, st.age || 0) - (st.age || 0)); // residual given elapsed age
      seg(i, 'decision', now, now + dur);
      heap.push(now + dur, 'decisionDone', i);
    } else if (st.kind === 'ready') {
      s.phase = 'ready';
      s.waitSince = now;
      if (w.executor === 'agent') readyAgent.add(i); else readyHuman.add(i);
    } else if (st.kind === 'coding') {
      s.phase = 'coding';
      if (w.executor === 'agent') agentBusy++; else humanBusy.set(w.assignee, (humanBusy.get(w.assignee) || 0) + 1);
      const total = s.round === 0 ? model.codeDur(w, s.d.code, st.age || 0) : model.reworkDur(w, s.d.rw[Math.min(s.round - 1, ROUNDS - 1)], st.age || 0);
      const dur = Math.max(1e-4, total - (st.age || 0));
      seg(i, s.round === 0 ? (w.executor === 'agent' ? 'agent_coding' : 'human_coding') : 'rework', now, now + dur);
      heap.push(now + dur, 'codeDone', i);
    } else if (st.kind === 'review_wait') {
      s.phase = 'review_wait';
      s.waitSince = now;
      reviewQueue.push({ i, since: st.since ?? now });
    } else if (st.kind === 'review') {
      s.phase = 'review';
      reviewBusy++;
      const dur = Math.max(1e-4, model.reviewDur(w, s.d.rev[Math.min(s.round, ROUNDS - 1)], st.age || 0) - (st.age || 0));
      seg(i, 'review', now, now + dur);
      heap.push(now + dur, 'reviewDone', i);
    }
  }
  reviewQueue.sort((a, b) => a.since - b.since);
  for (let i = 0; i < n; i++) {
    const s = S[i];
    if (s.phase === 'pending' && s.avail && s.depsLeft === 0) {
      const ph = phaseStart(s.w.phase);
      becomeEligible(i, now, ph >= now - 1e-9 && (s.w.availableAt ?? 0) <= ph ? { kind: 'phase' } : { kind: 'now' });
    }
  }
  // day ticks so time-varying review capacity takes effect
  for (let day = Math.ceil(now); day < horizon; day++) heap.push(day, 'tick', -1);
  dispatch(now);

  while (heap.size) {
    const ev = heap.pop();
    const t = ev.t;
    if (t > horizon) break;
    const i = ev.id;
    switch (ev.type) {
      case 'avail': {
        S[i].avail = true;
        const w = S[i].w;
        checkEligible(i, t, (w.availableAt ?? 0) > phaseStart(w.phase) ? { kind: 'added' } : { kind: 'phase' });
        break;
      }
      case 'decisionDone':
        becomeReady(i, t);
        break;
      case 'codeDone': {
        const w = wos[i];
        if (w.executor === 'agent') agentBusy--; else humanBusy.set(w.assignee, humanBusy.get(w.assignee) - 1);
        enterReview(i, t);
        break;
      }
      case 'reviewDone': {
        reviewBusy--;
        const s = S[i];
        const r = Math.min(s.round, ROUNDS - 1);
        if (s.round < ROUNDS - 1 && s.d.rwP[r] < model.reworkP(s.w, s.round)) { // at most 5 rework rounds
          s.round++;
          if (log) L(i, t, 'In Progress', { e: 'changes_requested' });
          // rework goes back to the same executor's queue
          s.phase = 'ready';
          s.waitSince = t;
          if (s.w.executor === 'agent') readyAgent.add(i); else readyHuman.add(i);
        } else {
          complete(i, t);
        }
        break;
      }
      case 'tick':
        break;
    }
    if (!heap.size || heap.a[0].t > t) dispatch(t);
    if (left <= 0) break;
  }
  return out;
}

// ---- calendar helpers ----
const BASE = Date.UTC(2026, 8, 7); // Mon Sep 7 2026
export function dayToDate(x) {
  const k = Math.floor(x);
  const week = Math.floor(k / 5), dow = k - week * 5;
  return new Date(BASE + (week * 7 + dow) * 86400000);
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDay(x, withDow = false) {
  // a completion at exactly k.0 means end of day k-1
  const d = dayToDate(Math.max(0, Math.ceil(x) - 1));
  return (withDow ? DOW[d.getUTCDay()] + ' ' : '') + MON[d.getUTCMonth()] + ' ' + d.getUTCDate();
}
export function phaseLabel(p) {
  const a = new Date(BASE + (p - 1) * 7 * 86400000), b = new Date(BASE + ((p - 1) * 7 + 6) * 86400000);
  const am = MON[a.getUTCMonth()], bm = MON[b.getUTCMonth()];
  return am === bm ? `${am} ${a.getUTCDate()} - ${b.getUTCDate()}` : `${am} ${a.getUTCDate()} - ${bm} ${b.getUTCDate()}`;
}
