// Multi-seed calibration check: generate independent projects, forecast phases
// 10-13 from the NOW snapshot, and score raw and conformal-calibrated forecasts
// against each project's realized future (which the forecaster never sees).
//   node scripts/calibration.mjs [seeds=12] [runs=600]
import { generate } from './synth.mjs';
import { forecast, backtest, conformalScale, calibratePhase } from '../core/forecast.mjs';
import { phaseEnd } from '../core/engine.mjs';

const score = (rows, key) => {
  const n = rows.length;
  const g = (r) => r[key];
  return {
    n,
    brier: rows.reduce((a, r) => a + (g(r).pOn - r.on) ** 2, 0) / n,
    cover80: rows.filter((r) => r.y >= g(r).q10 && r.y <= g(r).q90).length / n,
    bias: rows.reduce((a, r) => a + (g(r).q50 - r.y), 0) / n,
    mae: rows.reduce((a, r) => a + Math.abs(g(r).q50 - r.y), 0) / n,
  };
};

export function calibrate(seeds = 12, runs = 600) {
  const rows = [];
  const scales = [];
  for (let s = 1; s <= seeds; s++) {
    const { project, truth } = generate(1000 + s);
    const bt = backtest(project, project.now, { runs: 300 });
    const cs = conformalScale(bt.rows);
    scales.push(+cs.s.toFixed(3));
    const fc = forecast(project, project.now, { runs, phases: [10, 11, 12, 13] });
    for (const p of [10, 11, 12, 13]) {
      const R = fc.phase[p];
      const C = calibratePhase(R, phaseEnd(p), cs.s);
      const y = truth.phases[p];
      rows.push({
        seed: s, p, y, on: y <= phaseEnd(p) + 1e-9 ? 1 : 0,
        raw: { pOn: R.pOnTime, q10: R.q10, q50: R.q50, q90: R.q90 },
        cal: { pOn: C.pOnTime, q10: C.q10, q50: C.q50, q90: C.q90 },
        vel: { pOn: fc.velocity[p].onTime ? 1 : 0, q10: fc.velocity[p].at, q50: fc.velocity[p].at, q90: fc.velocity[p].at },
      });
    }
  }
  return { raw: score(rows, 'raw'), calibrated: score(rows, 'cal'), velocity: score(rows, 'vel'), scales, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = calibrate(+(process.argv[2] || 12), +(process.argv[3] || 600));
  const { rows, ...summary } = r;
  console.log(JSON.stringify(summary, null, 1));
}
