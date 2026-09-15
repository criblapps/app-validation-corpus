#!/usr/bin/env node
// Local-only validation of real app repos against the 19 AppInstallValidator
// throwing checks. Does NOT upload anything. Reads each repo's package.json +
// default/*.yml and reports which checks pass/fail. A repo is "not blocked" if
// no throwing check fails (warnings/missing-optional are OK).
//
// Mirrors the check semantics from the App Store design parity appendix:
//   - checks 1-5 (archive limits) are skipped (no archive; would pass for real bundles)
//   - check 6: package.json present
//   - check 7: version is valid semver
//   - check 8: cribl.type absent OR === 'app' (set-and-not-app throws)
//   - check 9: package.json is valid JSON + has required shape
//   - check 10: name matches ^[a-z0-9][a-z0-9-]*$ and <= 256 chars
//   - check 11/12: proxies.yml parseable + has paths.allowlist (if present)
//   - check 13/14: policies.yml parseable + valid shape (if present)
//   - check 15-19: policies.yml path/action rules (if present)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPS_DIR = process.argv[2] || '/tmp/criblapps-apps';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HTTP_VERBS = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','*']);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

function tryRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function checkRepo(repoDir) {
  const results = [];
  const pkgPath = join(repoDir, 'package.json');
  const pkgText = tryRead(pkgPath);

  // 6: missing manifest
  if (!pkgText) { results.push({ check: 'missing-manifest', pass: false, detail: 'no package.json' }); return results; }

  // 9: package.json readable + valid JSON
  let pkg;
  try { pkg = JSON.parse(pkgText); results.push({ check: 'manifest-schema', pass: true }); }
  catch (e) { results.push({ check: 'manifest-schema', pass: false, detail: e.message }); return results; }

  // 7: version valid semver
  if (!pkg.version || !SEMVER_RE.test(String(pkg.version))) {
    results.push({ check: 'bad-version', pass: false, detail: `version="${pkg.version}"` });
  } else { results.push({ check: 'bad-version', pass: true }); }

  // 8: cribl.type absent or === 'app'
  const t = pkg.cribl?.type;
  if (t !== undefined && t !== 'app') {
    results.push({ check: 'wrong-type', pass: false, detail: `cribl.type="${t}"` });
  } else { results.push({ check: 'wrong-type', pass: true, detail: t === undefined ? '(absent — treated as pack, not an app-validation failure)' : 'app' }); }

  // 10: app id pattern + length
  if (!pkg.name || !ID_RE.test(String(pkg.name)) || String(pkg.name).length > 256) {
    results.push({ check: 'bad-id', pass: false, detail: `name="${pkg.name}"` });
  } else { results.push({ check: 'bad-id', pass: true }); }

  // 11/12: proxies.yml (optional)
  const proxiesPath = join(repoDir, 'default', 'proxies.yml');
  const proxiesText = tryRead(proxiesPath);
  if (proxiesText !== null) {
    let proxies;
    try { proxies = parse(proxiesText); }
    catch (e) { results.push({ check: 'proxies-yaml', pass: false, detail: e.message }); }
    if (proxies) {
      // schema: each domain key must have paths.allowlist (array)
      let schemaOk = true; let detail = '';
      for (const [domain, cfg] of Object.entries(proxies || {})) {
        if (!cfg?.paths?.allowlist || !Array.isArray(cfg.paths.allowlist)) {
          schemaOk = false; detail = `domain "${domain}" missing paths.allowlist`; break;
        }
      }
      results.push({ check: 'proxies-schema', pass: schemaOk, detail: schemaOk ? '' : detail });
    }
  }

  // 13-19: policies.yml (optional)
  const policiesPath = join(repoDir, 'default', 'policies.yml');
  const policiesText = tryRead(policiesPath);
  if (policiesText !== null) {
    let policies;
    try { policies = parse(policiesText); }
    catch (e) { results.push({ check: 'policies-yaml', pass: false, detail: e.message }); }
    if (policies) {
      let schemaOk = true; let detail = '';
      const arr = Array.isArray(policies) ? policies : [policies];
      for (const p of arr) {
        // 14: shape — path + action
        if (!p.path || !p.action) { schemaOk = false; detail = 'missing path or action'; break; }
        // 15: path absolute
        if (!String(p.path).startsWith('/')) { schemaOk = false; detail = `path not absolute: ${p.path}`; break; }
        // 16: no interpolation in path
        if (/\$\{|\{[^}]*\}/.test(String(p.path))) { schemaOk = false; detail = `path interpolation: ${p.path}`; break; }
        // 17: no cross-app ref
        if (String(p.path).startsWith('/a/')) { schemaOk = false; detail = `cross-app ref: ${p.path}`; break; }
        // 18: no interpolation in action
        if (/\$\{|\{[^}]*\}/.test(String(p.action))) { schemaOk = false; detail = `action interpolation: ${p.action}`; break; }
        // 19: action is a verb or *
        if (!HTTP_VERBS.has(String(p.action).toUpperCase())) { schemaOk = false; detail = `bad verb: ${p.action}`; break; }
      }
      results.push({ check: 'policies-schema', pass: schemaOk, detail: schemaOk ? '' : detail });
    }
  }

  return results;
}

// run
const dirs = readdirSync(APPS_DIR).filter(d => existsSync(join(APPS_DIR, d, 'package.json')) || existsSync(join(APPS_DIR, d, 'default')));
let allClear = true;
for (const d of dirs) {
  const repoDir = join(APPS_DIR, d);
  if (!existsSync(join(repoDir, 'package.json'))) {
    console.log(`\n${d}: (no package.json — empty/scaffold repo)`);
    continue;
  }
  const results = checkRepo(repoDir);
  const failures = results.filter(r => !r.pass);
  const status = failures.length === 0 ? '✓ NOT BLOCKED' : '✗ WOULD BE BLOCKED';
  if (failures.length) allClear = false;
  console.log(`\n${d}: ${status}`);
  for (const r of results) {
    const mark = r.pass ? '✓' : '✗';
    console.log(`  ${mark} ${r.check.padEnd(22)} ${r.detail || ''}`);
  }
}
console.log(`\n${allClear ? 'ALL APPS CLEAR — none blocked by the harness validation' : 'SOME APPS WOULD BE BLOCKED — see failures above'}`);
process.exit(allClear ? 0 : 1);
