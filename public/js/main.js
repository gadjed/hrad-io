import {
  TILE,
  BUILDINGS,
  HOTBAR,
  buildingFootprint,
} from "/shared/defs.mjs";
import { Renderer, paintIcon } from "./render.js";

const lobby = document.getElementById("lobby");
const gameEl = document.getElementById("game");
const nameInput = document.getElementById("name");
const passInput = document.getElementById("password");
const errEl = document.getElementById("lobby-error");
const canvas = document.getElementById("view");
const minimap = document.getElementById("minimap");
const hotbarEl = document.getElementById("hotbar");
const hintEl = document.getElementById("build-hint");
const wreckHint = document.getElementById("wreck-hint");
const toastsEl = document.getElementById("toasts");
const deathEl = document.getElementById("death");
const deathT = document.getElementById("death-t");
const panel = document.getElementById("sandbox-panel");
const protoList = document.getElementById("proto-list");
const protoName = document.getElementById("proto-name");

nameInput.value = localStorage.getItem("hrad-name") || "";

const keys = new Set();
const mouse = { x: 0, y: 0, left: false, right: false };
let selected = HOTBAR[0];
let rot = 0;
let mode = "world";
let playerId = null;
let state = null;
let socket = null;
let sendAcc = 0;

const renderer = new Renderer(canvas, minimap);

function connect(joinMode) {
  errEl.hidden = true;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "join",
      name: nameInput.value.trim() || "Воєвода",
      mode: joinMode,
      password: passInput.value,
    }));
  });
  socket.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") {
      errEl.hidden = false;
      errEl.textContent = msg.text;
      return;
    }
    if (msg.type === "welcome") {
      playerId = msg.id;
      mode = msg.mode;
      renderer.mode = mode;
      localStorage.setItem("hrad-name", nameInput.value.trim());
      enterGame(msg.prototypes || []);
      return;
    }
    if (msg.type === "state") {
      state = msg.state;
      state.minimap = msg.minimap;
      renderer.ingest(state.events);
      for (const e of state.events || []) {
        if (e.t === "toast") toast(e.text);
      }
      syncHud();
      return;
    }
    if (msg.type === "prototypes") renderProtos(msg.prototypes);
    if (msg.type === "toast") toast(msg.text);
  });
  socket.addEventListener("close", () => {
    if (!lobby.hidden) return;
    toast("З'єднання втрачено");
  });
}

function enterGame(prototypes) {
  lobby.hidden = true;
  gameEl.hidden = false;
  document.getElementById("mode-badge").textContent = mode === "sandbox" ? "Пісочниця" : "Світ";
  panel.hidden = mode !== "sandbox";
  buildHotbar();
  renderProtos(prototypes);
  renderer.resize();
  requestAnimationFrame(() => renderer.resize());
  if (mode === "sandbox") renderer.zoom = 0.78;
}

function buildHotbar() {
  hotbarEl.innerHTML = "";
  HOTBAR.forEach((id, i) => {
    const def = BUILDINGS[id];
    const btn = document.createElement("button");
    btn.className = "slot" + (id === selected ? " active" : "");
    btn.dataset.id = id;
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 32;
    paintIcon(c, id);
    btn.innerHTML = `<small>${(i + 1) % 10}</small><span class="name">${def.name.split(" ")[0]}</span>`;
    btn.prepend(c);
    btn.addEventListener("click", () => select(id));
    hotbarEl.append(btn);
  });
  const wreck = document.createElement("button");
  wreck.className = "slot wreck" + (selected === "demolish" ? " active" : "");
  wreck.dataset.id = "demolish";
  wreck.title = "Знести свою споруду";
  const icon = document.createElement("canvas");
  paintIcon(icon, "demolish");
  wreck.innerHTML = `<small>X</small><span class="name">Знести</span>`;
  wreck.prepend(icon);
  wreck.addEventListener("click", () => select("demolish"));
  hotbarEl.append(wreck);
  updateHint();
}

function select(id) {
  selected = id;
  for (const el of hotbarEl.children) el.classList.toggle("active", el.dataset.id === id);
  updateHint();
}

function updateHint() {
  if (selected === "demolish") {
    hintEl.textContent = "Режим знесення: наведіть на свою споруду і натисніть ЛКМ.";
    return;
  }
  const def = BUILDINGS[selected];
  const cost = Object.entries(def.cost).map(([k, v]) => `${v} ${k}`).join(" · ");
  hintEl.textContent = `${def.name}: ${def.desc} (${cost}). ПКМ — поставити · «Знести» — прибрати.`;
}

