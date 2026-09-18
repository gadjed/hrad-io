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
  repairCost,
  formatCost,
  canAfford,
  buildingStatus,
  buildingEffect,
  harvestRadius,
  harvestPeriod,
  buildingMaxHp,
  heroUpgradeCost,
  heroLevelLabel,
} from "/shared/defs.mjs";
import { Renderer, paintIcon } from "./render.js";

const lobby = document.getElementById("lobby");
const gameEl = document.getElementById("game");
const nameInput = document.getElementById("name");
const worldPassInput = document.getElementById("world-password");
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
const toolTypeEl = document.getElementById("tool-type");
const toolBlueprintStatus = document.getElementById("tool-blueprint-status");
const BLUEPRINT_KEY = "hrad-blueprint";

nameInput.value = localStorage.getItem("hrad-name") || "";

const CHARACTERS_KEY = "hrad-characters";

function normalizePlayerName(name) {
  return (name || "Воєвода").trim().slice(0, 16) || "Воєвода";
}

function newAccountToken() {
  return `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-6)}`;
}

function loadCharacterTokens() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHARACTERS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Окремий акаунт світу на кожне ім'я (на цьому браузері). */
function accountTokenForName(name) {
  const norm = normalizePlayerName(name);
  const map = loadCharacterTokens();
  if (/^p_[a-z0-9]{8,32}$/i.test(map[norm] || "")) return map[norm];

  const legacy = localStorage.getItem("hrad-account");
  const legacyName = normalizePlayerName(localStorage.getItem("hrad-name") || "");
  if (
    Object.keys(map).length === 0
    && /^p_[a-z0-9]{8,32}$/i.test(legacy || "")
    && legacyName === norm
  ) {
    map[norm] = legacy;
    localStorage.setItem(CHARACTERS_KEY, JSON.stringify(map));
    return legacy;
  }

  const t = newAccountToken();
  map[norm] = t;
  localStorage.setItem(CHARACTERS_KEY, JSON.stringify(map));
  localStorage.setItem("hrad-account", t);
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
let catalogRefreshKey = "";
let socket = null;
let sendAcc = 0;
let inspectId = null;
let press = null;

const renderer = new Renderer(canvas, minimap);

function connect(joinMode) {
  errEl.hidden = true;
  if (joinMode === "world") {
    const pw = worldPassInput?.value || "";
    if (pw.length < 4) {
      errEl.hidden = false;
      errEl.textContent = "Пароль персонажа — мінімум 4 символи";
      return;
    }
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "join",
      name: nameInput.value.trim() || "Воєвода",
      mode: joinMode,
      password: passInput.value,
      password: worldPassInput?.value || "",
      token: accountTokenForName(nameInput.value.trim() || "Воєвода"),
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
      const norm = normalizePlayerName(nameInput.value.trim());
      localStorage.setItem("hrad-name", norm);
      const map = loadCharacterTokens();
      map[norm] = msg.id;
      localStorage.setItem(CHARACTERS_KEY, JSON.stringify(map));
      localStorage.setItem("hrad-account", msg.id);
      enterGame(msg.prototypes || []);
      return;
    }
    if (msg.type === "state") {
      state = msg.state;
      state.minimap = msg.minimap;
      renderer.ingest(state.events);
      for (const e of state.events || []) {
        if (e.t === "toast") toast(e.text);
        if (e.t === "deposit") toast("Ресурси в скарбниці");
        if (e.t === "fort_loot") toast("Трофеї зруйнованого форту");
      }
      syncHud();
      return;
    }
    if (msg.type === "prototypes") renderProtos(msg.prototypes);
    if (msg.type === "blueprint") {
      saveBlueprintLocal(msg.proto);
      toast(`Скопійовано: ${msg.proto.name} (${msg.proto.buildings.length} споруд)`);
    }
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

function clearAllHotkeys() {
  select(null);
  slots = Array(HOTBAR_SIZE).fill(null);
  saveSlots();
  buildHotbar();
  toast("Хоткей 1–0 очищено");
}

function saveBlueprintLocal(proto) {
  localStorage.setItem(BLUEPRINT_KEY, JSON.stringify(proto));
  updateBlueprintStatus();
}

function loadBlueprintLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(BLUEPRINT_KEY) || "null");
    if (!raw?.buildings?.length) return null;
    return raw;
  } catch {
    return null;
  }
}

function updateBlueprintStatus() {
  if (!toolBlueprintStatus) return;
  const b = loadBlueprintLocal();
  toolBlueprintStatus.textContent = b
    ? `Блупрінт: «${b.name}» · ${b.buildings.length} споруд`
    : "Блупрінт не збережено (копіюйте фортецю)";
}

