// Floor-aware launch sniper + dip rider for agent-fun/replay/v2 (pump.fun bonding curves).
//
// What the dev window (2026-11-02..03, 1222 universe coins) teaches:
// - A curve's price can never fall below its create price: virtual SOL is floored at the 30 SOL
//   seed and virtual tokens are capped at total supply, so price = vq/vt >= create price. A coin
//   "dies" by retracing to ~1.0x, not by going below it. Buying near the floor caps the downside;
//   buying after a run-up is what bleeds (the shipped momentum pilot loses ~94% that way).
// - Runs are fast: median 7 slots from create to peak, p75 109 slots. Entries must be decided in
//   the first few slots after CreateEvent, or on a retrace back toward the floor shortly after.
// - 23% of coins peak >= 2x, 12% >= 3x, 6.5% >= 5x, 3.8% >= 10x (from create). The edge is
//   asymmetric: buy near the floor (downside ~5-15% to the floor), ride the few that run with a
//   trailing stop, cut the rest fast. Fees are ~1.25% each way + 105k lamports per order, so a
//   round trip must clear ~3% before it makes money.
// - Size is capped at 1% of real SOL per reply per mint, so early buys are small; size is built
//   by adding while the coin runs and its real reserve grows.
//
// Two legs (only A is on by default: sweeps showed the dip leg dilutes the return
// slightly, +44.6% vs +45.0%, so it stays in the code as an option, off):
//  A) Snipe: in the first `maxAge` slots after create, buy coins with organic early flow
//     (several distinct non-creator buyers, creator not dumping, sell ratio low, run-up capped)
//     and add while the price steps up.
//  B) Dip: a coin that peaked >= `dipMinPeakBps` and retraced to within `dipBuyBps` of its floor
//     with fresh inflow is bought again - the second leg of a runner, still floor-protected.
//
// Exits: the position rides with a trailing stop once armed (no partial take-profit:
// sweeps showed letting the whole position ride beats selling a tranche early, +45.0%
// vs +39.8%); a full take-profit far above cost, a wide stop vs cost that almost never
// binds (the floor is the real stop), a creator-sell exit, and a time limit that does
// not apply while the position is up. Deterministic: no clock, no randomness,
// insertion-ordered maps only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const BPS = 10_000;
const CURVE_FEE = 0.0125;

export interface Params {
  // --- leg A: launch snipe ---
  maxAge: number; // oldest age (slots since create) for a first buy
  minRqSol: number; // real SOL reserve window at decision time
  maxRqSol: number;
  minBuyers: number; // distinct non-creator buyers seen before entry
  maxBuyers: number; // too many early buyers = bundled launch
  minTrades: number;
  maxDevBuySol: number; // creator's own buy in the create slot
  skipDevSold: boolean;
  maxSellRatioBps: number; // lamports sold by others / bought, at most
  maxRunupBps: number; // price now vs create price, at most
  minFlowSol: number; // net SOL (buys - sells) over flowWindow slots
  flowWindow: number;
  // --- sizing ---
  stakeSol: number; // total SOL aimed per coin
  minBuySol: number;
  maxAdds: number;
  addSol: number;
  addStepBps: number; // price must be this far above the last buy's decision price
  addDelay: number; // slots between buys on one coin
  addFlowSol: number; // adds require net SOL flow over flowWindow at least this
  buySlipBps: number;
  // --- exits ---
  tp1Bps: number; // first take-profit: sell tp1PartBps once up this much vs cost
  tp1PartBps: number;
  tpBps: number; // full exit once up this much vs cost
  slBps: number; // full exit once down this much vs cost
  trailArmBps: number; // trailing stop arms once up this much
  trailBps: number; // exit on a fall of this much from the best value
  maxHold: number; // slots
  holdIfUpBps: number; // maxHold does not apply while up at least this much vs cost
  exitOnDevSell: boolean;
  floorExitBps: number; // exit if price falls back to create*(1+floorExitBps) after arming
  floorArmBps: number; // arm the floor exit once up this much vs create
  staleSlots: number; // exit if no trade for this long
  // --- leg B: dip rider ---
  dipEnabled: boolean;
  dipMinPeakBps: number; // must have peaked this far above create
  dipBuyBps: number; // buy when retraced to this far above create (at most)
  dipMaxAge: number; // slots since create
  dipMinFlowSol: number; // fresh net inflow over flowWindow
  dipStakeSol: number;
  // --- pacing: keep fills/coins up without junk trades ---
  fillTarget: number;
  windowSeconds: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 12,
  minRqSol: 0.5,
  maxRqSol: 60,
  minBuyers: 5,
  maxBuyers: 40,
  minTrades: 8,
  maxDevBuySol: 1,
  skipDevSold: true,
  maxSellRatioBps: 5000,
  maxRunupBps: 6000,
  minFlowSol: 0,
  flowWindow: 10,
  stakeSol: 1,
  minBuySol: 0.005,
  maxAdds: 6,
  addSol: 0.4,
  addStepBps: 300,
  addDelay: 1,
  addFlowSol: 0,
  buySlipBps: 10_000,
  tp1Bps: 12_000,
  tp1PartBps: 0,
  tpBps: 60_000,
  slBps: 8000,
  trailArmBps: 2000,
  trailBps: 2400,
  maxHold: 600,
  holdIfUpBps: 2000,
  exitOnDevSell: true,
  floorExitBps: 500,
  floorArmBps: 2000,
  staleSlots: 150,
  dipEnabled: false,
  dipMinPeakBps: 10_000,
  dipBuyBps: 2500,
  dipMaxAge: 900,
  dipMinFlowSol: 0.2,
  dipStakeSol: 0.15,
  fillTarget: 300,
  windowSeconds: 21_600,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: number;
  vt0: number;
  devBuy: number;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  lastTradeSlot: number;
  recent: Tick[];
  peakMult: number; // best price / create price, in bps over 10000
  buysSent: number;
  spentSent: number;
  lastBuyPrice: number;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
  dipped: boolean; // leg B already used on this coin
}

