// Steady-survivor paper bot for the Pump.fun Sharpe Sprint (pumpfun-replay/v2).
//
// Two tiers, one goal: the highest hourly Sharpe ratio among entries that
// clear the guardrails (20 distinct mints, round trips >= 0.01 SOL, max
// drawdown <= 50%) with net PnL above 0.
//
//   STRICT tier — the edge. Only coins with proven real demand, bought once,
//   small, exited mechanically: age >= 100 slots, real SOL in [5, 20],
//   >= 30 distinct buyers, net inflow >= 3 SOL, no single buyer above 30%,
//   real price still within 75% of its own high (buy the pullback, not the
//   top), creator never sold. Stop -20%, take-profit +100%, trail 35%,
//   max hold 1500 slots, stale 600. On the 24h dev window: +0.087 SOL,
//   Sharpe 0.22, 49 trips. But a 6h final window only yields ~12-18 such
//   coins — below the 20-mint guardrail — so a strict-only bot cannot win.
//
//   SCOUT tier — guardrail insurance. Marginal coins (age >= 40, >= 15
//   buyers, net >= 1.5 SOL, real SOL in [3, 30], price >= 70% of high)
//   bought at a micro stake just above the 0.01 SOL round-trip floor
//   (0.0105 SOL) with very fast exits (stop -10%, TP +25%, trail 20%,
//   max hold 400, stale 200). Scouts are rate-limited (one buy per 3000
//   slots, at most 2 open) and never take the last open slot, so they
//   cannot crowd out strict entries. Their expected PnL is near zero;
//   their job is to lift the distinct-mint count over 20 in a 6h window
//   at minimal Sharpe cost.
//
// Prices are REAL-reserve prices (real SOL / real tokens) for both entry
// and exit decisions: the entry price is the real price at first sight of
// the filled position, so entry and exit prices are measured in the same
// units. (Virtual-reserve prices are damped by the curve offsets and make
// stops fire far too late; mixing the two units once produced a 8.7% win
// rate — the cost/tokens fill price must never be compared to a real price.)
//
// Deterministic: no clock, no randomness, no I/O. Sell orders are emitted
// in sorted mint order, so two runs produce byte-identical action logs.

