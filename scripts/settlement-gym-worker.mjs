#!/usr/bin/env node
/**
 * Headless Settlement Planner gym worker.
 * Protocol: one JSON object per stdin line; one JSON object per stdout line.
 * Logs go to stderr only.
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrototypeStore } from "../server/PrototypeStore.mjs";
import { World } from "../server/World.mjs";
import { OllamaEvaluator } from "../server/OllamaEvaluator.mjs";
import {
  ACTION_COUNT,
  ACTION_NAMES,
  CELL_COUNT,
  GRID_CH,
  KEEP_N,
  OBS_DIM,
  clipReward,
  executeDecision,
  lockNpcBrains,
  observe,
  parameterizeAction,
  parameterizeActionAt,
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

function envFlagDefault(name, fallback) {
  if (process.env[name] == null || process.env[name] === "") return fallback;
  return envFlag(name);
}

const TICKS = envInt("SETTLEMENT_GYM_TICKS", 10);
const MAX_STEPS = envInt("SETTLEMENT_GYM_MAX_STEPS", 500);
const USE_OLLAMA = envFlag("SETTLEMENT_GYM_USE_OLLAMA");
const OLLAMA_FREQ = envInt("SETTLEMENT_GYM_OLLAMA_FREQ", 1);
const ENV_ID = String(process.env.SETTLEMENT_GYM_ENV_ID || "0");
const DASH_URL = String(process.env.TRAIN_DASH_URL || "").replace(/\/$/, "");
const DESIGN = envFlagDefault("SETTLEMENT_GYM_DESIGN", true);
const INFINITE = envFlagDefault("SETTLEMENT_GYM_INFINITE_TREASURY", true);
const OLLAMA_OK = 7;
const OLLAMA_SAMPLE_EVERY = envInt("SETTLEMENT_GYM_OLLAMA_SAMPLE", 10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLLAMA_LOG_DIR = path.join(ROOT, "logs", "ollama");

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(...args) {
  console.error("[gym-worker]", ...args);
}

function appendOllamaSample(record) {
  try {
    fs.mkdirSync(OLLAMA_LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(OLLAMA_LOG_DIR, `${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch (err) {
    log("ollama sample write failed", err.message);
  }
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
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
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

function packViz(observation, decision) {
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
    P: full.P,
    overlap: full.overlap,
    clog: full.clog,
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
    this.gymSteps = 0;
    this.failStreak = 0;
    this.sellStreak = 0;
    this.ollamaCalls = 0;
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
    log(`ready · ticks=${TICKS} max_steps=${MAX_STEPS} ollama=${USE_OLLAMA ? "on" : "off"} design=${DESIGN ? "on" : "off"}`);
    void dashEmit({
      type: "worker_ready",
      actions: ACTION_NAMES,
      ollama: USE_OLLAMA,
      ollamaFreq: OLLAMA_FREQ,
      ticks: TICKS,
      maxSteps: MAX_STEPS,
      model: this.ollama?.model || null,
      keepN: KEEP_N,
      gridCh: GRID_CH,
      twoHead: true,
    });
  }

  async freshWorld() {
    const world = new World({ mode: "world", prototypes: this.store });
    world._silent = true;
    if (DESIGN) {
      world._designGym = true;
      world._infiniteTreasury = INFINITE;
      world.placeBareNpcKeep({ tx: 79, ty: 79, level: 1 });
    } else {
      world.generate();
      world.rebuildOccupancy();
    }
    lockNpcBrains(world);
    return world;
  }

  snapshot() {
    const packed = observe(this.world, this.settlementId);
    return {
      obs: packed.obs,
      grid: packed.grid,
      mask: packed.mask,
      cellMask: packed.cellMask,
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
    this.failStreak = 0;
    this.sellStreak = 0;
    const snap = this.snapshot();
    this.prevUtility = snap.utility;
    const breakdown = compactBreakdown(utilityBreakdown(snap.observation));
    void dashEmit({
      type: "episode",
      episode: this.episode,
      settlementId: this.settlementId,
      utility: snap.utility,
      breakdown,
      buildings: snap.observation.buildings.length,
      viz: packViz(snap.observation, null),
    });
    return {
      ok: true,
      obs: snap.obs,
      grid: snap.grid,
      mask: snap.mask,
      cellMask: snap.cellMask,
      info: {
        settlement_id: this.settlementId,
        utility: snap.utility,
        tick: this.world.tick,
        buildings: snap.observation.buildings.length,
      },
    };
  }

  async step(actionIndex, cellIndex = null) {
    if (!this.world || !this.settlementId) {
      throw new Error("step before reset");
    }
    const idx = Number(actionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= ACTION_COUNT) {
      throw new Error(`invalid action ${actionIndex}`);
    }

    const useCell = cellIndex != null && Number.isInteger(Number(cellIndex));
    const decision = (
      useCell
        ? parameterizeActionAt(this.world, this.settlementId, idx, Number(cellIndex))
        : parameterizeAction(this.world, this.settlementId, idx)
    ) || {
      mode: "wait",
      action: { op: "wait", building_id: null, type: null, tx: null, ty: null, rot: null },
      queue: [],
      utility_estimate: 0,
      rationale: "invalid masked as wait",
    };
    const executed = executeDecision(this.world, this.settlementId, decision);
    const illegal = decision.illegal || null;
    const isWait = !illegal && (idx === 0 || (decision.action?.op || "wait") === "wait");

    if (!isWait && !DESIGN) {
      for (let i = 0; i < TICKS; i++) this.world.step();
    }
    this.stepCount++;
    this.gymSteps += 1;

    const snap = this.snapshot();
    const coreGone = !this.world.factionCore(this.settlementId);
    const truncated = this.stepCount >= MAX_STEPS;
    const done = coreGone;
    const breakdown = compactBreakdown(utilityBreakdown(snap.observation));

    const rewardGame = clipReward((snap.utility - this.prevUtility) / 80);
    let reward = rewardGame;
    if (illegal) reward = clipReward(-0.7);
    else if (!executed && idx !== 0) reward = clipReward(reward - (useCell ? 0.08 : 0.02));
    this.prevUtility = snap.utility;

    if (executed && decision.action?.op === "sell") this.sellStreak += 1;
    else if (executed && decision.action?.op === "place") this.sellStreak = 0;

    let stripped = false;
    if (this.sellStreak >= 3) {
      this.world.stripSettlementToCore(this.settlementId);
      this.sellStreak = 0;
      this.failStreak = 0;
      stripped = true;
      void dashEmit({ type: "reset_to_core", reason: "sell_streak", episode: this.episode, step: this.stepCount });
    }

    const ollamaDue = !!(!illegal && !isWait && executed && this.ollama && this.stepCount % OLLAMA_FREQ === 0);
    const proposalId = ++this.proposalId;
    const actionName = ACTION_NAMES[idx];
    const legal = [];
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (snap.mask[i]) legal.push(ACTION_NAMES[i]);
    }

    const proposal = {
      type: "proposal",
      proposalId,
      gymSteps: this.gymSteps,
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
      buildings: snap.observation.buildings.length,
      legal,
      decision: {
        mode: decision.mode,
        action: decision.action,
        rationale: decision.rationale || "",
      },
      viz: packViz(snap.observation, decision),
      ollamaPending: ollamaDue,
      ollamaIn: this.ollama ? (OLLAMA_FREQ - (this.stepCount % OLLAMA_FREQ)) % OLLAMA_FREQ : null,
      skippedWait: isWait,
      ruleFail: illegal,
    };
    void dashEmit(proposal);

    if (illegal) {
      this.failStreak += 1;
      if (this.failStreak >= 3) {
        this.world.stripSettlementToCore(this.settlementId);
        this.failStreak = 0;
        this.sellStreak = 0;
        stripped = true;
        void dashEmit({ type: "reset_to_core", reason: illegal, episode: this.episode, step: this.stepCount });
      }
      await dashEmit({
        type: "ollama_done",
        proposalId,
        actionName,
        score: 0,
        ok: false,
        raw: illegal === "contour" ? "contour_walls_only" : "outside_keep",
        ms: 0,
        cached: true,
        error: null,
        model: "rule",
        reward,
        rewardGame,
        ollamaReward: -1,
        failStreak: this.failStreak,
        resetToCore: stripped,
        ruleFail: illegal,
      });
    } else if (ollamaDue) {
      await dashEmit({
        type: "ollama_start",
        proposalId,
        actionName,
        model: this.ollama.model,
        episode: this.episode,
        step: this.stepCount,
      });
      const ev = await this.ollama.evaluateDetailed(snap.observation, decision);
      const ok = ev.score > OLLAMA_OK;
      const ollamaReward = (ev.score - 5) / 5;
      reward = clipReward(0.7 * reward + 0.3 * ollamaReward);
      if (ok) this.failStreak = 0;
      else this.failStreak += 1;
      if (this.failStreak >= 3) {
        this.world.stripSettlementToCore(this.settlementId);
        this.failStreak = 0;
        this.sellStreak = 0;
        stripped = true;
        void dashEmit({ type: "reset_to_core", reason: "ollama_fail_streak", episode: this.episode, step: this.stepCount });
      }
      if (!ev.cached) {
        this.ollamaCalls += 1;
        if (this.ollamaCalls % OLLAMA_SAMPLE_EVERY === 0) {
          appendOllamaSample({
            ts: Date.now(),
            n: this.ollamaCalls,
            envId: ENV_ID,
            episode: this.episode,
            step: this.stepCount,
            gymSteps: this.gymSteps,
            proposalId,
            actionName,
            executed,
            ok,
            score: ev.score,
            ms: ev.ms,
            model: ev.model,
            error: ev.error,
            prompt: ev.prompt || "",
            response: ev.raw || "",
            decision: decision.action || null,
            rationale: decision.rationale || "",
            buildings: (snap.observation.buildings || []).map((b) => ({
              type: b.type,
              tx: b.tx,
              ty: b.ty,
              w: b.w,
              h: b.h,
              level: b.level,
            })),
          });
        }
      }
      await dashEmit({
        type: "ollama_done",
        proposalId,
        actionName,
        score: ev.score,
        ok,
        raw: ev.raw,
        ms: ev.ms,
        cached: ev.cached,
        error: ev.error,
        model: ev.model,
        reward,
        rewardGame,
        ollamaReward,
        failStreak: this.failStreak,
        resetToCore: stripped,
      });
    }

    if (stripped) {
      const after = this.snapshot();
      this.prevUtility = after.utility;
      snap.obs = after.obs;
      snap.grid = after.grid;
      snap.mask = after.mask;
      snap.cellMask = after.cellMask;
      snap.utility = after.utility;
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
      grid: snap.grid,
      mask: snap.mask,
      cellMask: snap.cellMask,
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
        cell: useCell ? Number(cellIndex) : null,
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
        send(await session.step(msg.action, msg.cell));
        return;
      }
      if (msg.cmd === "close") {
        send({ ok: true, dim: OBS_DIM, actions: ACTION_COUNT });
        process.exit(0);
      }
      if (msg.cmd === "spec") {
        send({
          ok: true,
          obs_dim: OBS_DIM,
          action_count: ACTION_COUNT,
          keep_n: KEEP_N,
          grid_ch: GRID_CH,
          cell_count: CELL_COUNT,
          names: ACTION_NAMES,
        });
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
