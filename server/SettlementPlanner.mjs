import {
  BUILDINGS,
  CORE,
  MAX_LEVEL,
  addResource,
  canAfford,
  sellValue,
} from "../shared/defs.mjs";
import { settlementPlannerObservation } from "./SettlementSnapshot.mjs";

export const OBS_DIM = 29;
export const ACTION_COUNT = 20;

export const ACTION_NAMES = [
  "wait",
  "place_mill",
  "place_quarry",
  "place_goldmine",
  "place_wall_stone",
  "place_gate",
  "place_tower_arrow",
  "place_tower_cannon",
  "place_spikes",
  "upgrade_core",
  "upgrade_harvest",
  "upgrade_tower",
  "repair_core",
  "repair_damaged",
  "sell_worst_harvest",
  "sell_worst_wall",
  "sell_redundant",
  "place_core",
  "expand_ring",
  "fortify_ring",
];

const HARVEST_TYPES = ["mill", "quarry", "goldmine"];

const WAIT_ACTION = {
  op: "wait",
  building_id: null,
  type: null,
  tx: null,
  ty: null,
  rot: null,
};

function clip01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function waitDecision(rationale = "wait") {
  return {
    mode: "wait",
    action: { ...WAIT_ACTION },
    queue: [],
    utility_estimate: 0,
    rationale,
  };
}

function placeDecision(mode, type, tx, ty, rot, rationale) {
  return {
    mode,
    action: {
      op: "place",
      building_id: null,
      type,
      tx,
      ty,
      rot: rot ?? 0,
    },
    queue: [],
    utility_estimate: 0,
    rationale,
  };
}

function targetDecision(mode, op, buildingId, rationale) {
  return {
    mode,
    action: {
      op,
      building_id: buildingId,
      type: null,
      tx: null,
      ty: null,
      rot: null,
    },
    queue: [],
    utility_estimate: 0,
    rationale,
  };
}

const surveyCache = { key: "", stats: null };

function surveyFor(world, f, core) {
  if (!core) return null;
  const key = `${world.tick}|${f.id}|${world.buildings.size}|${f.stock?.wood || 0}|${f.stock?.stone || 0}|${f.stock?.gold || 0}`;
  if (surveyCache.key === key) return surveyCache.stats;
  const stats = world.brain.survey(f, core);
  surveyCache.key = key;
  surveyCache.stats = stats;
  return stats;
}

function factionOf(world, settlementId) {
  const f = world.factions.get(settlementId);
  if (!f) return null;
  return world.ensureFaction(f);
}

function walletOf(f) {
  return f.stock || {};
}

function canPay(f, cost) {
  return canAfford(walletOf(f), cost || {});
}

function canPlace(world, f, type, tx, ty, rot = 0) {
  if (tx == null || ty == null || !BUILDINGS[type]) return false;
  if (!canPay(f, BUILDINGS[type].cost)) return false;
  return world.canPlaceTile(type, tx, ty, rot, f.id);
}

function meanHp(list) {
  if (!list.length) return 1;
  return list.reduce((s, b) => s + (b.maxHp ? b.hp / b.maxHp : 1), 0) / list.length;
}

function harvestBuildings(stats) {
  return HARVEST_TYPES.flatMap((t) => stats.harvest[BUILDINGS[t].harvest.resource] || []);
}

function adjacentToGate(b, gates) {
  return gates.some((g) => Math.abs(b.tx - g.tx) + Math.abs(b.ty - g.ty) <= 1);
}

function pickUpgrade(world, f, list) {
  const brain = world.brain;
  let best = null;
  for (const b of list) {
    if (!b || b.level >= MAX_LEVEL) continue;
    if (BUILDINGS[b.type]?.harvest && world.countHarvestNodes(b, BUILDINGS[b.type]) <= 0) continue;
    if (!brain.canUpgrade(f, b)) continue;
    if (!best || b.level < best.level) best = b;
  }
  return best;
}

