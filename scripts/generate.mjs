// node scripts/generate.mjs  -> data/project.json (history before NOW) and data/truth.json (tests only)
import { writeFileSync, mkdirSync } from 'node:fs';
import { generate } from './synth.mjs';

const { project, truth, wos, out } = generate(8090);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/project.json', import.meta.url), JSON.stringify(project));
writeFileSync(new URL('../data/truth.json', import.meta.url), JSON.stringify(truth));
console.log(`work orders: ${wos.length} (${project.wos.length - 1} visible at NOW)`);
for (const [p, d] of Object.entries(truth.phases)) console.log(`phase ${p}: done at ${d.toFixed(2)} (end ${5 * p})`);
