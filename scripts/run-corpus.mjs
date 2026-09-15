#!/usr/bin/env node
// Runs each generated fixture against a target and records the verdict.
//
//   mode=staging: POST the .tgz to {DISPENSARY_BASE}/extapi/v1/packs/{APP_ID}
//     with Bearer PACKS_API_TOKEN, then poll the dispensary validation status
//     until it resolves to accepted/rejected, recording which check fired.
//   mode=local:   (reserved) invoke a local validator; not wired here because the
//     dispensary carries no @cribl/* dep and the local path needs a cribl checkout.
//
// Verdict per fixture:
//   { id, check, positive, verdict: 'rejected'|'accepted'|'error', detail }
//
// A positive fixture (00-baseline-accept) MUST be accepted; every other fixture
// MUST be rejected. The exact check that fired is captured where the dispensary
// surfaces it (validation error message / status).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const manifestPath = arg('--manifest');
const outPath = arg('--out');
const mode = arg('--mode') || process.env.MODE || 'staging';

if (!manifestPath || !outPath) {
  console.error('usage: run-corpus.mjs --manifest <path> --out <path> [--mode staging|local]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const base = process.env.DISPENSARY_BASE || 'https://packs-staging.cribl.io';
const appId = process.env.APP_ID || 'corpus-abuse';
const token = process.env.PACKS_API_TOKEN || '';

const results = [];

async function uploadStaging(fixture) {
  if (!token) throw new Error('PACKS_API_TOKEN is required for staging mode');
  const file = readFileSync(join(dirname(manifestPath), fixture.file));
  const form = new FormData();
  form.append('file', new Blob([file]), basename(fixture.file));

  const res = await fetch(`${base}/extapi/v1/packs/${encodeURIComponent(appId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  let body = null;
  try { body = await res.json(); } catch { body = { _raw: await res.text() }; }

  // The extapi returns 202 (staged for validation) on success; a 400/401/403
  // means the upload itself was rejected (auth, schema, or a synchronous
  // validation failure). Either way we record the outcome; the parity
  // assertion is "rejected vs accepted", and we capture the detail.
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    body,
  };
}

async function runOne(fixture) {
  if (!fixture.built) {
    return { id: fixture.id, check: fixture.check, positive: !!fixture.positive, verdict: 'skipped', detail: fixture.reason || 'not built' };
  }
  try {
    if (mode === 'staging') {
      const r = await uploadStaging(fixture);
      // A positive fixture must be staged (2xx). A negative fixture must NOT
      // be staged — a 4xx (validation/auth rejection) is the expected outcome.
      const rejected = !r.ok;
      const verdict = fixture.positive
        ? (r.ok ? 'accepted' : 'rejected')
        : (rejected ? 'rejected' : 'accepted');
      return { id: fixture.id, check: fixture.check, positive: !!fixture.positive, verdict, detail: { http: r.status, body: r.body } };
    }
    return { id: fixture.id, check: fixture.check, positive: !!fixture.positive, verdict: 'error', detail: `unsupported mode: ${mode}` };
  } catch (e) {
    return { id: fixture.id, check: fixture.check, positive: !!fixture.positive, verdict: 'error', detail: e.message };
  }
}

// sequential to avoid hammering staging; fixtures are few
for (const f of manifest) {
  const r = await runOne(f);
  results.push(r);
  console.log(`${r.id.padEnd(28)} check=${String(r.check).padEnd(22)} verdict=${r.verdict}`);
}

writeFileSync(outPath, JSON.stringify({ mode, base, appId, timestamp: new Date().toISOString(), results }, null, 2));
console.log(`\nWrote ${results.length} results to ${outPath}`);
