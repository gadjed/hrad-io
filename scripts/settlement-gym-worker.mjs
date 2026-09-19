#!/usr/bin/env node
/**
 * Headless Settlement Planner gym worker.
 * Protocol: one JSON object per stdin line; one JSON object per stdout line.
 * Logs go to stderr only.
 */
import readline from "node:readline";
import { TILE, NPC_FACTION, dist2 } from "../shared/defs.mjs";
import { PrototypeStore } from "../server/PrototypeStore.mjs";
import { World } from "../server/World.mjs";
import { OllamaEvaluator } from "../server/OllamaEvaluator.mjs";
import {
  ACTION_COUNT,
  ACTION_NAMES,
  OBS_DIM,
  clipReward,
  executeDecision,
  lockNpcBrains,
  observe,
  parameterizeAction,
  pickNpcSettlement,
  utilityBreakdown,
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
const ENV_ID = String(process.env.SETTLEMENT_GYM_ENV_ID || "0");
const DASH_URL = String(process.env.TRAIN_DASH_URL || "").replace(/\/$/, "");

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.error("[gym-worker]", ...args);
}

function dashEmit(event) {
  if (!DASH_URL) return Promise.resolve();
  return fetch(`${DASH_URL}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...event,
      ts: Date.now(),
      envId: ENV_ID,
    }),
    signal: AbortSignal.timeout(200),
  }).catch(() => {});
}

function nearbyNodesViz(world, settlementId) {
  const core = world.factionCore(settlementId);
  if (!core) return [];
  const scan2 = NPC_FACTION.harvestScan * NPC_FACTION.harvestScan;
  const nodes = [];
  for (const n of world.nodes.values()) {
    if (!n.alive) continue;
    if (dist2(n.x, n.y, core.x, core.y) > scan2) continue;
    nodes.push({
      kind: n.kind,
      tx: Math.floor(n.x / TILE),
      ty: Math.floor(n.y / TILE),
    });
    if (nodes.length >= 80) break;
  }
  return nodes;
}

function packHighlight(observation, decision) {
  const action = decision?.action || {};
  if (action.op === "place" && action.tx != null && action.ty != null) {
    return {
      kind: "place",
      tx: action.tx,
      ty: action.ty,
      buildingId: null,
      type: action.type || null,
    };
  }
  if (action.building_id) {
    const b = (observation.buildings || []).find((x) => x.id === action.building_id);
    return {
      kind: action.op || "target",
      tx: b?.tx ?? null,
      ty: b?.ty ?? null,
      buildingId: action.building_id,
      type: b?.type || action.type || null,
    };
  }
  return { kind: "none", tx: null, ty: null, buildingId: null, type: null };
}

function packViz(world, settlementId, observation, decision) {
  const ring = observation.ring || null;
  return {
    keep: observation.keep || null,
    core: observation.core || null,
    buildings: (observation.buildings || []).map((b) => ({
      id: b.id,
      type: b.type,
      tx: b.tx,
      ty: b.ty,
      w: b.w,
      h: b.h,
      hp: b.hp,
      max_hp: b.max_hp,
      level: b.level,
    })),
    holes: (ring?.holes || []).map((h) => ({ tx: h.tx, ty: h.ty, gate: !!h.gate })),
    ring: ring
      ? {
          x0: ring.x0,
          y0: ring.y0,
          x1: ring.x1,
          y1: ring.y1,
          integrity: ring.integrity,
        }
      : null,
    nodes: nearbyNodesViz(world, settlementId),
    highlight: packHighlight(observation, decision),
  };
}

function compactBreakdown(full) {
  return {
    E: full.E,
    D: full.D,
    S: full.S,
    F: full.F,
    W: full.W,
    U: full.U,
    towers: full.towers,
    spikes: full.spikes,
    gates: full.gates,
    harvestZero: full.harvestZero,
    coreRatio: full.coreRatio,
    wallHp: full.wallHp,
    cov: full.cov,
  };
}

class GymSession {
  constructor() {
    this.store = null;
    this.world = null;
    this.settlementId = null;
    this.stepCount = 0;
    this.episode = 0;
    this.episodeReward = 0;
    this.prevUtility = 0;
    this.proposalId = 0;
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
    void dashEmit({
      type: "worker_ready",
      actions: ACTION_NAMES,
      ollama: USE_OLLAMA,
      ollamaFreq: OLLAMA_FREQ,
      ticks: TICKS,
      maxSteps: MAX_STEPS,
      model: this.ollama?.model || null,
    });
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
    this.episode += 1;
    this.episodeReward = 0;
    const snap = this.snapshot();
    this.prevUtility = snap.utility;
    const breakdown = compactBreakdown(utilityBreakdown(snap.observation));
    void dashEmit({
      type: "episode",
      episode: this.episode,
      settlementId: this.settlementId,
      utility: snap.utility,
      breakdown,
      treasury: snap.observation.treasury,
      threat: snap.observation.threat,
      tick: this.world.tick,
      buildings: snap.observation.buildings.length,
      viz: packViz(this.world, this.settlementId, snap.observation, null),
    });
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
    const isWait = idx === 0 || (decision.action?.op || "wait") === "wait";

    if (!isWait) {
      for (let i = 0; i < TICKS; i++) this.world.step();
    }
    this.stepCount++;

    const snap = this.snapshot();
    const coreGone = !this.world.factionCore(this.settlementId);
    const truncated = this.stepCount >= MAX_STEPS;
    const done = coreGone;
    const breakdown = compactBreakdown(utilityBreakdown(snap.observation));

    const rewardGame = clipReward((snap.utility - this.prevUtility) / 80);
    let reward = rewardGame;
    if (!executed && idx !== 0) reward = clipReward(reward - 0.02);
    this.prevUtility = snap.utility;

    const ollamaDue = !!(!isWait && this.ollama && this.stepCount % OLLAMA_FREQ === 0);
    const proposalId = ++this.proposalId;
    const actionName = ACTION_NAMES[idx];
    const legal = [];
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (snap.mask[i]) legal.push(ACTION_NAMES[i]);
    }

    const proposal = {
      type: "proposal",
      proposalId,
      episode: this.episode,
      step: this.stepCount,
      settlementId: this.settlementId,
      tick: this.world.tick,
      actionIndex: idx,
      actionName,
      executed,
      rewardGame,
      reward,
      utility: snap.utility,
      breakdown,
      treasury: snap.observation.treasury,
      threat: snap.observation.threat,
      enemiesNearby: !!snap.observation.enemies_nearby,
      buildings: snap.observation.buildings.length,
      legal,
      decision: {
        mode: decision.mode,
        action: decision.action,
        rationale: decision.rationale || "",
      },
      viz: packViz(this.world, this.settlementId, snap.observation, decision),
      ollamaPending: ollamaDue,
      ollamaIn: this.ollama ? (OLLAMA_FREQ - (this.stepCount % OLLAMA_FREQ)) % OLLAMA_FREQ : null,
      skippedWait: isWait,
    };
    void dashEmit(proposal);

    if (ollamaDue) {
      await dashEmit({
        type: "ollama_start",
        proposalId,
        actionName,
        model: this.ollama.model,
        episode: this.episode,
        step: this.stepCount,
      });
      const ev = await this.ollama.evaluateDetailed(snap.observation, decision);
      const ollamaReward = (ev.score - 5) / 5;
      reward = clipReward(0.7 * reward + 0.3 * ollamaReward);
      void dashEmit({
        type: "ollama_done",
        proposalId,
        actionName,
        score: ev.score,
        raw: ev.raw,
        ms: ev.ms,
        cached: ev.cached,
        error: ev.error,
        model: ev.model,
        reward,
        rewardGame,
        ollamaReward,
      });
    }

    this.episodeReward += reward;
    if (done || truncated) {
      void dashEmit({
        type: "episode_end",
        episode: this.episode,
        steps: this.stepCount,
        reward: this.episodeReward,
        utility: snap.utility,
        reason: done ? "core_lost" : "truncated",
      });
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
        action: actionName,
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
