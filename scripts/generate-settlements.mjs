/**
 * Генерує світ: ресурси, NPC-поселення за правилами World (рівномірні сектори,
 * відстань між зонами, без перетину з гравцями), монстри та боти.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrototypeStore } from "../server/PrototypeStore.mjs";
import { World } from "../server/World.mjs";
import { WorldStore } from "../server/WorldStore.mjs";
import { WORLD_NPC } from "../shared/defs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new PrototypeStore();
await store.init();
const worldStore = new WorldStore(path.join(root, "data/world.sqlite"));

const world = new World({ mode: "world", prototypes: store });
world.scatterNodes();
world.placeNpcSettlements(WORLD_NPC.settlementCount);
world.spawnMonsters();
world.spawnWorldBots();
world.rebuildOccupancy();

worldStore.save(world.serialize());

console.log(
  `Світ згенеровано · споруд ${world.buildings.size} · NPC ${world.npcSettlementCount()} · монстри ${world.monsters.size} · боти ${world.bots.size}`
);
