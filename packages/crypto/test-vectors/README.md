# Auth-DH Test-Vector Corpus

`auth-dh-v1.json` is a frozen corpus of `@repo/crypto`'s auth-DH
seal/open primitives. **Test-only — never loaded by production code.**
Production `seal()` always generates a fresh ephemeral on every
invocation; the deterministic-ephemeral variant used to build this
corpus is reachable only through relative imports (`../src/test-only`
from this generator, `../test-only` from the regression tests;
tsconfig-excluded, not a package export).

## What it guarantees

`packages/crypto/src/test-vectors.test.ts` recomputes the intermediates
(`canonical_aad`, `hkdf_salt`, `nonce`) and re-runs seal/open against
the committed vectors, and pins the whole file's SHA-256
(`EXPECTED_CORPUS_SHA256`). This makes it a frozen-output regression
test: an accidental change to the TS seal / HKDF / nonce derivation
fails CI.

It is **not** a cross-implementation parity gate — the corpus is
generated and verified by the same TS implementation, and no second
runtime currently loads it. A genuine second-runtime gate (having
`apps/bridge` decrypt/reproduce these vectors with its own AEAD
implementation) is tracked separately.

## Schema

```jsonc
{
  "version": "auth-dh-v1",
  "envelope_v": 1,
  "aad_v": 1,
  "info": "<hex of HKDF info string>",
  "constants": {
    "key_size": 32,
    "aes_key_size": 32,
    "nonce_size": 12,
    "tag_size": 16,
    "hkdf_hash": "sha256",
    "aead": "aes-256-gcm",
    "curve": "x25519"
  },
  "comment": "<provenance + intended use>",
  "vectors": [
    {
      "name": "<descriptive identifier>",
      "inputs": {
        "sender_priv":    "<32-byte hex>",
        "sender_pub":     "<32-byte hex>",
        "recipient_priv": "<32-byte hex>",
        "recipient_pub":  "<32-byte hex>",
        "eph_priv":       "<32-byte hex>",
        "plaintext":      "<hex>",
        "aad_obj": {
          "aad_v": 1,
          "zone_id": "...",
          "queue_name": "...",
          "direction": "hub_to_bridge | bridge_to_hub",
          "job_id": "...",
          "created_at": <unix ms int>
        }
      },
      "intermediates": {
        "canonical_aad": "<hex of canonicalised AAD bytes>",
        "hkdf_salt":     "<hex of SHA256(canonical_aad)>",
        "aes_key":       "<hex of HKDF-derived 32-byte key>",
        "nonce":         "<hex of SHA256(eph_pub)[:12]>"
      },
      "expected": {
        "eph_pub":    "<32-byte hex>",
        "ciphertext": "<hex>",
        "tag":        "<16-byte hex>"
      }
    }
  ]
}
```

Intermediate stages (`canonical_aad`, `hkdf_salt`, `aes_key`, `nonce`)
are exposed in the corpus so a regression can be localised to the
specific stage where it diverges, rather than only surfacing as a
final ciphertext mismatch. The AES key is safe to publish because every
byte of input is fixed and known — leaking it teaches an attacker
nothing they couldn't compute themselves.

## Coverage

The corpus exercises the six required envelope/AAD cases:

| #   | Name                                               | What it covers                                                    |
| --- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `empty_plaintext_minimal_aad_hub_to_bridge`        | Empty plaintext + minimal AAD edge case                           |
| 2   | `ascii_payload_full_aad_hub_to_bridge`             | Production-shape payload + full AAD                               |
| 3   | `ascii_payload_full_aad_bridge_to_hub`             | Reverse direction with key roles inverted                         |
| 4   | `binary_payload_all_byte_values_hub_to_bridge`     | 0..255 byte values × 4, exercises AES-GCM stream against patterns |
| 5   | `edge_aad_long_zone_id_empty_job_id_hub_to_bridge` | 4 KiB `zone_id` + zero-length `job_id` AAD edge cases             |
| 6   | `large_payload_64kib_plus_hub_to_bridge`           | 65 537-byte plaintext (>64 KiB)                                   |

## Regenerating

`generate.ts` is the canonical generator. It produces deterministic
output from fixed seed inputs (`HUB_PRIV = 0x01 * 32`, `ZONE_PRIV = 0x02 * 32`,
ephemerals `0x03..0x08 * 32`) so the corpus is reproducible.

```bash
pnpm --filter @repo/crypto run generate-vectors
```

The generator writes `auth-dh-v1.json` next to itself and prints the
SHA-256 hash. Bumping the corpus is a three-step ritual:

1. Edit `generate.ts` (add a vector, change a seed, etc.) and re-run.
   Note the new SHA-256 output.
2. Bump the `EXPECTED_CORPUS_SHA256` literal in
   `packages/crypto/src/test-vectors.test.ts` to the new value.
3. Run the test suite; it must pass.

## When to bump `envelope_v` / `aad_v` / filename

Any change that affects the _wire format_ — adding/removing AAD fields,
changing direction values, swapping the HKDF info string, changing the
nonce derivation — is a breaking change. In that case:

1. Bump `envelope_v` (and `aad_v` if AAD shape changed).
2. Create a new versioned filename: `auth-dh-v2.json` (keep the old
   file in tree for historical reference).
3. Update the loader to read the new filename.
4. Plan the rolling deployment: producers can't seal v2 envelopes
   while any consumer only reads v1, so gate activation of the new
   format behind a flag until every consumer can read it.

Anything that only changes test inputs (more vectors, different
plaintext/AAD content) is a non-breaking corpus bump and only requires
the three-step ritual above.
