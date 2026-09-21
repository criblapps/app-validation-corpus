# Validation Checks

This corpus verifies parity between the Cribl App Store validation path and Cribl's `AppInstallValidator`. It contains one deliberately invalid app bundle for each throwing validation check, plus one valid positive-control bundle.

The checks are grouped below by the boundary they protect. A category is an explanatory grouping used by this document; the harness itself records a flat check identifier such as `archive-size` or `policy-path`.

## How to read the checks

For every negative fixture, the corpus changes one property of an otherwise valid app bundle. The target validator should reject that bundle. The `00-baseline-accept` fixture is the inverse: it is a minimal valid bundle that should be accepted.

The harness currently proves **verdict parity**, not exact error-code parity:

- A negative fixture passes when the target returns a non-2xx HTTP response.
- The positive control passes when the target returns a 2xx HTTP response.
- A transport, authentication, or harness error fails the run.
- A large fixture that was not generated is reported as skipped and does not fail the run.
- The expected check identifier is recorded in the manifest and results, but `assert-parity.mjs` does not yet verify that the target reported that exact check.

This distinction matters because any rejection, including an unrelated synchronous rejection, currently satisfies a negative fixture. The fixtures are designed to isolate one violation each, but the target's returned validation reason is diagnostic rather than part of the assertion.

## Category 1: Archive resource limits

These checks protect the validation and extraction service from resource exhaustion. They run against the compressed upload and the amount of data it expands into.

### Check 1: Compressed archive size

- **Check identifier:** `archive-size`
- **Fixture:** `01-archive-size`
- **Rule:** The uploaded `.tgz` must not exceed 100 MiB (`100 * 1024 * 1024` bytes).
- **What it prevents:** Oversized uploads consuming excessive network bandwidth, request-body storage, temporary disk space, and validation time.
- **How the fixture triggers it:** The archive contains a padding file intended to make the compressed bundle larger than the limit.
- **Expected result:** Rejected before the bundle is accepted for installation.
- **Corpus behavior:** This is a large fixture and is not built by default. Use `npm run generate:big` or pass `--big` to the generator to materialize it.

### Check 4: Total uncompressed size

- **Check identifier:** `uncompressed-size`
- **Fixture:** `04-uncompressed-size`
- **Rule:** The total extracted content must not exceed 500 MiB (`500 * 1024 * 1024` bytes).
- **What it prevents:** A relatively small upload expanding until it exhausts disk, memory, or extraction quotas.
- **How the fixture triggers it:** The archive contains more than 500 MiB of high-entropy data. High entropy is intentional so the compression-ratio check is less likely to reject the fixture first.
- **Expected result:** Rejected while the validator accounts for archive entries or extracted bytes.
- **Corpus behavior:** This is a large fixture and is not built by default. Use `npm run generate:big` or pass `--big` to the generator to materialize it.

### Check 5: Compression ratio

- **Check identifier:** `compression-ratio`
- **Fixture:** `05-compression-ratio`
- **Rule:** The uncompressed-to-compressed size ratio must not exceed 100:1.
- **What it prevents:** Compression bombs that fit within the upload-size limit but expand disproportionately during inspection or installation.
- **How the fixture triggers it:** The archive contains 1 MiB of zero bytes, which gzip compresses to a very small payload and therefore produces a ratio well above 100:1.
- **Expected result:** Rejected when the validator compares expanded size with compressed size.

## Category 2: Archive entry and extraction safety

These checks constrain the kinds of entries allowed in the tar archive and where those entries may be written. They prevent an app bundle from escaping its own extraction root or referring to files outside the bundle.

### Check 2: Link entries

- **Check identifier:** `link-entry`
- **Fixture:** `02-link-entry`
- **Rule:** The archive must not contain symbolic-link or hard-link entries.
- **What it prevents:** Links can redirect later reads or writes outside the extracted app directory, bypass file-content inspection, or expose host files to the installed app.
- **How the fixture triggers it:** The archive contains a symbolic link named `static/evil-link` whose target is `/etc/passwd`.
- **Expected result:** Rejected based on the tar entry type, without following the link.