import type { Batch, Bot, BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TierParams {
  minAgeSlots: number;
  minRqSol: number;
  maxRqSol: number;
  minBuyers: number;
  minNetSol: number;
  maxSingleBuyerShare: number;
  minPriceVsHigh: number;
  stakeLamports: bigint;
  stopPct: number;
  takeProfitPct: number;
  trailPct: number;
  maxHoldSlots: number;
  staleSlots: number;
}

export interface StrategyParams {
  strict: TierParams;
  scout: TierParams;
  /** Minimum slots between two scout buys (rate limit). */
  scoutMinGapSlots: number;
  /** Maximum scout positions open at once. */
  scoutMaxOpen: number;
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const STRICT_DEFAULT: TierParams = {
  minAgeSlots: 100,
  minRqSol: 5,
  maxRqSol: 20,
  minBuyers: 30,
  minNetSol: 3,
  maxSingleBuyerShare: 0.3,
  minPriceVsHigh: 0.75,
  stakeLamports: 40_000_000n,
  stopPct: -0.2,
  takeProfitPct: 1.0,
  trailPct: 0.35,
  maxHoldSlots: 1500,
  staleSlots: 600,
};

export const SCOUT_DEFAULT: TierParams = {
  minAgeSlots: 40,
  minRqSol: 3,
  maxRqSol: 30,
  minBuyers: 15,
  minNetSol: 1.5,
  maxSingleBuyerShare: 0.4,
  minPriceVsHigh: 0.7,
  // Just above the 0.01 SOL round-trip floor, with very fast exits: the
  // same mint count at roughly half the hourly variance of a 0.012 stake.
  stakeLamports: 10_500_000n,
  stopPct: -0.1,
  takeProfitPct: 0.25,
  trailPct: 0.2,
  maxHoldSlots: 400,
  staleSlots: 200,
};

export const DEFAULT_PARAMS: StrategyParams = {
  strict: STRICT_DEFAULT,
  scout: SCOUT_DEFAULT,
  // One scout buy per 3000 slots (~20 min): 89 distinct mints on the 24h
  // dev window, 22/17/27/23 per 6h slice — clears the 20-mint guardrail in
  // 3 of 4 slices at a dev Sharpe of 0.137 and +0.057 SOL. A tighter gap
  // buys one more mint in the weakest slice but costs Sharpe; a wider gap
  // (9000) lifts dev Sharpe to 0.18 but drops to ~16 mints per slice.
  scoutMinGapSlots: 3000,
  scoutMaxOpen: 2,
  buySlippageBps: 500,
  sellSlippageBps: 10_000,
};

/** Sweep presets. `default` is the shipped config; the rest are practice
 *  variants scored offline and never shipped unless they beat it. */
export const PARAMS: Record<string, StrategyParams> = {
  default: DEFAULT_PARAMS,
  strictOnly: { ...DEFAULT_PARAMS, scoutMinGapSlots: Number.MAX_SAFE_INTEGER },
  scoutGap3000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 3000 },
  scoutGap6000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 6000 },
  scoutGap9000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 9000 },
  scoutStake0015: { ...DEFAULT_PARAMS, scout: { ...SCOUT_DEFAULT, stakeLamports: 15_000_000n } },
  scoutTp050: { ...DEFAULT_PARAMS, scout: { ...SCOUT_DEFAULT, takeProfitPct: 0.5 } },
  scoutMaxOpen1: { ...DEFAULT_PARAMS, scoutMaxOpen: 1 },
  scoutMaxOpen3: { ...DEFAULT_PARAMS, scoutMaxOpen: 3 },
  scoutGap3000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 3000 },
  scoutGap1500: { ...DEFAULT_PARAMS, scoutMinGapSlots: 1500 },
  scoutGap0: { ...DEFAULT_PARAMS, scoutMinGapSlots: 0 },
  scoutPickier: { ...DEFAULT_PARAMS, scoutMinGapSlots: 1500, scout: { ...SCOUT_DEFAULT, minAgeSlots: 60, minBuyers: 20, minNetSol: 2 } },
  scoutPickierGap0: { ...DEFAULT_PARAMS, scoutMinGapSlots: 0, scout: { ...SCOUT_DEFAULT, minAgeSlots: 60, minBuyers: 20, minNetSol: 2 } },
  scoutStop020: { ...DEFAULT_PARAMS, scout: { ...SCOUT_DEFAULT, stopPct: -0.2 } },
  // Micro-scouts: stake just above the 0.01 SOL round-trip floor, very fast
  // exits — same mint count, roughly half the hourly variance contribution.
  scoutMicro: { ...DEFAULT_PARAMS, scout: { ...SCOUT_DEFAULT, stakeLamports: 10_500_000n, stopPct: -0.1, takeProfitPct: 0.25, trailPct: 0.2, maxHoldSlots: 400, staleSlots: 200 } },
  scoutMicroGap9000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 9000, scout: { ...SCOUT_DEFAULT, stakeLamports: 10_500_000n, stopPct: -0.1, takeProfitPct: 0.25, trailPct: 0.2, maxHoldSlots: 400, staleSlots: 200 } },
  scoutTp025: { ...DEFAULT_PARAMS, scout: { ...SCOUT_DEFAULT, takeProfitPct: 0.25 } },
  scoutMicroGap3000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 3000, scout: { ...SCOUT_DEFAULT, stakeLamports: 10_500_000n, stopPct: -0.1, takeProfitPct: 0.25, trailPct: 0.2, maxHoldSlots: 400, staleSlots: 200 } },
  scoutMicroGap6000: { ...DEFAULT_PARAMS, scoutMinGapSlots: 6000, scout: { ...SCOUT_DEFAULT, stakeLamports: 10_500_000n, stopPct: -0.1, takeProfitPct: 0.25, trailPct: 0.2, maxHoldSlots: 400, staleSlots: 200 } },
  scoutMicroOpen3: { ...DEFAULT_PARAMS, scoutMaxOpen: 3, scout: { ...SCOUT_DEFAULT, stakeLamports: 10_500_000n, stopPct: -0.1, takeProfitPct: 0.25, trailPct: 0.2, maxHoldSlots: 400, staleSlots: 200 } },
  scoutMicroGap1500: { ...DEFAULT_PARAMS, scoutMinGapSlots: 1500, scout: { ...SCOUT_DEFAULT, stakeLamports: 10_500_000n, stopPct: -0.1, takeProfitPct: 0.25, trailPct: 0.2, maxHoldSlots: 400, staleSlots: 200 } },
};

