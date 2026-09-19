import { BUILDINGS, TILE } from "../shared/defs.mjs";

const WALL = new Set(["wall_wood", "wall_stone", "gate"]);
const NEED_PROTECT = new Set([
  "core",
  "mill",
  "quarry",
  "goldmine",
  "tower_arrow",
  "tower_cannon",
]);

function key(tx, ty) {
  return `${tx},${ty}`;
}

function occMap(obs) {
  const occ = new Map();
  for (const b of obs.buildings || []) {
    const w = b.w || 1;
    const h = b.h || 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        occ.set(key(b.tx + dx, b.ty + dy), b);
      }
    }
  }
  return occ;
}

function isWallTile(occ, tx, ty) {
  const b = occ.get(key(tx, ty));
  return !!(b && WALL.has(b.type));
}

function isBlocked(occ, tx, ty) {
  return occ.has(key(tx, ty));
}

function floodFromOutside(occ, keep, ignoreWalls) {
  const x0 = keep.tx - 1;
  const y0 = keep.ty - 1;
  const x1 = keep.tx1 + 1;
  const y1 = keep.ty1 + 1;
  const seen = new Set();
  const q = [];
  const walkable = (tx, ty) => {
    if (tx < x0 || ty < y0 || tx > x1 || ty > y1) return false;
    if (isWallTile(occ, tx, ty) && !ignoreWalls.has(key(tx, ty))) return false;
    if (isBlocked(occ, tx, ty) && !isWallTile(occ, tx, ty)) return false;
    return true;
  };
  for (let tx = x0; tx <= x1; tx++) {
    q.push([tx, y0], [tx, y1]);
  }
  for (let ty = y0 + 1; ty <= y1 - 1; ty++) {
    q.push([x0, ty], [x1, ty]);
  }
  for (const [tx, ty] of q) {
    const k = key(tx, ty);
    if (seen.has(k) || !walkable(tx, ty)) continue;
    seen.add(k);
  }
  const queue = [...seen].map((s) => s.split(",").map(Number));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const [tx, ty] = queue.pop();
    for (const [dx, dy] of dirs) {
      const nx = tx + dx;
      const ny = ty + dy;
      const k = key(nx, ny);
      if (seen.has(k) || !walkable(nx, ny)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

function buildingTouches(seen, b) {
  const w = b.w || 1;
  const h = b.h || 1;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = b.tx + dx;
      const ty = b.ty + dy;
      for (const [ox, oy] of dirs) {
        if (seen.has(key(tx + ox, ty + oy))) return true;
      }
    }
  }
  return false;
}

function outerWallsTouching(occ, keep, flooded) {
  const ignore = new Set();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let ty = keep.ty; ty <= keep.ty1; ty++) {
    for (let tx = keep.tx; tx <= keep.tx1; tx++) {
      if (!isWallTile(occ, tx, ty)) continue;
      for (const [dx, dy] of dirs) {
        if (flooded.has(key(tx + dx, ty + dy))) {
          ignore.add(key(tx, ty));
          break;
        }
      }
    }
  }
  return ignore;
}

/**
 * 0 = open to the outside, 1 = one closed contour, 2 = nested contours.
 */
export function enclosureLevel(obs, building) {
  const keep = obs.keep;
  if (!keep || !building) return 0;
  const occ = occMap(obs);
  const outer = floodFromOutside(occ, keep, new Set());
  if (buildingTouches(outer, building)) return 0;
  const peeled = outerWallsTouching(occ, keep, outer);
  if (!peeled.size) return 1;
  const inner = floodFromOutside(occ, keep, peeled);
  if (buildingTouches(inner, building)) return 1;
  return 2;
}

export function towerCount(obs) {
  return (obs.buildings || []).filter((b) => BUILDINGS[b.type]?.turret).length;
}

/** Protection 0/1/2 after the tower rule; 0 if no towers. */
export function protectionLevel(obs, building) {
  if (!NEED_PROTECT.has(building?.type)) return 0;
  if (towerCount(obs) < 1) return 0;
  return enclosureLevel(obs, building);
}

export function protectionScore(obs) {
  let score = 0;
  for (const b of obs.buildings || []) {
    if (!NEED_PROTECT.has(b.type)) continue;
    score += protectionLevel(obs, b) * (b.level || 1);
  }
  return score;
}

function circleOverlapArea(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) {
    const r = Math.min(r1, r2);
    return Math.PI * r * r;
  }
  const r1sq = r1 * r1;
  const r2sq = r2 * r2;
  const a = Math.acos(clamp((d * d + r1sq - r2sq) / (2 * d * r1), -1, 1));
  const b = Math.acos(clamp((d * d + r2sq - r1sq) / (2 * d * r2), -1, 1));
  return r1sq * a + r2sq * b - 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/** Sum of pairwise same-type harvest-radius overlap, normalized by one circle area. */
