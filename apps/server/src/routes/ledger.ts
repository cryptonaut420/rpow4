import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { scheduleInfo, BASE_UNITS_PER_RPOW } from '../schedule.js';

const LEDGER_CACHE_MS = 5_000;
const MAX_LEDGER_EVENTS_LIMIT = 100;

function encodeCursor(eventSeq: string): string {
  return Buffer.from(JSON.stringify({ event_seq: eventSeq }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { event_seq?: string };
    if (!parsed.event_seq || !/^[1-9][0-9]*$/.test(parsed.event_seq)) return null;
    return parsed.event_seq;
  } catch {
    return null;
  }
}

function etagFor(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
}

export async function ledgerRoutes(app: FastifyInstance) {
  let cached: { ts: number; body: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;

  async function refresh() {
    const [
      { rows: counter },
      { rows: stats },
      { rows: transferShards },
    ] = await Promise.all([
      app.pool.query<{ value: string }>(
        `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
      ),
      app.pool.query<{ name: string; value: string }>(
        `SELECT name, value::text AS value
         FROM ledger_stats
         WHERE name IN ('circulating_supply','user_count')`,
      ),
      app.pool.query<{ value: string }>(
        `SELECT coalesce(sum(value),0)::text AS value
         FROM ledger_stat_shards
         WHERE name='total_transferred'`,
      ),
    ]);

    const counterBaseUnits = counter[0] ? BigInt(counter[0].value) : 0n;
    const statMap = new Map(stats.map((r) => [r.name, r.value]));
    const totalTransferredBaseUnits = BigInt(transferShards[0]?.value ?? '0');
    const circulatingBaseUnits = BigInt(statMap.get('circulating_supply') ?? '0');
    const userCount = Number(statMap.get('user_count') ?? '0');
    const maxSupplyBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;

    const info = scheduleInfo(counterBaseUnits, {
      difficultyBits: app.config.difficultyBits,
      maxSupplyRpow: app.config.mintMaxSupply,
    });

    return {
      total_minted_base_units: counterBaseUnits.toString(),
      total_transferred_base_units: totalTransferredBaseUnits.toString(),
      circulating_supply_base_units: circulatingBaseUnits.toString(),
      minted_supply_counter_base_units: counterBaseUnits.toString(),
      max_supply_base_units: maxSupplyBaseUnits.toString(),
      base_units_per_rpow: BASE_UNITS_PER_RPOW.toString(),
      current_difficulty_bits: Math.max(app.config.difficultyFloor, info.currentDifficultyBits),
      current_reward_base_units: info.currentRewardBaseUnits.toString(),
      next_reward_base_units: info.nextRewardBaseUnits.toString(),
      next_halving_at_base_units: info.nextHalvingAtBaseUnits.toString(),
      base_units_to_next_halving: info.baseUnitsToNextHalving.toString(),
      halving_index: info.halvingIndex,
      is_capped: info.isCapped,
      user_count: userCount,
    };
  }

  async function ledgerBody() {
    if (cached && Date.now() - cached.ts < LEDGER_CACHE_MS) return cached.body;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const body = await refresh();
        cached = { ts: Date.now(), body };
        return body;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  app.get('/ledger', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=30');
    const body = await ledgerBody();
    const etag = etagFor(body);
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return body;
  });

  app.get('/ledger/stats', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=30');
    const body = await ledgerBody();
    const etag = etagFor(body);
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return body;
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/ledger/events', async (req, reply) => {
    const limitRaw = req.query.limit ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LEDGER_EVENTS_LIMIT)
      : 50;

    let cursorFilter = '';
    const params: unknown[] = [];
    if (req.query.cursor) {
      const cursor = decodeCursor(req.query.cursor);
      if (!cursor) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid cursor' });
      params.push(cursor);
      cursorFilter = `WHERE event_seq < $1::bigint`;
    }
    params.push(limit + 1);
    const limitParam = params.length;

    const { rows } = await app.pool.query<{
      event_seq: string;
      id: string;
      event_type: string;
      actor_pubkey: string;
      counterparty_pubkey: string | null;
      amount: string;
      challenge_id: string | null;
      idempotency_key: string | null;
      client_signature_base58: string | null;
      created_at: Date;
    }>(
      `SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
              amount::text AS amount, challenge_id, idempotency_key,
              client_signature_base58, created_at
       FROM ledger_events
       ${cursorFilter}
       ORDER BY event_seq DESC
       LIMIT $${limitParam}`,
      params,
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=30');
    const body = {
      events: page.map((r) => ({
        id: r.id,
        type: r.event_type.toLowerCase(),
        actor_pubkey: r.actor_pubkey,
        counterparty_pubkey: r.counterparty_pubkey ?? undefined,
        amount_base_units: r.amount,
        challenge_id: r.challenge_id ?? undefined,
        idempotency_key: r.idempotency_key ?? undefined,
        client_signature_base58: r.client_signature_base58 ?? undefined,
        at: r.created_at.toISOString(),
      })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.event_seq) : undefined,
    };
    const etag = etagFor(body);
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return body;
  });
}
