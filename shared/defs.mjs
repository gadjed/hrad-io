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
  harvestRange: 64,
  harvestDmg: 18,
  attackDmg: 18,
  attackRange: 88,
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

export const HERO = {
  maxLevel: 8,
  stats: {
    speed: { id: "speed", name: "Швидкість", desc: "Біжите швидше.", per: 0.08, cost: 8 },
    might: { id: "might", name: "Сила", desc: "Сильніший удар і збір.", per: 0.14, cost: 10 },
    armor: { id: "armor", name: "Броня", desc: "Поглинає частину шкоди.", per: 0.07, cost: 10 },
    vigor: { id: "vigor", name: "Живучість", desc: "Більше здоров'я.", per: 0.12, cost: 9 },
    regen: { id: "regen", name: "Регенерація", desc: "Повільно відновлює здоров'я.", per: 1.4, cost: 12 },
  },
};

export function emptyHero() {
  return { speed: 0, might: 0, armor: 0, vigor: 0, regen: 0 };
}

export function parseHero(raw) {
  const base = emptyHero();
  let src = raw;
  if (typeof raw === "string") {
    try { src = JSON.parse(raw); } catch { src = {}; }
  }
  for (const key of Object.keys(base)) {
    const n = Number(src?.[key] || 0);
    base[key] = clamp(Number.isFinite(n) ? n : 0, 0, HERO.maxLevel);
  }
  return base;
}

export function heroUpgradeCost(stat, level) {
  const def = HERO.stats[stat];
  if (!def) return 0;
  return Math.max(1, Math.ceil(def.cost * (1 + Math.max(0, level) * 0.7)));
}

export function playerSpeed(hero) {
  return PLAYER.speed * (1 + (hero?.speed || 0) * HERO.stats.speed.per);
}

export function playerMaxHp(hero) {
  return Math.round(PLAYER.hp * (1 + (hero?.vigor || 0) * HERO.stats.vigor.per));
}

export function playerDamage(hero, base) {
  return Math.round(base * (1 + (hero?.might || 0) * HERO.stats.might.per));
}

export function playerArmorMul(hero) {
  return Math.max(0.45, 1 - (hero?.armor || 0) * HERO.stats.armor.per);
}

export function playerRegen(hero) {
  return (hero?.regen || 0) * HERO.stats.regen.per;
}

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
    desc: "Ріже дерева в радіусі.",
    w: 2,
    h: 2,
    hp: 200,
    cost: { wood: 35, stone: 10 },
    category: "harvest",
    harvest: { resource: "wood", radius: 288, every: 1.35, damage: 12 },
  },
  quarry: {
    id: "quarry",
    name: "Каменоломня",
    desc: "Ломає камінь у радіусі.",
    w: 2,
    h: 2,
    hp: 220,
    cost: { wood: 25, stone: 20 },
    category: "harvest",
    harvest: { resource: "stone", radius: 288, every: 1.55, damage: 14 },
  },
  goldmine: {
    id: "goldmine",
    name: "Золота копальня",
    desc: "Добуває золоті жили в радіусі.",
    w: 2,
    h: 2,
    hp: 240,
    cost: { wood: 30, stone: 30, gold: 8 },
    category: "harvest",
    harvest: { resource: "gold", radius: 288, every: 2.0, damage: 16 },
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

export const BUILD_CATEGORIES = [
  { id: "wall", name: "Мури" },
  { id: "harvest", name: "Видобуток" },
  { id: "defense", name: "Оборона" },
  { id: "keep", name: "Цитадель" },
];

export const HOTBAR_SIZE = 10;

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

export const MAX_LEVEL = 5;

export function levelScale(level) {
  return 1 + (Math.max(1, level) - 1) * 0.28;
}

export function buildingMaxHp(def, level) {
  return Math.round(def.hp * levelScale(level));
}

export function harvestRadius(def, level) {
  if (!def.harvest) return 0;
  return Math.round(def.harvest.radius * (1 + (Math.max(1, level) - 1) * 0.22));
}

export function harvestPeriod(def, level) {
  if (!def.harvest) return 0;
  return def.harvest.every / (1 + (Math.max(1, level) - 1) * 0.18);
}

export function harvestDamage(def, level) {
  if (!def.harvest) return 0;
  return Math.round(def.harvest.damage * levelScale(level));
}

export function upgradeCost(def, level) {
  const out = {};
  for (const [k, v] of Object.entries(def.cost || {})) {
    out[k] = Math.max(1, Math.ceil(v * (0.55 + 0.55 * level)));
  }
  return out;
}

export function investedCost(def, level) {
  const total = { ...def.cost };
  for (let l = 1; l < level; l++) {
    const step = upgradeCost(def, l);
    for (const [k, v] of Object.entries(step)) {
      total[k] = (total[k] || 0) + v;
    }
  }
  return total;
}

export function sellValue(def, level) {
  const out = {};
  for (const [k, v] of Object.entries(investedCost(def, level))) {
    out[k] = Math.max(1, Math.floor(v * 0.6));
  }
  return out;
}

export function formatCost(cost) {
  return Object.entries(cost || {})
    .map(([k, v]) => `${v} ${RESOURCES[k]?.label || k}`)
    .join(" · ");
}

export function buildingStatus(hp, maxHp) {
  const r = hp / Math.max(1, maxHp);
  if (r >= 0.98) return { id: "intact", label: "Ціла" };
  if (r >= 0.55) return { id: "worn", label: "Пошкоджена" };
  return { id: "critical", label: "Критична" };
}

export function buildingEffect(def, level) {
  const s = levelScale(level);
  if (def.harvest) {
    const tiles = (harvestRadius(def, level) / TILE).toFixed(1);
    const every = harvestPeriod(def, level).toFixed(1);
    return `${RESOURCES[def.harvest.resource].label} · радіус ${tiles} кл. · ${every}с`;
  }
  if (def.turret) {
    const dmg = Math.round(def.turret.damage * s);
    const range = Math.round(def.turret.range * (1 + (level - 1) * 0.08));
    return `Урон ${dmg} · дальність ${range}`;
  }
  if (def.contact) {
    return `Контактний урон ${Math.round(def.contact.damage * s)}`;
  }
  return `Міцність ${buildingMaxHp(def, level)}`;
}