function pickDamaged(world, f, stats, coreOnly) {
  const brain = world.brain;
  const list = coreOnly
    ? stats.damaged.filter((b) => b.type === "core")
    : [...stats.damaged].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
  for (const b of list) {
    if (brain.canRepair(f, b)) return b;
  }
  return null;
}

function pickWorstHarvest(world, stats) {
  const all = harvestBuildings(stats).filter((b) => b.type !== "core");
  if (!all.length) return null;
  const scored = all.map((b) => ({
    b,
    cov: world.countHarvestNodes(b, BUILDINGS[b.type]) || 0,
  }));
  scored.sort((a, b) => a.cov - b.cov || a.b.hp / a.b.maxHp - b.b.hp / b.b.maxHp);
  return scored[0].b;
}

function pickWorstWall(stats) {
  const woods = stats.walls.filter((w) => w.type === "wall_wood");
  if (woods.length) return woods[0];
  if (stats.walls.length > 4) return stats.walls[0];
  return null;
}

function pickRedundant(stats) {
  const extraSpikes = stats.buildings.filter(
    (b) => b.type === "spikes" && !adjacentToGate(b, stats.gates)
  );
  if (extraSpikes.length) return extraSpikes[0];
  if (stats.towers.length > 1) {
    const arrows = stats.towers.filter((t) => t.type === "tower_arrow");
    if (arrows.length > 1) return arrows[arrows.length - 1];
  }
  return null;
}

function holeWallType(f, hole) {
  if (hole?.gate) return "gate";
  if (canPay(f, BUILDINGS.wall_stone.cost)) return "wall_stone";
  return "wall_wood";
}

function firstPlaceableHole(world, f, holes, typeOverride = null) {
  for (const hole of holes || []) {
    const type = typeOverride || holeWallType(f, hole);
    const rot = hole.rot || 0;
    if (canPlace(world, f, type, hole.tx, hole.ty, rot)) {
      return { type, tx: hole.tx, ty: hole.ty, rot };
    }
  }
  return null;
}

function findCoreSite(world, f) {
  const cx = 80 + ((Math.random() * 40) | 0) - 20;
  const cy = 80 + ((Math.random() * 40) | 0) - 20;
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (canPlace(world, f, "core", tx, ty, 0)) return { tx, ty, rot: 0 };
    }
  }
  return null;
}

/**
 * Map a discrete intent to a planner decision (schema-shaped).
 * @returns {object|null}
 */