export function harvestOverlapPenalty(obs) {
  const groups = new Map();
  for (const b of obs.buildings || []) {
    const def = BUILDINGS[b.type];
    if (!def?.harvest) continue;
    const list = groups.get(b.type) || [];
    list.push({
      x: (b.tx || 0) + (b.w || 1) / 2,
      y: (b.ty || 0) + (b.h || 1) / 2,
      r: (def.harvest.radius || 0) / TILE,
    });
    groups.set(b.type, list);
  }
  let penalty = 0;
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const area = circleOverlapArea(a.r, b.r, d);
        const norm = Math.PI * Math.min(a.r, b.r) ** 2;
        if (norm > 0) penalty += area / norm;
      }
    }
  }
  return penalty;
}

export function isContourTile(keep, tx, ty) {
  if (!keep) return false;
  if (tx < keep.tx || ty < keep.ty || tx > keep.tx1 || ty > keep.ty1) return false;
  return tx === keep.tx || tx === keep.tx1 || ty === keep.ty || ty === keep.ty1;
}

export function footprintOnContour(keep, fp) {
  if (!keep || !fp) return false;
  const w = fp.w || 1;
  const h = fp.h || 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (isContourTile(keep, fp.tx + dx, fp.ty + dy)) return true;
    }
  }
  return false;
}

export function footprintOutOfKeep(keep, fp) {
  if (!keep || !fp) return true;
  const w = fp.w || 1;
  const h = fp.h || 1;
  return fp.tx < keep.tx || fp.ty < keep.ty || fp.tx + w - 1 > keep.tx1 || fp.ty + h - 1 > keep.ty1;
}

/** Hard layout rules: keep bounds + design-env contour is walls/gates only. */
export function contourPlaceReason(keep, type, fp, { contourWallsOnly = false } = {}) {
  if (!keep || !fp) return "outside_keep";
  if (footprintOutOfKeep(keep, fp)) return "outside_keep";
  if (contourWallsOnly && type !== "core" && !WALL.has(type) && footprintOnContour(keep, fp)) return "contour";
  return null;
}

/** Penalty for packing the keep with walls and leaving no courtyard. */
export function clogPenalty(obs) {
  const keep = obs.keep;
  if (!keep) return 0;
  const keepTiles = Math.max(1, (keep.tx1 - keep.tx + 1) * (keep.ty1 - keep.ty + 1));
  const occ = occMap(obs);
  let wallTiles = 0;
  let blocked = 0;
  for (let ty = keep.ty; ty <= keep.ty1; ty++) {
    for (let tx = keep.tx; tx <= keep.tx1; tx++) {
      if (isWallTile(occ, tx, ty)) wallTiles += 1;
      if (isBlocked(occ, tx, ty)) blocked += 1;
    }
  }
  const wallFrac = wallTiles / keepTiles;
  const emptyFrac = 1 - blocked / keepTiles;
  let penalty = 0;
  if (wallFrac > 0.28) penalty += (wallFrac - 0.28) * 8;
  if (emptyFrac < 0.35) penalty += (0.35 - emptyFrac) * 10;
  return penalty;
}

export function layoutQuality(obs) {
  const P = protectionScore(obs);
  const overlap = harvestOverlapPenalty(obs);
  const clog = clogPenalty(obs);
  return { P, overlap, clog, towers: towerCount(obs) };
}

/** 0 = flush only. A 1-tile gap next to the citadel is space for illegal walls. */
const MAX_COMPACT_GAP = 0;

export function layoutCensus(obs) {
  const counts = {
    mill: 0,
    quarry: 0,
    goldmine: 0,
    tower: 0,
    tower_arrow: 0,
    wall: 0,
    spikes: 0,
    core: 0,
    gates: 0,
  };
  for (const b of obs.buildings || []) {
    if (b.type === "mill") counts.mill += 1;
    else if (b.type === "quarry") counts.quarry += 1;
    else if (b.type === "goldmine") counts.goldmine += 1;
    else if (b.type === "tower_arrow") {
      counts.tower_arrow += 1;
      counts.tower += 1;
    } else if (b.type === "tower_cannon") counts.tower += 1;
    else if (b.type === "gate") {
      counts.gates += 1;
      counts.wall += 1;
    } else if (WALL.has(b.type)) counts.wall += 1;
    else if (b.type === "spikes") counts.spikes += 1;
    else if (b.type === "core") counts.core += 1;
  }
  return counts;
}

function footprintOf(b) {
  if (!b) return null;
  const def = BUILDINGS[b.type];
  return {
    tx: b.tx,
    ty: b.ty,
    w: b.w || def?.w || 1,
    h: b.h || def?.h || 1,
  };
}

