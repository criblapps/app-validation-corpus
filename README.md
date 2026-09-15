# app-validation-corpus

Abuse corpus + reusable validation harness for the **Cribl App Store** bundle checks — the 19 throwing validations from cribl's `AppInstallValidator` that the Packs Dispensary must replicate (CRIBL-41931 / CRIBL-43012 parity).

## What this is

A set of deliberately malicious app bundles (one per validation check) plus a harness that feeds each to the dispensary's app validation and asserts it gets **rejected**. This converts the design's top accepted risk — hand-maintained validator drift between the dispensary copy and cribl's `AppInstallValidator` — into a failing CI test the moment the two disagree.

## The 19 checks

| # | Fixture | Violates |
|---|--------|----------|
| 1 | `01-archive-size` | archive > 100 MB |
| 2 | `02-link-entry` | symlink/hardlink entry |
| 3 | `03-path-traversal` | entry escapes extraction dir |
| 4 | `04-uncompressed-size` | uncompressed > 500 MB |
| 5 | `05-compression-ratio` | ratio > 100:1 |
| 6 | `06-missing-manifest` | no root `package.json` |
| 7 | `07-bad-version` | invalid semver |
| 8 | `08-wrong-type` | `cribl.type` ≠ `app` |
| 9 | `09-bad-manifest-json` | unreadable / schema-failing `package.json` |
| 10 | `10-bad-id-length` / `10b-bad-id-pattern` | id > 256 chars / bad pattern |
| 11 | `11-proxies-not-yaml` | `proxies.yml` not parseable YAML |
| 12 | `12-proxies-schema` | `proxies.yml` fails `AppProxiesConfigSchema` |
| 13 | `13-policies-not-yaml` | `policies.yml` not parseable YAML |
| 14 | `14-policies-schema` | `policies.yml` fails `AppPoliciesConfigSchema` |
| 15 | `15-policy-relative-path` | policy path not absolute |
| 16 | `16-policy-interpolation` | policy path contains `${}`/`{}` |
| 17 | `17-cross-app-ref` | policy path starts with `/a/` |
| 18 | `18-action-interpolation` | policy action contains `${}`/`{}` |
| 19 | `19-action-verb` | action not a valid HTTP verb or `*` |
| 0 | `00-baseline-accept` | **positive control** — must be ACCEPTED |

## Usage

### Locally

```bash
npm install
npm run generate          # build fixtures/*.tgz + manifest.json
npm run run:staging       # upload each to packs-staging.cribl.io (needs PACKS_API_TOKEN)
npm run assert            # fail if any verdict mismatches expectation
```

### In CI (reusable workflow)

Any repo calls it:

```yaml
jobs:
  validate:
    uses: criblapps/app-validation-corpus/.github/workflows/validate-bundle.yml@v1
    with:
      mode: staging
      app-id: corpus-abuse
    secrets:
      PACKS_API_TOKEN: ${{ secrets.PACKS_API_TOKEN }}
```

### All repos in the org (automatic)

The org-level workflow in [`criblapps/.github`](https://github.com/criblapps/.github) calls this for **every** repo in the `criblapps` org — no per-repo file needed. New repos are covered on creation.

## How coverage reaches all current + future repos

```
criblapps/.github  (org-level default workflow)
   └─ calls → criblapps/app-validation-corpus/.github/workflows/validate-bundle.yml@v1
                └─ uses → criblapps/app-validation-corpus/action (composite)
                            ├─ scripts/generate-fixtures.mjs
                            ├─ scripts/run-corpus.mjs
                            └─ scripts/assert-parity.mjs
```

1. **Org-level workflow** (`criblapps/.github/.github/workflows/app-corpus.yml`) — inherited by every repo in the org automatically.
2. **Reusable workflow** (`app-validation-corpus/.github/workflows/validate-bundle.yml@v1`) — the stable, versioned entry point.
3. **Composite action** (`app-validation-corpus/action@v1`) — generates fixtures, runs the harness, asserts parity.

New repos in `criblapps` get coverage the moment they're created. Updates to the corpus propagate to all repos on the next run via the `@v1` ref (tagged releases).

## Required secret

`PACKS_API_TOKEN` — a staging dispensary PAT (Bearer). Set as an **org-level Actions secret** in `criblapps` (Settings → Secrets and variables → Actions → New organization secret).

## Big fixtures

The >100 MB and >500 MB fixtures (checks 1 and 4) are skipped by default to keep the repo small. Pass `--big` to materialize them, or run `npm run generate:big`. The harness reports them as `skipped` (tolerated) unless materialized.
