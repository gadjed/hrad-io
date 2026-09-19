import {
  BUILDINGS,
  CORE,
  NODE_TYPES,
  NPC,
  NPC_FACTION,
  dist2,
  emptyStock,
} from "../shared/defs.mjs";

/** Settlement team ids that own a core building. */
export function listSettlementIds(world) {
  const ids = new Set();
  for (const b of world.buildings.values()) {
    if (b.type !== "core") continue;
    ids.add(b.team || b.ownerId);
  }
  return [...ids].filter(Boolean).sort();
}

function factionLike(world, settlementId) {
  const fac = world.factions.get(settlementId);
  if (fac) return world.ensureFaction(fac);
  return { id: settlementId, threat: 0, npc: false };
}

function treasuryFor(world, settlementId) {
  const wallet = world.fortWallet(settlementId);
  if (wallet) return emptyStock(wallet);
  const bot = world.bots.get(settlementId);
  if (bot?.treasury) return emptyStock(bot.treasury);
  if (bot?.stock) return emptyStock(bot.stock);
  const acc = world.accounts.get(settlementId);
  if (acc?.treasury) return emptyStock(acc.treasury);
  if (acc?.stock) return emptyStock(acc.stock);
  return emptyStock();
}

function nearbyNodes(world, core) {
  const out = { wood: 0, stone: 0, gold: 0 };
  if (!core) return out;
  const scan2 = NPC_FACTION.harvestScan * NPC_FACTION.harvestScan;
  for (const n of world.nodes.values()) {
    if (!n.alive) continue;
    if (dist2(core.x, core.y, n.x, n.y) > scan2) continue;
    const res = NODE_TYPES[n.kind]?.resource;
    if (res) out[res] += 1;
  }
  return out;
}

function enemiesNearby(world, settlementId, core) {
  if (!core) return false;
  const r2 = NPC.aggro * NPC.aggro;
  for (const p of world.players.values()) {
    if (!p.alive || p.team === settlementId) continue;
    if (dist2(p.x, p.y, core.x, core.y) <= r2) return true;
  }
  for (const bot of world.bots.values()) {
    if (!bot.alive || bot.team === settlementId) continue;
    if (dist2(bot.x, bot.y, core.x, core.y) <= r2) return true;
  }
  return false;
}

function packRing(world, f, core) {
  if (!core) return null;
  const ring = world.wallRing(f, core);
  const integrity = ring.cells.length
    ? 1 - ring.holes.length / ring.cells.length
    : 0;
  return {
    x0: ring.x0,
    y0: ring.y0,
    x1: ring.x1,
    y1: ring.y1,
    integrity,
    holes: ring.holes.map((h) => ({
      tx: h.tx,
      ty: h.ty,
      rot: h.rot ?? 0,
      gate: !!h.gate,
    })),
    corners: ring.corners.map((c) => ({ tx: c.tx, ty: c.ty })),
    can_expand: !!ring.next,
  };
}

function buildingCoverage(world, b) {
  const def = BUILDINGS[b.type];
  if (!def?.harvest) return null;
  return world.countHarvestNodes(b, def);
}

/**
 * Build a settlement planner observation object (matches docs/schemas/settlement-planner-observation.schema.json).
 * @param {import("./World.mjs").World} world
 * @param {string} settlementId
 * @param {{ includeMeta?: boolean }} [opts]
 */
export function settlementPlannerObservation(world, settlementId, opts = {}) {
  const f = factionLike(world, settlementId);
  const fac = world.factions.get(settlementId);
  const core =
    world.playerCore(settlementId)
    || world.factionCore(fac || settlementId)
    || null;

  const keep = core ? world.keepForCore(core) : null;
  const treasury = treasuryFor(world, settlementId);
  let threat = fac?.threat ?? 0;
  if (enemiesNearby(world, settlementId, core)) {
    threat = Math.min(1, Math.max(threat, 0.22));
  }

  const buildings = world.buildingsOf(settlementId, core).map((b) => ({
    id: b.id,
    type: b.type,
    tx: b.tx,
    ty: b.ty,
    w: b.w,
    h: b.h,
    rot: b.rot || 0,
    level: b.level || 1,
    hp: b.hp,
    max_hp: b.maxHp,
    coverage: buildingCoverage(world, b),
  }));

  const obs = {
    tick: world.tick,
    settlement_id: settlementId,
    core: core
      ? {
          id: core.id,
          tx: core.tx,
          ty: core.ty,
          level: core.level || 1,
          hp: core.hp,
          max_hp: core.maxHp,
        }
      : null,
    keep: keep
      ? {
          tx: keep.tx,
          ty: keep.ty,
          tx1: keep.tx1,
          ty1: keep.ty1,
          level: keep.level || 1,
        }
      : null,
    treasury: {
      wood: treasury.wood | 0,
      stone: treasury.stone | 0,
      gold: treasury.gold | 0,
    },
    threat,
    nearby_nodes: nearbyNodes(world, core),
    buildings,
    ring: packRing(world, f, core),
    enemies_nearby: enemiesNearby(world, settlementId, core),
    respawn_gold_cost: CORE.respawnGold,
  };

  if (opts.includeMeta && fac) {
    obs.meta = {
      npc: !!fac.npc,
      desire: fac.desire || "",
      job: fac.job || null,
      name: fac.name || "",
    };
  }

  return obs;
}

/** Map NpcBrain job to a planner action shape (weak expert label for SFT). */
export function jobToPlannerAction(job) {
  if (!job) {
    return {
      op: "wait",
      building_id: null,
      type: null,
      tx: null,
      ty: null,
      rot: null,
    };
  }
  if (job.kind === "place") {
    return {
      op: "place",
      building_id: null,
      type: job.type,
      tx: job.tx,
      ty: job.ty,
      rot: job.rot ?? 0,
    };
  }
  if (job.kind === "upgrade" || job.kind === "repair") {
    return {
      op: job.kind,
      building_id: job.id,
      type: null,
      tx: null,
      ty: null,
      rot: null,
    };
  }
  return {
    op: "wait",
    building_id: null,
    type: null,
    tx: null,
    ty: null,
    rot: null,
  };
}
