#!/usr/bin/env node
// Builds one malicious app bundle (.tgz) per validation check from the App Store
// design's parity appendix (the 19 throwing checks the dispensary must replicate
// from cribl's AppInstallValidator). Each fixture violates exactly one check so a
// parity harness can assert which check fired.
//
// Output: fixtures/<id>.tgz  +  fixtures/manifest.json (id -> expected check)
//
// Limits mirrored from AppInstallValidator.ts:
//   MAX_APP_ARCHIVE_BYTES      = 100 MB
//   MAX_UNCOMPRESSED_BYTES     = 500 MB
//   MAX_COMPRESSION_RATIO      = 100:1
//   MAX_APP_ID_LENGTH          = 256
//
// Run: node scripts/generate-fixtures.mjs [--out fixtures] [--big] [--seed]
//   --big   materialize the >100MB and >500MB fixtures (skipped by default to keep
//          the repo small; the harness synthesizes them at runtime instead)
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { pack as tarPack } from 'tar-stream';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const OUT = args.has('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(ROOT, 'fixtures');
const BIG = args.has('--big');

mkdirSync(OUT, { recursive: true });

const MAX_APP_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_APP_ID_LENGTH = 256;

// Canonical valid baseline (mirrors criblapps/HelloApps shape).
const validPackage = {
  name: 'corpus-baseline',
  version: '1.0.0',
  displayName: 'Corpus Baseline',
  author: 'ProdSec',
  cribl: { type: 'app' },
};
const validProxies = `api.open-meteo.com:\n  paths:\n    allowlist:\n      - /v1/forecast\n`;
const validPolicies = `- path: /data/kv\n  action: GET\n`;

// Each fixture: id, expected check (matches the 19-check table), and a builder
// that returns the tar entries [{path, content|stream|link, mode}].
const fixtures = [];

function entry(path, content, mode = 0o644) {
  return { path, content: Buffer.isBuffer(content) ? content : Buffer.from(content), mode };
}
function linkEntry(path, linkname) {
  return { path, linkname, type: 'symlink' };
}

// --- Check 1: Archive size > 100 MB -----------------------------------------
fixtures.push({
  id: '01-archive-size',
  check: 'archive-size',
  big: true,
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('static/padding.bin', Buffer.alloc(MAX_APP_ARCHIVE_BYTES + 1, 0x41)),
  ],
});

// --- Check 2: Link entry (symlink) ------------------------------------------
fixtures.push({
  id: '02-link-entry',
  check: 'link-entry',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    linkEntry('static/evil-link', '/etc/passwd'),
  ],
});

// --- Check 3: Path traversal ------------------------------------------------
fixtures.push({
  id: '03-path-traversal',
  check: 'path-traversal',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('../../etc/passwd', 'root:x:0:0:root:/root:/bin/sh\n'),
  ],
});

// --- Check 4: Uncompressed size > 500 MB ------------------------------------
fixtures.push({
  id: '04-uncompressed-size',
  check: 'uncompressed-size',
  big: true,
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    // high-entropy so compression can't shrink it below the ratio guard first
    entry('static/bomb.bin', randomBytes(MAX_UNCOMPRESSED_BYTES + 1)),
  ],
});

// --- Check 5: Compression ratio > 100:1 ------------------------------------
fixtures.push({
  id: '05-compression-ratio',
  check: 'compression-ratio',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    // 1 MB of zeros compresses to ~few KB -> ratio >> 100:1
    entry('static/zeros.bin', Buffer.alloc(1024 * 1024, 0x00)),
  ],
});

// --- Check 6: Missing manifest ---------------------------------------------
fixtures.push({
  id: '06-missing-manifest',
  check: 'missing-manifest',
  build: () => [
    entry('default/proxies.yml', validProxies),
    entry('static/index.html', '<html></html>'),
  ],
});

// --- Check 7: Bad semver ----------------------------------------------------
fixtures.push({
  id: '07-bad-version',
  check: 'bad-version',
  build: () => [
    entry('package.json', JSON.stringify({ ...validPackage, version: 'not-a-version' }, null, 2)),
    entry('default/proxies.yml', validProxies),
  ],
});

// --- Check 8: cribl.type != app --------------------------------------------
fixtures.push({
  id: '08-wrong-type',
  check: 'wrong-type',
  build: () => [
    entry('package.json', JSON.stringify({ ...validPackage, cribl: { type: 'pack' } }, null, 2)),
    entry('default/proxies.yml', validProxies),
  ],
});

// --- Check 9: package.json schema (unreadable) ------------------------------
fixtures.push({
  id: '09-bad-manifest-json',
  check: 'manifest-schema',
  build: () => [
    entry('package.json', '{ this is not : json ,,,'),
    entry('default/proxies.yml', validProxies),
  ],
});

