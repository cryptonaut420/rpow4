# Mining Pools

Bitcoin mining was a solo sport for its first eighteen months. Satoshi mined
the genesis block alone in January 2009; for the rest of that year almost
every block was found by a single hobbyist running `bitcoind` on a laptop or
a desktop GPU. Difficulty was low, the reward was 50 BTC, and on a fast
machine you'd find a block every few hours.

That changed quickly. By late 2010, GPU mining had become competitive, the
network's hash rate had risen by orders of magnitude, and the variance for
solo miners had become brutal: a single miner running flat-out might wait
weeks between blocks even though their *expected* income was steady. The
phrase "Bitcoin lottery" stopped feeling like a joke.

## The first pool: slush pool, November 2010

On 27 November 2010, a Czech developer named Marek "Slush" Palatinus
announced **Bitcoin Pooled Mining** on the bitcointalk forum:

> What is this? In short: A bunch of people connect their miners to one
> central server. The server distributes work between miners, collects
> their proofs-of-work, and once any of them solves a block, the reward
> is divided according to how much work each miner contributed.

That description — work distribution, share collection, pro-rata payout —
is the core of every pool that has been built since. Slush's original pool
(which still runs, now branded "Braiins Pool") pioneered the **shares**
abstraction: a miner submits hashes that meet a *lower-difficulty target*
than the network requires, and the pool counts each one as a unit of
proven work. When someone in the pool stumbles into a hash that *also*
meets the network target, the round closes and rewards are paid out.

## Payout schemes

The same primitive — shares — admits many distribution policies, each with
different variance vs. fairness vs. fee trade-offs. The big ones:

- **Proportional (PROP)**. The earliest scheme. Each round's reward is
  split by share count in that round. Vulnerable to "pool hopping": a
  miner switches in early in a round (when shares are scarce) and out
  late (when the per-share value drops as more shares pile in). Almost
  no modern pool runs pure PROP.

- **Pay Per Last N Shares (PPLNS)**. Reward is split across the last
  *N* shares submitted to the pool, regardless of round boundaries.
  Makes pool-hopping unprofitable: a miner has to be present long enough
  to fill the rolling window before they earn anything substantial.
  Higher long-term variance per-block but cleaner incentive structure.
  This is what most large pools use today.

- **Pay Per Share (PPS)**. The pool pays a fixed amount per accepted
  share *immediately*, irrespective of whether a block is found.
  Smoothest possible income for miners — the pool absorbs all variance.
  Pool operators charge a higher fee to offset the variance risk they
  take on.

- **FPPS / PPS+**. PPS plus a pro-rata cut of transaction fees. The
  current default for industrial-scale Bitcoin mining (Foundry, Antpool,
  ViaBTC).

All four schemes share the same property: a single miner's reward is no
longer a coin-flip. They trade some upside (a 100% share when *they* find
the block) for predictability.

## The centralization debate

Pools never *control* the network — every miner can leave at any moment
and point their hashrate elsewhere — but in practice the top three to
five Bitcoin pools have accounted for the majority of network hashrate
for over a decade. That concentration has been the source of constant
tension in the Bitcoin community: pool operators set fee policy, pick
which transactions to include, and can de-facto enforce protocol changes
by collectively withholding hashrate.

Several mitigations have shipped over the years:

- **Stratum V2** (2019, drafted by Braiins) lets each individual miner
  pick their own block template instead of accepting whatever the pool
  hands them. Pools still aggregate hashrate but lose unilateral
  transaction-selection power.
- **P2Pool** (2011), a peer-to-peer "share-chain" model where the pool
  itself has no central operator. Technically elegant; never achieved
  scale because individual miner UX was rougher than centralized pools.
- **Solo pools** (Solo CKPool, Slush's solo plan): the operator runs a
  pool front-end but with no share aggregation — a winning miner gets
  the entire reward minus a small fee. Useful for individuals running
  a single ASIC who don't want to maintain their own node.

## RPOW4's pool

RPOW4 is a centralized simulation, so the pool decentralization debate
doesn't apply directly — there is no "the network" separate from the
operator. We adopt the share-based model anyway because it's a strict UX
upgrade over solo at high difficulty:

- The browser submits hashes meeting a lower share difficulty (default
  10 bits below network, floored at 20 trailing-zero bits) every few
  seconds.
- Whichever miner happens to also clear network difficulty *closes the
  round* and earns a 25% finder bonus. The remaining 75% is split
  pro-rata across the round's other shares.
- 2% of the gross reward goes to the treasury, which funds the faucet.
  In a real Bitcoin pool, the same 2% would be the operator's revenue.

You can switch between **solo** and **pool** modes from the mining bar
at any time. Solo keeps the original "100% to the lucky finder"
semantics; pool gives steadier income with a small statistical haircut.
The schedule, supply cap, and difficulty progression are identical
either way.

## Sources

- Slush, *Bitcoin Pooled Mining (proposal)*, bitcointalk.org, 2010-11-27.
- Meni Rosenfeld, *Analysis of Bitcoin Pooled Mining Reward Systems*,
  2011 — the canonical write-up of PPS, PROP, and PPLNS payout math.
- Braiins, *Stratum V2: The Next Generation Protocol for Pooled Mining*,
  2019.
- *Bitcoin: A Peer-to-Peer Electronic Cash System* (Satoshi Nakamoto,
  2008) — section 4 ("Proof-of-Work") describes the per-block lottery
  that pools later smoothed out.
