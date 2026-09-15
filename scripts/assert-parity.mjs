#!/usr/bin/env node
// Asserts that every fixture in the results file got its expected verdict:
//   - positive fixtures (baseline) MUST be 'accepted'
//   - every other fixture MUST be 'rejected'
//   - 'skipped' is tolerated (big fixtures not materialized) but reported
//   - 'error' is a hard failure (harness could not reach the target)
// Exits non-zero on any mismatch so CI fails closed.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const resultsPath = arg('--results');
if (!resultsPath) {
  console.error('usage: assert-parity.mjs --results <path>');
  process.exit(2);
}

const { results } = JSON.parse(readFileSync(resultsPath, 'utf8'));

let failures = 0;
const summary = { passed: 0, failed: 0, skipped: 0, errors: 0 };

for (const r of results) {
  if (r.verdict === 'skipped') { summary.skipped++; continue; }
  if (r.verdict === 'error') {
    summary.errors++;
    failures++;
    console.error(`✗ ${r.id}: harness error — ${r.detail}`);
    continue;
  }
  const expected = r.positive ? 'accepted' : 'rejected';
  if (r.verdict === expected) {
    summary.passed++;
    console.log(`✓ ${r.id.padEnd(28)} ${r.verdict} (expected ${expected})`);
  } else {
    summary.failed++;
    failures++;
    console.error(`✗ ${r.id.padEnd(28)} verdict=${r.verdict} expected=${expected} check=${r.check}`);
    console.error(`  detail: ${JSON.stringify(r.detail).slice(0, 200)}`);
  }
}

console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.errors} errors`);
process.exit(failures > 0 ? 1 : 0);