### Check 3: Path traversal

- **Check identifier:** `path-traversal`
- **Fixture:** `03-path-traversal`
- **Rule:** Every archive entry must resolve beneath the designated extraction directory.
- **What it prevents:** Zip Slip-style writes that overwrite files elsewhere on the host by using `..`, absolute paths, or equivalent path-normalization tricks.
- **How the fixture triggers it:** The tar header contains an entry named `../../etc/passwd`.
- **Expected result:** Rejected after path normalization shows that the entry escapes the extraction root. The entry must never be written.

## Category 3: App manifest and identity

These checks establish that the bundle describes a recognizable Cribl app with a parseable manifest, a supported version, the correct artifact type, and a safe canonical identifier.

### Check 6: Root manifest present

- **Check identifier:** `missing-manifest`
- **Fixture:** `06-missing-manifest`
- **Rule:** A root-level `package.json` must exist in the bundle.
- **What it prevents:** Installing an artifact that cannot be identified, versioned, typed, or validated as an app.
- **How the fixture triggers it:** The bundle contains app-like content but omits `package.json`.
- **Expected result:** Rejected because validation cannot continue without the manifest.

### Check 7: Semantic version

- **Check identifier:** `bad-version`
- **Fixture:** `07-bad-version`
- **Rule:** `package.json.version` must be a valid semantic version.
- **What it prevents:** Ambiguous ordering, broken upgrade comparisons, and package records that downstream semver tooling cannot process consistently.
- **How the fixture triggers it:** The manifest sets `version` to `not-a-version`.
- **Expected result:** Rejected during manifest validation.

The local real-app helper uses a simplified semver expression that accepts `MAJOR.MINOR.PATCH` with an optional prerelease or build suffix. The authoritative target validator remains the source of truth for complete semantic-version behavior.

### Check 8: Cribl artifact type

- **Check identifier:** `wrong-type`
- **Fixture:** `08-wrong-type`
- **Rule:** If `cribl.type` is set for this validation path, it must be `app`.
- **What it prevents:** A pack or another Cribl artifact type being submitted through app-specific validation and installation behavior.
- **How the fixture triggers it:** The manifest sets `cribl.type` to `pack`.
- **Expected result:** Rejected as the wrong artifact type.

The local real-app helper treats an absent `cribl.type` as non-failing and rejects only a present value other than `app`. This mirrors the documented "set-and-not-app throws" behavior.

### Check 9: Manifest JSON and schema

- **Check identifier:** `manifest-schema`
- **Fixture:** `09-bad-manifest-json`
- **Rule:** `package.json` must be readable JSON and satisfy the app manifest schema expected by the target validator.
- **What it prevents:** Malformed or structurally invalid metadata reaching later validation and installation stages.
- **How the fixture triggers it:** The file contains syntactically invalid JSON.
- **Expected result:** Rejected while parsing or schema-validating the manifest.

The fixture proves the parse-failure branch. The production check may also reject well-formed JSON that violates required schema fields or field types.

### Check 10: App identifier

- **Check identifier:** `bad-id`
- **Fixtures:** `10-bad-id-length` and `10b-bad-id-pattern`
- **Rules:** `package.json.name` must be no more than 256 characters and must match `^[a-z0-9][a-z0-9-]*$`.
- **What it prevents:** Unsafe or ambiguous identifiers in URLs, storage keys, installation paths, and policy namespaces. The restricted alphabet also avoids case-folding differences and delimiter confusion.
- **How the fixtures trigger it:** One uses 257 lowercase characters; the other uses uppercase letters, spaces, and punctuation.
- **Expected result:** Both variants are rejected as invalid app identifiers.

## Category 4: Proxy configuration

Proxy configuration controls which external destinations and paths an app may access. These checks first establish that `default/proxies.yml` can be parsed, then validate its structure.

`default/proxies.yml` is optional. If it is absent, these checks have nothing to validate and do not block the app.

### Check 11: Proxy YAML syntax

