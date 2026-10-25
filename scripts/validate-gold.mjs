import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'schema', 'advisory_episode.schema.json');
const GOLD_PATH = path.resolve(__dirname, '..', 'data', 'gold_diagnostics.jsonl');

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

const schema = JSON.parse(stripBom(await readFile(SCHEMA_PATH, 'utf-8')));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const raw = stripBom(await readFile(GOLD_PATH, 'utf-8'));
const lines = raw.split('\n').filter(l => l.trim());

let pass = 0;
let fail = 0;

for (let i = 0; i < lines.length; i++) {
  let ep;
  try { ep = JSON.parse(lines[i]); }
  catch (e) {
    fail++;
    console.error(`FAIL line ${i + 1} (invalid JSON): ${e.message}`);
    console.error(`  first 120 chars: ${lines[i].substring(0, 120)}`);
    continue;
  }
  const ok = validate(ep);
  if (ok) {
    pass++;
    console.log(`PASS ${ep.episode_id} (${ep.record_kind})`);
  } else {
    fail++;
    console.error(`FAIL ${ep.episode_id} (${ep.record_kind})`);
    for (const err of validate.errors) {
      console.error(`  ${err.instancePath || '(root)'}: ${err.message}`);
    }
  }
}

console.log(`\n${pass}/${lines.length} valid, ${fail} invalid`);
process.exit(fail === 0 ? 0 : 1);