import { phaseEnd, phaseStart, phaseLabel, fmtDay, dayToDate } from './core/engine.mjs';
import { fitHistory } from './core/fit.mjs';
import { forecast, backtest, conformalScale, calibratePhase, snapshot, quantile, CATS } from './core/forecast.mjs';

const RUNS = 2000;
const P = await (await fetch('data/project.json')).json();
const NOW = P.now;
const CUR = Math.floor(NOW / 5) + 1;
const PHASES = [CUR, CUR + 1, CUR + 2, CUR + 3];
const byId = new Map(P.wos.map((w) => [w.id, w]));
const people = Object.fromEntries(P.people.map((p) => [p.id, p.name]));
const mission = P.wos.find((w) => w.isParent);
const snap = snapshot(P, NOW);

// ---------- board ----------
const STATUS = {
  pending: ['Backlog', 'clock'], blocked: ['Blocked', 'ban'], ready: ['Ready', 'play'], coding: ['In Progress', 'circle-dashed'],
  review_wait: ['In Review', 'git-pull-request'], review: ['In Review', 'git-pull-request'], done: ['Completed', 'circle-check'], canceled: ['Canceled', 'x'],
};
const LABEL_COLOR = { 'bank-feeds': 'blue', integrations: 'yellow', reconciliation: 'green', approvals: 'purple', audit: 'orange', 'multi-currency': 'brown', consolidation: 'pink', close: 'gray', payments: 'red', agents: 'blue', mission: 'purple', bug: 'red', 'spend-controls': 'orange' };
const PRIO_ICON = { Urgent: 'triangle-alert', High: 'signal-high', Medium: 'signal-medium', Low: 'signal-low' };
const statusOf = (w) => {
  if (w.isParent) {
    const kids = w.children.map((c) => snap.state[c]).filter(Boolean);
    return kids.length && kids.every((s) => s.kind === 'done') ? STATUS.done : kids.some((s) => s.kind !== 'pending') ? STATUS.coding : STATUS.pending;
  }
  return STATUS[(snap.state[w.id] || { kind: 'pending' }).kind];
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => (x >= 0.995 && x < 1 ? '>99%' : x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
const tone = (p) => (p < 0.35 ? 'lo' : p < 0.7 ? 'mid' : 'hi');

function card(w, crit) {
  const [st, ic] = statusOf(w);
  const stCls = 'st-' + st.replace(' ', '');
  const isAgent = w.executor === 'agent' && !w.isParent;
  const c = crit?.[w.id] || 0;
  return `<div class="card${c >= 0.3 ? ' on-chain' : ''}" data-wo="${w.id}">
    <div class="top"><span>${w.id}</span><span class="who-wrap">${isAgent ? '<i data-lucide="bot"></i>' : ''}<span class="avatar">${w.assignee}</span></span></div>
    <div class="title">${esc(w.title)}</div>
    <div class="chips">
      <span class="chip neutral">${w.type}</span>
      <span class="chip ${stCls}"><i data-lucide="${ic}"></i>${st}</span>
      <span class="chip neutral"><i data-lucide="${PRIO_ICON[w.priority] || 'signal-medium'}"></i>${w.priority}</span>
    </div>
    ${w.labels?.length ? `<div class="chips">${w.labels.map((l) => `<span class="chip lb-${LABEL_COLOR[l] || 'gray'}">${l}</span>`).join('')}</div>` : ''}
    ${c >= 0.3 ? `<div class="crit"><i data-lucide="route"></i>On the critical path in ${pct(c)} of runs</div>` : ''}
  </div>`;
}

function renderBoard(state) {
  const el = document.getElementById('board');
  el.innerHTML = PHASES.map((p) => {
    const ws = P.wos.filter((w) => w.phase === p && (snap.state[w.id] || w.isParent)).sort((a, b) => a.order - b.order);
    const C = state?.cal?.[p];
    const pill = C ? `<span class="fc-pill ${tone(C.pOnTime)}" title="Chance every work order in Phase ${p} is completed by ${fmtDay(phaseEnd(p), true)}">${pct(C.pOnTime)} on time</span>` : '';
    return `<div class="col"><div class="col-head"><i data-lucide="calendar"></i><span class="ph">Phase ${p}</span><span class="dates">${phaseLabel(p)}</span>${pill}</div>
      <div class="col-body">${ws.map((w) => card(w, state?.crit?.[p])).join('')}<div class="add"><i data-lucide="plus"></i>Add Work Order</div></div></div>`;
  }).join('');
  window.lucide.createIcons();
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('mouseenter', (e) => showTip(e, c.dataset.wo)));
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('mouseleave', hideTip));
}

