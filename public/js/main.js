import {
  TILE,
  BUILDINGS,
  BUILD_CATEGORIES,
  HOTBAR_SIZE,
  MAX_LEVEL,
  NODE_TYPES,
  RESOURCES,
  HERO,
  buildingFootprint,
  upgradeCost,
  sellValue,
  formatCost,
  buildingStatus,
  buildingEffect,
  harvestRadius,
  harvestPeriod,
  buildingMaxHp,
  heroUpgradeCost,
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
const inspectEl = document.getElementById("inspect");
const toastsEl = document.getElementById("toasts");
const deathEl = document.getElementById("death");
const deathT = document.getElementById("death-t");
const panel = document.getElementById("sandbox-panel");
const protoList = document.getElementById("proto-list");
const protoName = document.getElementById("proto-name");
const buildEl = document.getElementById("build");
const catalogEl = document.getElementById("build-catalog");
const assignHint = document.getElementById("build-assign");
const sandboxToggle = document.getElementById("sandbox-toggle");
const heroEl = document.getElementById("hero");
const heroList = document.getElementById("hero-list");

nameInput.value = localStorage.getItem("hrad-name") || "";

function accountToken() {
  let t = localStorage.getItem("hrad-account");
  if (!/^p_[a-z0-9]{8,32}$/i.test(t || "")) {
    t = "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
    localStorage.setItem("hrad-account", t);
  }
  return t;
}

const keys = new Set();
const mouse = { x: 0, y: 0, left: false, right: false };
let slots = loadSlots();
let selected = null;
let pendingAssign = null;
let rot = 0;
let mode = "world";
let playerId = null;
let state = null;
let socket = null;
let sendAcc = 0;
let inspectId = null;
let press = null;

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
      token: accountToken(),
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
  if (mode === "sandbox") setSandboxCollapsed(localStorage.getItem("hrad-sandbox-collapsed") === "1");
  buildHotbar();
  renderCatalog();
  renderProtos(prototypes);
  renderer.resize();
  requestAnimationFrame(() => renderer.resize());
  if (mode === "sandbox") renderer.zoom = 0.78;
}

function loadSlots() {
  try {
    const raw = JSON.parse(localStorage.getItem("hrad-hotkeys") || "[]");
    const next = Array.from({ length: HOTBAR_SIZE }, (_, i) => BUILDINGS[raw[i]] ? raw[i] : null);
    return next;
  } catch {
    return Array(HOTBAR_SIZE).fill(null);
  }
}

function saveSlots() {
  localStorage.setItem("hrad-hotkeys", JSON.stringify(slots));
}

function slotKey(i) {
  return i === 9 ? "0" : String(i + 1);
}

function buildHotbar() {
  hotbarEl.innerHTML = "";
  slots.forEach((id, i) => {
    const btn = document.createElement("button");
    btn.className = "slot" + (!id ? " empty" : "") + (id && id === selected ? " active" : "");
    btn.dataset.index = String(i);
    const label = document.createElement("small");
    label.textContent = slotKey(i);
    btn.append(label);
    if (id) {
      const c = document.createElement("canvas");
      paintIcon(c, id);
      btn.append(c);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = BUILDINGS[id].name.split(" ")[0];
      btn.append(name);
    } else {
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = "—";
      btn.append(name);
    }
    btn.addEventListener("click", () => onSlotClick(i));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      clearSlot(i);
    });
    hotbarEl.append(btn);
  });
  updateHint();
}

function onSlotClick(i) {
  if (pendingAssign) {
    assignToSlot(i, pendingAssign);
    return;
  }
  const id = slots[i];
  if (!id) {
    openBuild();
    return;
  }
  select(id === selected ? null : id);
}

function clearSlot(i) {
  if (slots[i] && slots[i] === selected) select(null);
  slots[i] = null;
  saveSlots();
  buildHotbar();
}

function assignToSlot(i, id) {
  slots[i] = id;
  pendingAssign = null;
  saveSlots();
  closeBuild();
  buildHotbar();
  select(id);
}

function select(id) {
  selected = id;
  for (const el of hotbarEl.children) {
    const i = Number(el.dataset.index);
    el.classList.toggle("active", !!id && slots[i] === id);
  }
  updateHint();
}

function updateHint() {
  if (!selected) {
    hintEl.textContent = "Рука порожня. B — відкрити будівництво, 1–0 — взяти з хоткея, ЛКМ — збір.";
    return;
  }
  const def = BUILDINGS[selected];
  hintEl.textContent = `${def.name} в руці (${formatCost(def.cost)}). ПКМ — поставити · Esc — сховати · R — поворот.`;
}

