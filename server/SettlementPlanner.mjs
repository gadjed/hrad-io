import {
  BUILDINGS,
  CORE,
  MAX_LEVEL,
  TILE,
  addResource,
  canAfford,
  sellValue,
} from "../shared/defs.mjs";
import { settlementPlannerObservation } from "./SettlementSnapshot.mjs";
import {
  contourPlaceReason,
  enclosureLevel,
  isContourTile,
  layoutQuality,
} from "./LayoutQuality.mjs";

export const OBS_DIM = 29;
export const ACTION_COUNT = 20;
/** L1 keep is 18×18 (core 2×2 + pad 8). Grid is clipped to this. */
export const KEEP_N = 18;
export const GRID_CH = 6;
export const CELL_COUNT = KEEP_N * KEEP_N;

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

function canPay(world, f, cost) {
  if (world?._infiniteTreasury) return true;
  return canAfford(walletOf(f), cost || {});
}

function footprintOf(type, tx, ty) {
  const def = BUILDINGS[type];
  return { tx, ty, w: def?.w || 1, h: def?.h || 1 };
}

export function illegalPlaceReason(world, settlementId, type, tx, ty) {
  if (!type || tx == null || ty == null) return null;
  const f = factionOf(world, settlementId);
  const core = f ? world.factionCore(f) : world.factionCore(settlementId);
  const keep = core ? world.keepForCore(core) : null;
  return contourPlaceReason(keep, type, footprintOf(type, tx, ty), {
    contourWallsOnly: !!world?._designGym,
  });
}

