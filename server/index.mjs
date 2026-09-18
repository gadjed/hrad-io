import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_RATE, ADMIN_PASSWORD, WORLD_TILES } from "../shared/defs.mjs";
import { PrototypeStore } from "./PrototypeStore.mjs";
import { World } from "./World.mjs";
import { WorldStore } from "./WorldStore.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dir, "..");
const PORT = Number(process.env.PORT || 3000);
const password = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD;
const TOKEN_RE = /^p_[a-z0-9]{8,32}$/i;

const app = express();
app.use("/shared", express.static(path.join(root, "shared")));
app.use(express.static(path.join(root, "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const store = new PrototypeStore();
const worldStore = new WorldStore(path.join(root, "data/world.sqlite"));
const rooms = {
  world: null,
  sandbox: null,
};

function ensureWorld() {
  if (rooms.world) return rooms.world;
  rooms.world = new World({ mode: "world", prototypes: store });
  const snap = worldStore.load();
  if (snap) {
    rooms.world.hydrate(snap);
    rooms.world.rebuildOccupancy();
    rooms.world.catchUp((Date.now() - snap.savedAt) / 1000);
    const before = rooms.world.npcSettlementCount();
    rooms.world.maintainNpcSettlements();
    if (rooms.world.monsters.size === 0) rooms.world.spawnMonsters();
    if (rooms.world.bots.size === 0) rooms.world.spawnWorldBots();
    const npcKeeps = rooms.world.npcSettlementCount();
    console.log(
      `Світ відновлено · ${rooms.world.buildings.size} споруд · NPC ${npcKeeps}${npcKeeps > before ? ` (+${npcKeeps - before})` : ""} · AFK ${(Math.max(0, Date.now() - snap.savedAt) / 1000) | 0}с`
    );
  } else {
    rooms.world.generate();
    persistWorld();
  }
  return rooms.world;
}

function persistWorld() {
  if (!rooms.world) return;
  worldStore.save(rooms.world.serialize());
}

function ensureSandbox() {
  if (!rooms.sandbox) {
    rooms.sandbox = new World({ mode: "sandbox", prototypes: store });
    rooms.sandbox.generate();
  }
  return rooms.sandbox;
}

const clients = new Map();

wss.on("connection", (socket) => {
  const client = { socket, player: null, room: null, mode: null };
  clients.set(socket, client);

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handle(client, msg);
  });

  socket.on("close", () => {
    if (client.player && client.room) client.room.removePlayer(client.player.id);
    clients.delete(socket);
    if (client.mode === "sandbox" && sandboxEmpty()) {
      rooms.sandbox = null;
    }
  });
});

function sandboxEmpty() {
  for (const c of clients.values()) {
    if (c.mode === "sandbox" && c.player) return false;
  }
  return true;
}

function handle(client, msg) {
  if (msg.type === "join") return join(client, msg);
  if (!client.player || !client.room) return;
  if (msg.type === "input") {
    client.room.setInput(client.player.id, msg);
    return;
  }
  if (msg.type === "upgrade") {
    client.room.upgradeBuilding(client.player.id, msg.id);
    return;
  }
  if (msg.type === "sell") {
    client.room.sellBuilding(client.player.id, msg.id);
    return;
  }
  if (msg.type === "repair") {
    client.room.repairBuilding(client.player.id, msg.id);
    return;
  }
  if (msg.type === "bulk_upgrade") {
    client.room.bulkUpgrade(client.player.id, msg.buildType);
    return;
  }
  if (msg.type === "bulk_sell") {
    client.room.bulkSell(client.player.id, msg.buildType || "*");
    return;
  }
  if (msg.type === "blueprint_export") {
    const proto = client.room.exportPlayerBlueprint(client.player.id, msg.name);
    if (!proto) {
      send(client.socket, { type: "toast", text: "Немає ваших споруд для копіювання" });
      return;
    }
    send(client.socket, { type: "blueprint", proto });
    return;
  }
  if (msg.type === "blueprint_paste") {
    if (!msg.proto?.buildings?.length) {
      send(client.socket, { type: "toast", text: "Блупрінт порожній" });
      return;
    }
    client.room.pasteBlueprint(client.player.id, msg.proto);
    return;
  }
  if (msg.type === "hero_upgrade") {
    client.room.upgradeHero(client.player.id, msg.stat);
    return;
  }
  if (client.mode !== "sandbox") return;
  sandboxCommand(client, msg);
}

function join(client, msg) {
  if (client.player) return;
  const mode = msg.mode === "sandbox" ? "sandbox" : "world";
  if (mode === "sandbox" && msg.password !== password) {
    send(client.socket, { type: "error", text: "Невірний пароль адміністратора" });
    return;
  }
  const room = mode === "sandbox" ? ensureSandbox() : ensureWorld();
  if (mode === "sandbox") {
    for (const c of clients.values()) {
      if (c !== client && c.mode === "sandbox" && c.player) {
        send(client.socket, { type: "error", text: "Пісочниця вже зайнята іншим адміном" });
        return;
      }
    }
  }
  let player;
  if (mode === "world") {
    const login = room.loginWorldPlayer(
      msg.name,
      msg.password,
      TOKEN_RE.test(msg.token || "") ? msg.token : null
    );
    if (!login.ok) {
      send(client.socket, { type: "error", text: login.text });
      return;
    }
    for (const c of clients.values()) {
      if (c !== client && c.mode === "world" && c.player?.id === login.player.id) {
        send(client.socket, { type: "error", text: "Цей гравець уже в світі" });
        return;
      }
    }
    player = login.player;
  } else {
    player = room.addPlayer(msg.name, { skin: msg.color, token: null });
  }
  client.player = player;
  client.room = room;
  client.mode = mode;
  send(client.socket, {
    type: "welcome",
    id: player.id,
    mode,
    prototypes: store.list(),
  });
}

async function sandboxCommand(client, msg) {
  const room = client.room;
  const player = client.player;
  try {
    if (msg.type === "sandbox_save") {
      const proto = room.exportPrototype(msg.name);
      if (!proto) {
        send(client.socket, { type: "toast", text: "Немає будівель для збереження" });
        return;
      }
      const saved = await store.save(proto);
      broadcastSandbox({ type: "prototypes", prototypes: store.list() });
      send(client.socket, { type: "toast", text: `Збережено: ${saved.name}` });
      const world = ensureWorld();
      const margin = 16;
      let stamped = false;
      for (let i = 0; i < 12; i++) {
        const tx = margin + ((Math.random() * (WORLD_TILES - margin * 2)) | 0);
        const ty = margin + ((Math.random() * (WORLD_TILES - margin * 2)) | 0);
        if (!world.canStamp(saved, tx, ty)) continue;
        world.stampPrototype(saved, tx, ty, `npc_${world.factions.size}`);
        stamped = true;
        break;
      }
      if (!stamped) send(client.socket, { type: "toast", text: "Немає місця у світі для цитаделі НПС" });
      return;
    }
    if (msg.type === "sandbox_load") {
      const proto = store.get(msg.id);
      if (!proto) {
        send(client.socket, { type: "toast", text: "Прототип не знайдено" });
        return;
      }
      room.loadPrototype(proto, player);
      send(client.socket, { type: "toast", text: `Завантажено: ${proto.name}` });
      return;
    }
    if (msg.type === "sandbox_delete") {
      await store.remove(msg.id);
      broadcastSandbox({ type: "prototypes", prototypes: store.list() });
      send(client.socket, { type: "toast", text: "Прототип видалено" });
      return;
    }
    if (msg.type === "sandbox_clear") {
      room.clearBuildings();
      send(client.socket, { type: "toast", text: "Майданчик очищено" });
      return;
    }
    if (msg.type === "sandbox_list") {
      send(client.socket, { type: "prototypes", prototypes: store.list() });
    }
  } catch (err) {
    send(client.socket, { type: "toast", text: "Помилка пісочниці" });
    console.error(err);
  }
}

function broadcastSandbox(payload) {
  for (const c of clients.values()) {
    if (c.mode === "sandbox") send(c.socket, payload);
  }
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

setInterval(() => {
  if (rooms.world) {
    rooms.world.step();
    const mini = rooms.world.minimap();
    for (const c of clients.values()) {
      if (c.room !== rooms.world || !c.player) continue;
      const you = rooms.world.players.get(c.player.id);
      if (!you) continue;
      send(c.socket, { type: "state", state: rooms.world.snapshotFor(you), minimap: mini });
    }
  }
  if (rooms.sandbox) {
    const occupied = [...clients.values()].some((c) => c.room === rooms.sandbox);
    if (!occupied) return;
    rooms.sandbox.step();
    const mini = rooms.sandbox.minimap();
    for (const c of clients.values()) {
      if (c.room !== rooms.sandbox || !c.player) continue;
      const you = rooms.sandbox.players.get(c.player.id);
      if (!you) continue;
      send(c.socket, { type: "state", state: rooms.sandbox.snapshotFor(you), minimap: mini });
    }
  }
}, 1000 / TICK_RATE);

setInterval(() => persistWorld(), 5000);

function shutdown() {
  persistWorld();
  try { worldStore.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await store.init();
ensureWorld();

httpServer.listen(PORT, () => {
  console.log(`Hrad.io → http://localhost:${PORT}`);
});