export function parameterizeAction(world, settlementId, actionIndex) {
  const f = factionOf(world, settlementId);
  if (!f) return null;
  const idx = actionIndex | 0;
  if (idx === 0) return waitDecision("policy wait");

  const core = world.factionCore(f);
  const brain = world.brain;

  if (idx === 17) {
    if (core) return null;
    const site = findCoreSite(world, f);
    if (!site) return null;
    return placeDecision("expand", "core", site.tx, site.ty, 0, "place core");
  }

  if (!core) return null;
  const stats = surveyFor(world, f, core);

  if (idx === 1 || idx === 2 || idx === 3) {
    const type = HARVEST_TYPES[idx - 1];
    const site = world.findHarvestSite(f, core, type, stats.ring);
    if (!site || !canPlace(world, f, type, site.tx, site.ty, 0)) return null;
    return placeDecision("economy", type, site.tx, site.ty, 0, `place ${type}`);
  }

  if (idx === 4) {
    const hole = firstPlaceableHole(world, f, stats.ring.holes);
    if (!hole) return null;
    return placeDecision("fortify", hole.type, hole.tx, hole.ty, hole.rot, "close ring hole");
  }

  if (idx === 5) {
    const gates = (stats.ring.holes || []).filter((h) => h.gate);
    const hole = firstPlaceableHole(world, f, gates.length ? gates : stats.ring.holes, "gate");
    if (!hole) return null;
    return placeDecision("fortify", "gate", hole.tx, hole.ty, hole.rot, "place gate");
  }

  if (idx === 6 || idx === 7) {
    const type = idx === 6 ? "tower_arrow" : "tower_cannon";
    const corner = brain.weakestCorner(stats);
    if (!corner || !canPlace(world, f, type, corner.tx, corner.ty, 0)) return null;
    return placeDecision("fortify", type, corner.tx, corner.ty, 0, `place ${type}`);
  }

  if (idx === 8) {
    for (const g of stats.gates) {
      if (brain.gateHasSpikes(g, stats.buildings)) continue;
      const spot = brain.spikeSpot(g, core);
      if (spot && canPlace(world, f, "spikes", spot.tx, spot.ty, 0)) {
        return placeDecision("fortify", "spikes", spot.tx, spot.ty, 0, "spikes at gate");
      }
    }
    return null;
  }

  if (idx === 9) {
    const b = pickUpgrade(world, f, [core]);
    if (!b) return null;
    return targetDecision("upgrade", "upgrade", b.id, "upgrade core");
  }

  if (idx === 10) {
    const b = pickUpgrade(world, f, harvestBuildings(stats));
    if (!b) return null;
    return targetDecision("upgrade", "upgrade", b.id, "upgrade harvest");
  }

  if (idx === 11) {
    const b = pickUpgrade(world, f, stats.towers);
    if (!b) return null;
    return targetDecision("upgrade", "upgrade", b.id, "upgrade tower");
  }

  if (idx === 12) {
    const b = pickDamaged(world, f, stats, true) || (brain.canRepair(f, core) ? core : null);
    if (!b) return null;
    return targetDecision("survive", "repair", b.id, "repair core");
  }

  if (idx === 13) {
    const b = pickDamaged(world, f, stats, false);
    if (!b) return null;
    return targetDecision("survive", "repair", b.id, "repair damaged");
  }

  if (idx === 14) {
    const b = pickWorstHarvest(world, stats);
    if (!b || b.type === "core") return null;
    return targetDecision("economy", "sell", b.id, "sell harvest");
  }

  if (idx === 15) {
    const b = pickWorstWall(stats);
    if (!b) return null;
    return targetDecision("economy", "sell", b.id, "sell wall");
  }

  if (idx === 16) {
    const b = pickRedundant(stats);
    if (!b) return null;
    return targetDecision("economy", "sell", b.id, "sell redundant");
  }

  if (idx === 18) {
    const next = stats.ring.next;
    if (!next) return null;
    const cell = next.holes[0] || next.cells[0];
    if (!cell) return null;
    const isGate = (next.gates || []).some((g) => g.tx === cell.tx && g.ty === cell.ty);
    const type = isGate ? "gate" : (canPay(f, BUILDINGS.wall_stone.cost) && (f.stock.stone || 0) >= 24
      ? "wall_stone"
      : "wall_wood");
    if (!canPlace(world, f, type, cell.tx, cell.ty, cell.rot || 0)) return null;
    return placeDecision("expand", type, cell.tx, cell.ty, cell.rot || 0, "expand ring");
  }

  if (idx === 19) {
    const hole = firstPlaceableHole(world, f, stats.ring.holes);
    if (hole) return placeDecision("fortify", hole.type, hole.tx, hole.ty, hole.rot, "fortify hole");
    for (const g of stats.gates) {
      if (brain.gateHasSpikes(g, stats.buildings)) continue;
      const spot = brain.spikeSpot(g, core);
      if (spot && canPlace(world, f, "spikes", spot.tx, spot.ty, 0)) {
        return placeDecision("fortify", "spikes", spot.tx, spot.ty, 0, "fortify spikes");
      }
    }
    const wood = stats.walls.find((w) => w.type === "wall_wood" && brain.canUpgrade(f, w));
    if (wood) return targetDecision("fortify", "upgrade", wood.id, "upgrade wood wall");
    const corner = brain.weakestCorner(stats);
    if (corner && canPlace(world, f, "tower_arrow", corner.tx, corner.ty, 0)) {
      return placeDecision("fortify", "tower_arrow", corner.tx, corner.ty, 0, "fortify tower");
    }
    return null;
  }

  return null;
}