function canPlace(world, f, type, tx, ty, rot = 0) {
  if (tx == null || ty == null || !BUILDINGS[type]) return false;
  if (!canPay(world, f, BUILDINGS[type].cost)) return false;
  if (illegalPlaceReason(world, f.id, type, tx, ty)) return false;
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
    if (BUILDINGS[b.type]?.harvest && !world._designGym && world.countHarvestNodes(b, BUILDINGS[b.type]) <= 0) continue;
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

function holeWallType(world, f, hole) {
  if (hole?.gate) return "gate";
  if (canPay(world, f, BUILDINGS.wall_stone.cost)) return "wall_stone";
  return "wall_wood";
}

function firstPlaceableHole(world, f, holes, typeOverride = null) {
  for (const hole of holes || []) {
    const type = typeOverride || holeWallType(world, f, hole);
    const rot = hole.rot || 0;
    if (canPlace(world, f, type, hole.tx, hole.ty, rot)) {
      return { type, tx: hole.tx, ty: hole.ty, rot };
    }
  }
  return null;
}

function findLayoutSite(world, f, core, type) {
  const keep = world.keepForCore(core);
  const def = BUILDINGS[type];
  if (!keep || !def) return null;
  const harvestR = def.harvest ? def.harvest.radius / TILE : 0;
  let best = null;
  let bestScore = Infinity;
  for (let ty = keep.ty; ty <= keep.ty1 - (def.h || 1) + 1; ty++) {
    for (let tx = keep.tx; tx <= keep.tx1 - (def.w || 1) + 1; tx++) {
      if (!canPlace(world, f, type, tx, ty, 0)) continue;
      let overlap = 0;
      if (harvestR) {
        const cx = tx + (def.w || 1) / 2;
        const cy = ty + (def.h || 1) / 2;
        for (const b of world.buildingsOf(f.id)) {
          if (b.type !== type) continue;
          const d = Math.hypot(cx - (b.tx + b.w / 2), cy - (b.ty + b.h / 2));
          overlap += Math.max(0, 2 * harvestR - d);
        }
      }
      const dist = Math.hypot(tx - core.tx, ty - core.ty);
      const score = overlap * 80 + dist;
      if (score < bestScore) {
        bestScore = score;
        best = { tx, ty, rot: 0 };
      }
    }
  }
  return best;
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
    let site = world._designGym ? null : world.findHarvestSite(f, core, type, stats.ring);
    if (!site) site = findLayoutSite(world, f, core, type);
    if (!site || !canPlace(world, f, type, site.tx, site.ty, 0)) return null;
    return placeDecision("economy", type, site.tx, site.ty, 0, `place ${type}`);
  }

  if (idx === 4) {
    if (world._designGym) {
      const site = findLayoutSite(world, f, core, "wall_stone") || findLayoutSite(world, f, core, "wall_wood");
      if (!site) return null;
      const type = canPlace(world, f, "wall_stone", site.tx, site.ty, 0) ? "wall_stone" : "wall_wood";
      return placeDecision("fortify", type, site.tx, site.ty, 0, "place wall");
    }
    const hole = firstPlaceableHole(world, f, stats.ring.holes);
    if (!hole) return null;
    return placeDecision("fortify", hole.type, hole.tx, hole.ty, hole.rot, "close ring hole");
  }

  if (idx === 5) {
    if (world._designGym) {
      const site = findLayoutSite(world, f, core, "gate");
      if (!site) return null;
      return placeDecision("fortify", "gate", site.tx, site.ty, 0, "place gate");
    }
    const gates = (stats.ring.holes || []).filter((h) => h.gate);
    const hole = firstPlaceableHole(world, f, gates.length ? gates : stats.ring.holes, "gate");
    if (!hole) return null;
    return placeDecision("fortify", "gate", hole.tx, hole.ty, hole.rot, "place gate");
  }

  if (idx === 6 || idx === 7) {
    const type = idx === 6 ? "tower_arrow" : "tower_cannon";
    if (world._designGym) {
      const site = findLayoutSite(world, f, core, type);
      if (!site) return null;
      return placeDecision("fortify", type, site.tx, site.ty, 0, `place ${type}`);
    }
    const corner = brain.weakestCorner(stats);
    if (!corner || !canPlace(world, f, type, corner.tx, corner.ty, 0)) return null;
    return placeDecision("fortify", type, corner.tx, corner.ty, 0, `place ${type}`);
  }

  if (idx === 8) {
    if (world._designGym) {
      const site = findLayoutSite(world, f, core, "spikes");
      if (!site) return null;
      return placeDecision("fortify", "spikes", site.tx, site.ty, 0, "place spikes");
    }
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
    if (world._designGym) return null;
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
    if (world._designGym) {
      const site = findLayoutSite(world, f, core, "wall_stone") || findLayoutSite(world, f, core, "wall_wood");
      if (!site) return null;
      const type = canPlace(world, f, "wall_stone", site.tx, site.ty, 0) ? "wall_stone" : "wall_wood";
      return placeDecision("expand", type, site.tx, site.ty, 0, "expand wall");
    }
    const next = stats.ring.next;
    if (!next) return null;
    const cell = next.holes[0] || next.cells[0];
    if (!cell) return null;
    const isGate = (next.gates || []).some((g) => g.tx === cell.tx && g.ty === cell.ty);
    const type = isGate ? "gate" : (canPay(world, f, BUILDINGS.wall_stone.cost) && (world._infiniteTreasury || (f.stock.stone || 0) >= 24)
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

export function cellToTile(keep, cellIndex) {
  const i = cellIndex | 0;
  if (!keep || i < 0 || i >= CELL_COUNT) return null;
  return {
    tx: keep.tx + (i % KEEP_N),
    ty: keep.ty + Math.floor(i / KEEP_N),
  };
}

function buildingAtOrigin(world, settlementId, tx, ty) {
  for (const b of world.buildingsOf(settlementId)) {
    if (b.tx === tx && b.ty === ty) return b;
  }
  return null;
}

const PLACE_AT = {
  1: "mill",
  2: "quarry",
  3: "goldmine",
  4: "wall_stone",
  5: "gate",
  6: "tower_arrow",
  7: "tower_cannon",
  8: "spikes",
  18: "wall_stone",
};

/**
 * Two-head gym: intent + keep cell. Does not search for a site.
 */
export function parameterizeActionAt(world, settlementId, actionIndex, cellIndex) {
  const f = factionOf(world, settlementId);
  if (!f) return null;
  const idx = actionIndex | 0;
  if (idx === 0) return waitDecision("policy wait");

  const core = world.factionCore(f);
  const keep = core ? world.keepForCore(core) : null;
  const tile = cellToTile(keep, cellIndex);

  if (idx === 17) {
    if (core || !tile) return null;
    if (!canPlace(world, f, "core", tile.tx, tile.ty, 0)) return null;
    return placeDecision("expand", "core", tile.tx, tile.ty, 0, "place core");
  }
  if (!core || !tile) return null;

  const { tx, ty } = tile;
  const placeType = PLACE_AT[idx];
  if (placeType) {
    let type = placeType;
    if ((idx === 4 || idx === 18) && !canPlace(world, f, "wall_stone", tx, ty, 0)) type = "wall_wood";
    const illegal = illegalPlaceReason(world, f.id, type, tx, ty);
    const mode = HARVEST_TYPES.includes(type) ? "economy" : idx === 18 ? "expand" : "fortify";
    const decision = placeDecision(mode, type, tx, ty, 0, illegal ? `${illegal} ${type} @${tx},${ty}` : `place ${type} @${tx},${ty}`);
    if (illegal) {
      decision.illegal = illegal;
      return decision;
    }
    if (!canPlace(world, f, type, tx, ty, 0)) return null;
    return decision;
  }

  if (idx === 19) {
    const wallType = canPlace(world, f, "wall_stone", tx, ty, 0)
      ? "wall_stone"
      : canPlace(world, f, "wall_wood", tx, ty, 0)
        ? "wall_wood"
        : null;
    if (wallType) return placeDecision("fortify", wallType, tx, ty, 0, `fortify wall @${tx},${ty}`);
    const towerIllegal = illegalPlaceReason(world, f.id, "tower_arrow", tx, ty);
    if (towerIllegal) {
      const decision = placeDecision("fortify", "tower_arrow", tx, ty, 0, `${towerIllegal} tower @${tx},${ty}`);
      decision.illegal = towerIllegal;
      return decision;
    }
    if (canPlace(world, f, "tower_arrow", tx, ty, 0)) {
      return placeDecision("fortify", "tower_arrow", tx, ty, 0, `fortify tower @${tx},${ty}`);
    }
  }

  const b = buildingAtOrigin(world, f.id, tx, ty);
  if (!b) return null;

  if (idx === 9) {
    if (world._designGym) return null;
    if (b.type !== "core") return null;
    const u = pickUpgrade(world, f, [b]);
    if (!u) return null;
    return targetDecision("upgrade", "upgrade", u.id, "upgrade core");
  }
  if (idx === 10) {
    if (!HARVEST_TYPES.includes(b.type)) return null;
    const u = pickUpgrade(world, f, [b]);
    if (!u) return null;
    return targetDecision("upgrade", "upgrade", u.id, "upgrade harvest");
  }
  if (idx === 11) {
    if (!BUILDINGS[b.type]?.turret) return null;
    const u = pickUpgrade(world, f, [b]);
    if (!u) return null;
    return targetDecision("upgrade", "upgrade", u.id, "upgrade tower");
  }
  if (idx === 12) {
    if (b.type !== "core") return null;
    if (!world.brain.canRepair(f, b)) return null;
    return targetDecision("survive", "repair", b.id, "repair core");
  }
  if (idx === 13) {
    if (b.type === "core") return null;
    if (!world.brain.canRepair(f, b)) return null;
    return targetDecision("survive", "repair", b.id, "repair damaged");
  }
  if (idx === 14) {
    if (!HARVEST_TYPES.includes(b.type)) return null;
    return targetDecision("economy", "sell", b.id, "sell harvest");
  }
  if (idx === 15) {
    if (b.type !== "wall_wood" && b.type !== "wall_stone" && b.type !== "gate") return null;
    return targetDecision("economy", "sell", b.id, "sell wall");
  }
  if (idx === 16) {
    if (b.type === "core") return null;
    return targetDecision("economy", "sell", b.id, "sell redundant");
  }
  if (idx === 19 && b.type === "wall_wood") {
    const u = pickUpgrade(world, f, [b]);
    if (!u) return null;
    return targetDecision("fortify", "upgrade", u.id, "upgrade wood wall");
  }
  return null;
}

export function cellMask(world, settlementId) {
  const mask = new Array(CELL_COUNT).fill(false);
  const f = factionOf(world, settlementId);
  const core = f ? world.factionCore(f) : null;
  const keep = core ? world.keepForCore(core) : null;
  if (!f || !keep) {
    mask[0] = true;
    return mask;
  }
  for (let i = 0; i < CELL_COUNT; i++) {
    const tx = keep.tx + (i % KEEP_N);
    const ty = keep.ty + Math.floor(i / KEEP_N);
    if (tx > keep.tx1 || ty > keep.ty1) continue;
    if (world.canPlaceTile("wall_wood", tx, ty, 0, f.id)) {
      mask[i] = true;
      continue;
    }
    if (buildingAtOrigin(world, f.id, tx, ty)) mask[i] = true;
  }
  if (!mask.some(Boolean)) mask[0] = true;
  return mask;
}

const GRID_TYPE = {
  core: 0.14,
  mill: 0.28,
  quarry: 0.42,
  goldmine: 0.56,
  wall_wood: 0.7,
  wall_stone: 0.7,
  gate: 0.72,
  spikes: 0.78,
  tower_arrow: 0.86,
  tower_cannon: 0.86,
};

export function encodeKeepGrid(obs) {
  const grid = new Float32Array(GRID_CH * KEEP_N * KEEP_N);
  const keep = obs.keep;
  if (!keep) return Array.from(grid);
  const at = (c, x, y) => c * KEEP_N * KEEP_N + y * KEEP_N + x;
  const inside = (x, y) => x >= 0 && y >= 0 && x < KEEP_N && y < KEEP_N;

  for (const b of obs.buildings || []) {
    const enc = enclosureLevel(obs, b) / 2;
    const w = b.w || 1;
    const h = b.h || 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = b.tx + dx - keep.tx;
        const y = b.ty + dy - keep.ty;
        if (!inside(x, y)) continue;
        grid[at(0, x, y)] = GRID_TYPE[b.type] || 1;
        grid[at(1, x, y)] = clip01((b.level || 1) / MAX_LEVEL);
        grid[at(2, x, y)] = enc;
        if (dx === 0 && dy === 0) grid[at(5, x, y)] = 1;
      }
    }
  }

  for (let y = 0; y < KEEP_N; y++) {
    for (let x = 0; x < KEEP_N; x++) {
      if (grid[at(0, x, y)] !== 0) continue;
      const tx = keep.tx + x;
      const ty = keep.ty + y;
      grid[at(4, x, y)] = isContourTile(keep, tx, ty) ? 0.4 : 1;
    }
  }

  const cover = new Map();
  for (const b of obs.buildings || []) {
    const def = BUILDINGS[b.type];
    if (!def?.harvest) continue;
    const rad = (def.harvest.radius || 0) / TILE;
    const cx = b.tx - keep.tx + (b.w || 1) / 2;
    const cy = b.ty - keep.ty + (b.h || 1) / 2;
    const r2 = rad * rad;
    for (let y = 0; y < KEEP_N; y++) {
      for (let x = 0; x < KEEP_N; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r2) continue;
        const k = `${b.type}:${x},${y}`;
        cover.set(k, (cover.get(k) || 0) + 1);
      }
    }
  }
  for (const [k, n] of cover) {
    if (n < 2) continue;
    const comma = k.indexOf(":");
    const xy = k.slice(comma + 1).split(",");
    const x = Number(xy[0]);
    const y = Number(xy[1]);
    grid[at(3, x, y)] = Math.max(grid[at(3, x, y)], clip01((n - 1) / 3));
  }
  return Array.from(grid);
}

