# RPOW Lineage

## Hal Finney's RPOW

Hal Finney announced Reusable Proofs of Work in August 2004. Standard Hashcash
proof-of-work tokens were single-use. Finney's RPOW server accepted a valid
proof-of-work token, destroyed it, and returned a new RSA-signed RPOW token of
equal value. That new token could be handed to someone else and redeemed again,
preserving scarcity while making proof-of-work transferable.

The trust model was the interesting part: the RPOW server ran on an IBM 4758
secure cryptographic coprocessor, and users could verify signed attestations
that the box was running the published source code. It was not decentralized,
but it tried to shrink the trusted computing base to a sealed, auditable
machine.

RPOW foreshadowed several Bitcoin-era ideas:

- Proof-of-work as scarce digital object.
- Public-key ownership.
- Transferable bearer-style tokens.
- Public source as part of the trust story.
- The problem of replacing a trusted mint with something stronger.

## RPOW2

RPOW2 revived the idea as a web-native tribute: browser mining, signed tokens,
transfers, and a public ledger. Instead of an IBM 4758, it used modern web
infrastructure, TypeScript, public stats, and a user-facing mining flow. It was
not a clone of Bitcoin and not a clone of Finney's original, but a living
homage to both.

This codebase was forked from that RPOW2 lineage.

## RPOW4

RPOW4 leans harder into Bitcoin-like issuance:

- 50 RPOW initial block reward.
- Reward halving every 210,000 accepted proofs.
- Hard 21,000,000 RPOW cap.
- Public explorer, stats, faucet, activity feed, and trollbox.
- No founder allocation, no premine, no Solana bridge.

It remains centralized. The ledger is operated by this server and backed by
Postgres. The point is not to pretend otherwise. The point is to keep the
historical idea visible: proof-of-work can be a thing you earn, hold, transfer,
and inspect.

