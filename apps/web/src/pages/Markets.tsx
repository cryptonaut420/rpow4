// Markets page — the in-app exchange for trading custom RPOW assets against
// RPOW4.0. Layout follows the conventional centralised-exchange (Binance /
// Coinbase Pro) shape so users land on familiar real estate:
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │  HEADER  symbol + nickname / price / 24h change / 24h tape           │
//   ├─────────┬────────────────────────────┬───────────┬─────────────────────┤
//   │  PAIRS  │  CHART                     │  ORDER    │  TRADE TICKET      │
//   │         │  recent trades             │  BOOK     │  buy / sell        │
//   ├─────────┴────────────────────────────┴───────────┴─────────────────────┤
//   │  MY ORDERS (open / history tabs)                                     │
//   └─────────────────────────────────────────────────────────────────────┘
//
// Every column is `min-width: 0` and uses `text-overflow: ellipsis` so
// formatted bigint amounts don't force a horizontal scroll on the entire
// app shell.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  MarketBalancesResponse,
  MarketBookLevel,
  MarketBookResponse,
  MarketCandle,
  MarketOrder,
  MarketSummary,
  MarketTrade,
} from '@rpow/shared';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useAsset } from '../assets/AssetProvider.js';
import { usePageMeta } from '../hooks/usePageMeta.js';
import { useWallet } from '../wallet/WalletProvider.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';

type Side = 'buy' | 'sell';
type OrderType = 'limit' | 'market';
type OrderTab = 'open' | 'history';
type Interval = '1m' | '5m' | '1h' | '1d';

const POLL_MS = 1500;
const ONE = 1_000_000_000n;
const BPS_DENOM = 10_000n;
const INTERVALS: Interval[] = ['1m', '5m', '1h', '1d'];
const PINNED_MARKET_BASE_SLUG = 'rpow2';
const PINNED_MARKET_QUOTE_SLUG = 'rpow4-0';