// --- Check 10: App id over 256 chars / bad pattern -------------------------
fixtures.push({
  id: '10-bad-id-length',
  check: 'bad-id',
  build: () => [
    entry('package.json', JSON.stringify({ ...validPackage, name: 'a'.repeat(MAX_APP_ID_LENGTH + 1) }, null, 2)),
    entry('default/proxies.yml', validProxies),
  ],
});
fixtures.push({
  id: '10b-bad-id-pattern',
  check: 'bad-id',
  build: () => [
    entry('package.json', JSON.stringify({ ...validPackage, name: 'UPPERCASE Bad Id!' }, null, 2)),
    entry('default/proxies.yml', validProxies),
  ],
});

// --- Check 11: proxies.yml not YAML ----------------------------------------
fixtures.push({
  id: '11-proxies-not-yaml',
  check: 'proxies-yaml',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', '\x00\x01\x02\x03 not: : : yaml: ['),
  ],
});

// --- Check 12: proxies.yml schema fail --------------------------------------
fixtures.push({
  id: '12-proxies-schema',
  check: 'proxies-schema',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    // missing required paths.allowlist
    entry('default/proxies.yml', 'api.open-meteo.com:\n  something: else\n'),
  ],
});

// --- Check 13: policies.yml not YAML ---------------------------------------
fixtures.push({
  id: '13-policies-not-yaml',
  check: 'policies-yaml',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', '\xff\xfe\xfd not yaml: [[['),
  ],
});

// --- Check 14: policies.yml schema fail -------------------------------------
fixtures.push({
  id: '14-policies-schema',
  check: 'policies-schema',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    // missing required action
    entry('default/policies.yml', '- path: /data/kv\n'),
  ],
});

// --- Check 15: Policy path not absolute ------------------------------------
fixtures.push({
  id: '15-policy-relative-path',
  check: 'policy-path',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', '- path: relative/x\n  action: GET\n'),
  ],
});

// --- Check 16: Policy object interpolation ${}/{} ---------------------------
fixtures.push({
  id: '16-policy-interpolation',
  check: 'policy-interpolation',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', '- path: /data/${env}\n  action: GET\n'),
  ],
});

// --- Check 17: Cross-app reference /a/ --------------------------------------
fixtures.push({
  id: '17-cross-app-ref',
  check: 'cross-app-ref',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', '- path: /a/otherapp/data\n  action: GET\n'),
  ],
});

// --- Check 18: Policy action interpolation ----------------------------------
fixtures.push({
  id: '18-action-interpolation',
  check: 'action-interpolation',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', '- path: /data/kv\n  action: GET ${x}\n'),
  ],
});

// --- Check 19: Policy action not a verb/* -----------------------------------
fixtures.push({
  id: '19-action-verb',
  check: 'action-verb',
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', '- path: /data/kv\n  action: CONNECT\n'),
  ],
});

// --- Positive control: a clean bundle that must be ACCEPTED ----------------
fixtures.push({
  id: '00-baseline-accept',
  check: null,
  positive: true,
  build: () => [
    entry('package.json', JSON.stringify(validPackage, null, 2)),
    entry('default/proxies.yml', validProxies),
    entry('default/policies.yml', validPolicies),
    entry('static/index.html', '<html><body>ok</body></html>'),
  ],
});

function randomBytes(n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) {
    crypto.randomFillSync(buf, i, Math.min(65536, n - i));
  }
  return buf;
}
import crypto from 'node:crypto';

async function writeTgz(filePath, entries) {
  // tar-stream builds the tarball in memory with full control over entry
  // headers — needed for path-traversal (../etc/passwd) and symlink entries
  // that can't exist as real on-disk files under a temp root.
  const pack = tarPack();
  const chunks = [];
  pack.on('data', (c) => chunks.push(c));
  for (const e of entries) {
    if (e.type === 'symlink') {
      pack.entry({ name: e.path, type: 'symlink', linkname: e.linkname, mode: 0o777 }, null);
    } else {
      pack.entry({ name: e.path, mode: e.mode ?? 0o644 }, e.content);
    }
  }
  pack.finalize();
  await new Promise((res) => pack.on('end', res));
  const tgz = gzipSync(Buffer.concat(chunks));
  writeFileSync(filePath, tgz);
}

const manifest = [];
for (const f of fixtures) {
  if (f.big && !BIG) {
    manifest.push({ ...f, built: false, reason: 'big fixture; set --big or synthesize at runtime' });
    continue;
  }
  const outPath = join(OUT, `${f.id}.tgz`);
  await writeTgz(outPath, f.build());
  const stat = execSync(`stat -f%z "${outPath}"`).toString().trim();
  manifest.push({
    id: f.id,
    check: f.check,
    positive: !!f.positive,
    file: `${f.id}.tgz`,
    bytes: Number(stat),
    built: true,
  });
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${manifest.filter(m => m.built).length}/${fixtures.length} fixtures to ${OUT}`);
console.log(`Manifest: ${join(OUT, 'manifest.json')}`);