// ---------- tooltip with per-work-order forecast ----------
const tip = document.createElement('div');
tip.className = 'tip';
document.body.appendChild(tip);
function showTip(e, id) {
  const d = S.woDone?.[id];
  if (!d) return;
  const r = e.currentTarget.getBoundingClientRect();
  tip.innerHTML = `<b>${id}</b> forecast finish<br>50%: ${fmtDay(quantile(d, 0.5), true)} · 80%: ${fmtDay(quantile(d, 0.8), true)}`;
  tip.style.display = 'block';
  tip.style.left = `${Math.min(r.right + 8, innerWidth - 270)}px`;
  tip.style.top = `${r.top + 6}px`;
}
function hideTip() { tip.style.display = 'none'; }

// ---------- compute ----------
const S = { focus: CUR, scenario: null, ivCache: {} };
const panel = document.getElementById('panel');
panel.innerHTML = `<div class="fp-head"><i data-lucide="chart-no-axes-gantt"></i><span class="t">Phase Forecast</span><span class="badge">CONCEPT</span></div><div class="loading">Simulating phases…</div>`;
renderBoard(null);

await new Promise((r) => setTimeout(r, 30));
const fit = fitHistory(P, NOW);
const bt = backtest(P, NOW, { runs: 300 });
const cs = conformalScale(bt.rows);
const missions = [{ id: mission.id, children: mission.children, due: mission.due }];
const base = forecast(P, NOW, { runs: RUNS, phases: PHASES, missions, fit, woDone: true });
S.base = base;
S.cal = Object.fromEntries(PHASES.map((p) => [p, calibratePhase(base.phase[p], phaseEnd(p), cs.s)]));
S.crit = Object.fromEntries(PHASES.map((p) => [p, Object.fromEntries(base.phase[p].critIdx.map((c) => [c.id, c.ci]))]));
S.woDone = Object.fromEntries(Object.entries(base.woDone).map(([k, v]) => [k, v.slice().sort((a, b) => a - b)]));
const M = base.mission[mission.id];
const mDone = M.done.map((x) => M.q50 + cs.s * (x - M.q50));
S.mission = { pOnTime: mDone.filter((x) => x <= mission.due + 1e-9).length / mDone.length, done: mDone, q50: quantile(mDone, 0.5), q80: quantile(mDone, 0.8) };
renderBoard(S);