/** Empty cells between two footprints (0 = flush, 1 = one-tile gap). */
export function cellGap(a, b) {
  if (!a || !b || a.tx == null || b.tx == null) return 99;
  const a1x = a.tx + (a.w || 1) - 1;
  const a1y = a.ty + (a.h || 1) - 1;
  const b1x = b.tx + (b.w || 1) - 1;
  const b1y = b.ty + (b.h || 1) - 1;
  const dx = Math.max(0, b.tx - a1x - 1, a.tx - b1x - 1);
  const dy = Math.max(0, b.ty - a1y - 1, a.ty - b1y - 1);
  return Math.max(dx, dy);
}

function actionFootprint(action, type) {
  const def = BUILDINGS[type];
  return {
    tx: action.tx,
    ty: action.ty,
    w: def?.w || 1,
    h: def?.h || 1,
  };
}

function coreOf(obs) {
  const b = (obs.buildings || []).find((x) => x.type === "core");
  if (b) return b;
  const c = obs.core;
  if (!c) return null;
  return { ...c, type: "core", w: c.w || 2, h: c.h || 2 };
}

function compactInteriors(obs) {
  const core = coreOf(obs);
  const out = [];
  for (const b of obs.buildings || []) {
    if (WALL.has(b.type) || b.type === "spikes") continue;
    if (b.type === "core") {
      out.push(b);
      continue;
    }
    if (core && cellGap(footprintOf(core), footprintOf(b)) <= MAX_COMPACT_GAP) out.push(b);
  }
  return out;
}

function footprintBlocked(obs, fp) {
  if (!fp || fp.tx == null) return true;
  const occ = occMap(obs);
  const w = fp.w || 1;
  const h = fp.h || 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (occ.has(key(fp.tx + dx, fp.ty + dy))) return true;
    }
  }
  return false;
}

function withGhost(obs, action, type) {
  const def = BUILDINGS[type];
  return {
    ...obs,
    buildings: [
      ...(obs.buildings || []),
      {
        type,
        tx: action.tx,
        ty: action.ty,
        w: def?.w || 1,
        h: def?.h || 1,
        level: 1,
      },
    ],
  };
}

function hasFlushSite(obs, type) {
  return countFlushSites(obs, type) > 0;
}

function countFlushSites(obs, type) {
  const core = coreOf(obs);
  const keep = obs.keep;
  if (!core || !keep) return 0;
  const def = BUILDINGS[type];
  const w = def?.w || 1;
  const h = def?.h || 1;
  const cfp = footprintOf(core);
  let n = 0;
  for (let ty = keep.ty; ty + h - 1 <= keep.ty1; ty++) {
    for (let tx = keep.tx; tx + w - 1 <= keep.tx1; tx++) {
      const fp = { tx, ty, w, h };
      if (cellGap(cfp, fp) > MAX_COMPACT_GAP) continue;
      if (footprintBlocked(obs, fp)) continue;
      if (type !== "core" && !WALL.has(type) && footprintOnContour(keep, fp)) continue;
      n += 1;
    }
  }
  return n;
}

function farFromCore(obs, fp) {
  const core = coreOf(obs);
  if (!core || !fp || fp.tx == null) return true;
  return cellGap(footprintOf(core), fp) > MAX_COMPACT_GAP;
}

function farFromCluster(obs, fp) {
  if (!fp || fp.tx == null) return true;
  const cluster = compactInteriors(obs);
  if (!cluster.length) return true;
  let best = 99;
  for (const b of cluster) {
    const g = cellGap(footprintOf(b), fp);
    if (g < best) best = g;
  }
  return best > MAX_COMPACT_GAP;
}

function clusterBBox(obs) {
  const cluster = compactInteriors(obs);
  if (!cluster.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of cluster) {
    const fp = footprintOf(b);
    x0 = Math.min(x0, fp.tx);
    y0 = Math.min(y0, fp.ty);
    x1 = Math.max(x1, fp.tx + (fp.w || 1) - 1);
    y1 = Math.max(y1, fp.ty + (fp.h || 1) - 1);
  }
  return { x0, y0, x1, y1 };
}

/** Walls belong on the outer rectangle around the cluster, not in pockets beside the citadel. */
function wallPlacementReason(obs, fp) {
  if (!fp || fp.tx == null) return "wall_too_far";
  const bbox = clusterBBox(obs);
  if (!bbox) return "wall_too_far";
  const { x0, y0, x1, y1 } = bbox;
  const tx = fp.tx;
  const ty = fp.ty;
  if (tx < x0 - 1 || tx > x1 + 1 || ty < y0 - 1 || ty > y1 + 1) return "wall_too_far";
  if (tx > x0 && tx < x1 && ty > y0 && ty < y1) {
    const core = coreOf(obs);
    if (core && cellGap(footprintOf(core), fp) === 0) return "wall_against_core";
    return "wall_inside";
  }
  if (farFromCluster(obs, fp)) return "wall_too_far";
  return null;
}