- **Check identifier:** `proxies-yaml`
- **Fixture:** `11-proxies-not-yaml`
- **Rule:** When present, `default/proxies.yml` must be valid YAML.
- **What it prevents:** Invalid configuration being interpreted inconsistently or bypassing structural policy checks because parsing failed.
- **How the fixture triggers it:** The file contains invalid binary-like bytes and malformed YAML tokens.
- **Expected result:** Rejected during YAML parsing.

### Check 12: Proxy schema

- **Check identifier:** `proxies-schema`
- **Fixture:** `12-proxies-schema`
- **Rule:** Parsed proxy configuration must satisfy `AppProxiesConfigSchema`. In the local parity helper, each domain entry must contain `paths.allowlist` as an array.
- **What it prevents:** Incomplete or incorrectly typed allowlists that could produce accidental broad access, fail open, or behave differently across consumers.
- **How the fixture triggers it:** It defines a domain with `something: else` but omits the required `paths.allowlist` array.
- **Expected result:** Rejected during proxy schema validation.

The local helper checks the key invariant used by this fixture; the authoritative schema may enforce additional fields, types, and constraints.

## Category 5: Policy document structure

App policies describe which Cribl API paths an app may call and which actions it may perform. These checks establish that `default/policies.yml` is parseable and has the required record shape before evaluating individual path and action restrictions.

`default/policies.yml` is optional. If it is absent, these checks have nothing to validate and do not block the app.

### Check 13: Policy YAML syntax

- **Check identifier:** `policies-yaml`
- **Fixture:** `13-policies-not-yaml`
- **Rule:** When present, `default/policies.yml` must be valid YAML.
- **What it prevents:** Malformed authorization policy being skipped, partially interpreted, or interpreted differently by separate components.
- **How the fixture triggers it:** The file contains invalid bytes and an unterminated YAML sequence.
- **Expected result:** Rejected during YAML parsing.

### Check 14: Policy schema

- **Check identifier:** `policies-schema`
- **Fixture:** `14-policies-schema`
- **Rule:** Parsed policy data must satisfy `AppPoliciesConfigSchema`. Each policy record must include, at minimum, a `path` and an `action`.
- **What it prevents:** Incomplete authorization entries whose meaning would be ambiguous or whose defaults could grant unintended access.
- **How the fixture triggers it:** The policy has `path: /data/kv` but omits `action`.
- **Expected result:** Rejected during policy schema validation.

## Category 6: Policy path restrictions

These checks constrain the resource portion of each policy. A policy path must be a static, app-local absolute path so that review and enforcement refer to the same resource.

### Check 15: Absolute policy path

- **Check identifier:** `policy-path`
- **Fixture:** `15-policy-relative-path`
- **Rule:** Every policy path must begin with `/`.
- **What it prevents:** Relative paths resolving differently depending on the current route, base URL, or normalization behavior.
- **How the fixture triggers it:** The policy uses `relative/x` instead of `/relative/x`.
- **Expected result:** Rejected while validating the policy path.

### Check 16: No path interpolation

- **Check identifier:** `policy-interpolation`
- **Fixture:** `16-policy-interpolation`
- **Rule:** Policy paths must not contain interpolation expressions such as `${...}` or `{...}`.
- **What it prevents:** A static allowlist turning into a runtime-selected resource pattern that is broader than the path reviewed at install time.
- **How the fixture triggers it:** The policy path is `/data/${env}`.
- **Expected result:** Rejected because the resource path is dynamic.

### Check 17: No cross-app reference

- **Check identifier:** `cross-app-ref`
- **Fixture:** `17-cross-app-ref`
- **Rule:** A policy path must not begin with `/a/`, the namespace used to address another app.
- **What it prevents:** One installed app requesting policy access to another app's routes or data, which would violate app isolation and make permissions transitive across app boundaries.
- **How the fixture triggers it:** The policy path is `/a/otherapp/data`.
- **Expected result:** Rejected as a cross-app policy reference.

## Category 7: Policy action restrictions

These checks constrain the operation portion of each policy. Actions must be static and drawn from the supported HTTP-method allowlist.

### Check 18: No action interpolation