function setSandboxCollapsed(collapsed) {
  panel.classList.toggle("collapsed", collapsed);
  sandboxToggle.textContent = collapsed ? "Розгорнути" : "Згорнути";
  sandboxToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  localStorage.setItem("hrad-sandbox-collapsed", collapsed ? "1" : "0");
}

function renderCatalog() {
  catalogEl.innerHTML = "";
  for (const cat of BUILD_CATEGORIES) {
    const wrap = document.createElement("section");
    wrap.className = "build-cat";
    wrap.innerHTML = `<h3>${cat.name}</h3>`;
    const grid = document.createElement("div");
    grid.className = "build-grid";
    for (const def of Object.values(BUILDINGS)) {
      if (def.category !== cat.id) continue;
      const btn = document.createElement("button");
      btn.className = "build-item" + (pendingAssign === def.id ? " active" : "");
      btn.type = "button";
      const c = document.createElement("canvas");
      paintIcon(c, def.id);
      btn.append(c);
      const meta = document.createElement("span");
      meta.innerHTML = `<strong>${def.name}</strong><em>${formatCost(def.cost)}</em><em>${buildingEffect(def, 1)}</em>`;
      btn.append(meta);
      btn.addEventListener("click", () => {
        pendingAssign = pendingAssign === def.id ? null : def.id;
        setAssignHint(pendingAssign);
        renderCatalog();
      });
      grid.append(btn);
    }
    wrap.append(grid);
    catalogEl.append(wrap);
  }
}

function setAssignHint(id) {
  if (!id) {
    assignHint.hidden = true;
    assignHint.textContent = "";
    return;
  }
  assignHint.hidden = false;
  assignHint.textContent = `«${BUILDINGS[id].name}» — оберіть слот 1–0`;
}

function openBuild() {
  closeInspect();
  closeHero();
  buildEl.hidden = false;
  renderCatalog();
}

function openHero() {
  closeInspect();
  closeBuild();
  heroEl.hidden = false;
  renderHero();
}

function closeHero() {
  heroEl.hidden = true;
}