export function actionMask(world, settlementId) {
  const mask = new Array(ACTION_COUNT).fill(false);
  for (let i = 1; i < ACTION_COUNT; i++) {
    mask[i] = !!parameterizeAction(world, settlementId, i);
  }
  if (!world._designGym) mask[0] = true;
  if (!mask.some(Boolean)) mask[0] = true;
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

  const lqFeat = layoutQuality(obs);
  const buildings = obs.buildings || [];
  features.push(clip01(obs.threat || 0), clip01((lqFeat.P || 0) / 10));

  const n = obs.nearby_nodes || {};
  const nodeCount = (n.wood || 0) + (n.stone || 0) + (n.gold || 0);
  if (nodeCount > 0) {
    features.push(clip01((n.wood || 0) / 20), clip01((n.stone || 0) / 20), clip01((n.gold || 0) / 10));
  } else {
    const has = (type) => buildings.some((b) => b.type === type);
    features.push(has("mill") ? 1 : 0, has("quarry") ? 1 : 0, has("goldmine") ? 1 : 0);
  }

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
  features.push(nodeCount > 0 ? clip01(waste / 4) : clip01((lqFeat.overlap || 0) / 4));

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

  const nodes = obs.nearby_nodes || {};
  const designLike = ((nodes.wood || 0) + (nodes.stone || 0) + (nodes.gold || 0)) === 0;
  const hasType = (type) => buildings.some((b) => b.type === type);
  const diversity = (hasType("mill") ? 1 : 0) + (hasType("quarry") ? 1 : 0) + (hasType("goldmine") ? 1 : 0);
  const harvestCount = buildings.filter((b) => BUILDINGS[b.type]?.harvest).length;
  const lq = layoutQuality(obs);

  const E = designLike
    ? 28 * diversity + 3 * Math.min(harvestCount, 6)
    : (t.gold || 0) * 3 + (t.stone || 0) * 1.5 + (t.wood || 0) + 8 * (cov.wood + cov.stone + 1.4 * cov.gold);
  const enclosed = core && enclosureLevel(obs, core) >= 1 ? 1 : 0;
  const D = designLike
    ? 48 * enclosed +
      (enclosed ? 24 * (ring.integrity || 0) : 0) +
      36 * Math.min(towers, 1) +
      8 * Math.max(0, Math.min(towers, 2) - 1) +
      5 * Math.min(gates, 1) -
      14 * Math.max(0, gates - 1) -
      10 * (enclosed ? Math.max(0, spikes - 6) : spikes)
    : 40 * (ring.integrity || 0) + 8 * towers + 4 * spikes + 6 * gates;
  const coreRatio = core?.max_hp ? core.hp / core.max_hp : 0;
  const wallHp = meanHp(walls.map((b) => ({ hp: b.hp, maxHp: b.max_hp })));
  const S = 50 * coreRatio + (designLike ? 0 : 12 * Math.min((t.gold || 0) / CORE.respawnGold, 1)) + 20 * wallHp;
  const keep = obs.keep;
  const keepTiles = keep ? Math.max(1, (keep.tx1 - keep.tx + 1) * (keep.ty1 - keep.ty + 1)) : 1;
  const valuable = buildings.filter((b) => {
    const tpe = b.type;
    return tpe === "core" || BUILDINGS[tpe]?.harvest || BUILDINGS[tpe]?.turret;
  }).length;
  const F = designLike
    ? 8 * Math.min(valuable / 6, 1)
    : 30 * Math.min(used / keepTiles, 1);
  const W =
    (designLike ? 0 : 15 * harvestZero) +
    (designLike ? 0 : 8 * ((ring.integrity || 0) < 0.5 ? 1 : 0)) +
    12 * (lq.overlap || 0) +
    10 * (lq.clog || 0);
  const P = 22 * (lq.P || 0);
  const U = 1.0 * E + 0.85 * D + 1.2 * S + 0.4 * F + P - 0.9 * W;
  return { E, D, S, F, W, P, overlap: lq.overlap, clog: lq.clog, U, towers, spikes, gates, harvestZero, used, keepTiles, coreRatio, wallHp, cov };
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
    grid: encodeKeepGrid(observation),
    mask: actionMask(world, settlementId),
    cellMask: cellMask(world, settlementId),
    utility: calculateUtility(observation),
  };
}

export function clipReward(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-1, Math.min(1, x));
}
