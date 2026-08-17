# Export-Control Compliance — encryption source in the OSS tree

> **STATUS: DRAFT — NOT A LEGAL DETERMINATION.** Every classification, exception, and
> obligation below is a working hypothesis prepared by engineering to scope the question.
> It **requires legal/compliance sign-off** before the OSS release and before any notification
> is sent. Nothing here asserts an authoritative ECCN, and no filing has been made.

The related LICENSE/NOTICE work is already addressed — the package ships under Apache-2.0
with the repo-level `NOTICE`/`THIRD-PARTY-LICENSES.md`.

## 1. Cryptography inventory (what is actually present in the released tree)

This inventory covers all encryption source code that ships in the public OSS tree, not only
`packages/crypto/`. Several proprietary packages and internal-infrastructure paths are excluded
from the public sync, but every path inventoried below — `packages/crypto` and the `apps/bridge`
sources named — ships publicly. All primitives are standard and come from Node's built-in
`node:crypto` — there is **no bespoke algorithm**.

### 1a. `@repo/crypto` (`packages/crypto/`)

Implements an authenticated Diffie-Hellman seal/open envelope, with **zero third-party crypto
dependency** (the package has only dev dependencies; see `packages/crypto/package.json`).

| Primitive     | Algorithm                                             | `node:crypto` API                                         | Location                                  |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Key agreement | x25519 ECDH                                           | `generateKeyPairSync('x25519')`, `diffieHellman()`        | `src/auth-dh.ts:77`, `:57-58`, `:112-113` |
| KDF           | HKDF-SHA256                                           | `hkdfSync('sha256', ...)`                                 | `src/auth-dh.ts:35`                       |
| AEAD          | AES-256-GCM (256-bit key, 12-byte nonce, 16-byte tag) | `createCipheriv` / `createDecipheriv('aes-256-gcm', ...)` | `src/auth-dh.ts:64`, `:119`               |
| AAD           | Canonical additional-authenticated-data struct        | (plain serialization, not crypto)                         | `src/aad.ts`                              |

Public API surface (shipped in the OSS tree): `seal`, `open`, `derivePublicKey`, plus the AAD
canonicalizer and error types — re-exported from `src/index.ts`.

### 1b. Bridge Redis at-rest encryption (`apps/bridge/src/common/redis/redis-client/redis-encryptor.ts`)

A **second, independent** AES-256-GCM implementation that does **not** call into `@repo/crypto`.
It builds its own seal/open envelope on `node:crypto` for encrypting values at rest in Redis.

| Primitive | Algorithm                                             | `node:crypto` API                                         | Location                       |
| --------- | ----------------------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| AEAD      | AES-256-GCM (256-bit key, 12-byte nonce, 16-byte tag) | `createCipheriv` / `createDecipheriv('aes-256-gcm', ...)` | `redis-encryptor.ts:52`, `:72` |
| RNG       | Nonce generation                                      | `randomBytes(12)`                                         | `redis-encryptor.ts:47`        |

Envelope framing: `base64(nonce(12) ‖ ciphertext ‖ tag(16))`. Key supplied via
`BRIDGE_AT_REST_KEY` (32 raw bytes, base64-encoded).

### 1c. Bridge zone-crypto bootstrap (`apps/bridge/src/startup/zone-crypto-bootstrap.ts`)

Uses `node:crypto` **directly** (not via `@repo/crypto`) for enrollment-handshake integrity and
local key generation. The AEAD seal/open in `apps/bridge/src/zone-crypto/sealed-envelope.service.ts`
is a **consumer** of `@repo/crypto` (calls `seal`/`open`), not an independent implementation.

| Primitive        | Algorithm   | `node:crypto` API               | Location                       |
| ---------------- | ----------- | ------------------------------- | ------------------------------ |
| MAC              | HMAC-SHA256 | `createHmac('sha256', ...)`     | `zone-crypto-bootstrap.ts:105` |
| Constant-time eq | —           | `timingSafeEqual()`             | `zone-crypto-bootstrap.ts:433` |
| Key generation   | x25519      | `generateKeyPairSync('x25519')` | `zone-crypto-bootstrap.ts:113` |

### How `@repo/crypto` is used

- **Device-token / bridge↔hub auth sealing.** The seal/open envelope authenticates and
  encrypts payloads exchanged between the hub and bridge agents.
  - API side: `apps/api/src/zone-crypto/zone-crypto.config.ts`
  - Bridge side: `apps/bridge/src/zone-crypto/sealed-envelope.service.ts`,
    `apps/bridge/src/bullmq/seal-outbound-payload.ts`, `.../results.service.ts`