interface Held {
  openedSlot: number;
  txPaid: number;
  best: number; // best close value seen (SOL)
  tookTp1: boolean;
  floorArmed: boolean;
}

function sellValue(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  const q = (tokens * vq) / (vt + tokens);
  return q * (1 - CURVE_FEE);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;
  let filled = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: Number(e.virtual_quote_reserves),
          vt0: Number(e.virtual_token_reserves),
          devBuy: 0,
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0,
          soldByOthers: 0,
          lastTradeSlot: e.slot,
          recent: [],
          peakMult: BPS,
          buysSent: 0,
          spentSent: 0,
          lastBuyPrice: 0,
          lastBuySlot: 0,
          done: false,
          complete: false,
          dipped: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / LAMPORTS;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        const multBps = Math.floor((price / (c.vq0 / c.vt0)) * BPS);
        if (multBps > c.peakMult) c.peakMult = multBps;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function flow(c: Coin, slot: number): { net: number; buyers: number } {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === side) return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map<Pubkey, { vq: number; vt: number }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: Number(m.virtual_quote_reserves), vt: Number(m.virtual_token_reserves) });
      }
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') filled += 1;
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: Number(f.tx_fee_lamports) / LAMPORTS, best: 0, tookTp1: false, floorArmed: false });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // ---- exits first ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0, tookTp1: false, floorArmed: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: Number(cv.virtual_quote_reserves), vt: Number(cv.virtual_token_reserves) };
        }
        const value = sellValue(Number(pos.token_amount), mk.vq, mk.vt) / LAMPORTS - tx;
        const basis = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
        if (value > h.best) h.best = value;
        if (c !== undefined && basis > 0) {
          const upBps = Math.floor(((value / basis) - 1) * BPS);
          if (upBps >= p.floorArmBps) h.floorArmed = true;
        }
        let exit = false;
        if (basis > 0) {
          if (!h.tookTp1 && value >= basis * (1 + p.tp1Bps / BPS)) {
            const part = (BigInt(pos.token_amount) * BigInt(p.tp1PartBps)) / BigInt(BPS);
            if (part > 0n && part < BigInt(pos.token_amount)) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0;
              continue;
            }
          }
          if (value >= basis * (1 + p.tpBps / BPS)) exit = true;
          if (value <= basis * (1 - p.slBps / BPS)) exit = true;
          if (h.best >= basis * (1 + p.trailArmBps / BPS) && value <= h.best * (1 - p.trailBps / BPS)) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold && !(basis > 0 && value >= basis * (1 + p.holdIfUpBps / BPS))) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (h.floorArmed) {
            const createPrice = c.vq0 / c.vt0;
            const nowPrice = mk.vq / mk.vt;
            if (nowPrice <= createPrice * (1 + p.floorExitBps / BPS)) exit = true;
          }
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // ---- entries ----
      let free = Number(state.freeCashLamports()) / LAMPORTS - tx * orders.length;
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          if (c.buysSent === 0) c.done = true;
          continue;
        }
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const price = vq / vt;
        const createPrice = c.vq0 / c.vt0;
        const runupBps = Math.floor((price / createPrice - 1) * BPS);
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        const isAdd = c.buysSent > 0;
        if (isAdd) {
          if (c.buysSent > p.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
          if (state.slot - c.lastBuySlot < p.addDelay) continue;
          if (runupBps < Math.floor((c.lastBuyPrice / createPrice - 1) * BPS) + p.addStepBps) continue;
          if (flow(c, state.slot).net < p.addFlowSol) continue;
          const maxAdd = Number(state.maxBuyLamports(c.mint)) / LAMPORTS;
          const room = p.stakeSol - c.spentSent;
          const amount = Math.min(p.addSol, room, maxAdd);
          if (amount < p.minBuySol || free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyPrice = price;
          c.lastBuySlot = state.slot;
          continue;
        }
        // First buy: leg A (snipe) or leg B (dip).
        const fl = flow(c, state.slot);
        let stake = 0;
        if (age <= p.maxAge) {
          if (open >= state.hello.caps.max_open_positions) continue;
          if (rq < p.minRqSol || rq > p.maxRqSol) continue;
          if (c.devBuy > p.maxDevBuySol) continue;
          if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
          if (c.bought > 0 && c.soldByOthers > (c.bought * p.maxSellRatioBps) / BPS) continue;
          if (runupBps > p.maxRunupBps) continue;
          if (fl.net < p.minFlowSol) continue;
          stake = p.stakeSol;
        } else if (p.dipEnabled && !c.dipped && age <= p.dipMaxAge && c.peakMult >= BPS + p.dipMinPeakBps) {
          if (open >= state.hello.caps.max_open_positions) continue;
          if (rq < p.minRqSol || rq > p.maxRqSol) continue;
          if (runupBps > p.dipBuyBps) continue;
          if (fl.net < p.dipMinFlowSol) continue;
          if (c.buyers.size < p.minBuyers) continue;
          stake = p.dipStakeSol;
          c.dipped = true;
        } else {
          if (age > Math.max(p.maxAge, p.dipMaxAge)) c.done = true;
          continue;
        }
        const maxBuy = Number(state.maxBuyLamports(c.mint)) / LAMPORTS;
        const amount = Math.min(stake, maxBuy);
        if (amount < p.minBuySol || free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyPrice = price;
        c.lastBuySlot = state.slot;
        open += 1;
      }
      return orders;
    },
  };
}
