export const TILE = 48;
export const WORLD_TILES = 160;
export const WORLD_SIZE = TILE * WORLD_TILES;
export const TICK_RATE = 20;
export const DT = 1 / TICK_RATE;
export const AOI_RADIUS = 1100;

export const ADMIN_PASSWORD = "admin";

export const PLAYER = {
  radius: 16,
  speed: 210,
  hp: 120,
  harvestRange: 52,
  harvestDmg: 18,
  attackDmg: 16,
  attackCooldown: 0.28,
  placeRange: 220,
  respawnDelay: 3,
};

export const NPC = {
  radius: 15,
  speed: 150,
  hp: 80,
  attackDmg: 12,
  attackCooldown: 0.45,
  aggro: 280,
  leash: 520,
};

export const RESOURCES = {
  wood: { label: "Дерево", color: "#c9843c" },
  stone: { label: "Камінь", color: "#9aa4b2" },
  gold: { label: "Золото", color: "#efc94a" },
};

export const NODE_TYPES = {
  tree: {
    resource: "wood",
    hp: 70,
    yield: 4,
    radius: 20,
    respawn: 28,
  },
  rock: {
    resource: "stone",
    hp: 90,
    yield: 3,
    radius: 18,
    respawn: 34,
  },
  goldvein: {
    resource: "gold",
    hp: 110,
    yield: 2,
    radius: 16,
    respawn: 48,
  },
};

export const BUILDINGS = {
  core: {
    id: "core",
    name: "Цитадель",
    desc: "Серце бази. Точка відродження.",
    w: 2,
    h: 2,
    hp: 800,
    cost: { wood: 80, stone: 80, gold: 20 },
    category: "keep",
    sandboxOnly: false,
    limit: 1,
  },
  wall_wood: {
    id: "wall_wood",
    name: "Дерев'яна стіна",
    desc: "Швидкий мур.",
    w: 1,
    h: 1,
    hp: 140,
    cost: { wood: 8 },
    category: "wall",
  },
  wall_stone: {
    id: "wall_stone",
    name: "Кам'яна стіна",
    desc: "Міцний мур.",
    w: 1,
    h: 1,
    hp: 320,
    cost: { wood: 4, stone: 12 },
    category: "wall",
  },
  gate: {
    id: "gate",
    name: "Брама",
    desc: "Прохід для своїх.",
    w: 1,
    h: 1,
    hp: 220,
    cost: { wood: 12, stone: 6 },
    category: "wall",
    rotatable: true,
  },
  mill: {
    id: "mill",
    name: "Лісопилка",
    desc: "Добуває дерево.",
    w: 2,
    h: 2,
    hp: 200,
    cost: { wood: 35, stone: 10 },
    category: "harvest",
    produces: { resource: "wood", amount: 1, every: 2.4 },
  },
  quarry: {
    id: "quarry",
    name: "Каменоломня",
    desc: "Добуває камінь.",
    w: 2,
    h: 2,
    hp: 220,
    cost: { wood: 25, stone: 20 },
    category: "harvest",
    produces: { resource: "stone", amount: 1, every: 2.8 },
  },
  goldmine: {
    id: "goldmine",
    name: "Золота копальня",
    desc: "Добуває золото.",
    w: 2,
    h: 2,
    hp: 240,
    cost: { wood: 30, stone: 30, gold: 8 },
    category: "harvest",
    produces: { resource: "gold", amount: 1, every: 4.2 },
  },
  tower_arrow: {
    id: "tower_arrow",
    name: "Стрільниця",
    desc: "Швидкі стріли.",
    w: 2,
    h: 2,
    hp: 260,
    cost: { wood: 40, stone: 20, gold: 5 },
    category: "defense",
    turret: { range: 320, cooldown: 0.7, damage: 14, speed: 420, color: "#e8d9a8" },
  },
  tower_cannon: {
    id: "tower_cannon",
    name: "Гарматна вежа",
    desc: "Повільно, боляче.",
    w: 2,
    h: 2,
    hp: 340,
    cost: { wood: 30, stone: 50, gold: 18 },
    category: "defense",
    turret: { range: 380, cooldown: 1.6, damage: 38, speed: 340, color: "#5b5b5b" },
  },
  spikes: {
    id: "spikes",
    name: "Шипи",
    desc: "Ранить ворогів на клітинці.",
    w: 1,
    h: 1,
    hp: 90,
    cost: { wood: 6, stone: 8 },
    category: "defense",
    contact: { damage: 18, every: 0.45 },
  },
};

export const HOTBAR = [
  "wall_wood",
  "wall_stone",
  "gate",
  "mill",
  "quarry",
  "goldmine",
  "tower_arrow",
  "tower_cannon",
  "spikes",
  "core",
];

export const TEAM_COLORS = [
  "#4ecdc4",
  "#ff6b6b",
  "#ffe66d",
  "#7bed9f",
  "#70a1ff",
  "#ffa502",
  "#e056fd",
  "#26de81",
];

export function tileCenter(tx, ty) {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

export function worldToTile(x, y) {
  return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) };
}

export function buildingFootprint(type, tx, ty, rot = 0) {
  const def = BUILDINGS[type];
  let w = def.w;
  let h = def.h;
  if (def.rotatable && (rot % 2 === 1)) {
    w = def.h;
    h = def.w;
  }
  return { tx, ty, w, h };
}

export function footprintRect(fp) {
  return {
    x: fp.tx * TILE,
    y: fp.ty * TILE,
    w: fp.w * TILE,
    h: fp.h * TILE,
  };
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

export function id() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function canAfford(stock, cost, free) {
  if (free) return true;
  for (const [k, v] of Object.entries(cost || {})) {
    if ((stock[k] || 0) < v) return false;
  }
  return true;
}

export function payCost(stock, cost, free) {
  if (free) return;
  for (const [k, v] of Object.entries(cost || {})) {
    stock[k] = (stock[k] || 0) - v;
  }
}

export function refundCost(stock, cost, factor = 0.5) {
  for (const [k, v] of Object.entries(cost || {})) {
    stock[k] = (stock[k] || 0) + Math.floor(v * factor);
  }
}
