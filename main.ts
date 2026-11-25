// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
// Entry point: wires the steady-survivor strategy (strategy.ts) into the
// make.fun replay harness (agent-fun/replay/v2) via the vendored SDK shim.
// Run by the grader as `node /bot/main.ts` with this directory at /bot.
// The config is validated before the bot starts, so a bad parameter set
// fails loudly here instead of trading on it in the replay.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, validateConfig } from './strategy.ts';

validateConfig(DEFAULT_PARAMS);
await runBot(createStrategy(DEFAULT_PARAMS));