function tryParseAmount(raw: string): bigint | null {
  try {
    const n = BigInt(parseRpowToBaseUnits(raw.trim()));
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function fmtPrice(price?: string | null): string {
  if (!price) return '—';
  return formatRpow(price);
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

function quoteFor(baseAmount: bigint, price: bigint): bigint {
  return ceilDiv(baseAmount * price, ONE);
}

function feeFor(notional: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  return ceilDiv(notional * BigInt(bps), BPS_DENOM);
}

function isPinnedMarket(market: MarketSummary): boolean {
  return market.base_asset.slug === PINNED_MARKET_BASE_SLUG
    && market.quote_asset.slug === PINNED_MARKET_QUOTE_SLUG;
}

function sortMarketsForDisplay(markets: MarketSummary[]): MarketSummary[] {
  return [...markets].sort((a, b) => {
    const pinnedDelta = Number(isPinnedMarket(b)) - Number(isPinnedMarket(a));
    if (pinnedDelta !== 0) return pinnedDelta;
    const seqDelta = a.base_asset.display_code.localeCompare(b.base_asset.display_code, undefined, { numeric: true });
    if (seqDelta !== 0) return seqDelta;
    return a.symbol.localeCompare(b.symbol);
  });
}

interface BuyEstimate {
  baseFilled: bigint;
  baseReceived: bigint;
  quoteSpent: bigint;
  fee: bigint;
  quoteFee: bigint;
  totalDebit: bigint;
  fullyFillable: boolean;
}

function estimateMarketBuy(
  book: MarketBookResponse | null,
  baseAmount: bigint,
  feeBps: number,
  feeInBase: boolean,
): BuyEstimate {
  let remaining = baseAmount;
  let baseFilled = 0n;
  let quoteSpent = 0n;
  for (const ask of book?.asks ?? []) {
    if (remaining <= 0n) break;
    const levelBase = BigInt(ask.base_amount_base_units);
    const fill = remaining < levelBase ? remaining : levelBase;
    quoteSpent += quoteFor(fill, BigInt(ask.price_quote_base_units));
    baseFilled += fill;
    remaining -= fill;
  }
  const fee = feeFor(feeInBase ? baseFilled : quoteSpent, feeBps);
  const quoteFee = feeInBase ? 0n : fee;
  return {
    baseFilled,
    baseReceived: baseFilled - (feeInBase ? fee : 0n),
    quoteSpent,
    fee,
    quoteFee,
    totalDebit: quoteSpent + quoteFee,
    fullyFillable: remaining === 0n,
  };
}

interface SellEstimate {
  baseFilled: bigint;
  quoteReceived: bigint;
  fee: bigint;
  netReceive: bigint;
  fullyFillable: boolean;
}

function estimateMarketSell(
  book: MarketBookResponse | null,
  baseAmount: bigint,
  feeBps: number,
  feeInBase: boolean,
): SellEstimate {
  let remaining = baseAmount;
  let baseFilled = 0n;
  let quoteReceived = 0n;
  for (const bid of book?.bids ?? []) {
    if (remaining <= 0n) break;
    const levelBase = BigInt(bid.base_amount_base_units);
    const fill = remaining < levelBase ? remaining : levelBase;
    quoteReceived += quoteFor(fill, BigInt(bid.price_quote_base_units));
    baseFilled += fill;
    remaining -= fill;
  }
  const fee = feeFor(feeInBase ? baseFilled : quoteReceived, feeBps);
  return {
    baseFilled,
    quoteReceived,
    fee,
    netReceive: feeInBase ? quoteReceived : quoteReceived - fee,
    fullyFillable: remaining === 0n,
  };
}

function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function depthRatios(levels: MarketBookLevel[]): number[] {
  if (!levels.length) return [];
  let cumul = 0n;
  const cumuls = levels.map((l) => (cumul += BigInt(l.base_amount_base_units)));
  const peak = cumuls[cumuls.length - 1] ?? 1n;
  return cumuls.map((c) => Number((c * 1000n) / bigintMax(peak, 1n)) / 1000);
}

interface ChartPoint {
  price: string;
  at: string;
}

function PriceChart({
  candles,
  trades,
  height = 220,
}: {
  candles: MarketCandle[];
  trades: MarketTrade[];
  height?: number;
}) {
  const candlePoints: ChartPoint[] = candles.map((c) => ({
    price: c.close_quote_base_units,
    at: c.bucket_start,
  }));
  // A young market can have many trades but only one 1m candle. In that case
  // draw the tick tape directly so the chart never looks broken while price
  // discovery is happening.
  const tradePoints: ChartPoint[] = trades
    .slice()
    .reverse()
    .map((t) => ({ price: t.price_quote_base_units, at: t.created_at }));
  const pointsSource = candlePoints.length >= 2 ? 'candles' : 'trades';
  const series = pointsSource === 'candles' ? candlePoints : tradePoints;

  if (series.length < 2) {
    return (
      <div className="market-chart-empty">
        <strong>waiting for the next trade</strong>
        <span>the chart starts drawing once two prices exist</span>
      </div>
    );
  }

  const closes = series.map((p) => BigInt(p.price));
  const min = closes.reduce((a, b) => (a < b ? a : b));
  const max = closes.reduce((a, b) => (a > b ? a : b));
  const span = max - min;
  // Project into a 100x40 viewBox; vector-effect keeps the line crisp at
  // every CSS width.
  const points = closes.map((p, i) => {
    const x = (i / Math.max(1, closes.length - 1)) * 100;
    const yFrac = span === 0n ? 0.5 : Number(((p - min) * 1000n) / span) / 1000;
    const y = 38 - yFrac * 34;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const areaPoints = `0,40 ${points.join(' ')} 100,40`;
  const open = series[0]!.price;
  const last = series[series.length - 1]!.price;
  const trendUp = BigInt(last) >= BigInt(open);
  const lastPoint = points[points.length - 1]!;
  const [lastX, lastY] = lastPoint.split(',').map(Number);
  return (
    <div className={`market-chart-wrap ${trendUp ? 'up' : 'down'}`}>
      <svg
        className="market-chart"
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        style={{ height }}
        aria-label="price history"
      >
        <polygon points={areaPoints} fill="currentColor" opacity="0.07" />
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={lastX} cy={lastY} r="1.4" fill="currentColor" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-overlay">
        <span>{pointsSource === 'candles' ? `${candles.length} candles` : `${trades.length} live ticks`}</span>
        <span>H {fmtPrice(max.toString())}</span>
        <span>L {fmtPrice(min.toString())}</span>
      </div>
    </div>
  );
}

function pctChange(openStr: string | undefined, closeStr: string | undefined): number | null {
  if (!openStr || !closeStr) return null;
  const open = BigInt(openStr);
  const close = BigInt(closeStr);
  if (open === 0n) return null;
  return Number(((close - open) * 10_000n) / open) / 100;
}

function change24hFromMarket(m: MarketSummary): number | null {
  // Real 24h change anchored to the first trade in the window — supplied
  // by the server. Without an anchor (no trades in 24h) we honestly return
  // null instead of synthesizing a fake number from bid/ask spread.
  return pctChange(m.open_price_24h_quote_base_units, m.last_price_quote_base_units);
}

function sumBase(levels: MarketBookLevel[]): bigint {
  return levels.reduce((acc, l) => acc + BigInt(l.base_amount_base_units), 0n);
}

function sumQuote(levels: MarketBookLevel[]): bigint {
  return levels.reduce((acc, l) => acc + BigInt(l.quote_amount_base_units), 0n);
}

function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function MarketsPage() {
  const wallet = useWallet();
  const nav = useNavigate();
  const params = useParams();
  const { selectedAsset, assetPath } = useAsset();
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [book, setBook] = useState<MarketBookResponse | null>(null);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [balances, setBalances] = useState<MarketBalancesResponse | null>(null);
  const [orders, setOrders] = useState<MarketOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>('');

  const [side, setSide] = useState<Side>('buy');
  const [orderType, setOrderType] = useState<OrderType>('limit');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [lastResult, setLastResult] = useState('');
  const [orderTab, setOrderTab] = useState<OrderTab>('open');
  // `chartInterval` instead of `interval` so the setter doesn't shadow the
  // global `setInterval` function.
  const [chartInterval, setChartInterval] = useState<Interval>('1m');
  const [pairFilter, setPairFilter] = useState('');
  // Bumped every time the polling effect tears down so late fetches from
  // a previous market or asset context can't clobber fresh state.
  const refreshGenRef = useRef(0);

  // Sorted book levels — kept as top-level hooks (before any early returns)
  // so they're always called in the same order every render.
  const sortedBids = useMemo(
    () => [...(book?.bids ?? [])].sort((a, b) => {
      const d = BigInt(b.price_quote_base_units) - BigInt(a.price_quote_base_units);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    }),
    [book?.bids],
  );
  const sortedAsks = useMemo(
    () => [...(book?.asks ?? [])].sort((a, b) => {
      const d = BigInt(a.price_quote_base_units) - BigInt(b.price_quote_base_units);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    }),
    [book?.asks],
  );
  const sortedBook = useMemo(
    () => book ? { ...book, bids: sortedBids, asks: sortedAsks } : null,
    [book, sortedBids, sortedAsks],
  );

  const selectedMarket = useMemo(() => {
    if (params.marketId) return markets.find((m) => m.id === params.marketId) ?? null;
    if (selectedAsset && !selectedAsset.system_default) {
      return markets.find((m) => m.base_asset.slug === selectedAsset.slug) ?? markets[0] ?? null;
    }
    return markets[0] ?? null;
  }, [markets, params.marketId, selectedAsset]);

  usePageMeta(
    selectedMarket
      ? `${selectedMarket.base_asset.nickname} (${selectedMarket.symbol}) Market`
      : 'RPOW Markets',
    'Trade RPOW assets against RPOW4.0 with reserved-funds spot orders.',
  );

  async function refreshAll(
    marketId: string | undefined,
    requestedInterval: Interval,
    isFresh: () => boolean,
    manual = false,
  ) {
    if (!loading && manual) setIsRefreshing(true);
    try {
      const res = await api.markets();
      if (!isFresh()) return;
      const sortedMarkets = sortMarketsForDisplay(res.markets);
      setMarkets(sortedMarkets);
      const next = marketId
        ? sortedMarkets.find((m) => m.id === marketId)
        : (selectedAsset && !selectedAsset.system_default
            ? sortedMarkets.find((m) => m.base_asset.slug === selectedAsset.slug)
            : sortedMarkets[0]);
      if (!next) {
        setBook(null); setTrades([]); setCandles([]); setBalances(null); setOrders([]);
        return;
      }
      const [bookRes, tradeRes, candleRes] = await Promise.all([
        api.marketBook(next.id),
        api.marketTrades(next.id, 40),
        api.marketCandles(next.id, requestedInterval, 80),
      ]);
      if (!isFresh()) return;
      setBook(bookRes);
      setTrades(tradeRes.trades);
      setCandles(candleRes.candles);
      if (wallet.status === 'unlocked') {
        const [balRes, orderRes] = await Promise.all([
          api.marketBalances(next.id).catch(() => null),
          api.myMarketOrders(next.id).catch(() => ({ orders: [] })),
        ]);
        if (!isFresh()) return;
        setBalances(balRes);
        setOrders(orderRes.orders);
      } else {
        setBalances(null);
        setOrders([]);
      }
      setError('');
      setRefreshError('');
      setLastUpdatedAt(new Date().toISOString());
    } catch (e: any) {
      if (!isFresh()) return;
      const message = e?.message ?? 'failed to load markets';
      if (!markets.length) setError(message);
      setRefreshError(message);
    } finally {
      if (isFresh()) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }

  useEffect(() => {
    const myGen = ++refreshGenRef.current;
    const isFresh = () => refreshGenRef.current === myGen;
    const tick = () => {
      if (!isFresh()) return;
      if (document.visibilityState === 'hidden') return;
      void refreshAll(params.marketId, chartInterval, isFresh);
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.marketId, selectedAsset?.slug, wallet.status, chartInterval]);

  // Clear any leftover form feedback whenever the user switches markets or
  // sides so stale "filled X RPOW4.2" lines don't carry across pairs.
  useEffect(() => {
    setFormError('');
    setLastResult('');
  }, [selectedMarket?.id, side, orderType]);

  function onSelectMarket(id: string) {
    // Switch asset context to match the clicked market's base asset so the
    // top-level instance picker, explorer, and activity tabs all stay in
    // lockstep with the visible pair.
    const m = markets.find((x) => x.id === id);
    if (m) nav(assetPath(`/markets/${id}`, m.base_asset.slug));
    else nav(assetPath(`/markets/${id}`));
  }

  function manualRefresh() {
    const gen = refreshGenRef.current;
    void refreshAll(selectedMarket?.id, chartInterval, () => refreshGenRef.current === gen, true);
  }

  function fillAmountFromBalance(pct: number) {
    if (!selectedMarket) return;
    if (side === 'sell' && balances?.base) {
      const avail = BigInt(balances.base.spendable_base_units);
      const portion = (avail * BigInt(Math.round(pct * 100))) / 100n;
      setAmount(formatRpow(portion));
      return;
    }
    if (side === 'buy' && balances?.quote && orderType === 'limit') {
      const priceBu = tryParseAmount(price);
      if (!priceBu) {
        setFormError('enter a price first to size from balance');
        return;
      }
      const avail = BigInt(balances.quote.spendable_base_units);
      const portion = (avail * BigInt(Math.round(pct * 100))) / 100n;
      const baseUnits = (portion * ONE) / priceBu;
      setAmount(formatRpow(baseUnits));
      return;
    }
    if (side === 'buy' && balances?.quote && orderType === 'market') {
      const avail = BigInt(balances.quote.spendable_base_units);
      const budget = (avail * BigInt(Math.round(pct * 100))) / 100n;
      let remaining = budget;
      let totalBase = 0n;
      for (const ask of sortedAsks) {
        if (remaining <= 0n) break;
        const levelBase = BigInt(ask.base_amount_base_units);
        const levelPrice = BigInt(ask.price_quote_base_units);
        const levelQuote = quoteFor(levelBase, levelPrice);
        if (levelQuote <= remaining) {
          totalBase += levelBase;
          remaining -= levelQuote;
        } else {
          const baseFromBudget = (remaining * ONE) / levelPrice;
          totalBase += baseFromBudget;
          remaining = 0n;
        }
      }
      setAmount(formatRpow(totalBase));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedMarket) return;
    if (wallet.status !== 'unlocked') {
      setFormError('login required to place orders');
      return;
    }
    const amountBu = tryParseAmount(amount);
    if (!amountBu) {
      setFormError('enter a valid base amount');
      return;
    }
    const sigBody: Record<string, string> = {
      market_id: selectedMarket.id,
      side,
      order_type: orderType,
      base_amount_base_units: amountBu.toString(),
      client_order_id: crypto.randomUUID(),
    };
    if (orderType === 'limit') {
      const priceBu = tryParseAmount(price);
      if (!priceBu) {
        setFormError('enter a valid limit price');
        return;
      }
      sigBody.price_quote_base_units = priceBu.toString();
    } else if (side === 'buy') {
      const est = estimateMarketBuy(sortedBook, amountBu, selectedMarket.taker_fee_bps, feeInBase);
      if (est.baseFilled === 0n) {
        setFormError('no ask liquidity — place a limit order or wait for sellers');
        return;
      }
      // Set slippage cap to the estimated debit even for partial fills, so
      // the server never over-spends beyond what the current book can fill.
      sigBody.max_quote_base_units = est.totalDebit.toString();
    } else {
      const est = estimateMarketSell(sortedBook, amountBu, selectedMarket.taker_fee_bps, feeInBase);
      if (est.baseFilled === 0n) {
        setFormError('no bid liquidity — place a limit order or wait for buyers');
        return;
      }
    }
    setSubmitting(true);
    setFormError('');
    try {
      const res = await api.createMarketOrder(selectedMarket.id, {
        ...sigBody,
        side,
        order_type: orderType,
        market_id: selectedMarket.id,
        base_amount_base_units: sigBody.base_amount_base_units,
        client_order_id: sigBody.client_order_id,
        client_signature_base58: wallet.sign('market.order.create', sigBody),
      } as any);
      const filled = formatRpow(res.filled_base_units);
      const summary =
        res.order.status === 'filled' ? `filled ${filled} ${selectedMarket.base_asset.display_code}`
        : res.order.status === 'partially_filled' ? `partial fill: ${filled} / ${formatRpow(res.order.original_base_units)} ${selectedMarket.base_asset.display_code}`
        : res.order.status === 'rejected' ? 'order rejected — no eligible counterparty (own orders cannot self-fill)'
        : `${res.order.status} (${filled} filled)`;
      setLastResult(summary);
      setAmount('');
      const gen = refreshGenRef.current;
      await refreshAll(selectedMarket.id, chartInterval, () => refreshGenRef.current === gen);
    } catch (err: any) {
      setFormError(err?.message ?? err?.error ?? 'order failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelOrder(order: MarketOrder) {
    const filled = BigInt(order.original_base_units) - BigInt(order.remaining_base_units);
    if (filled > 0n) {
      const baseCodeForOrder = selectedMarket?.base_asset.display_code ?? 'units';
      if (!window.confirm(
        `Cancel this ${order.side.toUpperCase()} order? ${formatRpow(filled)} ${baseCodeForOrder} has already filled — only the unfilled remainder of `
        + `${formatRpow(order.remaining_base_units)} ${baseCodeForOrder} will be cancelled and returned.`,
      )) return;
    }
    const sigBody = { market_id: order.market_id, order_id: order.id };
    try {
      await api.cancelMarketOrder(order.market_id, order.id, {
        ...sigBody,
        client_signature_base58: wallet.sign('market.order.cancel', sigBody),
      });
      const gen = refreshGenRef.current;
      await refreshAll(order.market_id, chartInterval, () => refreshGenRef.current === gen);
    } catch (err: any) {
      setFormError(err?.message ?? 'cancel failed');
    }
  }

  if (loading) return <Panel title="MARKETS"><div>loading…</div></Panel>;
  if (error) return <Panel title="MARKETS"><div className="error">{error}</div></Panel>;
  if (markets.length === 0) {
    return (
      <Panel title="RPOW MARKETS">
        <div className="market-empty">
          <div>Markets open automatically the moment a custom RPOW launches.</div>
          <div>Be the first to seed price discovery.</div>
          <div style={{ marginTop: 14 }}><Link to={assetPath('/launch')}>[ launch new rpow ]</Link></div>
        </div>
      </Panel>
    );
  }
  if (!selectedMarket) return <Panel title="MARKETS"><div>market not found.</div></Panel>;

  const quoteCode = selectedMarket.quote_asset.display_code;
  const baseCode = selectedMarket.base_asset.display_code;
  const baseNickname = selectedMarket.base_asset.nickname;
  const quoteNickname = selectedMarket.quote_asset.nickname;
  const isExternalMarket = selectedMarket.base_asset.asset_kind === 'external_custodial';
  const feeInBase = isExternalMarket;
  const feeAssetCode = feeInBase ? baseCode : quoteCode;
  const quoteBalance = balances?.quote;
  const baseBalance = balances?.base;
  const amountBu = tryParseAmount(amount);
  const priceBu = orderType === 'limit' ? tryParseAmount(price) : null;
  const change24h = change24hFromMarket(selectedMarket);

  const askDepth = depthRatios(sortedAsks);
  const bidDepth = depthRatios(sortedBids);
  const visibleBidBase = sumBase(sortedBids);
  const visibleAskBase = sumBase(sortedAsks);
  const visibleBidQuote = sumQuote(sortedBids);
  const visibleAskQuote = sumQuote(sortedAsks);
  const lastTrade = trades[0];

  // Cumulative book size at each level — used so clicking a book row fills
  // the trade ticket with the size needed to consume all levels up to and
  // including that price (Coinbase-style "click to ladder").
  const askCumBase = sortedAsks.reduce<bigint[]>((acc, l) => {
    const prev = acc[acc.length - 1] ?? 0n;
    acc.push(prev + BigInt(l.base_amount_base_units));
    return acc;
  }, []);
  const bidCumBase = sortedBids.reduce<bigint[]>((acc, l) => {
    const prev = acc[acc.length - 1] ?? 0n;
    acc.push(prev + BigInt(l.base_amount_base_units));
    return acc;
  }, []);

  function onClickAsk(level: MarketBookLevel, cumBase: bigint) {
    setSide('buy');
    setOrderType('limit');
    setPrice(formatRpow(level.price_quote_base_units));
    setAmount(formatRpow(cumBase));
  }
  function onClickBid(level: MarketBookLevel, cumBase: bigint) {
    setSide('sell');
    setOrderType('limit');
    setPrice(formatRpow(level.price_quote_base_units));
    setAmount(formatRpow(cumBase));
  }

  const filteredPairs = pairFilter.trim()
    ? markets.filter((m) => {
        const f = pairFilter.trim().toLowerCase();
        return (
          m.symbol.toLowerCase().includes(f)
          || m.base_asset.nickname.toLowerCase().includes(f)
          || m.base_asset.display_code.toLowerCase().includes(f)
        );
      })
    : markets;

  let preview: { label: string; value: string }[] = [];
  if (orderType === 'limit' && amountBu && priceBu) {
    const notional = quoteFor(amountBu, priceBu);
    const fee = feeFor(feeInBase ? amountBu : notional, selectedMarket.taker_fee_bps);
    if (side === 'buy') {
      preview = [
        { label: 'notional', value: `${formatRpow(notional)} ${quoteCode}` },
        { label: 'taker fee (if takes)', value: selectedMarket.taker_fee_bps ? `${formatRpow(fee)} ${feeAssetCode}` : 'none' },
        { label: 'reserves', value: `${formatRpow(notional)} ${quoteCode}` },
      ];
    } else {
      preview = [
        { label: 'notional', value: `${formatRpow(notional)} ${quoteCode}` },
        { label: 'taker fee (if takes)', value: selectedMarket.taker_fee_bps ? `${formatRpow(fee)} ${feeAssetCode}` : 'none' },
        { label: 'reserves', value: `${formatRpow(amountBu)} ${baseCode}` },
      ];
    }
  } else if (orderType === 'market' && amountBu) {
    if (side === 'buy') {
      const est = estimateMarketBuy(sortedBook, amountBu, selectedMarket.taker_fee_bps, feeInBase);
      preview = [
        { label: 'fills', value: est.fullyFillable ? `${formatRpow(amountBu)} ${baseCode}` : `${formatRpow(est.baseFilled)} / ${formatRpow(amountBu)} ${baseCode}` },
        ...(feeInBase ? [{ label: 'receive after fee', value: `${formatRpow(est.baseReceived)} ${baseCode}` }] : []),
        { label: 'avg cost', value: est.baseFilled > 0n ? `${formatRpow(quoteFor(ONE, (est.quoteSpent * ONE) / est.baseFilled))} ${quoteCode}` : '—' },
        { label: 'spend', value: `${formatRpow(est.quoteSpent)} ${quoteCode}` },
        { label: 'taker fee', value: selectedMarket.taker_fee_bps ? `${formatRpow(est.fee)} ${feeAssetCode}` : 'none' },
        { label: 'total debit', value: `${formatRpow(est.totalDebit)} ${quoteCode}` },
      ];
    } else {
      const est = estimateMarketSell(sortedBook, amountBu, selectedMarket.taker_fee_bps, feeInBase);
      preview = [
        { label: 'fills', value: est.fullyFillable ? `${formatRpow(amountBu)} ${baseCode}` : `${formatRpow(est.baseFilled)} / ${formatRpow(amountBu)} ${baseCode}` },
        { label: 'gross proceeds', value: `${formatRpow(est.quoteReceived)} ${quoteCode}` },
        { label: 'taker fee', value: selectedMarket.taker_fee_bps ? `${formatRpow(est.fee)} ${feeAssetCode}` : 'none' },
        { label: 'net receive', value: `${formatRpow(est.netReceive)} ${quoteCode}` },
      ];
    }
  }

  const filteredOrders = orderTab === 'open'
    ? orders.filter((o) => o.status === 'open' || o.status === 'partially_filled')
    : orders.filter((o) => o.status !== 'open' && o.status !== 'partially_filled').slice(0, 20);

  // Pre-flight balance check so the user sees the failure before signing —
  // a much friendlier loop than round-tripping for an INSUFFICIENT_BALANCE
  // 400. We mirror the server's reservation rules exactly:
  //   limit-buy:  reserve = ceil(amount * price / 1e9) in quote
  //   limit-sell: reserve = amount in base
  //   market-buy: needs estimated quote spend + fee
  //   market-sell:needs base amount
  let insufficientBalance = false;
  if (wallet.status === 'unlocked' && amountBu) {
    if (orderType === 'limit' && priceBu) {
      if (side === 'buy') {
        const need = quoteFor(amountBu, priceBu);
        if (quoteBalance && BigInt(quoteBalance.spendable_base_units) < need) insufficientBalance = true;
      } else {
        if (baseBalance && BigInt(baseBalance.spendable_base_units) < amountBu) insufficientBalance = true;
      }
    } else if (orderType === 'market') {
      if (side === 'buy') {
        const est = estimateMarketBuy(sortedBook, amountBu, selectedMarket.taker_fee_bps, feeInBase);
        if (quoteBalance && BigInt(quoteBalance.spendable_base_units) < est.totalDebit) insufficientBalance = true;
      } else {
        if (baseBalance && BigInt(baseBalance.spendable_base_units) < amountBu) insufficientBalance = true;
      }
    }
  }

  const submitDisabled = submitting
    || !amountBu
    || (orderType === 'limit' && !priceBu)
    || wallet.status !== 'unlocked'
    || insufficientBalance;

  // Spread derived from the live book so it tracks the actual resting orders,
  // not the polled market summary which can lag by one tick.
  const bestBookBid = sortedBids[0];
  const bestBookAsk = sortedAsks[0];
  const spreadRaw = (bestBookBid && bestBookAsk)
    ? BigInt(bestBookAsk.price_quote_base_units) - BigInt(bestBookBid.price_quote_base_units)
    : null;
  const spread = spreadRaw !== null ? spreadRaw.toString() : null;
  const spreadPct = (spreadRaw !== null && bestBookBid && BigInt(bestBookBid.price_quote_base_units) > 0n)
    ? (Number((spreadRaw * 10_000n) / BigInt(bestBookBid.price_quote_base_units)) / 100).toFixed(2)
    : null;

  // Pick a colour cue for the headline price based on the active chart range.
  const headlineCls = change24h === null ? '' : (change24h >= 0 ? 'up' : 'down');
  // Keep the headline feed status stable during normal background polling.
  // The refresh button still shows `[ syncing ]`; the feed itself should only
  // leave `live` when we have no successful snapshot yet or a refresh fails.
  const liveState = refreshError ? 'stale' : (lastUpdatedAt ? 'live' : 'syncing');
  const midPrice = (bestBookBid && bestBookAsk)
    ? ((BigInt(bestBookAsk.price_quote_base_units) + BigInt(bestBookBid.price_quote_base_units)) / 2n).toString()
    : null;

  return (
    <div className="markets-page">
      {/* ── Header strip ── */}
      <div className="market-header">
        <div className="market-header-left">
          <span className="market-header-nickname" title={`${baseNickname} (${baseCode}) priced in ${quoteNickname}`}>
            {baseNickname}
            <em>{selectedMarket.symbol}</em>
          </span>
          {isExternalMarket ? <Link to="/assets/rpow2" className="market-external-badge">RPOW2 deposits + withdrawals</Link> : null}
          <span className={`market-header-price ${headlineCls}`}>
            {fmtPrice(selectedMarket.last_price_quote_base_units)}
            <small>{quoteCode}</small>
          </span>
          {change24h !== null ? (
            <span className={`market-tape-change ${change24h >= 0 ? 'up' : 'down'}`}>
              {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}% 24h
            </span>
          ) : (
            <span className="market-tape-change dim">— 24h</span>
          )}
          <button
            type="button"
            className="market-refresh"
            onClick={manualRefresh}
            disabled={isRefreshing}
            title={refreshError || 'refresh market data now'}
          >
            {isRefreshing ? '[ syncing ]' : '[ refresh ]'}
          </button>
        </div>
        <div className="market-header-tape">
          <span>feed<strong className={`market-live ${liveState}`}>{liveState}</strong></span>
          <span>bid<strong className="market-bid">{fmtPrice(selectedMarket.best_bid_quote_base_units)}</strong></span>
          <span>ask<strong className="market-ask">{fmtPrice(selectedMarket.best_ask_quote_base_units)}</strong></span>
          <span>mid<strong>{fmtPrice(midPrice)}</strong></span>
          <span>last trade<strong>{timeAgo(lastTrade?.created_at)}</strong></span>
          <span>24h vol<strong>{formatRpow(selectedMarket.volume_24h_base_units)} {baseCode}</strong></span>
          <span>24h quote vol<strong>{formatRpow(selectedMarket.volume_24h_quote_base_units)} {quoteCode}</strong></span>
          <span>24h trades<strong>{selectedMarket.trade_count_24h}</strong></span>
          <span>taker fee<strong>{selectedMarket.taker_fee_bps === 0 ? '0' : `${selectedMarket.taker_fee_bps / 100}%`}</strong></span>
        </div>
      </div>

      {/* ── Body grid ── */}
      <div className="market-body">
        {/* Column 1 — pairs sidebar */}
        <div className="market-col">
          <div className="market-card">
            <div className="market-card-head">
              <span>markets</span>
              <input
                className="pair-search"
                type="search"
                placeholder="search…"
                value={pairFilter}
                onChange={(e) => setPairFilter(e.target.value)}
                aria-label="filter markets"
              />
            </div>
            <div className="markets-list">
              {filteredPairs.length === 0 ? (
                <div className="book-empty">no matches</div>
              ) : filteredPairs.map((m) => {
                const change = change24hFromMarket(m);
                const pinned = isPinnedMarket(m);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`market-pair ${m.id === selectedMarket.id ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
                    onClick={() => onSelectMarket(m.id)}
                    title={`${m.base_asset.nickname} (${m.base_asset.display_code}) priced in ${m.quote_asset.display_code}`}
                  >
                    <span className="market-pair-left">
                      <span className="market-pair-symbol">
                        {pinned ? <span className="market-pair-star" aria-label="pinned market">★</span> : null}
                        {m.base_asset.display_code}/{m.quote_asset.display_code}
                      </span>
                      <span className="market-pair-nickname">
                        {m.base_asset.nickname}
                      </span>
                    </span>
                    <span className="market-pair-right">
                      <span>{fmtPrice(m.last_price_quote_base_units)}</span>
                      {change !== null ? (
                        <span className={`market-pair-change ${change >= 0 ? 'up' : 'down'}`}>
                          {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                        </span>
                      ) : (
                        <span className="market-pair-change dim">—</span>
                      )}
                      <span className="market-pair-trades">{m.trade_count_24h} trades</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Column 2 — chart + recent trades */}
        <div className="market-col">
          <div className="market-card">
            <div className="market-card-head">
              <span>price chart · <strong>{baseCode}/{quoteCode}</strong></span>
              <div className="chart-tabs">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    type="button"
                    className={`chart-tab ${chartInterval === iv ? 'active' : ''}`}
                    onClick={() => setChartInterval(iv)}
                  >
                    {iv}
                  </button>
                ))}
              </div>
            </div>
            <div className="market-card-body">
              <PriceChart candles={candles} trades={trades} />
            </div>
          </div>

          <div className="market-card">
            <div className="market-card-head"><span>recent trades</span></div>
            <div className="trade-list">
              <div className="book-head"><span>price</span><span>size ({baseCode})</span><span>time</span></div>
              {trades.length === 0 ? (
                <div className="book-empty">no trades yet</div>
              ) : trades.map((t, idx) => (
                <div className={`trade-row ${t.taker_side} ${idx === 0 ? 'latest' : ''}`} key={t.id}>
                  <span className="book-cell book-price">{fmtPrice(t.price_quote_base_units)}</span>
                  <span className="book-cell">{formatRpow(t.base_amount_base_units)}</span>
                  <span className="book-cell">{new Date(t.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Column 3 — order book */}
        <div className="market-col">
          <div className="market-card">
            <div className="market-card-head">
              <span>order book</span>
              <span className="market-card-hint">{formatRpow(visibleBidBase + visibleAskBase)} {baseCode}</span>
            </div>
            <div className="market-card-body" style={{ padding: 0 }}>
              {(!sortedBids.length || !sortedAsks.length) ? (
                <div className="market-liquidity-warning">
                  {!sortedBids.length && !sortedAsks.length
                    ? 'no resting liquidity yet'
                    : !sortedBids.length
                      ? 'no bids resting'
                      : 'no asks resting'}
                </div>
              ) : null}
              <div className="book-section">
                <div className="book-head">
                  <span>price ({quoteCode})</span>
                  <span>size ({baseCode})</span>
                  <span>total ({quoteCode})</span>
                </div>
                <div className="book-rows">
                  {sortedAsks.length === 0 ? <div className="book-empty">no asks</div> : null}
                  {(() => {
                    const visible = sortedAsks.slice(0, 12);
                    // Render best-ask-at-bottom; depth ratios and cumulative
                    // sizes still indexed against the full sorted asks array.
                    return [...visible].reverse().map((l) => {
                      const idx = sortedAsks.indexOf(l);
                      const ratio = askDepth[idx] ?? 0;
                      const cum = askCumBase[idx] ?? BigInt(l.base_amount_base_units);
                      return (
                        <button
                          type="button"
                          className="book-row ask"
                          key={`ask-${l.price_quote_base_units}`}
                          onClick={() => onClickAsk(l, cum)}
                          title={`fill BUY at ${formatRpow(l.price_quote_base_units)} for ${formatRpow(cum)} ${baseCode} (clears ${idx + 1} level${idx ? 's' : ''})`}
                        >
                          <span className="book-depth ask-depth" style={{ width: `${ratio * 100}%` }} />
                          <span className="book-cell book-price">{fmtPrice(l.price_quote_base_units)}</span>
                          <span className="book-cell">{formatRpow(l.base_amount_base_units)}</span>
                          <span className="book-cell">{formatRpow(l.quote_amount_base_units)}</span>
                        </button>
                      );
                    });
                  })()}
                </div>
                <div className="market-spread">
                  <span>spread</span>
                  <strong>
                    {spreadRaw === null ? '—'
                      : spreadRaw < 0n ? `crossed (${formatRpow((-spreadRaw).toString())} ${quoteCode} overlap)`
                      : `${formatRpow(spread!)} ${quoteCode}${spreadPct ? ` · ${spreadPct}%` : ''}`}
                  </strong>
                </div>
                <div className="book-rows">
                  {sortedBids.length === 0 ? <div className="book-empty">no bids</div> : null}
                  {sortedBids.slice(0, 12).map((l, idx) => {
                    const ratio = bidDepth[idx] ?? 0;
                    const cum = bidCumBase[idx] ?? BigInt(l.base_amount_base_units);
                    return (
                      <button
                        type="button"
                        className="book-row bid"
                        key={`bid-${l.price_quote_base_units}`}
                        onClick={() => onClickBid(l, cum)}
                        title={`fill SELL at ${formatRpow(l.price_quote_base_units)} for ${formatRpow(cum)} ${baseCode} (clears ${idx + 1} level${idx ? 's' : ''})`}
                      >
                        <span className="book-depth bid-depth" style={{ width: `${ratio * 100}%` }} />
                        <span className="book-cell book-price">{fmtPrice(l.price_quote_base_units)}</span>
                        <span className="book-cell">{formatRpow(l.base_amount_base_units)}</span>
                        <span className="book-cell">{formatRpow(l.quote_amount_base_units)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="depth-summary">
                <span>bids {formatRpow(visibleBidBase)} {baseCode} / {formatRpow(visibleBidQuote)} {quoteCode}</span>
                <span>asks {formatRpow(visibleAskBase)} {baseCode} / {formatRpow(visibleAskQuote)} {quoteCode}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Column 4 — trade ticket */}
        <div className="market-col">
          <div className="market-card">
            <div className="market-card-head"><span>trade <strong>{baseCode}</strong></span></div>
            <div className="market-card-body">
              {wallet.status !== 'unlocked' ? (
                <div className="market-empty">
                  <div>Sign in to place orders.</div>
                  <div style={{ marginTop: 8 }}>
                    <Link to={assetPath('/login')}>[ login ]</Link>
                  </div>
                </div>
              ) : (
                <form onSubmit={submit} className="trade-ticket">
                  <div className="trade-side-tabs">
                    <button type="button" className={`side-tab buy ${side === 'buy' ? 'active' : ''}`} onClick={() => setSide('buy')}>BUY</button>
                    <button type="button" className={`side-tab sell ${side === 'sell' ? 'active' : ''}`} onClick={() => setSide('sell')}>SELL</button>
                  </div>
                  <div className="trade-tabs">
                    <button type="button" className={orderType === 'limit' ? 'tab active' : 'tab'} onClick={() => setOrderType('limit')}>[ limit ]</button>
                    <button type="button" className={orderType === 'market' ? 'tab active' : 'tab'} onClick={() => setOrderType('market')}>[ market ]</button>
                  </div>
                  {orderType === 'limit' ? (
                    <label>
                      <span className="trade-label">PRICE <em>{quoteCode} / {baseCode}</em></span>
                      <input
                        inputMode="decimal"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        placeholder={selectedMarket.last_price_quote_base_units ? formatRpow(selectedMarket.last_price_quote_base_units) : '1.0'}
                      />
                    </label>
                  ) : null}
                  <label>
                    <span className="trade-label">AMOUNT <em>{baseCode}</em></span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                    />
                  </label>
                  <div className="size-presets">
                    {[0.25, 0.5, 0.75, 1].map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="size-preset"
                        onClick={() => fillAmountFromBalance(p)}
                      >
                        {Math.round(p * 100)}%
                      </button>
                    ))}
                  </div>
                  <div className="balance-row">
                    <div>
                      <span className="dim">{baseCode}</span>
                      <span className="val" title="spendable">{baseBalance ? formatRpow(baseBalance.spendable_base_units) : '0'}</span>
                    </div>
                    <div>
                      <span className="dim">locked</span>
                      <span className="val">{baseBalance ? formatRpow(baseBalance.locked_base_units) : '0'}</span>
                    </div>
                    <div>
                      <span className="dim">{quoteCode}</span>
                      <span className="val" title="spendable">{quoteBalance ? formatRpow(quoteBalance.spendable_base_units) : '0'}</span>
                    </div>
                    <div>
                      <span className="dim">locked</span>
                      <span className="val">{quoteBalance ? formatRpow(quoteBalance.locked_base_units) : '0'}</span>
                    </div>
                  </div>
                  {preview.length > 0 ? (
                    <div className="trade-preview">
                      {preview.map((p) => (
                        <div key={p.label} className="trade-preview-row">
                          <span className="dim">{p.label}</span>
                          <span className="val">{p.value}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {insufficientBalance && !formError ? (
                    <div className="error">insufficient {side === 'buy' ? quoteCode : baseCode} balance</div>
                  ) : null}
                  {formError ? <div className="error">{formError}</div> : null}
                  {lastResult ? <div className="success-line">{lastResult}</div> : null}
                  <button className={`trade-submit ${side}`} disabled={submitDisabled}>
                    {submitting ? '[ submitting… ]' : `[ ${side} ${baseCode} ]`}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── My orders (full width) ── */}
      <div className="market-card">
        <div className="market-card-head">
          <span>my orders · <strong>{baseCode}/{quoteCode}</strong></span>
          <div className="trade-tabs">
            <button type="button" className={orderTab === 'open' ? 'tab active' : 'tab'} onClick={() => setOrderTab('open')}>[ open ]</button>
            <button type="button" className={orderTab === 'history' ? 'tab active' : 'tab'} onClick={() => setOrderTab('history')}>[ history ]</button>
          </div>
        </div>
        <div className="market-card-body" style={{ padding: 0 }}>
          {wallet.status !== 'unlocked' ? (
            <div className="book-empty">login to view your orders.</div>
          ) : (
            <div className="orders-list">
              <div className="order-row order-head">
                <span>side</span>
                <span>type</span>
                <span>price</span>
                <span>size</span>
                <span>filled</span>
                <span>status</span>
                <span></span>
              </div>
              {filteredOrders.length === 0 ? (
                <div className="book-empty">{orderTab === 'open' ? 'no open orders' : 'no order history yet'}</div>
              ) : filteredOrders.map((o) => {
                const filled = BigInt(o.original_base_units) - BigInt(o.remaining_base_units);
                return (
                  <div className="order-row" key={o.id}>
                    <span className={`order-side-pill ${o.side}`}>{o.side.toUpperCase()}</span>
                    <span className="order-type">{o.order_type}</span>
                    <span>{o.order_type === 'limit'
                      ? `${fmtPrice(o.price_quote_base_units)} ${quoteCode}`
                      : o.avg_fill_price_quote_base_units
                        ? `~${fmtPrice(o.avg_fill_price_quote_base_units)} ${quoteCode}`
                        : '—'}</span>
                    <span>{formatRpow(o.original_base_units)} {baseCode}</span>
                    <span>{formatRpow(filled)} {baseCode}</span>
                    <span className={`order-status ${o.status}`}>{o.status}</span>
                    {orderTab === 'open' ? (
                      <button type="button" onClick={() => void cancelOrder(o)}>[ cancel ]</button>
                    ) : (
                      <span className="dim" title={o.id}>{shortId(o.id)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