- **Check identifier:** `action-interpolation`
- **Fixture:** `18-action-interpolation`
- **Rule:** Policy actions must not contain interpolation expressions such as `${...}` or `{...}`.
- **What it prevents:** A policy selecting its permitted operation at runtime and escaping the action that was reviewed during installation.
- **How the fixture triggers it:** The policy action is `GET ${x}`.
- **Expected result:** Rejected because the action is dynamic.

### Check 19: Supported action verb

- **Check identifier:** `action-verb`
- **Fixture:** `19-action-verb`
- **Rule:** The action must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or `*`.
- **What it prevents:** Unknown or unsupported operations entering the authorization model and being handled inconsistently by policy consumers.
- **How the fixture triggers it:** The policy action is `CONNECT`, which is not in the accepted set.
- **Expected result:** Rejected during action validation.

`*` is intentionally accepted by the validator as an explicit all-supported-actions value. It is broad, but it is not malformed.

## Positive control

### Baseline valid bundle

- **Check identifier:** none
- **Fixture:** `00-baseline-accept`
- **Rule:** A minimal, correctly formed app must still be accepted.
- **What it proves:** The target is reachable and the corpus is not merely observing universal rejection. It also catches validator drift that accidentally blocks the canonical valid shape.
- **Bundle contents:** A valid root `package.json`, a valid proxy allowlist, a valid `/data/kv` `GET` policy, and a small static HTML file.
- **Expected result:** Accepted with a 2xx response.

## Validation order and overlapping failures

The numeric fixture order follows the parity checklist, but consumers should not depend on it as a public execution order. Some invalid inputs could violate more than one rule. The corpus reduces ambiguity by constructing each fixture from the same valid baseline and changing only the property needed for its intended check.

Important examples:

- The uncompressed-size fixture uses high-entropy content so it is less likely to trip the compression-ratio limit first.
- The invalid policy path and action fixtures retain both required schema fields so they reach the more specific rule.
- The manifest fixtures retain valid proxy configuration so proxy validation does not obscure the intended manifest failure.
- The two app-ID fixtures cover the length and character-pattern branches of the same `bad-id` check.

## What the local real-app helper does

`scripts/validate-real-apps.mjs` is a non-uploading compatibility helper for checking app repository source trees. It is useful for identifying whether existing apps would be blocked, but it is not a replacement for validating the final archive.

- It skips checks 1 through 5 because it reads extracted source directories rather than `.tgz` files.
- It checks the root manifest, version, type, and app ID.
- It checks proxy and policy files only when they exist.
- It implements the essential schema invariants needed by this corpus, not every constraint in the production schemas.
- It exits non-zero if any checked repository would be blocked.

The staging corpus remains the parity mechanism for archive-level behavior and the authoritative target validator.

## Harness outcomes

| Outcome | Meaning | CI treatment |
|---|---|---|
| `accepted` | The upload returned a 2xx response. | Passes only for the positive control. |
| `rejected` | The upload returned a non-2xx response. | Passes only for negative fixtures. |
| `error` | The harness could not complete the test, such as missing credentials or a network failure. | Hard failure. |
| `skipped` | The fixture was listed but not materialized, normally because it is a large fixture. | Reported but tolerated. |

## Limits of the current corpus

- Staging mode treats all 2xx responses as acceptance and all non-2xx responses as rejection; it does not poll an asynchronous validation job despite the runner's historical comments describing polling.
- Exact returned check identifiers or error messages are captured in response details when available but are not asserted.
- Authentication failures are non-2xx responses and can therefore look like successful rejection for negative fixtures. The positive control should expose a globally invalid token because it would also be rejected.
- The `local` mode accepted by the CLI and action metadata is reserved but not implemented in `run-corpus.mjs`; selecting it produces an `error` verdict.
- Checks 1 and 4 are skipped unless large fixtures are explicitly generated.
- The local real-app helper approximates selected production schemas and semantic-version behavior; it is not the source of truth.

These constraints should be considered when interpreting a green run: it demonstrates that the valid control was accepted and each materialized invalid fixture was rejected, not that every rejection came from the intended validator branch.
