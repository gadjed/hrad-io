/**
 * Export settlement planner observations from a World instance (JSONL for training).
 *
 * Examples:
 *   node scripts/export-settlement-snapshots.mjs --out data/training/snapshots.jsonl
 *   node scripts/export-settlement-snapshots.mjs --load --steps 200 --interval 5 --with-labels
 */
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrototypeStore } from "../server/PrototypeStore.mjs";
import { World } from "../server/World.mjs";
import { WorldStore } from "../server/WorldStore.mjs";
import {
  jobToPlannerAction,
  listSettlementIds,
  settlementPlannerObservation,
} from "../server/SettlementSnapshot.mjs";
import { DT, NPC_FACTION } from "../shared/defs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

async function loadWorld() {
  const store = new PrototypeStore();
  await store.init();
  const world = new World({ mode: "world", prototypes: store });
  const dbPath = path.join(root, "data/world.sqlite");
  const worldStore = new WorldStore(dbPath);
  const snap = worldStore.load();
  if (snap) {
    world.hydrate(snap);
    world.rebuildOccupancy();
    world.repairOccupancyIntegrity();
    world.reconcileNpcSettlements();
    world.catchUp((Date.now() - snap.savedAt) / 1000);
    if (world.monsters.size === 0) world.spawnMonsters();
    if (world.bots.size === 0) world.spawnWorldBots();
    return world;
  }
  world.scatterNodes();
  world.placeNpcSettlements(10);
  world.spawnMonsters();
  world.spawnWorldBots();
  world.rebuildOccupancy();
  return world;
}

async function freshWorld() {
  const store = new PrototypeStore();
  await store.init();
  const world = new World({ mode: "world", prototypes: store });
  world.generate();
  world.rebuildOccupancy();
  return world;
}

function expertDecision(world, settlementId, observation) {
  const fac = world.factions.get(settlementId);
  if (!fac?.npc) return null;
  const action = jobToPlannerAction(fac.job);
  return {
    mode: fac.desire || "wait",
    action,
    queue: [],
    utility_estimate: 0,
    rationale: fac.job ? `NpcBrain job ${fac.job.kind}` : "No active job",
  };
}

async function main() {
  const outArg = arg("--out", "data/training/snapshots.jsonl");
  const outPath = path.isAbsolute(outArg) ? outArg : path.join(root, outArg);
  const loadSaved = !!arg("--load", false);
  const steps = Number(arg("--steps", "0")) || 0;
  const interval = Math.max(1, Number(arg("--interval", "1")) || 1);
  const withLabels = !!arg("--with-labels", false);
  const includeMeta = !!arg("--meta", false) || withLabels;
  const settlementFilter = arg("--settlement", null);
  const truncate = !!arg("--truncate", false);

  const world = loadSaved ? await loadWorld() : await freshWorld();
  world._silent = true;

  await mkdir(path.dirname(outPath), { recursive: true });
  if (truncate) await writeFile(outPath, "", "utf8");

  const tickEvery = Math.max(1, Math.round(interval / DT));
  let written = 0;

  const emit = async () => {
    let ids = listSettlementIds(world);
    if (settlementFilter) ids = ids.filter((id) => id === settlementFilter);
    for (const id of ids) {
      const observation = settlementPlannerObservation(world, id, { includeMeta });
      const record = {
        observation,
        settlement_id: id,
        tick: world.tick,
      };
      if (withLabels) {
        const decision = expertDecision(world, id, observation);
        if (decision) record.decision = decision;
      }
      await appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
      written++;
    }
  };

  await emit();
  for (let s = 0; s < steps; s++) {
    world.step();
    if (world.tick % tickEvery !== 0) continue;
    if (withLabels) {
      world.brain.step({ force: world.tick % Math.max(1, Math.round(NPC_FACTION.brainPeriod / DT)) === 0 });
    }
    await emit();
  }

  console.log(
    `Wrote ${written} snapshot(s) → ${outPath} · settlements ${listSettlementIds(world).length} · final tick ${world.tick}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