export function actionMask(world, settlementId) {
  const mask = new Array(ACTION_COUNT).fill(false);
  mask[0] = true;
  for (let i = 1; i < ACTION_COUNT; i++) {
    mask[i] = !!parameterizeAction(world, settlementId, i);
  }
  return mask;
}

export function sellFactionBuilding(world, settlementId, buildingId) {
  const f = factionOf(world, settlementId);
  const b = world.buildings.get(buildingId);
  if (!f || !b || b.type === "core") return false;
  if (b.ownerId !== f.id && b.team !== f.id) return false;
  const def = BUILDINGS[b.type];
  if (!def) return false;
  const value = sellValue(def, b.level || 1);
  const wallet = world.fortWallet(f.id);
  if (wallet) {
    for (const [k, v] of Object.entries(value)) addResource(wallet, k, v);
    world.persistFortWallet(f.id, wallet);
  }
  world.destroyBuilding(b, false);
  return true;
}

/**
 * @returns {boolean} whether the world mutated
 */
export function executeDecision(world, settlementId, decision) {
  const f = factionOf(world, settlementId);
  if (!f || !decision?.action) return false;
  const a = decision.action;
  if (a.op === "wait") return false;

  if (a.op === "place") {
    const placed = world.placeBuilding(f, {
      type: a.type,
      tx: a.tx,
      ty: a.ty,
      rot: a.rot || 0,
      quiet: true,
      skipRange: true,
    });
    return !!placed;
  }

  if (a.op === "upgrade") {
    return !!world.upgradeBuilding(f.id, a.building_id, { quiet: true });
  }

  if (a.op === "repair") {
    return !!world.repairBuilding(f.id, a.building_id, { quiet: true });
  }

  if (a.op === "sell") {
    return sellFactionBuilding(world, settlementId, a.building_id);
  }

  return false;
}

export function encodeObservation(obs) {
  const features = [];
  const t = obs.treasury || {};
  features.push(clip01((t.wood || 0) / 100), clip01((t.stone || 0) / 100), clip01((t.gold || 0) / 50));

  const c = obs.core;
  if (c && c.max_hp) features.push(clip01(c.hp / c.max_hp), clip01((c.level || 1) / MAX_LEVEL));
  else features.push(0, 0);

  features.push(clip01(obs.threat || 0), obs.enemies_nearby ? 1 : 0);

  const n = obs.nearby_nodes || {};
  features.push(clip01((n.wood || 0) / 20), clip01((n.stone || 0) / 20), clip01((n.gold || 0) / 10));

  const buildings = obs.buildings || [];
  const count = (type) => buildings.filter((b) => b.type === type).length;
  features.push(
    clip01(count("mill") / 3),
    clip01(count("quarry") / 3),
    clip01(count("goldmine") / 3),
    clip01(count("tower_arrow") / 4),
    clip01(count("tower_cannon") / 4),
    clip01(count("wall_wood") / 40),
    clip01(count("wall_stone") / 40),
    clip01(count("gate") / 4),
    clip01(count("spikes") / 8)
  );

  for (const type of HARVEST_TYPES) {
    const hs = buildings.filter((b) => b.type === type);
    if (!hs.length) {
      features.push(0);
      continue;
    }
    const avg = hs.reduce((s, b) => s + (b.coverage || 0), 0) / hs.length;
    features.push(clip01(avg / 8));
  }

  const ring = obs.ring;
  if (ring) {
    features.push(
      clip01(ring.integrity || 0),
      clip01((ring.holes?.length || 0) / 10),
      ring.can_expand ? 1 : 0
    );
  } else {
    features.push(0, 0, 0);
  }

  const respawn = obs.respawn_gold_cost || CORE.respawnGold;
  features.push(clip01((t.gold || 0) / Math.max(1, respawn)));

  const keep = obs.keep;
  const keepTiles = keep ? Math.max(1, (keep.tx1 - keep.tx + 1) * (keep.ty1 - keep.ty + 1)) : 1;
  const used = buildings.reduce((s, b) => s + (b.w || 1) * (b.h || 1), 0);
  features.push(clip01(used / keepTiles));

  const hpAvg = buildings.length
    ? buildings.reduce((s, b) => s + (b.max_hp ? b.hp / b.max_hp : 1), 0) / buildings.length
    : 1;
  features.push(clip01(hpAvg));

  const waste = buildings.filter((b) => BUILDINGS[b.type]?.harvest && (b.coverage || 0) === 0).length;
  features.push(clip01(waste / 4));

  while (features.length < OBS_DIM) features.push(0);
  return features.slice(0, OBS_DIM);
}