/** Reject a bad config loudly instead of trading on it. Throws an Error
 *  naming the exact field and bound that failed (never a bare assert, so
 *  no optimisation flag can strip the gate). */
export function validateTier(p: TierParams, name: string): void {
  if (!Number.isInteger(p.minAgeSlots) || p.minAgeSlots < 0) {
    throw new Error(`${name}.minAgeSlots must be a non-negative integer, got ${p.minAgeSlots}`);
  }
  if (!(p.minRqSol > 0) || !(p.maxRqSol >= p.minRqSol)) {
    throw new Error(`${name} requires 0 < minRqSol <= maxRqSol, got ${p.minRqSol} / ${p.maxRqSol}`);
  }
  if (!Number.isInteger(p.minBuyers) || p.minBuyers < 1) {
    throw new Error(`${name}.minBuyers must be an integer >= 1, got ${p.minBuyers}`);
  }
  if (!(p.minNetSol >= 0)) {
    throw new Error(`${name}.minNetSol must be >= 0, got ${p.minNetSol}`);
  }
  if (!(p.maxSingleBuyerShare > 0) || !(p.maxSingleBuyerShare <= 1)) {
    throw new Error(`${name}.maxSingleBuyerShare must be in (0, 1], got ${p.maxSingleBuyerShare}`);
  }
  if (!(p.minPriceVsHigh > 0) || !(p.minPriceVsHigh <= 1)) {
    throw new Error(`${name}.minPriceVsHigh must be in (0, 1], got ${p.minPriceVsHigh}`);
  }
  if (typeof p.stakeLamports !== 'bigint' || p.stakeLamports <= 0n) {
    throw new Error(`${name}.stakeLamports must be a positive bigint, got ${String(p.stakeLamports)}`);
  }
  if (p.stakeLamports < 10_000_000n) {
    throw new Error(`${name}.stakeLamports must be >= 0.01 SOL (the round-trip floor), got ${String(p.stakeLamports)}`);
  }
  if (!(p.stopPct < 0) || !(p.stopPct > -1)) {
    throw new Error(`${name}.stopPct must be in (-1, 0), got ${p.stopPct}`);
  }
  if (!(p.takeProfitPct > 0)) {
    throw new Error(`${name}.takeProfitPct must be > 0, got ${p.takeProfitPct}`);
  }
  if (!(p.trailPct > 0) || !(p.trailPct < 1)) {
    throw new Error(`${name}.trailPct must be in (0, 1), got ${p.trailPct}`);
  }
  if (!Number.isInteger(p.maxHoldSlots) || p.maxHoldSlots <= 0) {
    throw new Error(`${name}.maxHoldSlots must be a positive integer, got ${p.maxHoldSlots}`);
  }
  if (!Number.isInteger(p.staleSlots) || p.staleSlots <= 0) {
    throw new Error(`${name}.staleSlots must be a positive integer, got ${p.staleSlots}`);
  }
}