function renderHero() {
  if (heroEl.hidden || !state?.you) return;
  const hero = state.you.hero || {};
  const coins = state.you.coins || 0;
  document.getElementById("hero-coins").textContent = `Монети: ${coins}`;
  const sig = `${mode}|${coins}|${JSON.stringify(hero)}`;
  if (heroList.dataset.sig === sig) return;
  heroList.dataset.sig = sig;
  heroList.innerHTML = "";
  const free = mode === "sandbox";
  for (const def of Object.values(HERO.stats)) {
    const level = hero[def.id] || 0;
    const maxed = level >= HERO.maxLevel;
    const cost = heroUpgradeCost(def.id, level);
    const row = document.createElement("div");
    row.className = "hero-row";
    const meta = document.createElement("div");
    meta.innerHTML = `<strong>${def.name}</strong><em>${def.desc}</em>`;
    const lvl = document.createElement("span");
    lvl.className = "hero-lvl";
    lvl.textContent = `${level} / ${HERO.maxLevel}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.disabled = maxed || (!free && coins < cost);
    btn.textContent = maxed ? "Максимум" : free ? "Покращити" : `${cost} монет`;
    btn.onclick = () => send({ type: "hero_upgrade", stat: def.id });
    row.append(meta, lvl, btn);
    heroList.append(row);
  }
}

function closeBuild() {
  buildEl.hidden = true;
  pendingAssign = null;
  setAssignHint(null);
  renderCatalog();
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

function canManage(b) {
  if (!b || !playerId) return false;
  return b.ownerId === playerId || mode === "sandbox";
}

function openInspect(id) {
  inspectId = id;
  inspectEl.hidden = false;
  inspectEl.style.pointerEvents = "none";
  refreshInspect();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      inspectEl.style.pointerEvents = "";
    });
  });
}

function closeInspect() {
  inspectId = null;
  inspectEl.hidden = true;
}

function refreshInspect() {
  if (!inspectId || inspectEl.hidden) return;
  const b = state?.buildings.find((item) => item.id === inspectId);
  if (!b) {
    closeInspect();
    return;
  }
  const def = BUILDINGS[b.type];
  const level = b.level || 1;
  const status = buildingStatus(b.hp, b.maxHp);
  document.getElementById("inspect-name").textContent = def.name;
  document.getElementById("inspect-desc").textContent = def.desc;
  const statusEl = document.getElementById("inspect-status");
  statusEl.textContent = status.label;
  statusEl.className = `status-${status.id}`;
  const hpNow = `${Math.ceil(b.hp)} / ${b.maxHp}`;
  document.getElementById("inspect-hp").textContent = def.harvest && level < MAX_LEVEL
    ? `${hpNow} → ${buildingMaxHp(def, level + 1)}`
    : hpNow;
  document.getElementById("inspect-hpbar").style.width = `${Math.max(0, Math.min(100, (b.hp / b.maxHp) * 100))}%`;
  document.getElementById("inspect-level").textContent = `${level} / ${MAX_LEVEL}`;
  document.getElementById("inspect-effect").textContent = buildingEffect(def, level);
  const radiusRow = document.getElementById("inspect-radius-row");
  const speedRow = document.getElementById("inspect-speed-row");
  if (def.harvest) {
    const maxed = level >= MAX_LEVEL;
    const rNow = (harvestRadius(def, level) / TILE).toFixed(1);
    const rNext = (harvestRadius(def, level + 1) / TILE).toFixed(1);
    const pNow = harvestPeriod(def, level).toFixed(2);
    const pNext = harvestPeriod(def, level + 1).toFixed(2);
    radiusRow.hidden = false;
    speedRow.hidden = false;
    document.getElementById("inspect-radius").textContent = maxed
      ? `${rNow} кл.`
      : `${rNow} → ${rNext} кл.`;
    document.getElementById("inspect-speed").textContent = maxed
      ? `удар / ${pNow}с`
      : `удар / ${pNow}с → ${pNext}с`;
    document.getElementById("inspect-effect").textContent = `Видобуває ${RESOURCES[def.harvest.resource].label.toLowerCase()} з жил на мапі`;
  } else {
    radiusRow.hidden = true;
    speedRow.hidden = true;
  }
  paintIcon(document.getElementById("inspect-icon"), b.type);
  const own = canManage(b);
  const actions = document.getElementById("inspect-actions");
  const note = document.getElementById("inspect-note");
  const upBtn = document.getElementById("inspect-upgrade");
  const sellBtn = document.getElementById("inspect-sell");
  actions.hidden = !own;
  if (!own) {
    note.hidden = false;
    note.textContent = "Ворожа споруда. Її можна лише атакувати.";
    return;
  }
  note.hidden = true;
  const maxed = level >= MAX_LEVEL;
  const cost = upgradeCost(def, level);
  const free = mode === "sandbox";
  renderUpgradeButton(upBtn, { maxed, cost, stock: state.you.stock, free });
  const value = sellValue(def, level);
  sellBtn.textContent = free ? "Продати" : `Продати (${formatCost(value)})`;
  if (def.harvest) {
    const sources = countHarvestNodes(b, def, level);
    note.hidden = false;
    const next = maxed ? "" : "Апгрейд: міцність, радіус, швидкість. ";
    note.textContent = sources
      ? `${next}Жил у радіусі: ${sources}`
      : `${next}У радіусі немає відповідних жил.`;
  }
}

function renderUpgradeButton(btn, { maxed, cost, stock, free }) {
  if (maxed) {
    btn.disabled = true;
    btn.dataset.sig = "max";
    btn.textContent = "Максимум";
    return;
  }
  btn.disabled = false;
  const sig = `${free ? "free" : ""}:${JSON.stringify(cost)}:${stock.wood}|${stock.stone}|${stock.gold}`;
  if (btn.dataset.sig === sig) return;
  btn.dataset.sig = sig;
  btn.textContent = "";
  const label = document.createElement("span");
  label.textContent = "Покращити";
  btn.append(label);
  if (free) return;
  const row = document.createElement("span");
  row.className = "cost-pips";
  for (const [k, v] of Object.entries(cost || {})) {
    if (!v) continue;
    const pip = document.createElement("span");
    const ok = (stock[k] || 0) >= v;
    pip.className = "cost-pip " + (ok ? "ok" : "short");
    pip.title = `${v} ${RESOURCES[k]?.label || k}`;
    const icon = document.createElement("i");
    icon.dataset.res = k;
    const amt = document.createElement("b");
    amt.textContent = String(v);
    pip.append(icon, amt);
    row.append(pip);
  }
  btn.append(row);
}

function harvestCenter(b) {
  return {
    x: b.x ?? (b.tx + b.w / 2) * TILE,
    y: b.y ?? (b.ty + b.h / 2) * TILE,
  };
}

function countHarvestNodes(b, def, level) {
  if (!def.harvest || !state?.nodes) return 0;
  const { x, y } = harvestCenter(b);
  const r2 = harvestRadius(def, level) ** 2;
  let n = 0;
  for (const node of state.nodes) {
    if (NODE_TYPES[node.kind]?.resource !== def.harvest.resource) continue;
    const dx = node.x - x;
    const dy = node.y - y;
    if (dx * dx + dy * dy <= r2) n++;
  }
  return n;
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
  const blocked = !inspectEl.hidden || !buildEl.hidden || !heroEl.hidden;
  return {
    type: "input",
    mx: blocked ? 0 : mx,
    my: blocked ? 0 : my,
    ax,
    ay,
    harvest: mouse.left && !blocked,
    place: mouse.right && !blocked && !!selected,
    selected,
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
document.getElementById("inspect-close").onclick = () => closeInspect();
document.getElementById("inspect").addEventListener("click", (e) => {
  if (e.target.id === "inspect") closeInspect();
});
document.getElementById("inspect-upgrade").onclick = () => {
  if (inspectId) send({ type: "upgrade", id: inspectId });
};
document.getElementById("inspect-sell").onclick = () => {
  if (!inspectId) return;
  send({ type: "sell", id: inspectId });
  closeInspect();
};
document.getElementById("open-build").onclick = () => {
  if (buildEl.hidden) openBuild();
  else closeBuild();
};
document.getElementById("open-hero").onclick = () => {
  if (heroEl.hidden) openHero();
  else closeHero();
};
document.getElementById("hero-close").onclick = () => closeHero();
document.getElementById("hero").addEventListener("click", (e) => {
  if (e.target.id === "hero") closeHero();
});
document.getElementById("build-close").onclick = () => closeBuild();
document.getElementById("build").addEventListener("click", (e) => {
  if (e.target.id === "build") closeBuild();
});
sandboxToggle.onclick = () => setSandboxCollapsed(!panel.classList.contains("collapsed"));

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (gameEl.hidden) return;
  if (e.code.startsWith("Digit")) {
    const n = Number(e.key);
    const idx = n === 0 ? 9 : n - 1;
    if (idx < 0 || idx >= HOTBAR_SIZE) return;
    if (pendingAssign) assignToSlot(idx, pendingAssign);
    else onSlotClick(idx);
  }
  if (e.code === "KeyB") {
    if (buildEl.hidden) openBuild();
    else closeBuild();
  }
  if (e.code === "KeyC") {
    if (heroEl.hidden) openHero();
    else closeHero();
  }
  if (e.code === "KeyR") rot = (rot + 1) % 4;
  if (e.code === "Escape") {
    mouse.left = false;
    if (!inspectEl.hidden) closeInspect();
    else if (!heroEl.hidden) closeHero();
    else if (!buildEl.hidden) closeBuild();
    else select(null);
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
  const r = canvas.getBoundingClientRect();
  mouse.x = e.clientX - r.left;
  mouse.y = e.clientY - r.top;
  const target = buildingUnderCursor();
  if (e.button === 0 && target && canManage(target)) {
    press = { x: mouse.x, y: mouse.y, id: target.id };
    return;
  }
  if (e.button === 0) mouse.left = true;
  if (e.button === 2) mouse.right = true;
  send(inputPayload());
});
window.addEventListener("mouseup", (e) => {
  if (press && e.button === 0) {
    const dx = mouse.x - press.x;
    const dy = mouse.y - press.y;
    if (dx * dx + dy * dy < 144) openInspect(press.id);
    press = null;
    return;
  }
  if (e.button === 0) mouse.left = false;
  if (e.button === 2) mouse.right = false;
  press = null;
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
    renderer.focus = null;
    return;
  }
  if (inspectId || !buildEl.hidden || !heroEl.hidden) {
    renderer.focus = inspectId ? state.buildings.find((b) => b.id === inspectId) || null : null;
    renderer.ghost = null;
    canvas.style.cursor = "crosshair";
    return;
  }
  const target = buildingUnderCursor();
  if (target) {
    renderer.focus = target;
    renderer.ghost = null;
    canvas.style.cursor = "pointer";
    return;
  }
  renderer.focus = null;
  canvas.style.cursor = "crosshair";
  if (!selected) {
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
  if (ok && mode !== "sandbox") {
    for (const keep of state.keeps || []) {
      if (keep.team === playerId) continue;
      if (fp.tx >= keep.tx && fp.ty >= keep.ty && fp.tx + fp.w - 1 <= keep.tx1 && fp.ty + fp.h - 1 <= keep.ty1) {
        ok = false;
        break;
      }
    }
  }
  renderer.ghost = { ...fp, type: selected, rot, ok, level: 1 };
}

function syncHud() {
  if (!state?.you) return;
  const y = state.you;
  document.getElementById("res-wood").textContent = y.stock.wood | 0;
  document.getElementById("res-stone").textContent = y.stock.stone | 0;
  document.getElementById("res-gold").textContent = y.stock.gold | 0;
  document.getElementById("res-coins").textContent = y.coins | 0;
  document.getElementById("hp-bar").style.width = `${Math.max(0, (y.hp / y.maxHp) * 100)}%`;
  deathEl.hidden = y.alive;
  if (!y.alive) deathT.textContent = y.respawnIn.toFixed(1);
  refreshInspect();
  renderHero();
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