export function utilityBreakdown(obs) {
  const t = obs.treasury || {};
  const buildings = obs.buildings || [];
  const ring = obs.ring || {};
  const core = obs.core;

  let cov = { wood: 0, stone: 0, gold: 0 };
  let towers = 0;
  let spikes = 0;
  let gates = 0;
  let walls = [];
  let harvestZero = 0;
  let used = 0;
  for (const b of buildings) {
    used += (b.w || 1) * (b.h || 1);
    const def = BUILDINGS[b.type];
    if (def?.harvest) {
      const res = def.harvest.resource;
      cov[res] += b.coverage || 0;
      if ((b.coverage || 0) === 0) harvestZero++;
    }
    if (def?.turret) towers++;
    if (b.type === "spikes") spikes++;
    if (b.type === "gate") gates++;
    if (b.type === "wall_wood" || b.type === "wall_stone") walls.push(b);
  }

  const E = (t.gold || 0) * 3 + (t.stone || 0) * 1.5 + (t.wood || 0) + 8 * (cov.wood + cov.stone + 1.4 * cov.gold);
  const D = 40 * (ring.integrity || 0) + 8 * towers + 4 * spikes + 6 * gates;
  const coreRatio = core?.max_hp ? core.hp / core.max_hp : 0;
  const wallHp = meanHp(walls.map((b) => ({ hp: b.hp, maxHp: b.max_hp })));
  const S = 50 * coreRatio + 12 * Math.min((t.gold || 0) / CORE.respawnGold, 1) + 20 * wallHp;
  const keep = obs.keep;
  const keepTiles = keep ? Math.max(1, (keep.tx1 - keep.tx + 1) * (keep.ty1 - keep.ty + 1)) : 1;
  const F = 30 * Math.min(used / keepTiles, 1);
  const W = 15 * harvestZero + 8 * ((ring.integrity || 0) < 0.5 ? 1 : 0);
  const U = 1.0 * E + 0.85 * D + 1.2 * S + 0.4 * F - 0.9 * W;
  return { E, D, S, F, W, U, towers, spikes, gates, harvestZero, used, keepTiles, coreRatio, wallHp, cov };
}

export function calculateUtility(obs) {
  return utilityBreakdown(obs).U;
}

export function lockNpcBrains(world) {
  for (const f of world.factions.values()) {
    if (f.npc) f.plannerLocked = true;
  }
}

export function pickNpcSettlement(world) {
  const ids = [];
  for (const f of world.factions.values()) {
    if (!f.npc) continue;
    if (!world.factionCore(f)) continue;
    ids.push(f.id);
  }
  ids.sort();
  return ids[0] || null;
}

export function observe(world, settlementId) {
  const observation = settlementPlannerObservation(world, settlementId, { includeMeta: true });
  return {
    observation,
    obs: encodeObservation(observation),
    mask: actionMask(world, settlementId),
    utility: calculateUtility(observation),
  };
}

export function clipReward(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-1, Math.min(1, x));
}