function renderToolTypes() {
  if (!toolTypeEl) return;
  const prev = toolTypeEl.value;
  const seen = new Set();
  for (const b of state?.buildings || []) {
    if (b.ownerId === playerId || b.team === playerId) seen.add(b.type);
  }
  toolTypeEl.innerHTML = "";
  const sellAll = document.createElement("option");
  sellAll.value = "*";
  sellAll.textContent = "Усі споруди (крім цитаделі) — лише продаж";
  toolTypeEl.append(sellAll);
  for (const cat of BUILD_CATEGORIES) {
    const og = document.createElement("optgroup");
    og.label = cat.name;
    for (const def of Object.values(BUILDINGS)) {
      if (def.category !== cat.id) continue;
      const opt = document.createElement("option");
      opt.value = def.id;
      opt.textContent = seen.has(def.id) ? `${def.name} (на карті)` : def.name;
      if (def.id === "core") opt.textContent += " — не продається";
      og.append(opt);
    }
    toolTypeEl.append(og);
  }
  if (prev && [...toolTypeEl.options].some((o) => o.value === prev)) toolTypeEl.value = prev;
  else {
    const wall = [...seen].find((t) => t.startsWith("wall_"));
    toolTypeEl.value = wall || (seen.size ? [...seen][0] : "wall_wood");
  }
}

