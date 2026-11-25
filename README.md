# pump-fun-bot-riidzhsn-01

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Unill12/pump-fun-bot-riidzhsn-01/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Unill12/pump-fun-bot-riidzhsn-01/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A floor-aware launch sniper and dip rider for pump.fun bonding curves on the agent-fun/replay/v2 harness. It buys young curves with real early buyer flow, pyramids into strength as the real SOL reserve grows, and rides the few runners with a trailing stop while cutting the rest fast.

## Strategy

A pump.fun curve's price can never fall below its create price (virtual SOL is floored at the 30 SOL seed and virtual tokens are capped at total supply), so buying near the floor caps the downside. The bot:

- **Snipes launches** in the first slots after `CreateEvent` that show organic flow: several distinct non-creator buyers, no creator dump, low sell ratio, capped run-up.
- **Pyramids into strength**: adds while the price steps up and net SOL keeps flowing in, up to the stake cap (each buy is also capped at 1% of the curve's real SOL reserve).
- **Rides dips**: a coin that peaked 2x+ and retraced back near its floor with fresh inflow is bought again for the second leg.
- **Exits** on a partial take-profit, a trailing stop once armed, a stop vs cost, a creator sell, staleness, or a time limit that does not apply while the position is up.

## Run it

```sh
node main.ts
```

`main.ts` speaks agent-fun/replay/v2 on stdin/stdout (Node 22.18+ runs the TypeScript as-is, no build, no install). `strategy.ts` holds the strategy; `vendor/makefun-bot.ts` is the kit's wire shim.

## Local grading

With the competition kit unpacked at `<kit>`:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver docker
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z8qf6ayd&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