function interventionsFor(p) {
  if (S.ivCache[p]) return S.ivCache[p];
  const R = base.phase[p];
  const chainIds = R.critIdx.filter((c) => c.ci >= 0.2).map((c) => c.id);
  const notStarted = (id) => ['pending', 'blocked', 'ready'].includes(snap.state[id]?.kind);
  const handoff = chainIds.find((id) => byId.get(id).executor === 'human' && ['Build', 'Fix'].includes(byId.get(id).type) && notStarted(id));
  // tail of the chain: a critical work order in this phase that nothing else in the phase waits on
  const tail = chainIds.find((id) => byId.get(id).phase === p && notStarted(id) && !snap.wos.some((w) => w.phase === p && w.blockedBy.includes(id)));
  const cands = [
    { key: 'rev', icon: 'user-plus', label: 'Add a third reviewer', desc: 'One more review slot every day', iv: { extraReviewer: 1 } },
    { key: 'dec', icon: 'zap', label: 'Same-day decisions', desc: 'Blocked work orders unblocked within half a day', iv: { decisionCap: 0.5 } },
  ];
  if (handoff) cands.push({ key: 'agent', icon: 'bot', label: `Hand ${handoff} to a coding agent`, desc: byId.get(handoff).title, iv: { toAgent: [handoff] } });
  if (tail) cands.push({ key: 'defer', icon: 'calendar-clock', label: `Move ${tail} to Phase ${p + 1}`, desc: byId.get(tail).title, iv: { defer: [tail] }, next: true });
  // same runs, same seeds, same phase list as the baseline: only the change differs (common random numbers)
  const refCal = S.cal;
  for (const c of cands) {
    const f = forecast(P, NOW, { runs: RUNS, phases: PHASES, fit, interventions: c.iv });
    c.cal = Object.fromEntries(PHASES.map((q) => [q, calibratePhase(f.phase[q], phaseEnd(q), cs.s)]));
    c.res = f.phase;
    c.ref = refCal;
    c.gain = c.cal[p].pOnTime - refCal[p].pOnTime;
  }
  cands.sort((a, b) => b.gain - a.gain);
  return (S.ivCache[p] = cands);
}

// ---------- panel ----------
const CAT = {
  human_coding: ['Engineer building', 'var(--chart-3)'],
  agent_coding: ['Agent building', 'var(--pip)'],
  wait_assignee: ['Waiting for the assignee', 'var(--linen-300)'],
  wait_agent: ['Waiting for an agent slot', 'var(--linen-200)'],
  wait_review: ['Waiting for review', 'var(--status-in-review-base)'],
  review: ['In review', 'var(--status-in-review-indicator)'],
  rework: ['Rework after review', 'var(--status-in-progress-base)'],
  decision: ['Blocked on a decision', 'var(--status-blocked-base)'],
};

function histogram(done, deadline, q50, q80, baseline) {
  const W = 420, H = 132, padL = 4, padB = 22, padT = 8;
  const lo = Math.floor(NOW), hi = Math.max(Math.ceil(quantile(done, 0.985)) + 1, Math.ceil(deadline) + 2, lo + 6);
  const nb = hi - lo;
  const bins = new Array(nb).fill(0), bb = new Array(nb).fill(0);
  for (const x of done) bins[Math.min(nb - 1, Math.max(0, Math.ceil(x) - 1 - lo))]++;
  if (baseline) for (const x of baseline) bb[Math.min(nb - 1, Math.max(0, Math.ceil(x) - 1 - lo))]++;
  const mx = Math.max(...bins.map((b) => b / done.length), ...(baseline ? bb.map((b) => b / baseline.length) : [0]));
  const bw = (W - padL) / nb;
  const y = (v) => padT + (H - padB - padT) * (1 - v / mx);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
  for (let g = 0; g <= 3; g++) { const yy = padT + (H - padB - padT) * g / 3; s += `<line x1="0" x2="${W}" y1="${yy}" y2="${yy}" stroke="var(--linen-100)" stroke-width="1"/>`; }
  for (let k = 0; k < nb; k++) {
    const x = padL + k * bw;
    const late = lo + k + 1 > deadline + 1e-9;
    const v = bins[k] / done.length;
    s += `<rect x="${x + 1.5}" y="${y(v)}" width="${bw - 3}" height="${Math.max(0, H - padB - y(v))}" rx="2" fill="${late ? 'var(--status-blocked-base)' : 'var(--status-completed-base)'}" opacity="${late ? 0.75 : 0.85}"><title>${fmtDay(lo + k + 1, true)}: ${pct(v)}</title></rect>`;
    if (baseline) { const vb = bb[k] / baseline.length; s += `<rect x="${x + 1.5}" y="${y(vb)}" width="${bw - 3}" height="${Math.max(0, H - padB - y(vb))}" rx="2" fill="none" stroke="var(--linen-600)" stroke-dasharray="2 2"/>`; }
    const d = dayToDate(lo + k);
    if (d.getUTCDay() === 1 || k === 0) s += `<text x="${x + 2}" y="${H - 6}" font-size="10.5" fill="var(--linen-500)">${fmtDay(lo + k + 1)}</text>`;
  }
  const xd = padL + (deadline - lo) * bw;
  s += `<line x1="${xd}" x2="${xd}" y1="2" y2="${H - padB + 2}" stroke="var(--foreground)" stroke-width="1" stroke-dasharray="3 3"/>`;
  s += `<text x="${xd - 4}" y="11" font-size="10.5" text-anchor="end" fill="var(--linen-700)">Phase end</text>`;
  return s + '</svg>';
}

