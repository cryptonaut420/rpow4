# Pre-Bitcoin Cash

## Electronic Cash Before Bitcoin

The central problem was always double-spending. Digital bits copy perfectly;
cash should not. Early systems solved this with a bank, mint, or issuer.
Chaumian ecash gave strong privacy against merchants and banks through blind
signatures, but the issuer still existed.

Private-money experiments such as e-gold and the Liberty Dollar explored
redeemable digital balances, precious-metal backing, and voluntary currency.
They proved demand existed, but also exposed the choke points: custody,
warehouses, issuers, bank accounts, and law enforcement.

## Wei Dai's b-money

Wei Dai's 1998 b-money proposal is one of Bitcoin's direct ancestors and is
cited in the Bitcoin white paper. It imagined pseudonymous public keys, signed
balance updates, computational work creating money, and contract enforcement
among untraceable entities.

Dai described two protocols. The first relied on every participant maintaining
the balance database and using a synchronous, unjammable anonymous broadcast
channel. The second moved accounting to a subset of servers, with deposits and
published commitments to keep them honest.

The most Bitcoin-like piece is the combination of pseudonyms, public broadcast,
signed balance transfers, and computational work as issuance.

## Hashcash

Adam Back's Hashcash made proof-of-work practical as an anti-spam and denial of
service countermeasure. The sender burns CPU to find a stamp; the receiver
verifies it cheaply.

Bitcoin reused the idea, but pointed it at timestamped consensus instead of
email postage. Hashcash became the engine under "one-CPU-one-vote."

## Nick Szabo, Bit Gold, Smart Contracts

Nick Szabo coined and developed the idea of smart contracts in the 1990s:
agreements specified in digital form and enforced, at least partly, by
protocols. His bit gold design combined scarce proof-of-work strings,
timestamping, and public registries.

Smart property pushed the same logic outward: if ownership can be represented
cryptographically, then keys and protocols can mediate property rights with
less human trust.

Colored coins later brought that instinct into Bitcoin itself. By "coloring"
specific coins, users could represent claims, assets, collectibles, smart
property, or other instruments on top of Bitcoin's ledger.

## What Bitcoin Added

Bitcoin's breakthrough was not any single component. It was the synthesis:

- Hashcash-style proof-of-work.
- Public append-only transaction history.
- A peer-to-peer timestamp server.
- Incentives for block production.
- Difficulty adjustment.
- A fixed issuance schedule.
- Public-key ownership without accounts at a bank.

That bundle made electronic cash possible without a trusted mint.

