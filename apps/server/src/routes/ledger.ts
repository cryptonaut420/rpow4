import type { FastifyInstance, FastifyReply } from 'fastify';
import { scheduleInfoForBlock, BASE_UNITS_PER_RPOW } from '../schedule.js';
import { buildCachedJsonResponse, type CachedJsonResponse } from '../cache.js';
import { TREASURY_PUBKEY } from '@rpow/shared';

const MAX_LEDGER_EVENTS_LIMIT = 100;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

interface LedgerEventDbRow {
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
}

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

/**
 * Send a precomputed JSON response without re-stringifying. Honors
 * If-None-Match using the cached ETag.
 */
function sendCachedJson(
  reply: FastifyReply,
  cached: CachedJsonResponse,
  ifNoneMatch: string | undefined,
  cacheControl: string,
): FastifyReply {
  reply.header('etag', cached.etag);
  reply.header('cache-control', cacheControl);
  if (ifNoneMatch === cached.etag) {
    return reply.code(304).send();
  }
  reply.header('content-type', JSON_CONTENT_TYPE);
  return reply.send(cached.json);
}

export async function ledgerRoutes(app: FastifyInstance) {
  async function ledgerCachedResponse(): Promise<CachedJsonResponse> {
    return app.caches.ledger.get('singleton', async () => {
      const { rows } = await app.pool.query<{
        minted_supply: string;
        block_height: string;
        transfer_count: string;
        total_fees_collected: string;
        treasury_balance: string;
        circulating_supply: string;
        user_count: string;
        total_transferred: string;
        trollbox_message_count: string;
      }>(
        `SELECT
           COALESCE((SELECT value FROM app_counters WHERE name='minted_supply'), 0)::text AS minted_supply,
           COALESCE((SELECT value FROM app_counters WHERE name='block_height'), 0)::text AS block_height,
           COALESCE((SELECT value FROM app_counters WHERE name='transfer_count'), 0)::text AS transfer_count,
           COALESCE((SELECT value FROM app_counters WHERE name='total_fees_collected'), 0)::text AS total_fees_collected,
           COALESCE((SELECT spendable_base_units FROM account_balances WHERE pubkey=$1), 0)::text AS treasury_balance,
           COALESCE((SELECT value FROM ledger_stats WHERE name='circulating_supply'), 0)::text AS circulating_supply,
           COALESCE((SELECT value FROM ledger_stats WHERE name='user_count'), 0)::text AS user_count,
           COALESCE((SELECT sum(value) FROM ledger_stat_shards WHERE name='total_transferred'), 0)::text AS total_transferred,
           COALESCE((SELECT value FROM app_counters WHERE name='trollbox_message_count'), 0)::text AS trollbox_message_count`,
        [TREASURY_PUBKEY],
      );

      const stats = rows[0]!;
      const counterBaseUnits = BigInt(stats.minted_supply);
      const blockHeight = BigInt(stats.block_height);
      const transferCount = BigInt(stats.transfer_count);
      const totalFeesCollected = BigInt(stats.total_fees_collected);
      const treasuryBalance = BigInt(stats.treasury_balance);
      const totalTransferredBaseUnits = BigInt(stats.total_transferred);
      const circulatingBaseUnits = BigInt(stats.circulating_supply);
      const userCount = Number(stats.user_count);
      const maxSupplyBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;

      const info = scheduleInfoForBlock(blockHeight, counterBaseUnits, {
        baseRewardBaseUnits: app.config.baseRewardBaseUnits,
        halvingIntervalBlocks: app.config.halvingIntervalBlocks,
        difficultyStartBits: app.config.difficultyStartBits,
        difficultyStepBlocks: app.config.difficultyStepBlocks,
        difficultyMaxBits: app.config.difficultyMaxBits,
        maxSupplyRpow: app.config.mintMaxSupply,
      });

      // Current fee = base fee >> halving_index (halves with every reward halving).
      const currentFeeBaseUnits =
        info.halvingIndex <= 0
          ? app.config.sendBaseFeeBaseUnits
          : app.config.sendBaseFeeBaseUnits >> BigInt(info.halvingIndex);

      const body = {
        total_minted_base_units: counterBaseUnits.toString(),
        total_transferred_base_units: totalTransferredBaseUnits.toString(),
        circulating_supply_base_units: circulatingBaseUnits.toString(),
        minted_supply_counter_base_units: counterBaseUnits.toString(),
        max_supply_base_units: maxSupplyBaseUnits.toString(),
        base_units_per_rpow: BASE_UNITS_PER_RPOW.toString(),

        block_height: blockHeight.toString(),
        transfer_count: transferCount.toString(),
        treasury_balance_base_units: treasuryBalance.toString(),
        total_fees_collected_base_units: totalFeesCollected.toString(),
        current_fee_base_units: currentFeeBaseUnits.toString(),
        halving_interval_blocks: app.config.halvingIntervalBlocks,
        difficulty_step_blocks: app.config.difficultyStepBlocks,
        difficulty_max_bits: app.config.difficultyMaxBits,

        current_difficulty_bits: info.currentDifficultyBits,
        next_difficulty_bits: info.nextDifficultyBits,
        next_difficulty_at_block: info.nextDifficultyAtBlock.toString(),
        blocks_to_next_difficulty_step: info.blocksToNextDifficultyStep.toString(),
        difficulty_tier: info.difficultyTier,

        current_reward_base_units: info.currentRewardBaseUnits.toString(),
        next_reward_base_units: info.nextRewardBaseUnits.toString(),
        next_halving_at_block: info.nextHalvingAtBlock.toString(),
        blocks_to_next_halving: info.blocksToNextHalving.toString(),
        halving_index: info.halvingIndex,

        is_capped: info.isCapped,
        user_count: userCount,
        trollbox_message_count: stats.trollbox_message_count,
      };
      return buildCachedJsonResponse(body);
    });
  }

  async function loadLedgerEventRows(cursor: string | null, limit: number): Promise<LedgerEventDbRow[]> {
    const recentParams: unknown[] = [];
    let recentCursorFilter = '';
    if (cursor) {
      recentParams.push(cursor);
      recentCursorFilter = `WHERE event_seq < $1::bigint`;
    }
    recentParams.push(limit + 1);
    const recentLimitParam = recentParams.length;

    const recent = await app.pool.query<LedgerEventDbRow>(
      `SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
              amount::text AS amount, challenge_id, idempotency_key,
              client_signature_base58, created_at
       FROM ledger_recent_events
       ${recentCursorFilter}
       ORDER BY event_seq DESC
       LIMIT $${recentLimitParam}`,
      recentParams,
    );
    // Newest page is the hottest public path. The bounded hot table is
    // maintained transactionally by mint/send and seeded during migration,
    // so when it has any rows, avoid touching historical partitions.
    if (!cursor && recent.rows.length > 0) return recent.rows;
    if (recent.rows.length >= limit + 1) return recent.rows;

    // If the hot table did not fill the page, continue from the oldest
    // hot row (or from the requested cursor) against the partitioned
    // historical ledger. This keeps correctness while the common case
    // stays on the tiny hot table.
    const oldestRecent = recent.rows[recent.rows.length - 1]?.event_seq ?? null;
    const historicalCursor = oldestRecent ?? cursor;
    const remaining = limit + 1 - recent.rows.length;
    const historicalParams: unknown[] = [];
    let historicalCursorFilter = '';
    if (historicalCursor) {
      historicalParams.push(historicalCursor);
      historicalCursorFilter = `WHERE event_seq < $1::bigint`;
    }
    historicalParams.push(remaining);
    const historicalLimitParam = historicalParams.length;

    const historical = await app.pool.query<LedgerEventDbRow>(
      `SELECT event_seq::text AS event_seq, id, event_type, actor_pubkey, counterparty_pubkey,
              amount::text AS amount, challenge_id, idempotency_key,
              client_signature_base58, created_at
       FROM ledger_events
       ${historicalCursorFilter}
       ORDER BY event_seq DESC
       LIMIT $${historicalLimitParam}`,
      historicalParams,
    );
    return [...recent.rows, ...historical.rows];
  }

  app.get('/ledger', async (req, reply) => {
    const cached = await ledgerCachedResponse();
    return sendCachedJson(
      reply,
      cached,
      req.headers['if-none-match'] as string | undefined,
      'public, max-age=5, stale-while-revalidate=30',
    );
  });

  app.get('/ledger/stats', async (req, reply) => {
    const cached = await ledgerCachedResponse();
    return sendCachedJson(
      reply,
      cached,
      req.headers['if-none-match'] as string | undefined,
      'public, max-age=5, stale-while-revalidate=30',
    );
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/ledger/events', async (req, reply) => {
    const limitRaw = req.query.limit ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LEDGER_EVENTS_LIMIT)
      : 50;

    let cursor: string | null = null;
    if (req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid cursor' });
    }
    const cacheKey = `${cursor ?? ''}|${limit}`;
    const cached = await app.caches.ledgerEvents.get(cacheKey, async () => {
      const rows = await loadLedgerEventRows(cursor, limit);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
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
      return buildCachedJsonResponse(body);
    });

    return sendCachedJson(
      reply,
      cached,
      req.headers['if-none-match'] as string | undefined,
      'public, max-age=2, stale-while-revalidate=10',
    );
  });
}