function selectedToolType() {
  return toolTypeEl?.value || "wall_wood";
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

function buildWallet(y) {
  if (!y) return { wood: 0, stone: 0, gold: 0 };
  if (mode === "sandbox") return y.stock;
  if (y.hasCore) return y.treasury || { wood: 0, stone: 0, gold: 0 };
  return y.stock;
}

function updateHint() {
  if (!selected) {
    const extra = state?.you?.hasCore
      ? " Зайдіть у коло цитаделі — ресурси з рюкзака в скарбницю."
      : " Спочатку поставте цитадель (B).";
    hintEl.textContent = `Рука порожня. B — будівництво, 1–0 — хоткей, ЛКМ — збір.${extra}`;
    return;
  }
  const def = BUILDINGS[selected];
  const payFrom = mode !== "sandbox" && state?.you?.hasCore && selected !== "core" ? "скарбниця" : "рюкзак";
  hintEl.textContent = `${def.name} (${formatCost(def.cost)}, ${payFrom}). ПКМ — поставити · Esc · R — поворот.`;
}

function setSandboxCollapsed(collapsed) {
  panel.classList.toggle("collapsed", collapsed);
  sandboxToggle.textContent = collapsed ? "Розгорнути" : "Згорнути";
  sandboxToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  localStorage.setItem("hrad-sandbox-collapsed", collapsed ? "1" : "0");
}

function catalogRefreshToken(y) {
  if (!y) return "";
  const t = y.treasury || {};
  return [
    mode,
    y.hasCore ? 1 : 0,
    y.stock.wood | 0,
    y.stock.stone | 0,
    y.stock.gold | 0,
    t.wood | 0,
    t.stone | 0,
    t.gold | 0,
    pendingAssign || "",
  ].join("|");
}

function pickCatalogBuilding(defId) {
  if (!BUILDINGS[defId] || !state?.you) return;
  const def = BUILDINGS[defId];
  const hasCore = !!state.you.hasCore;
  const locked = mode === "world" && !hasCore && defId !== "core";
  if (locked) return;
  if (!canBuildInCatalog(def)) return;
  const empty = slots.findIndex((s) => !s);
  assignToSlot(empty >= 0 ? empty : 0, defId);
}

function canBuildInCatalog(def) {
  if (!def || !state?.you) return false;
  const hasCore = !!state.you.hasCore;
  const locked = mode === "world" && !hasCore && def.id !== "core";
  if (locked) return false;
  if (mode === "world" && def.id === "core" && hasCore) return false;
  if (mode === "world" && def.id !== "core" && !hasCore) return false;
  const free = mode === "sandbox";
  const wallet = buildWallet(state.you);
  return canAfford(wallet, def.cost, free);
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
      const hasCore = !!state?.you?.hasCore;
      const locked = mode === "world" && !hasCore && def.id !== "core";
      const canBuild = canBuildInCatalog(def);
      const btn = document.createElement("button");
      btn.className =
        "build-item"
        + (pendingAssign === def.id ? " active" : "")
        + (locked ? " locked" : "")
        + (canBuild ? " can-build" : "");
      btn.type = "button";
      btn.disabled = locked;
      const c = document.createElement("canvas");
      paintIcon(c, def.id);
      btn.append(c);
      const meta = document.createElement("span");
      meta.innerHTML = `<strong>${def.name}</strong><em>${formatCost(def.cost)}</em><em>${buildingEffect(def, 1)}</em>`;
      btn.append(meta);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        pickCatalogBuilding(def.id);
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
  catalogRefreshKey = "";
  pendingAssign = null;
  setAssignHint(null);
  renderCatalog();
  renderToolTypes();
  updateBlueprintStatus();
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
    const cost = heroUpgradeCost(def.id, level);
    const row = document.createElement("div");
    row.className = "hero-row";
    const meta = document.createElement("div");
    const late = level >= HERO.baseMaxLevel;
    meta.innerHTML = `<strong>${def.name}</strong><em>${def.desc}${late ? " · asc" : ""}</em>`;
    const lvl = document.createElement("span");
    lvl.className = "hero-lvl";
    lvl.textContent = heroLevelLabel(level);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.disabled = !free && coins < cost;
    btn.textContent = free ? "Покращити" : `${cost} монет`;
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
  const repairBtn = document.getElementById("inspect-repair");
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
  const treasury = buildWallet(state.you);
  renderUpgradeButton(upBtn, { maxed, cost, stock: treasury, free, label: "Покращити" });
  const intact = b.hp >= b.maxHp - 0.5;
  const rcost = repairCost(def, level);
  renderUpgradeButton(repairBtn, {
    maxed: intact,
    cost: rcost,
    stock: treasury,
    free,
    label: "Ремонт",
    maxLabel: "Ціла",
  });
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

function renderUpgradeButton(btn, { maxed, cost, stock, free, label = "Покращити", maxLabel = "Максимум" }) {
  if (maxed) {
    btn.disabled = true;
    btn.dataset.sig = "max:" + maxLabel;
    btn.textContent = maxLabel;
    return;
  }
  const sig = `${label}:${free ? "free" : ""}:${JSON.stringify(cost)}:${stock.wood}|${stock.stone}|${stock.gold}`;
  let afford = true;
  if (!free) {
    for (const [k, v] of Object.entries(cost || {})) {
      if (v && (stock[k] || 0) < v) afford = false;
    }
  }
  btn.disabled = !afford;
  if (btn.dataset.sig === sig) return;
  btn.dataset.sig = sig;
  btn.textContent = "";
  const title = document.createElement("span");
  title.textContent = label;
  btn.append(title);
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
document.getElementById("inspect-repair").onclick = () => {
  if (inspectId) send({ type: "repair", id: inspectId });
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
document.getElementById("tool-bulk-upgrade").onclick = () => {
  const t = selectedToolType();
  if (t === "*") {
    toast("Оберіть конкретний тип для покращення");
    return;
  }
  send({ type: "bulk_upgrade", buildType: t });
};
document.getElementById("tool-bulk-sell").onclick = () => {
  const t = selectedToolType();
  const label = t === "*" ? "усі споруди (крім цитаделі)" : BUILDINGS[t]?.name || t;
  if (!confirm(`Продати ${label}? Це незворотно.`)) return;
  send({ type: "bulk_sell", buildType: t });
};
document.getElementById("tool-blueprint-copy").onclick = () => {
  send({ type: "blueprint_export", name: "Моя фортеця" });
};
document.getElementById("tool-blueprint-paste").onclick = () => {
  const proto = loadBlueprintLocal();
  if (!proto) {
    toast("Спочатку скопіюйте фортецю");
    return;
  }
  if (!confirm(`Вставити «${proto.name}» (${proto.buildings.length} споруд)? Потрібні ресурси / вільні клітинки.`)) return;
  send({ type: "blueprint_paste", proto });
};
document.getElementById("tool-clear-hotkeys").onclick = () => clearAllHotkeys();
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
    if (selected === "core" && state.you.hasCore) ok = false;
    if (selected !== "core") {
      const own = (state.keeps || []).find((k) => k.team === playerId);
      if (!state.you.hasCore || !own) ok = false;
      else if (
        fp.tx < own.tx || fp.ty < own.ty
        || fp.tx + fp.w - 1 > own.tx1 || fp.ty + fp.h - 1 > own.ty1
      ) ok = false;
    }
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
  const treRow = document.getElementById("treasury-row");
  if (y.hasCore && mode === "world") {
    treRow.hidden = false;
    treRow.classList.toggle("in-vault", !!y.inVault);
    document.getElementById("tre-wood").textContent = (y.treasury?.wood || 0) | 0;
    document.getElementById("tre-stone").textContent = (y.treasury?.stone || 0) | 0;
    document.getElementById("tre-gold").textContent = (y.treasury?.gold || 0) | 0;
  } else treRow.hidden = true;
  document.getElementById("hp-bar").style.width = `${Math.max(0, (y.hp / y.maxHp) * 100)}%`;
  deathEl.hidden = y.alive;
  if (!y.alive) {
    deathT.textContent = y.respawnIn.toFixed(1);
    const msg = document.getElementById("death-msg");
    if (y.hasCore) {
      const ok = (y.treasury?.gold || 0) >= (y.respawnGold || 0);
      msg.textContent = ok
        ? `Відродження на цитаделі · ${y.respawnGold} золота`
        : "Відродження далеко (нема золота в скарбниці)";
    } else msg.textContent = "Відродження";
  }
  refreshInspect();
  renderHero();
  if (!buildEl.hidden) {
    const key = catalogRefreshToken(y);
    if (key !== catalogRefreshKey) {
      catalogRefreshKey = key;
      renderCatalog();
    }
  }
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
