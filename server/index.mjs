import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_RATE, ADMIN_PASSWORD, WORLD_TILES } from "../shared/defs.mjs";
import { PrototypeStore } from "./PrototypeStore.mjs";
import { World } from "./World.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dir, "..");
const PORT = Number(process.env.PORT || 3000);
const password = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD;

const app = express();
app.use("/shared", express.static(path.join(root, "shared")));
app.use(express.static(path.join(root, "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const store = new PrototypeStore();
const rooms = {
  world: null,
  sandbox: null,
};

function ensureWorld() {
  if (!rooms.world) {
    rooms.world = new World({ mode: "world", prototypes: store });
    rooms.world.generate();
  }
  return rooms.world;
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
  const player = room.addPlayer(msg.name, msg.color);
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
      for (let i = 0; i < 12; i++) {
        const tx = margin + ((Math.random() * (WORLD_TILES - margin * 2)) | 0);
        const ty = margin + ((Math.random() * (WORLD_TILES - margin * 2)) | 0);
        if (!world.canStamp(saved, tx, ty)) continue;
        world.stampPrototype(saved, tx, ty, `npc_${world.factions.size}`);
        break;
      }
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
  for (const room of [rooms.world, rooms.sandbox]) {
    if (!room) continue;
    const occupied = [...clients.values()].some((c) => c.room === room);
    if (!occupied) continue;
    room.step();
    const mini = room.minimap();
    for (const c of clients.values()) {
      if (c.room !== room || !c.player) continue;
      const you = room.players.get(c.player.id);
      if (!you) continue;
      send(c.socket, { type: "state", state: room.snapshotFor(you), minimap: mini });
    }
  }
}, 1000 / TICK_RATE);

await store.init();
ensureWorld();

httpServer.listen(PORT, () => {
  console.log(`Hrad.io → http://localhost:${PORT}`);
});
