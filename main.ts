// Pump.fun Bot Sprint entry: floor-aware launch sniper + dip rider.
//
// Strategy lives in strategy.ts (createStrategy). This file only wires it to the
// agent-fun/replay/v2 harness through the vendored shim: stdin/stdout JSONL, one reply
// per batch, deterministic by construction (no clock, no randomness, no I/O).
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
