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
