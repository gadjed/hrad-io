import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILDINGS } from "../shared/defs.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(root, "../data/prototypes");

function footprintKeys(type, tx, ty, rot = 0) {
  const def = BUILDINGS[type];
  let w = def.w;
  let h = def.h;
  if (def.rotatable && rot % 2 === 1) {
    w = def.h;
    h = def.w;
  }
  const keys = [];
  for (let x = tx; x < tx + w; x++) {
    for (let y = ty; y < ty + h; y++) keys.push(`${x},${y}`);
  }
  return keys;
}

function keep(name, pieces, rings) {
  const used = new Set();
  const buildings = [];
  const add = (type, tx, ty, rot = 0) => {
    const keys = footprintKeys(type, tx, ty, rot);
    if (keys.some((k) => used.has(k))) return;
    keys.forEach((k) => used.add(k));
    buildings.push({ type, tx, ty, rot });
  };
  for (const p of pieces) add(p[0], p[1], p[2], p[3] || 0);
  for (const ring of rings) {
    const { type, x0, y0, x1, y1, gates = [] } = ring;
    const gateSet = new Set(gates.map(([x, y]) => `${x},${y}`));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
        if (gateSet.has(`${x},${y}`)) add("gate", x, y, x === x0 || x === x1 ? 1 : 0);
        else add(type, x, y);
      }
    }
  }
  return {
    id: name,
    name,
    createdAt: new Date().toISOString(),
    origin: { tx: 0, ty: 0 },
    buildings,
  };
}

export const DEFAULT_PROTOTYPES = [
  keep(
    "Сторожовий пост",
    [
      ["core", -1, -1],
      ["tower_arrow", 1, -2],
      ["goldmine", -2, 1],
      ["spikes", 0, -2],
      ["spikes", 0, 2],
    ],
    [{ type: "wall_wood", x0: -3, y0: -3, x1: 3, y1: 3, gates: [[0, -3], [0, 3]] }]
  ),
  keep(
    "Квадратний форт",
    [
      ["core", -1, -1],
      ["tower_arrow", -4, -4],
      ["tower_arrow", 3, -4],
      ["tower_cannon", 3, 3],
      ["mill", -4, 0],
      ["quarry", 2, 0],
      ["goldmine", -1, 2],
      ["spikes", 0, -4],
      ["spikes", 0, 4],
      ["spikes", -4, 0],
      ["spikes", 4, 0],
    ],
    [
      { type: "wall_stone", x0: -5, y0: -5, x1: 5, y1: 5, gates: [[0, -5], [0, 5], [-5, 0], [5, 0]] },
      { type: "wall_wood", x0: -2, y0: -2, x1: 2, y1: 2, gates: [[0, -2], [0, 2]] },
    ]
  ),
  keep(
    "Цитадель",
    [
      ["core", -1, -1],
      ["tower_cannon", -7, -6],
      ["tower_cannon", 6, -6],
      ["tower_cannon", -7, 5],
      ["tower_arrow", 6, 5],
      ["tower_arrow", -1, -6],
      ["tower_arrow", -1, 5],
      ["mill", -7, -2],
      ["quarry", 5, -2],
      ["goldmine", -7, 1],
      ["goldmine", 5, 1],
      ["spikes", 0, -6],
      ["spikes", 0, 6],
      ["spikes", -7, 0],
      ["spikes", 7, 0],
    ],
    [
      { type: "wall_stone", x0: -8, y0: -7, x1: 8, y1: 7, gates: [[0, -7], [0, 7], [-8, 0], [8, 0]] },
      { type: "wall_stone", x0: -3, y0: -3, x1: 3, y1: 3, gates: [[0, -3], [0, 3]] },
    ]
  ),
];

function validPrototype(data) {
  if (!data || typeof data !== "object") return false;
  if (!Array.isArray(data.buildings)) return false;
  return data.buildings.every(
    (b) => b && BUILDINGS[b.type] && Number.isInteger(b.tx) && Number.isInteger(b.ty)
  );
}

export class PrototypeStore {
  constructor() {
    this.cache = new Map();
  }

  async init() {
    await mkdir(DIR, { recursive: true });
    const files = await readdir(DIR).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(DIR, file), "utf8"));
        if (validPrototype(raw)) this.cache.set(raw.id, raw);
      } catch {
        // skip broken files
      }
    }
    if (this.cache.size === 0) {
      for (const proto of DEFAULT_PROTOTYPES) {
        await this.save(proto, true);
      }
    }
  }

  list() {
    return [...this.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "uk"))
      .map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        buildings: p.buildings.length,
      }));
  }

  get(id) {
    return this.cache.get(id);
  }

  all() {
    return [...this.cache.values()];
  }

  async save(proto, keepId = false) {
    const id = keepId && proto.id ? proto.id : slug(proto.name);
    const record = {
      id,
      name: proto.name || "Без назви",
      createdAt: proto.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      origin: proto.origin || { tx: 0, ty: 0 },
      buildings: proto.buildings,
    };
    this.cache.set(id, record);
    await writeFile(path.join(DIR, `${id}.json`), JSON.stringify(record, null, 2));
    return record;
  }

  async remove(id) {
    this.cache.delete(id);
    await unlink(path.join(DIR, `${id}.json`)).catch(() => {});
  }
}

function slug(name) {
  const base = String(name || "prototype")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "prototype"}-${Date.now().toString(36)}`;
}
