#!/usr/bin/env node
/**
 * Headless Settlement Planner gym worker.
 * Protocol: one JSON object per stdin line; one JSON object per stdout line.
 * Logs go to stderr only.
 */
import readline from "node:readline";
import { PrototypeStore } from "../server/PrototypeStore.mjs";
import { World } from "../server/World.mjs";
import { OllamaEvaluator } from "../server/OllamaEvaluator.mjs";
import {
  ACTION_COUNT,
  ACTION_NAMES,
  OBS_DIM,
  calculateUtility,
  clipReward,
  executeDecision,
  lockNpcBrains,
  observe,
  parameterizeAction,
  pickNpcSettlement,
} from "../server/SettlementPlanner.mjs";

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name) {
  const v = String(process.env[name] || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const TICKS = envInt("SETTLEMENT_GYM_TICKS", 10);
const MAX_STEPS = envInt("SETTLEMENT_GYM_MAX_STEPS", 500);
const USE_OLLAMA = envFlag("SETTLEMENT_GYM_USE_OLLAMA");
const OLLAMA_FREQ = envInt("SETTLEMENT_GYM_OLLAMA_FREQ", 10);

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.error("[gym-worker]", ...args);
}

class GymSession {
  constructor() {
    this.store = null;
    this.world = null;
    this.settlementId = null;
    this.stepCount = 0;
    this.prevUtility = 0;
    this.ollama = USE_OLLAMA
      ? new OllamaEvaluator({
          host: process.env.OLLAMA_HOST || "localhost",
          port: process.env.OLLAMA_PORT || 11434,
          model: process.env.OLLAMA_MODEL || "gemma4:e4b",
        })
      : null;
  }

  async init() {
    this.store = new PrototypeStore();
    await this.store.init();
    log(`ready · ticks=${TICKS} max_steps=${MAX_STEPS} ollama=${USE_OLLAMA ? "on" : "off"}`);
  }

  async freshWorld() {
    const world = new World({ mode: "world", prototypes: this.store });
    world._silent = true;
    world.generate();
    world.rebuildOccupancy();
    lockNpcBrains(world);
    return world;
  }

  snapshot() {
    const packed = observe(this.world, this.settlementId);
    return {
      obs: packed.obs,
      mask: packed.mask,
      observation: packed.observation,
      utility: packed.utility,
    };
  }

  async reset() {
    this.world = await this.freshWorld();
    this.settlementId = pickNpcSettlement(this.world);
    if (!this.settlementId) {
      throw new Error("no NPC settlement after generate()");
    }
    this.stepCount = 0;
    const snap = this.snapshot();
    this.prevUtility = snap.utility;
    return {
      ok: true,
      obs: snap.obs,
      mask: snap.mask,
      info: {
        settlement_id: this.settlementId,
        utility: snap.utility,
        tick: this.world.tick,
        buildings: snap.observation.buildings.length,
      },
    };
  }

  async step(actionIndex) {
    if (!this.world || !this.settlementId) {
      throw new Error("step before reset");
    }
    const idx = Number(actionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= ACTION_COUNT) {
      throw new Error(`invalid action ${actionIndex}`);
    }

    const decision = parameterizeAction(this.world, this.settlementId, idx) || {
      mode: "wait",
      action: { op: "wait", building_id: null, type: null, tx: null, ty: null, rot: null },
      queue: [],
      utility_estimate: 0,
      rationale: "invalid masked as wait",
    };
    const executed = executeDecision(this.world, this.settlementId, decision);

    for (let i = 0; i < TICKS; i++) this.world.step();
    this.stepCount++;

    const snap = this.snapshot();
    const coreGone = !this.world.factionCore(this.settlementId);
    const truncated = this.stepCount >= MAX_STEPS;
    const done = coreGone;

    let reward = clipReward((snap.utility - this.prevUtility) / 80);
    if (!executed && idx !== 0) reward = clipReward(reward - 0.02);
    this.prevUtility = snap.utility;

    if (this.ollama && this.stepCount % OLLAMA_FREQ === 0) {
      const score = await this.ollama.evaluateDecision(snap.observation, decision);
      const ollamaReward = (score - 5) / 5;
      reward = clipReward(0.7 * reward + 0.3 * ollamaReward);
    }

    return {
      ok: true,
      obs: snap.obs,
      mask: snap.mask,
      reward,
      done,
      truncated,
      info: {
        settlement_id: this.settlementId,
        utility: snap.utility,
        tick: this.world.tick,
        executed,
        action: ACTION_NAMES[idx],
        op: decision.action?.op || "wait",
      },
    };
  }
}

async function main() {
  const session = new GymSession();
  await session.init();

  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();

  const handle = async (line) => {
    const raw = String(line || "").trim();
    if (!raw) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send({ ok: false, error: "invalid json" });
      return;
    }
    try {
      if (msg.cmd === "reset") {
        send(await session.reset());
        return;
      }
      if (msg.cmd === "step") {
        send(await session.step(msg.action));
        return;
      }
      if (msg.cmd === "close") {
        send({ ok: true, dim: OBS_DIM, actions: ACTION_COUNT });
        process.exit(0);
      }
      if (msg.cmd === "spec") {
        send({ ok: true, obs_dim: OBS_DIM, action_count: ACTION_COUNT, names: ACTION_NAMES });
        return;
      }
      send({ ok: false, error: `unknown cmd ${msg.cmd}` });
    } catch (err) {
      send({ ok: false, error: err.message || String(err) });
    }
  };

  rl.on("line", (line) => {
    chain = chain.then(() => handle(line)).catch((err) => {
      send({ ok: false, error: err.message || String(err) });
    });
  });

  rl.on("close", () => process.exit(0));
}

main().catch((err) => {
  log(err);
  process.exit(1);
});