function renderProtos(list) {
  protoList.innerHTML = "";
  for (const p of list) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${p.name}</strong><em>${p.buildings} споруд</em>`;
    const row = document.createElement("div");
    row.className = "row";
    const load = document.createElement("button");
    load.textContent = "Завантажити";
    load.onclick = () => send({ type: "sandbox_load", id: p.id });
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Видалити";
    del.onclick = () => send({ type: "sandbox_delete", id: p.id });
    row.append(load, del);
    li.append(row);
    protoList.append(li);
  }
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastsEl.append(el);
  setTimeout(() => el.remove(), 2400);
}

function send(obj) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(obj));
}

function worldCursor() {
  return renderer.screenToWorld(mouse.x, mouse.y);
}

function buildingUnderCursor() {
  if (!state?.buildings) return null;
  const c = worldCursor();
  const tx = Math.floor(c.x / TILE);
  const ty = Math.floor(c.y / TILE);
  return state.buildings.find((b) => tx >= b.tx && ty >= b.ty && tx < b.tx + b.w && ty < b.ty + b.h) || null;
}

function canWreck(b) {
  if (!b || !playerId) return false;
  return b.ownerId === playerId || mode === "sandbox";
}

function inputPayload() {
  const you = state?.you;
  const c = worldCursor();
  let mx = 0;
  let my = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) my -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) my += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
  const ax = you ? c.x - you.x : 1;
  const ay = you ? c.y - you.y : 0;
  const target = buildingUnderCursor();
  const wreckable = canWreck(target);
  const demolishMode = selected === "demolish";
  return {
    type: "input",
    mx,
    my,
    ax,
    ay,
    harvest: mouse.left && !demolishMode && !wreckable,
    place: mouse.right && !wreckable && !demolishMode,
    demolish: (demolishMode && mouse.left) || (mouse.right && wreckable),
    selected: demolishMode ? (you?.selected || HOTBAR[0]) : selected,
    rot,
    cursor: c,
  };
}

document.getElementById("play").onclick = () => connect("world");
document.getElementById("sandbox").onclick = () => connect("sandbox");
document.getElementById("save-proto").onclick = () => {
  send({ type: "sandbox_save", name: protoName.value.trim() || "Прототип" });
};
document.getElementById("clear-proto").onclick = () => send({ type: "sandbox_clear" });

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.code.startsWith("Digit")) {
    const n = Number(e.key);
    const idx = n === 0 ? 9 : n - 1;
    if (HOTBAR[idx]) select(HOTBAR[idx]);
  }
  if (e.code === "KeyR") rot = (rot + 1) % 4;
  if (e.code === "KeyX") select(selected === "demolish" ? HOTBAR[0] : "demolish");
  if (e.code === "Escape") {
    mouse.left = false;
    if (selected === "demolish") select(HOTBAR[0]);
  }
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());
canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.x = e.clientX - r.left;
  mouse.y = e.clientY - r.top;
});
canvas.addEventListener("mousedown", (e) => {
  if (e.button === 0) mouse.left = true;
  if (e.button === 2) mouse.right = true;
  send(inputPayload());
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) mouse.left = false;
  if (e.button === 2) mouse.right = false;
  send(inputPayload());
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("resize", () => renderer.resize());

function occupancySet(buildings) {
  const s = new Set();
  for (const b of buildings) {
    for (let x = b.tx; x < b.tx + b.w; x++) {
      for (let y = b.ty; y < b.ty + b.h; y++) s.add(`${x},${y}`);
    }
  }
  return s;
}

function updateGhost() {
  if (!state?.you) {
    renderer.ghost = null;
    renderer.wreck = null;
    wreckHint.hidden = true;
    return;
  }
  const target = buildingUnderCursor();
  const wreckable = canWreck(target);
  if (wreckable) {
    renderer.wreck = target;
    renderer.ghost = null;
    wreckHint.hidden = false;
    wreckHint.textContent = selected === "demolish" ? "ЛКМ — знести" : "Кнопка «Знести» або ПКМ";
    wreckHint.style.left = `${mouse.x + 16}px`;
    wreckHint.style.top = `${mouse.y + 18}px`;
    canvas.style.cursor = "pointer";
    return;
  }
  renderer.wreck = null;
  wreckHint.hidden = true;
  canvas.style.cursor = "crosshair";
  if (selected === "demolish") {
    renderer.ghost = null;
    return;
  }
  const c = worldCursor();
  const tx = Math.floor(c.x / TILE);
  const ty = Math.floor(c.y / TILE);
  const fp = buildingFootprint(selected, tx, ty, rot);
  const occ = occupancySet(state.buildings);
  let ok = true;
  for (let x = fp.tx; x < fp.tx + fp.w; x++) {
    for (let y = fp.ty; y < fp.ty + fp.h; y++) {
      if (occ.has(`${x},${y}`)) ok = false;
    }
  }
  renderer.ghost = { ...fp, type: selected, rot, ok };
}

function syncHud() {
  if (!state?.you) return;
  const y = state.you;
  document.getElementById("res-wood").textContent = y.stock.wood | 0;
  document.getElementById("res-stone").textContent = y.stock.stone | 0;
  document.getElementById("res-gold").textContent = y.stock.gold | 0;
  document.getElementById("hp-bar").style.width = `${Math.max(0, (y.hp / y.maxHp) * 100)}%`;
  deathEl.hidden = y.alive;
  if (!y.alive) deathT.textContent = y.respawnIn.toFixed(1);
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!gameEl.hidden) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w && h && (canvas.width !== Math.floor(w * renderer.dpr) || canvas.height !== Math.floor(h * renderer.dpr))) {
      renderer.resize();
    }
    sendAcc += dt;
    if (sendAcc >= 1 / 20 && socket?.readyState === 1 && playerId) {
      sendAcc = 0;
      send(inputPayload());
    }
    if (state?.you) {
      renderer.follow(state.you.x, state.you.y, dt);
      updateGhost();
      renderer.draw(state, playerId, dt);
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.addEventListener("wheel", (e) => {
  if (gameEl.hidden) return;
  renderer.zoom = Math.max(0.55, Math.min(1.45, renderer.zoom * (e.deltaY > 0 ? 0.94 : 1.06)));
}, { passive: true });