`@repo/crypto` is marked `"private": true`, which only blocks `npm publish` to a registry. Its
**source files still ship in the public OSS repository tree** — as do the §1b/§1c bridge sources,
which are not a separately published package at all — which is what raises the
publicly-available-encryption-source question. `private` does not change the analysis.

## 2. Likely classification path (DRAFT — requires legal sign-off)

This is the _expected_ path for standard, publicly-available open-source encryption source
code. It is **not** a determination.

1. **ECCN 5D002** — Encryption "software" under EAR Category 5, Part 2 (Information Security).
   Encryption source code is generally classified here. This applies to all three inventory
   entries (§1a `@repo/crypto`, §1b Redis at-rest encryptor, §1c bridge enrollment HMAC/keygen).
2. **EAR §740.13(e) — "TSU" license exception (publicly available encryption source code).**
   Publicly available open-source encryption source code is typically eligible for the TSU
   exception. TSU requires a **one-time email notification** of the internet location of the
   source code to BIS and the NSA — **not** a license application, and **not** an ongoing
   reporting burden, provided the source remains publicly available and unchanged in a way that
   would require re-notification.
3. **No license required if TSU applies.** The obligation reduces to sending (and archiving)
   the notification email below before/at publication.

Open questions for legal:

- Does the release jurisdiction actually require the TSU notification for these standard
  primitives, or is the code "publicly available" in a way that needs no notification?
- `@repo/crypto` is **not** the sole implementer. The inventory above identifies two additional
  independent `node:crypto` uses in the public tree: a second AES-256-GCM implementation
  (`apps/bridge` Redis at-rest encryptor, §1b) and bridge enrollment HMAC-SHA256 / x25519 keygen
  (§1c). All three use only standard `node:crypto` primitives, so they are expected to fall under
  the same 5D002 / publicly-available classification — but each must be classified explicitly
  rather than assumed to be a mere consumer of `@repo/crypto`.

## 3. TSU notification email — TEMPLATE (DO NOT SEND WITHOUT SIGN-OFF)

> **REQUIRES LEGAL/COMPLIANCE SIGN-OFF BEFORE SENDING.** Replace `{{REPO_URL}}` with the
> public source URL and confirm recipients/wording with legal. This template is provided for
> convenience only; it is not advice that a notification is required.

```text
To: crypt@bis.doc.gov, enc@nsa.gov
Subject: Notification of publicly available encryption source code (EAR 740.13(e) / 742.15(b))

To whom it may concern,

Pursuant to the notification requirement for publicly available encryption source code under
the Export Administration Regulations, this email provides notice of the internet location of
publicly available open-source encryption source code.

  Product / package: Brokkr (open-source encryption source code)
  Internet location (source URL): {{REPO_URL}}
  Description: Open-source TypeScript source implementing, using only standard primitives
    exposed by the Node.js runtime: (1) an authenticated Diffie-Hellman envelope (x25519 ECDH
    key agreement, HKDF-SHA256 key derivation, AES-256-GCM authenticated encryption); (2) an
    AES-256-GCM at-rest encryption envelope; and (3) HMAC-SHA256 message authentication with
    x25519 key generation for an enrollment handshake. No proprietary or non-standard
    cryptographic algorithm is implemented.

  Submitter: Hydrahost, Inc.
  Contact: <name>, <title>, <email>, <phone>

Please contact us if any additional information is required.

Regards,
<name>
Hydrahost, Inc.
```

## 4. Pre-publish release checklist (export control)

Add to the release gate (alongside `release/public-sync-exclude.txt` and the public-sync
checks). Each item is a hard gate before the OSS publication:

- [ ] **ECCN determination recorded.** Legal/compliance has classified all three inventory
      entries (§1a `@repo/crypto`, §1b Redis at-rest encryptor, §1c bridge enrollment HMAC/keygen)
      (expected 5D002 / publicly-available encryption source) and recorded the determination.
- [ ] **TSU notification, if required.** If legal determines a TSU notification is required,
      the §740.13(e) email (Section 3 above, with `{{REPO_URL}}` filled in) has been sent to
      `crypt@bis.doc.gov` and `enc@nsa.gov`, and the sent confirmation is archived with the
      release artifacts.
- [ ] **Release checklist references this clearance.** This document is linked from
      the release checklist and the determination/confirmation are attached to the release.
