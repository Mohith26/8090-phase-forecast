// Seeded synthetic Software Factory project ("Ledger Plus"): 14 weekly phases
// of work orders, executed by six engineers and their coding agents, with the
// ground-truth process simulated by core/engine.mjs under a hidden model that
// the forecaster never sees (lognormal durations scaled by a per-work-order
// complexity factor, day-to-day reviewer availability, unplanned fixes).
//
//   node scripts/generate.mjs        -> data/project.json (history up to NOW)
//                                       data/truth.json   (full future + hidden params, tests only)

import { simulate, mulberry32, seedOf, invNorm, phaseStart } from '../core/engine.mjs';

export const NOW = 46; // Tue Nov 10 2026, 9:00 (working day 46 = phase 10, day 2)

export function generate(SEED = 8090) {
const PHASES = 14;
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const wpick = (pairs) => { let u = rnd() * pairs.reduce((s, p) => s + p[1], 0); for (const [v, w] of pairs) { if ((u -= w) <= 0) return v; } return pairs[0][0]; };

const people = [
  { id: 'AW', name: 'Ava Wright' }, { id: 'JC', name: 'Jon Chen' }, { id: 'JY', name: 'Jia Yu' },
  { id: 'MB', name: 'Marcus Bell' }, { id: 'PN', name: 'Priya Nair' }, { id: 'SO', name: 'Sam Ortiz' },
];

// Hand-written titles for the phases visible on the board (8-13); earlier
// phases use templated titles (they only feed the history and the backtest).
const TITLES = {
  8: ['Normalize Plaid transaction categories into ledger accounts', 'Add idempotency keys to journal entry API', 'Requirements for multi-entity consolidation', 'Fix rounding drift in FX revaluation job', 'Blueprint: event-sourced posting engine', 'Implement trial balance export to CSV', 'Backfill counterparty IDs for legacy vendors', 'Add audit trail to manual journal edits', 'Fix duplicate webhook delivery on retries', 'Build period close checklist UI', 'Paginate general ledger detail report'],
  9: ['Implement bank feed connection health checks', 'Requirements for approval policies on payments', 'Build vendor bill OCR intake queue', 'Fix timezone bug in daily cash position', 'Add role-scoped access to entity settings', 'Blueprint: approvals workflow service', 'Implement accrual reversal scheduler', 'Fix stale balances after feed reconnection', 'Build reconciliation rules editor', 'Add Slack alerts for failed syncs', 'Implement ledger snapshot API for auditors', 'Migrate chart of accounts to versioned schema'],
  10: ['Implement bank feed transaction matcher', 'Build reconciliation exceptions inbox', 'Requirements for bank feed GA rollout', 'Add retry and backoff to bank feed sync worker', 'Fix double-posting when feeds overlap', 'Implement payment approval chains', 'Build approver delegation settings', 'Blueprint: bank feed matching service', 'Add multi-currency support to cash dashboard', 'Fix CSV import losing memo fields', 'Expose reconciliation status in MCP tools', 'Write runbook for feed outage handling', 'Implement statement balance assertions'],
  11: ['Build match confidence review screen', 'Implement auto-categorization rules from history', 'Add bulk approve to exceptions inbox', 'Requirements for audit evidence packages', 'Implement approval audit export', 'Fix slow ledger query on large entities', 'Build feed coverage report by institution', 'Add SOC 2 evidence links to close checklist', 'Implement payment run scheduling', 'Fix currency rounding in approval thresholds', 'Blueprint: audit evidence pipeline', 'Build entity-level feature flags'],
  12: ['Implement bank feed GA migration for existing tenants', 'Build matcher accuracy dashboard', 'Add customer-facing feed status page', 'Implement evidence package generator', 'Requirements for intercompany eliminations', 'Fix pagination on vendor ledger', 'Build approval SLA reminders', 'Add webhook signing for feed events', 'Implement close lock with override audit', 'Harden feed credential rotation', 'Load test matcher at 1M transactions/day'],
  13: ['Launch bank feeds GA to all tenants', 'Build intercompany elimination entries', 'Implement auditor read-only workspace', 'Add consolidation report by entity', 'Fix approval email deep links', 'Blueprint: consolidation engine', 'Implement scheduled evidence exports', 'Build onboarding checklist for new entities', 'Add anomaly flags to journal entries', 'Requirements for spend controls'],
  14: ['Implement spend control policies', 'Build consolidation currency translation', 'Add auditor comment threads', 'Fix report caching after close lock', 'Implement card feed ingestion', 'Build policy violation inbox', 'Add entity templates', 'Implement variance explanations', 'Blueprint: spend controls service', 'Fix dashboard load time on mobile'],
};
const VERBS = ['Implement', 'Build', 'Add', 'Fix', 'Refactor', 'Harden', 'Document'];
const NOUNS = ['ledger posting API', 'journal import', 'chart of accounts editor', 'tenant onboarding flow', 'invoice sync', 'cash dashboard', 'role permissions', 'GL detail report', 'vendor master', 'webhook delivery', 'entity settings', 'search index', 'approval inbox', 'FX rates job', 'audit log', 'CSV export', 'period close', 'sandbox seeding', 'API rate limits', 'error reporting'];

const typeFor = (title) => {
  if (title.startsWith('Requirements')) return 'Requirements';
  if (title.startsWith('Blueprint')) return 'Blueprint';
  if (title.startsWith('Fix')) return 'Fix';
  if (title.startsWith('Write') || title.startsWith('Document')) return 'Knowledge Base';
  if (title.startsWith('Load test') || title.startsWith('Launch')) return 'Other';
  return 'Build';
};
const LABELS = {
  feed: ['bank-feeds', 'integrations'], match: ['bank-feeds', 'reconciliation'], reconcil: ['reconciliation'], approv: ['approvals'], audit: ['audit'], evidence: ['audit'],
  MCP: ['agents', 'integrations'], currency: ['multi-currency'], FX: ['multi-currency'], consolidat: ['consolidation'], intercompany: ['consolidation'], spend: ['spend-controls'], close: ['close'], payment: ['payments'],
};
const labelsFor = (title) => { const s = new Set(); for (const [k, v] of Object.entries(LABELS)) if (title.toLowerCase().includes(k.toLowerCase())) v.forEach((x) => s.add(x)); return [...s].slice(0, 3); };

const wos = [];
let nextId = 1;
const missionChildren = [];
for (let p = 1; p <= PHASES; p++) {
  const titles = TITLES[p] || Array.from({ length: 10 + Math.floor(rnd() * 3) }, () => `${pick(VERBS)} ${pick(NOUNS)}`);
  const phaseIds = [];
  titles.forEach((title, k) => {
    const type = typeFor(title);
    const agentShare = Math.min(0.8, 0.22 + 0.04 * (p - 1));
    const executor = (type === 'Build' || type === 'Fix') && rnd() < agentShare ? 'agent' : 'human';
    const id = `WO-${nextId++}`;
    const w = {
      id, title, type, phase: p, order: k,
      priority: wpick([['Urgent', 0.05], ['High', 0.3], ['Medium', 0.5], ['Low', 0.15]]),
      assignee: wpick([['AW', 1.2], ['JC', 1], ['JY', 1], ['MB', 0.9], ['PN', 1], ['SO', 0.9]]),
      executor, labels: labelsFor(title), blockedBy: [],
      createdAt: Math.max(0, phaseStart(p) - 15 + (rnd() * 4 - 2)),
      hidden: { k: Math.exp(0.3 * invNorm(Math.min(0.999, Math.max(0.001, rnd())))) },
    };
    // dependencies: within the phase on an earlier item, or on last phase's work
    // history phases get random shallow dependencies; the visible plan (10+) is wired by hand below
    if (p < 10) {
      // same planning style as the visible plan: chains up to 4 deep
      const depth = (id) => { const x = wos.find((y) => y.id === id); return x.blockedBy.length ? 1 + depth(x.blockedBy[0]) : 1; };
      const cands = phaseIds.filter((id) => depth(id) < 4);
      if (cands.length && rnd() < 0.35) w.blockedBy.push(pick(cands));
      else if (p > 1 && rnd() < 0.08) w.blockedBy.push(pick(wos.filter((x) => x.phase === p - 1)).id);
    }
    if (title.includes('Requirements for bank feed GA')) w.priority = 'High';
    if (p >= 10 && p <= 13 && /feed|match|Launch bank/i.test(title)) missionChildren.push(id);
    w.availableAt = phaseStart(p);
    wos.push(w);
    phaseIds.push(id);
  });
  // unplanned fixes discovered mid-phase (bugs, incidents)
  const k = Math.floor(-Math.log(rnd()) * 1.4);
  for (let j = 0; j < Math.min(k, 3); j++) {
    const created = phaseStart(p) + 0.3 + rnd() * 4;
    const id = `WO-${nextId++}`;
    wos.push({
      id, title: `Fix ${pick(['sync failure for', 'regression in', 'incorrect totals in', 'timeout in', 'permission error in'])} ${pick(NOUNS)}`,
      type: 'Fix', phase: p, order: 50 + j, priority: 'High', assignee: pick(people).id,
      executor: rnd() < 0.5 ? 'agent' : 'human', labels: ['bug'], blockedBy: [], createdAt: created, availableAt: created,
      hidden: { k: Math.exp(0.3 * invNorm(Math.min(0.999, Math.max(0.001, rnd())))) },
    });
  }
}
// the planned dependency graph for phases 10-14, wired by title
const byTitle = (s) => wos.find((w) => w.title.startsWith(s));
const DEPS = [
  ['Blueprint: bank feed matching service', ['Requirements for bank feed GA rollout']],
  ['Implement bank feed transaction matcher', ['Blueprint: bank feed matching service']],
  ['Build reconciliation exceptions inbox', ['Implement bank feed transaction matcher']],
  ['Build approver delegation settings', ['Implement payment approval chains']],
  ['Fix double-posting when feeds overlap', ['Add retry and backoff to bank feed sync worker']],
  ['Build match confidence review screen', ['Implement bank feed transaction matcher']],
  ['Add bulk approve to exceptions inbox', ['Build reconciliation exceptions inbox']],
  ['Implement approval audit export', ['Implement payment approval chains']],
  ['Blueprint: audit evidence pipeline', ['Requirements for audit evidence packages']],
  ['Implement bank feed GA migration', ['Requirements for bank feed GA rollout']],
  ['Build matcher accuracy dashboard', ['Build match confidence review screen']],
  ['Implement evidence package generator', ['Blueprint: audit evidence pipeline']],
  ['Add customer-facing feed status page', ['Build feed coverage report by institution']],
  ['Launch bank feeds GA', ['Implement bank feed GA migration', 'Build matcher accuracy dashboard']],
  ['Blueprint: consolidation engine', ['Requirements for intercompany eliminations']],
  ['Build intercompany elimination entries', ['Blueprint: consolidation engine']],
  ['Add consolidation report by entity', ['Build intercompany elimination entries']],
  ['Implement scheduled evidence exports', ['Implement evidence package generator']],
  ['Blueprint: spend controls service', ['Requirements for spend controls']],
  ['Implement spend control policies', ['Blueprint: spend controls service']],
];
for (const [a, bs] of DEPS) byTitle(a).blockedBy = bs.map((b) => byTitle(b).id);
byTitle('Implement bank feed transaction matcher').executor = 'human';
byTitle('Implement payment approval chains').executor = 'human';

// ---- hidden "true" process ----
const LN = (median, sigma, u) => median * Math.exp(sigma * invNorm(Math.min(0.995, Math.max(0.005, u))));
const CODE = { human: { Build: 1.3, Fix: 0.6, Requirements: 0.9, Blueprint: 0.8, 'Knowledge Base': 0.5, Other: 0.9 }, agent: { Build: 0.3, Fix: 0.15 } };
const truth = {
  codeMedian: CODE, codeSigma: { human: 0.5, agent: 0.7 },
  reviewMedian: { human: 0.2, agent: 0.28 }, reviewSigma: 0.6,
  reworkP: { agent: [0.4, 0.22], human: [0.14, 0.07] },
  reworkMedian: { agent: 0.12, human: 0.5 },
  decisionP: { Requirements: 0.4, Blueprint: 0.3, Build: 0.14, Fix: 0.05, 'Knowledge Base': 0.1, Other: 0.2 },
  decisionMedian: 1.0, decisionSigma: 0.7,
  reviewSlots: 'two reviewers; on ~30% of days only one is available',
  agentCap: 6,
};
const trueModel = {
  agentCap: truth.agentCap,
  codeDur: (w, u) => LN(CODE[w.executor][w.type] ?? 1, truth.codeSigma[w.executor], u) * w.hidden.k,
  reviewDur: (w, u) => LN(truth.reviewMedian[w.executor], truth.reviewSigma, u) * Math.sqrt(w.hidden.k),
  reworkDur: (w, u) => LN(truth.reworkMedian[w.executor], 0.6, u) * w.hidden.k,
  decisionDur: (w, u) => LN(truth.decisionMedian, truth.decisionSigma, u),
  decisionP: (w) => truth.decisionP[w.type] ?? 0.1,
  reworkP: (w, round) => Math.min(0.9, truth.reworkP[w.executor][Math.min(round, 1)] * Math.min(1.6, w.hidden.k)),
  reviewSlots: (day) => (mulberry32(seedOf(SEED, day, 5))() < 0.3 ? 1 : 2),
};

const out = simulate({ wos, model: trueModel, now: 0, run: SEED, log: true, horizon: 200 });
const events = {};
wos.forEach((w, i) => { events[w.id] = [{ t: w.createdAt, s: 'Backlog' }, ...out.logs[i]].sort((a, b) => a.t - b.t); });

// mission parent work order (tracks its children; does no work itself)
const mission = { id: `WO-${nextId++}`, title: 'Mission - Bank Feeds GA', type: 'Other', phase: 13, order: -1, priority: 'High', assignee: 'AW', executor: 'human', labels: ['mission', 'bank-feeds'], blockedBy: [], createdAt: 38, availableAt: 60, isParent: true, children: missionChildren, due: 65 };

  const strip = (w) => { const { hidden, ...rest } = w; return rest; };
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const histEvents = {};
  for (const [id, ev] of Object.entries(events)) {
    const h = ev.filter((e) => e.t < NOW).map((e) => ({ ...e, t: round(e.t) }));
    if (h.length) histEvents[id] = h;
  }
  const visible = wos.filter((w) => w.createdAt < NOW).map(strip).map((w) => ({ ...w, createdAt: round(w.createdAt), availableAt: round(w.availableAt) }));
  const project = {
    project: 'Ledger Plus', org: 'Ledger Plus', now: NOW, seed: SEED,
    settings: { maxConcurrentAgents: truth.agentCap, phaseLengthDays: 7 },
    people, wos: [...visible, strip(mission)], events: histEvents,
  };
  const truthOut = {
    seed: SEED, now: NOW, truth,
    done: Object.fromEntries(wos.map((w, i) => [w.id, round(out.done[i])])),
    phases: Object.fromEntries(Array.from({ length: PHASES }, (_, k) => k + 1).map((p) => [p, round(Math.max(...wos.filter((w) => w.phase === p).map((w) => out.done[wos.indexOf(w)])))])),
    mission: { id: mission.id, due: mission.due, done: round(Math.max(...missionChildren.map((id) => out.done[wos.findIndex((w) => w.id === id)]))) },
  };
  return { project, truth: truthOut, wos, out, trueModel };
}