function renderPanel() {
  const p = S.focus;
  const isMission = p === 'mission';
  let html = `<div class="fp-head"><i data-lucide="chart-no-axes-gantt"></i><span class="t">Phase Forecast</span><span class="badge">CONCEPT</span><span class="grow"></span><button class="icon-btn" aria-label="Close"><i data-lucide="x"></i></button></div><div class="fp-body">`;
  html += `<div class="seg">${PHASES.map((q) => `<button data-f="${q}" class="${q === p ? 'on' : ''}">Phase ${q}</button>`).join('')}<button data-f="mission" class="${isMission ? 'on' : ''}">Bank Feeds GA</button></div>`;
  if (isMission) { panel.innerHTML = html + missionView() + '</div>'; return wire(); }

  const sc = S.scenario && S.ivCache[p]?.find((c) => c.key === S.scenario);
  const C = sc ? sc.cal[p] : S.cal[p];
  const R = sc ? sc.res[p] : base.phase[p]; // breakdown and chain follow the active scenario
  const vel = base.velocity[p];
  if (sc) html += `<div class="scen"><i data-lucide="sparkles"></i>Scenario: ${esc(sc.label)}<button data-reset>Reset</button></div>`;
  html += `<div class="hero"><div class="big ${tone(C.pOnTime)}">${pct(C.pOnTime)}</div><div class="lbl">chance every work order in Phase ${p}<br>is completed by <b>${fmtDay(phaseEnd(p), true)}</b></div></div>`;
  html += `<div class="kv"><div><div class="k">Likely finish</div><div class="v">${fmtDay(C.q50, true)}</div></div><div><div class="k">80% confident by</div><div class="v">${fmtDay(C.q80, true)}</div></div><div><div class="k">Burn-up projection</div><div class="v strike" title="Remaining work orders ÷ last 10 days' throughput">${fmtDay(vel.at, true)}</div></div></div>`;
  html += `<div><div class="sec-t">Finish date distribution<span class="sub">${RUNS.toLocaleString()} runs · calibrated</span></div>${histogram(C.done, phaseEnd(p), C.q50, C.q80, sc ? S.cal[p].done : null)}</div>`;

  // where the critical path waits
  const share = R.catShare;
  const cats = CATS.filter((c) => share[c] > 0.004).sort((a, b) => share[b] - share[a]);
  html += `<div><div class="sec-t">Where the critical path waits<span class="sub">avg ${(CATS.reduce((s, c) => s + R.catDays[c], 0)).toFixed(1)} working days</span></div>
    <div class="stack">${cats.map((c) => `<span style="width:${share[c] * 100}%;background:${CAT[c][1]}" title="${CAT[c][0]}"></span>`).join('')}</div>
    <div class="legend">${cats.map((c) => `<span><i class="sw" style="background:${CAT[c][1]}"></i>${CAT[c][0]}</span><span class="n">${R.catDays[c] < 0.05 ? '<0.1' : R.catDays[c].toFixed(1)} d</span><span class="n">${pct(share[c])}</span>`).join('')}</div>
    <div class="note" style="margin-top:8px">Agents are ${pct(share.agent_coding)} of the path; ${pct(share.wait_review + share.review + share.decision)} is review and decisions.</div></div>`;

  // critical chain
  const chain = R.critIdx.filter((c) => c.ci >= 0.15).slice(0, 6);
  const depth = (id, g = 0) => { const w = byId.get(id); const d = (w?.blockedBy || []).filter((b) => snap.state[b]?.kind !== 'done'); return d.length && g < 8 ? 1 + Math.max(...d.map((b) => depth(b, g + 1))) : 0; };
  chain.sort((a, b) => depth(a.id) - depth(b.id) || b.ci - a.ci);
  html += `<div><div class="sec-t">Critical chain<span class="sub">share of runs a work order sets the finish</span></div><div class="chain">${chain.map((c, k) => {
    const w = byId.get(c.id);
    const [st] = statusOf(w);
    return `<div class="row" data-wo="${w.id}"><span class="idx">${k + 1}</span><div class="nm"><div class="ttl">${esc(w.title)}</div><div class="meta">${w.id} · ${st} · ${w.executor === 'agent' ? 'agent' : people[w.assignee] || w.assignee} · Phase ${w.phase}</div></div><span class="pct">${pct(c.ci)}</span></div>`;
  }).join('') || '<div class="row"><span></span><div class="nm muted">No dominant chain: risk is spread across the phase.</div><span></span></div>'}</div></div>`;

  // interventions
  const ivs = interventionsFor(p);
  html += `<div><div class="sec-t">What would move the date<span class="sub">same ${RUNS.toLocaleString()} runs, one change</span></div><div class="ivs">${ivs.map((c) => {
    const a = c.ref[p].pOnTime, b = c.cal[p].pOnTime;
    const nx = c.next && c.cal[p + 1] && c.ref[p + 1] ? `<div class="d">Phase ${p + 1}: ${pct(c.ref[p + 1].pOnTime)} → ${pct(c.cal[p + 1].pOnTime)}</div>` : '';
    return `<div class="iv${S.scenario === c.key ? ' on' : ''}" data-iv="${c.key}"><span class="ic"><i data-lucide="${c.icon}"></i></span><div><div>${esc(c.label)}</div><div class="d">${esc(c.desc)}</div></div><div class="delta"><span class="muted">${pct(a)} →</span> <b class="${b > a + 0.005 ? 'up' : b < a - 0.005 ? 'down' : ''}">${pct(b)}</b>${nx}</div></div>`;
  }).join('')}</div></div>`;

  // calibration + model
  const f = fit;
  const capMean = f.capDays.reduce((s, x) => s + x, 0) / f.capDays.length;
  const one = f.capDays.filter((x) => x === 1).length / f.capDays.length;
  const rw = (ex) => { const [a, b] = f.reworkBeta[ex][0]; return a / (a + b); };
  html += `<div><div class="sec-t">Backtest on this project</div><div class="calib">
      <div><div class="k">Past forecasts</div><div class="v">${bt.n}</div></div>
      <div><div class="k">80% range hit</div><div class="v">${pct(bt.rows.filter((r) => { const hw1 = r.q50 - r.q10, hw2 = r.q90 - r.q50; return r.actual >= r.q50 - cs.s * hw1 - 1e-9 && r.actual <= r.q50 + cs.s * hw2 + 1e-9; }).length / bt.n)}</div></div>
      <div><div class="k">Brier score</div><div class="v">${bt.brier.toFixed(2)} <small>vs ${bt.brierVel.toFixed(2)} burn-up</small></div></div>
    </div>
    <div class="note" style="margin-top:8px">Forecasts replayed from Tuesdays and Thursdays of Phases ${bt.rows[0]?.phase}-${bt.rows[bt.rows.length - 1]?.phase} using only the history available then. Ranges are rescaled by s = ${cs.s.toFixed(2)} (split-conformal on those ${bt.n} forecasts).</div></div>`;
  html += `<div><div class="sec-t">What the model learned</div><div class="note">
      ${f.counts.codeSpells} build spells (${f.counts.censored} still open, kept as censored) · ${f.counts.reviews} reviews · ${f.counts.decisions} decisions<br>
      Median build: agent ${f.codeKM['agent|Build'] ? f.codeKM['agent|Build'].quantile(0.5).toFixed(2) : '–'} d, engineer ${f.codeKM['human|Build'] ? f.codeKM['human|Build'].quantile(0.5).toFixed(2) : '–'} d · median review ${f.reviewKM.agent.quantile(0.5).toFixed(2)} d<br>
      Bounced in first review: agents ${pct(rw('agent'))}, engineers ${pct(rw('human'))} · review capacity ${capMean.toFixed(1)} slots (1 on ${pct(one)} of days)<br>
      Unplanned fixes: ${f.unplanned.mean.toFixed(1)} per phase · difficulty coupling ρ = ${f.rho.dur.toFixed(2)}</div></div>`;
  panel.innerHTML = html + '</div>';
  wire();
}