export function validateConfig(p: StrategyParams): void {
  validateTier(p.strict, 'strict');
  validateTier(p.scout, 'scout');
  if (!Number.isInteger(p.scoutMinGapSlots) || p.scoutMinGapSlots < 0) {
    throw new Error(`scoutMinGapSlots must be a non-negative integer, got ${p.scoutMinGapSlots}`);
  }
  if (!Number.isInteger(p.scoutMaxOpen) || p.scoutMaxOpen < 0 || p.scoutMaxOpen > 5) {
    throw new Error(`scoutMaxOpen must be an integer in [0, 5], got ${p.scoutMaxOpen}`);
  }
  if (!Number.isInteger(p.buySlippageBps) || p.buySlippageBps < 0 || p.buySlippageBps > 10_000) {
    throw new Error(`buySlippageBps must be an integer in [0, 10000], got ${p.buySlippageBps}`);
  }
  if (!Number.isInteger(p.sellSlippageBps) || p.sellSlippageBps < 0 || p.sellSlippageBps > 10_000) {
    throw new Error(`sellSlippageBps must be an integer in [0, 10000], got ${p.sellSlippageBps}`);
  }
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Per-coin flow tracking
// ---------------------------------------------------------------------------

interface CoinFlow {
  createdSlot: number;
  creator: string;
  creatorSold: boolean;
  buyers: Set<string>;
  buySol: bigint;
  sellSol: bigint;
  biggestBuyerSol: bigint;
  lastTradeSlot: number;
  highPrice: number;
  decidedStrict: boolean;
  decidedScout: boolean;
}

type Tier = 'strict' | 'scout';

interface Held {
  tier: Tier;
  entryPrice: number;
  peakPrice: number;
  openSlot: number;
}

/** Real-reserve token price in SOL (0 when the curve holds no real tokens). */
function realPriceOf(curve: { real_quote_reserves: bigint; real_token_reserves: bigint }): number {
  if (curve.real_token_reserves === 0n) return 0;
  return Number(curve.real_quote_reserves) / Number(curve.real_token_reserves);
}

function blankFlow(createdSlot: number, creator: string): CoinFlow {
  return {
    createdSlot,
    creator,
    creatorSold: false,
    buyers: new Set<string>(),
    buySol: 0n,
    sellSol: 0n,
    biggestBuyerSol: 0n,
    lastTradeSlot: createdSlot,
    highPrice: 0,
    decidedStrict: false,
    decidedScout: false,
  };
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS): Bot {
  validateConfig(params);
  const flow = new Map<string, CoinFlow>();
  const held = new Map<string, Held>();
  // Buy tier by client_id (for pending buys) and by mint (for positions
  // whose fill has landed but whose tier must survive until registration).
  const buyTierById = new Map<string, Tier>();
  const buyTierByMint = new Map<string, Tier>();
  let lastScoutBuySlot = -1_000_000_000;

  function noteTrade(mint: string, e: any, slot: number): void {
    let c = flow.get(mint);
    if (c === undefined) {
      c = blankFlow(slot, typeof e.creator === 'string' ? e.creator : '');
      flow.set(mint, c);
    }
    c.lastTradeSlot = slot;
    const sol = BigInt(e.sol_amount ?? e.quote_amount ?? '0');
    if (e.is_buy === true) {
      c.buySol += sol;
      if (typeof e.user === 'string') c.buyers.add(e.user);
      if (sol > c.biggestBuyerSol) c.biggestBuyerSol = sol;
    } else {
      c.sellSol += sol;
      if (typeof e.user === 'string' && e.user === c.creator) c.creatorSold = true;
    }
  }

  /** The exit reason for a held position under its tier's rules, or ''. */
  function exitReason(mint: string, h: Held, state: BotState, slot: number): string {
    const t = h.tier === 'strict' ? params.strict : params.scout;
    const curve = state.curves.get(mint);
    if (curve === undefined) return '';
    if (curve.complete) return 'complete';
    const c = flow.get(mint);
    if (c !== undefined && c.creatorSold) return 'creator-sold';
    const p = realPriceOf(curve);
    if (p > 0 && h.entryPrice > 0 && p <= h.entryPrice * (1 + t.stopPct)) return 'stop';
    if (p > 0 && h.entryPrice > 0 && p >= h.entryPrice * (1 + t.takeProfitPct)) return 'take-profit';
    if (p > 0 && h.peakPrice > 0 && p <= h.peakPrice * (1 - t.trailPct)) return 'trailing';
    if (c !== undefined && slot - c.lastTradeSlot >= t.staleSlots) return 'stale';
    if (slot - h.openSlot >= t.maxHoldSlots) return 'max-hold';
    return '';
  }

  /** True when a coin passes a tier's entry filters on this batch. */
  function tierPasses(mint: string, t: TierParams, state: BotState, slot: number): boolean {
    const c = flow.get(mint);
    const curve = state.curves.get(mint);
    if (c === undefined || curve === undefined || curve.complete) return false;
    if (state.positions.has(mint)) return false;
    if (slot - c.createdSlot < t.minAgeSlots) return false;
    const rqSol = Number(curve.real_quote_reserves) / Number(LAMPORTS_PER_SOL);
    if (rqSol < t.minRqSol || rqSol > t.maxRqSol) return false;
    if (c.buyers.size < t.minBuyers) return false;
    const netSol = Number(c.buySol - c.sellSol) / Number(LAMPORTS_PER_SOL);
    if (netSol < t.minNetSol) return false;
    if (c.buySol > 0n && Number(c.biggestBuyerSol) / Number(c.buySol) > t.maxSingleBuyerShare) return false;
    if (c.creatorSold) return false;
    const p = realPriceOf(curve);
    if (p <= 0 || c.highPrice <= 0 || p < c.highPrice * t.minPriceVsHigh) return false;
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;
      const txFee = state.txFeeLamports();

      // Fold this batch's events into per-coin flow stats and price highs.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!flow.has(e.mint)) {
            flow.set(e.mint, blankFlow(slot, typeof e.creator === 'string' ? e.creator : ''));
          }
        } else if (e.event === 'TradeEvent') {
          noteTrade(e.mint, e, slot);
          const curve = state.curves.get(e.mint);
          const c = flow.get(e.mint);
          if (curve !== undefined && c !== undefined) {
            const p = realPriceOf(curve);
            if (p > c.highPrice) c.highPrice = p;
          }
        }
      }

      // Refresh peak prices for held positions from the latest marks.
      for (const [mint, h] of held) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const p = realPriceOf(curve);
        if (p > h.peakPrice) h.peakPrice = p;
      }

      // Register newly filled positions (first sight in state.positions).
      // Entry price is the REAL-reserve price at first sight, so entry and
      // exit prices are measured in the same units. The tier comes from the
      // buy that opened the position, recorded by client_id at buy time.
      for (const id of [...buyTierById.keys()]) {
        if (!state.pending.has(id)) buyTierById.delete(id);
      }
      // Drop tier records for buys that resolved without opening a position
      // (rejected / failed fills), so a stale tier can never attach later.
      for (const mint of [...buyTierByMint.keys()]) {
        if (state.positions.has(mint)) continue;
        let stillPending = false;
        for (const p of state.pending.values()) {
          if (p.order.side === 'buy' && p.order.mint === mint) { stillPending = true; break; }
        }
        if (!stillPending) buyTierByMint.delete(mint);
      }
      for (const [mint, pos] of state.positions) {
        if (!held.has(mint)) {
          const curve = state.curves.get(mint);
          const entry = curve !== undefined ? realPriceOf(curve) : 0;
          const tier = buyTierByMint.get(mint) ?? 'strict';
          buyTierByMint.delete(mint);
          held.set(mint, { tier, entryPrice: entry, peakPrice: entry, openSlot: slot });
        }
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) held.delete(mint);
      }

      // --- Exits first: sell whole positions, sorted mint order for determinism.
      const pendingSell = new Set<string>();
      const pendingBuy = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') pendingSell.add(p.order.mint);
        else pendingBuy.add(p.order.mint);
      }
      for (const mint of [...held.keys()].sort()) {
        if (pendingSell.has(mint)) continue;
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (exitReason(mint, h, state, slot) === '') continue;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: params.sellSlippageBps,
        };
        orders.push(sell);
      }

      // --- Entries: strict first, then rate-limited scouts.
      let free = state.freeCashLamports();
      let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
      let scoutOpen = 0;
      for (const h of held.values()) if (h.tier === 'scout') scoutOpen += 1;
      for (const tier of buyTierById.values()) if (tier === 'scout') scoutOpen += 1;
      for (const e of batch.events) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint: string = e.mint;
        if (pendingBuy.has(mint)) continue;
        const c = flow.get(mint);
        if (c === undefined) continue;
        let tier: Tier | null = null;
        let t: TierParams | null = null;
        if (!c.decidedStrict && tierPasses(mint, params.strict, state, slot)) {
          tier = 'strict';
          t = params.strict;
        } else if (!c.decidedScout && tierPasses(mint, params.scout, state, slot)) {
          tier = 'scout';
          t = params.scout;
        }
        if (tier === null || t === null) continue;
        if (tier === 'strict') c.decidedStrict = true;
        else c.decidedScout = true;
        if (tier === 'scout') {
          // Scouts never crowd out strict entries: rate limit, cap on open
          // scouts, and keep one slot free while a strict candidate may come.
          if (slot - lastScoutBuySlot < params.scoutMinGapSlots) continue;
          if (scoutOpen >= params.scoutMaxOpen) continue;
          if (slots <= 1) continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap <= 0n) continue;
        const amount = t.stakeLamports < cap ? t.stakeLamports : cap;
        if (slots <= 0 || free < amount + txFee) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: params.buySlippageBps,
          client_id: state.clientId(),
        };
        buyTierById.set(buy.client_id, tier);
        buyTierByMint.set(mint, tier);
        orders.push(buy);
        free -= amount + txFee;
        slots -= 1;
        if (tier === 'scout') {
          lastScoutBuySlot = slot;
          scoutOpen += 1;
        }
      }
      return orders;
    },
  };
}