function hasCompact(obs, type) {
  const core = coreOf(obs);
  if (!core) return false;
  return (obs.buildings || []).some(
    (b) => b.type === type && cellGap(footprintOf(core), footprintOf(b)) <= MAX_COMPACT_GAP
  );
}

/** mill → quarry → goldmine → arrow tower → tight wall hull. */
export function openingPhase(obs) {
  if (!hasCompact(obs, "mill")) return "need_mill";
  if (!hasCompact(obs, "quarry")) return "need_quarry";
  if (!hasCompact(obs, "goldmine")) return "need_goldmine";
  if (!hasCompact(obs, "tower_arrow")) return "need_tower";
  const core = coreOf(obs);
  if (core && enclosureLevel(obs, core) < 1) return "need_ring";
  return "layout";
}

const PHASE_NEXT = {
  need_mill: "place mill flush against the citadel",
  need_quarry: "place quarry flush against the citadel",
  need_goldmine: "place goldmine flush against the citadel",
  need_tower: "place arrow tower flush against the citadel",
  need_ring: "place a solid outer wall around the buildings, not against the citadel inside",
  layout: "keep is enclosed; optional polish",
};

export function openingPhaseHint(phase) {
  return PHASE_NEXT[phase] || PHASE_NEXT.layout;
}

function verdict(phase, score, reason, extra = {}) {
  return {
    phase,
    score,
    ok: score > 7,
    punish: score <= 3,
    deferOllama: false,
    reason,
    ...extra,
  };
}

function compactPlace(phase, before, action, expected, okReason) {
  if (action.op !== "place" || action.type !== expected) {
    return verdict(phase, 1, `expected_${expected}`);
  }
  const fp = actionFootprint(action, expected);
  if (farFromCore(before, fp)) return verdict(phase, 1, "too_far_from_core");
  if (expected === "mill" || expected === "quarry" || expected === "goldmine") {
    const ghost = withGhost(before, action, expected);
    const need = expected === "mill" ? 3 : expected === "quarry" ? 2 : 1;
    if (countFlushSites(ghost, "tower_arrow") < need) return verdict(phase, 1, "blocks_tower");
  }
  return verdict(phase, 8, okReason);
}

function countType(obs, type) {
  return (obs.buildings || []).filter((b) => b.type === type).length;
}

function extraPlace(phase, before, type) {
  if (type === "mill" && countType(before, "mill") >= 1) return verdict(phase, 1, "extra_mill");
  if (type === "quarry" && countType(before, "quarry") >= 1) return verdict(phase, 1, "extra_quarry");
  if (type === "goldmine" && countType(before, "goldmine") >= 1) return verdict(phase, 1, "extra_goldmine");
  if (type === "tower_arrow" && countType(before, "tower_arrow") >= 1) return verdict(phase, 1, "extra_tower");
  if (type === "tower_cannon") return verdict(phase, 1, "expected_tower_arrow");
  return null;
}

/**
 * Hard local teacher (no Ollama): compact mill→quarry→goldmine→arrow→walls.
 */
export function scoreLayoutDecision(before, decision, after) {
  const phase = openingPhase(before);
  const action = decision?.action || decision || {};
  const op = action.op || "wait";
  const type = action.type || null;

  if (op === "sell") return verdict(phase, 1, "sell");
  if (op === "wait") return verdict(phase, 1, "expected_build");

  if (phase !== "layout" && op === "place") {
    const extra = extraPlace(phase, before, type);
    if (extra) return extra;
  }

  if (phase === "need_mill") return compactPlace(phase, before, action, "mill", "opening_mill");
  if (phase === "need_quarry") return compactPlace(phase, before, action, "quarry", "opening_quarry");
  if (phase === "need_goldmine") return compactPlace(phase, before, action, "goldmine", "opening_goldmine");
  if (phase === "need_tower") return compactPlace(phase, before, action, "tower_arrow", "opening_tower");

  if (phase === "need_ring") {
    if (type !== "wall_wood" && type !== "wall_stone") {
      return verdict(phase, 1, "expected_wall");
    }
    const fp = actionFootprint(action, type);
    const bad = wallPlacementReason(before, fp);
    if (bad) return verdict(phase, 1, bad);
    const closed = openingPhase(after || before) === "layout";
    return verdict(phase, closed ? 9 : 8, closed ? "ring_closed" : "opening_wall");
  }

  return {
    phase,
    score: null,
    ok: null,
    punish: false,
    deferOllama: true,
    reason: "layout",
  };
}
