# Contributor License Agreements

Brokkr is licensed under [Apache-2.0](../LICENSE). The Apache-2.0 license
on any release you have received is irrevocable — nothing here changes the
terms of code already distributed to you. To keep the project's licensing
posture flexible over its lifetime (including the ability to offer the
software under additional or different license terms in the future), Hydra
Host requires all external contributors to sign a Contributor License
Agreement (CLA) before their first contribution is merged.

The CLA does **not** transfer ownership of your contribution — you retain
full copyright and may use your work for any other purpose. It grants Hydra
Host a broad, irrevocable license to your contribution (including the
rights to sublicense and to distribute it under other license terms). The
agreements are adapted from the [Apache Software Foundation's contributor
agreements](https://www.apache.org/licenses/contributor-agreements.html).

## Which agreement do I sign?

| You are...                                  | Agreement                                                     | How                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| An individual contributing your own work    | [Individual CLA](./individual.md)                             | Automatic: the CLA Assistant bot prompts on your first PR; sign by replying with the requested statement |
| A company assigning employees to contribute | [Corporate CLA](./corporate.md) + Individual CLA per employee | Contact opensource@hydrahost.com to execute the CCLA; employees sign the ICLA via the PR bot             |
| A Hydra Host employee                       | Neither                                                       | Covered by your employment agreement; employee GitHub accounts are allowlisted in the CLA check          |

## How signing works

1. Open a pull request against the repository.
2. The CLA Assistant bot posts a comment if you haven't signed yet, and the
   `CLA` status check fails.
3. Read the [Individual CLA](./individual.md), then reply to the PR with
   the exact acceptance statement the bot requests. Per section 8 of the
   agreement, this electronic acceptance is your legal signature and binds
   you to the agreement.
4. The bot records your signature (GitHub username, date, and the CLA
   document version, identified by its git revision hash) in a signature
   registry retained by Hydra Host, and the check turns green. You won't be
   asked again on future PRs unless the CLA text changes materially.

## CLA vs. DCO — why both?

Pull requests are also gated by a [Developer Certificate of
Origin](https://developercertificate.org/) check (the `Signed-off-by:`
trailer on each commit). The two answer different questions:

- **DCO** — per-commit _provenance_ attestation: "I have the right to
  submit this code under the project's license."
- **CLA** — one-time _rights_ grant: the license terms under which Hydra
  Host receives your contribution.

The DCO does not grant Hydra Host any rights beyond Apache-2.0, and the CLA
does not attest where each commit came from — so both checks must pass.

## Questions

Open a discussion on the repository or email opensource@hydrahost.com.