function missionView() {
  const m = S.mission;
  const kids = mission.children.map((id) => byId.get(id)).filter(Boolean);
  const done = kids.filter((w) => snap.state[w.id]?.kind === 'done').length;
  let h = `<div class="hero"><div class="big ${tone(m.pOnTime)}">${pct(m.pOnTime)}</div><div class="lbl">chance <b>${esc(mission.title)}</b><br>(${mission.id}) lands by <b>${fmtDay(mission.due, true)}</b></div></div>`;
  h += `<div class="kv"><div><div class="k">Likely finish</div><div class="v">${fmtDay(m.q50, true)}</div></div><div><div class="k">80% confident by</div><div class="v">${fmtDay(m.q80, true)}</div></div><div><div class="k">Child work orders</div><div class="v">${done} / ${kids.length} done</div></div></div>`;
  h += `<div><div class="sec-t">Finish date distribution<span class="sub">${RUNS.toLocaleString()} runs · calibrated</span></div>${histogram(m.done, mission.due, m.q50, m.q80)}</div>`;
  h += `<div><div class="sec-t">Children by forecast finish</div><div class="chain">${kids.filter((w) => S.woDone[w.id]).sort((a, b) => quantile(S.woDone[b.id], 0.8) - quantile(S.woDone[a.id], 0.8)).slice(0, 8).map((w, k) => {
    const [st] = statusOf(w);
    return `<div class="row" data-wo="${w.id}"><span class="idx">${k + 1}</span><div class="nm"><div class="ttl">${esc(w.title)}</div><div class="meta">${w.id} · ${st} · Phase ${w.phase}</div></div><span class="pct">${fmtDay(quantile(S.woDone[w.id], 0.8))}</span></div>`;
  }).join('')}</div><div class="note" style="margin-top:6px">Right column: 80% confident finish for each child.</div></div>`;
  return h;
}

function wire() {
  window.lucide.createIcons();
  panel.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    S.focus = b.dataset.f === 'mission' ? 'mission' : +b.dataset.f;
    S.scenario = null;
    renderPanel();
  }));
  panel.querySelectorAll('[data-iv]').forEach((b) => b.addEventListener('click', () => {
    S.scenario = S.scenario === b.dataset.iv ? null : b.dataset.iv;
    renderPanel();
  }));
  panel.querySelector('[data-reset]')?.addEventListener('click', () => { S.scenario = null; renderPanel(); });
  panel.querySelectorAll('.chain .row[data-wo]').forEach((r) => r.addEventListener('click', () => {
    document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
    const c = document.querySelector(`.card[data-wo="${r.dataset.wo}"]`);
    if (c) { c.classList.add('sel'); c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }));
}

// deep links: #phase=11, #phase=mission, #phase=10&scenario=rev
const hp = new URLSearchParams(location.hash.slice(1));
if (hp.get('phase')) S.focus = hp.get('phase') === 'mission' ? 'mission' : +hp.get('phase');
if (hp.get('scenario') && S.focus !== 'mission') { interventionsFor(S.focus); S.scenario = hp.get('scenario'); }
renderPanel();
window.__forecastReady = true;
