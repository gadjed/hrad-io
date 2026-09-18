import {
  TILE,
  WORLD_TILES,
  WORLD_SIZE,
  DT,
  AOI_RADIUS,
  OCCUPANCY_AUDIT_SEC,
  LOOT_DESPAWN_SEC,
  PLAYER,
  NPC,
  NODE_TYPES,
  BUILDINGS,
  TEAM_COLORS,
  MAX_LEVEL,
  buildingFootprint,
  footprintRect,
  rectsOverlap,
  dist2,
  clamp,
  id as makeId,
  canAfford,
  payCost,
  buildingMaxHp,
  upgradeCost,
  sellValue,
  levelScale,
  harvestRadius,
  harvestPeriod,
  harvestDamage,
  emptyHero,
  parseHero,
  heroUpgradeCost,
  playerSpeed,
  playerMaxHp,
  playerDamage,
  playerArmorMul,
  playerRegen,
  HERO,
  NPC_FACTION,
  WORLD_NPC,
  WORLD_BOTS,
  MONSTER,
  emptyStock,
  repairCost,
  CORE,
  BUILD_REGEN,
  coreZonePad,
  FORT_WIPE,
  addResource,
  capStock,
  capCoins,
} from "../shared/defs.mjs";
import { NpcBrain } from "./NpcBrain.mjs";
import { MonsterBrain } from "./MonsterBrain.mjs";
import { BotBrain } from "./BotBrain.mjs";
import { hashPassword, verifyPassword } from "./Auth.mjs";

let seq = 1;
function nid(prefix) {
  return `${prefix}_${(seq++).toString(36)}`;
}
function peekSeq() {
  return seq;
}
function setSeq(n) {
  seq = Math.max(1, n | 0);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function circleHitsRect(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  return dist2(cx, cy, nx, ny) < r * r;
}

export class World {
  constructor({ mode, prototypes }) {
    this.mode = mode;
    this.prototypes = prototypes;
    this.tick = 0;
    this.players = new Map();
    this.npcs = new Map();
    this.buildings = new Map();
    this.nodes = new Map();
    this.projectiles = new Map();
    this.loot = new Map();
    this.factions = new Map();
    this.occupancy = new Map();
    this.events = [];
    this.accounts = new Map();
    this._silent = false;
    this.brain = new NpcBrain(this);
    this.monsterBrain = new MonsterBrain(this);
    this.botBrain = new BotBrain(this);
    this.monsters = new Map();
    this.bots = new Map();
    this._npcFactionSeq = null;
    this._botSeq = 0;
  }

  generate() {
    this.scatterNodes();
    if (this.mode === "world") {
      this.stampNpcKeeps();
      this.spawnMonsters();
      this.spawnWorldBots();
    }
  }

  scatterNodes() {
    const counts = { tree: 980, rock: 520, goldvein: 160 };
    for (const [kind, n] of Object.entries(counts)) {
      let placed = 0;
      let guard = 0;
      while (placed < n && guard++ < n * 8) {
        const tx = 2 + ((Math.random() * (WORLD_TILES - 4)) | 0);
        const ty = 2 + ((Math.random() * (WORLD_TILES - 4)) | 0);
        if (!this.canSpawnNodeAt(tx, ty)) continue;
        this.spawnNode(kind, tx, ty);
        placed++;
      }
    }
  }

  /** Чи можна поставити ресурс на тайл (без споруд і без іншого живого вузла). */
  canSpawnNodeAt(tx, ty, ignoreNodeId = null) {
    if (tx < 2 || ty < 2 || tx >= WORLD_TILES - 2 || ty >= WORLD_TILES - 2) return false;
    if (this.occupiedKey(tx, ty)) return false;
    for (const n of this.nodes.values()) {
      if (!n.alive || n.id === ignoreNodeId) continue;
      if (n.tx === tx && n.ty === ty) return false;
    }
    return true;
  }

  findEmptyNodeTile(preferTx, preferTy, maxRing = 28) {
    if (this.canSpawnNodeAt(preferTx, preferTy)) return { tx: preferTx, ty: preferTy };
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const tx = preferTx + dx;
          const ty = preferTy + dy;
          if (this.canSpawnNodeAt(tx, ty)) return { tx, ty };
        }
      }
    }
    return null;
  }

  placeNodeOnTile(node, tx, ty) {
    node.tx = tx;
    node.ty = ty;
    node.x = (tx + 0.5) * TILE;
    node.y = (ty + 0.5) * TILE;
  }

  suppressNodeIfUnderBuilding(n) {
    if (!n.alive) return false;
    if (!this.occupiedKey(n.tx, n.ty)) return false;
    const def = NODE_TYPES[n.kind];
    n.alive = false;
    n.respawnAt = this.tick + Math.round((def?.respawn ?? 30) / DT);
    return true;
  }

  sanitizeAliveNodesVsBuildings() {
    let fixed = 0;
    for (const n of this.nodes.values()) {
      if (this.suppressNodeIfUnderBuilding(n)) fixed++;
    }
    return fixed;
  }

  spawnNode(kind, tx, ty, saved = null) {
    const def = NODE_TYPES[kind];
    if (!def) return null;
    const node = {
      id: saved?.id || nid("n"),
      kind,
      tx,
      ty,
      x: (tx + 0.5) * TILE,
      y: (ty + 0.5) * TILE,
      hp: saved?.hp ?? def.hp,
      maxHp: def.hp,
      radius: def.radius,
      alive: saved?.alive == null ? true : !!saved.alive,
      respawnAt: saved?.respawnAt ?? 0,
    };
    if (node.alive && !this.canSpawnNodeAt(tx, ty, node.id)) {
      node.alive = false;
      node.respawnAt = this.tick + Math.round(def.respawn / DT);
    }
    this.nodes.set(node.id, node);
    return node;
  }

  nodeAt(tx, ty) {
    for (const n of this.nodes.values()) {
      if (n.alive && n.tx === tx && n.ty === ty) return n;
    }
    return null;
  }

  stampNpcKeeps() {
    this.placeNpcSettlements(WORLD_NPC.settlementCount);
  }

  nextNpcFactionId() {
    if (this._npcFactionSeq == null) {
      let max = -1;
      for (const id of this.factions.keys()) {
        const m = /^npc_(\d+)$/.exec(id);
        if (m) max = Math.max(max, Number(m[1]));
      }
      this._npcFactionSeq = max + 1;
    }
    return `npc_${this._npcFactionSeq++}`;
  }

  npcSettlementCount() {
    let n = 0;
    for (const f of this.factions.values()) {
      if (f.npc && this.factionCore(f)) n++;
    }
    return n;
  }

  pruneDeadNpcFactions() {
    for (const [id, f] of [...this.factions.entries()]) {
      if (!f.npc) continue;
      if (!this.factionCore(f) && this.buildingsOf(id).length === 0) this.factions.delete(id);
    }
  }

  maintainNpcSettlements() {
    if (this.mode !== "world") return;
    this.reconcileNpcSettlements();
    this.pruneDeadNpcFactions();
    this.removeNpcSettlementsOverlappingPlayers();
    const need = WORLD_NPC.settlementCount - this.npcSettlementCount();
    if (need <= 0) return;
    this.placeNpcSettlements(need);
    this.rebuildOccupancy();
  }

  /** Прибирає NPC-форти, чия зона будівництва перетинає цитадель гравця (legacy з save). */
  removeNpcSettlementsOverlappingPlayers() {
    this.invalidateKeepsCache();
    const playerKeeps = this.keepsList().filter((k) => this.isPlayerTeam(k.team));
    if (!playerKeeps.length) return;
    let changed = false;
    for (const f of [...this.factions.values()]) {
      if (!f.npc) continue;
      this.invalidateKeepsCache();
      const npcKeep = this.keepsList().find((k) => k.team === f.id);
      if (!npcKeep) continue;
      for (const pk of playerKeeps) {
        if (this.keepRectsOverlap(npcKeep, pk)) {
          this.destroySettlement(f.id);
          this.invalidateKeepsCache();
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.pruneDeadNpcFactions();
      this.rebuildOccupancy();
    }
  }

  /** Прототипи з цитаделлю — лише вони для NPC-поселень у світі. */
  npcSettlementPrototypes() {
    return this.prototypes.all().filter((p) => p.buildings?.some((b) => b.type === "core"));
  }

  /**
   * NPC-форт без справжньої цитаделі (зруйнована / битий save) — прибрати залишки.
   */
  reconcileNpcSettlements() {
    if (this.mode !== "world") return 0;
    let fixes = 0;
    for (const f of [...this.factions.values()]) {
      if (!f.npc) continue;
      const core = this.buildingsOf(f.id).find((b) => b.type === "core") || null;
      if (!core) {
        if (this.buildingsOf(f.id).length > 0 || this.npcsOf(f.id).length > 0) {
          this.destroySettlement(f.id);
          fixes++;
        } else {
          this.factions.delete(f.id);
          fixes++;
        }
        continue;
      }
      if (f.core !== core.id) {
        f.core = core.id;
        fixes++;
      }
    }
    this.pruneDeadNpcFactions();
    if (fixes) {
      this.invalidateKeepsCache();
      this.rebuildOccupancy();
    }
    return fixes;
  }

  placeNpcSettlements(count) {
    const list = this.npcSettlementPrototypes();
    if (!list.length || count <= 0) return 0;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      if (!this.tryPlaceNpcSettlementEvenly(list)) break;
      placed++;
    }
    return placed;
  }

  settlementCoreWorld(proto, ox, oy) {
    const core = proto.buildings.find((b) => b.type === "core");
    if (!core) return null;
    const def = BUILDINGS.core;
    return {
      x: (ox + core.tx + def.w / 2) * TILE,
      y: (oy + core.ty + def.h / 2) * TILE,
    };
  }

  keepRectsOverlap(a, b) {
    return a.tx <= b.tx1 && b.tx <= a.tx1 && a.ty <= b.ty1 && b.ty <= a.ty1;
  }

  npcProtoKeepRect(proto, ox, oy) {
    const coreB = proto.buildings.find((b) => b.type === "core");
    if (!coreB) return null;
    const def = BUILDINGS.core;
    const cx = ox + coreB.tx;
    const cy = oy + coreB.ty;
    const pad = NPC_FACTION.keepTiles;
    return {
      tx: cx - pad,
      ty: cy - pad,
      tx1: cx + (def.w || 2) - 1 + pad,
      ty1: cy + (def.h || 2) - 1 + pad,
    };
  }

  minNpcCoreSpacingTiles() {
    const gap = WORLD_NPC.keepGapTiles ?? 4;
    return Math.max(
      WORLD_NPC.minCoreSpacingTiles,
      coreZonePad(MAX_LEVEL) + NPC_FACTION.keepTiles + gap
    );
  }

  canStampNpcKeep(proto, ox, oy) {
    if (!proto.buildings?.some((b) => b.type === "core")) return false;
    if (!this.canStamp(proto, ox, oy)) return false;
    const newKeep = this.npcProtoKeepRect(proto, ox, oy);
    if (!newKeep) return false;
    for (const keep of this.keepsList()) {
      if (this.keepRectsOverlap(newKeep, keep)) return false;
    }
    const c = this.settlementCoreWorld(proto, ox, oy);
    if (!c) return false;
    const minDist = this.minNpcCoreSpacingTiles() * TILE;
    const min2 = minDist * minDist;
    for (const b of this.buildings.values()) {
      if (b.type !== "core") continue;
      if (dist2(c.x, c.y, b.x, b.y) < min2) return false;
    }
    return true;
  }

  /** Ставить поселення в сектор з найменшою кількістю NPC-цитаделей. */
  tryPlaceNpcSettlementEvenly(prototypes) {
    const target = WORLD_NPC.settlementCount;
    const grid = Math.max(3, Math.ceil(Math.sqrt(target)));
    const margin = 16;
    const span = WORLD_TILES - margin * 2;
    const cell = span / grid;
    const sectors = new Array(grid * grid).fill(0);

    for (const b of this.buildings.values()) {
      if (b.type !== "core") continue;
      const fac = this.factions.get(b.team);
      if (!fac?.npc) continue;
      const sx = clamp(Math.floor((b.tx - margin) / cell), 0, grid - 1);
      const sy = clamp(Math.floor((b.ty - margin) / cell), 0, grid - 1);
      sectors[sy * grid + sx]++;
    }

    const order = sectors.map((c, i) => ({ i, c })).sort((a, b) => a.c - b.c || a.i - b.i);

    for (let attempt = 0; attempt < 96; attempt++) {
      const { i: si } = order[attempt % order.length];
      const gx = si % grid;
      const gy = (si / grid) | 0;
      const tx = margin + gx * cell + ((Math.random() * cell) | 0);
      const ty = margin + gy * cell + ((Math.random() * cell) | 0);
      const proto = prototypes[(Math.random() * prototypes.length) | 0];
      if (!this.canStampNpcKeep(proto, tx, ty)) continue;
      this.stampPrototype(proto, tx, ty, this.nextNpcFactionId());
      return true;
    }
    return false;
  }

  canStamp(proto, ox, oy) {
    for (const b of proto.buildings) {
      const fp = buildingFootprint(b.type, ox + b.tx, oy + b.ty, b.rot || 0);
      if (fp.tx < 2 || fp.ty < 2 || fp.tx + fp.w >= WORLD_TILES - 2 || fp.ty + fp.h >= WORLD_TILES - 2) {
        return false;
      }
      if (this.footprintBlocked(fp, null)) return false;
    }
    return true;
  }

  stampPrototype(proto, ox, oy, factionId) {
    const color = pick(["#c4453c", "#a33b34", "#8b2f2f", "#6e2a32"]);
    const faction = {
      id: factionId,
      name: proto.name,
      npc: true,
      color,
      core: null,
      stock: emptyStock(NPC_FACTION.startStock),
      threat: 0,
      recruitAt: 0,
      job: null,
      desire: "economy",
    };
    this.factions.set(factionId, faction);
    const created = [];
    for (const b of proto.buildings) {
      const building = this.createBuilding({
        type: b.type,
        tx: ox + b.tx,
        ty: oy + b.ty,
        rot: b.rot || 0,
        ownerId: factionId,
        team: factionId,
        level: b.level || 1,
      });
      if (!building) {
        for (const x of created) this.destroyBuilding(x, false, true);
        this.factions.delete(factionId);
        return [];
      }
      created.push(building);
    }
    const core = created.find((b) => b.type === "core");
    if (!core) {
      for (const x of created) this.destroyBuilding(x, false, true);
      this.factions.delete(factionId);
      return [];
    }
    faction.core = core.id;
    this.ensureFaction(faction);
    const towers = created.filter((b) => BUILDINGS[b.type]?.turret).length;
    const guards = Math.min(NPC_FACTION.maxGuards, 2 + towers);
    const gateBuildings = created.filter((b) => b.type === "gate");
    const npcs = this.spawnNpcOutsideGates(factionId, guards, core, gateBuildings);
    for (const npc of npcs) npc.role = "guard";
    this.clearNodesUnder(created);
    return created;
  }

  clearNodesUnder(buildings) {
    const delay = Math.round(2 / DT);
    for (const b of buildings) {
      const rect = footprintRect(b);
      for (const n of this.nodes.values()) {
        if (!n.alive) continue;
        if (n.x >= rect.x && n.x <= rect.x + rect.w && n.y >= rect.y && n.y <= rect.y + rect.h) {
          n.alive = false;
          n.respawnAt = this.tick + delay;
        }
      }
    }
  }

  releaseNodesUnder(b) {
    const rect = footprintRect(b);
    const delay = Math.round(2 / DT);
    for (const n of this.nodes.values()) {
      if (n.x >= rect.x && n.x <= rect.x + rect.w && n.y >= rect.y && n.y <= rect.y + rect.h) {
        if (!n.alive) n.respawnAt = Math.min(n.respawnAt || Infinity, this.tick + delay);
      }
    }
  }

  spawnNpc(team, x, y, home, saved = null) {
    const npc = {
      id: saved?.id || nid("e"),
      kind: "npc",
      team,
      x: clamp(x, 40, WORLD_SIZE - 40),
      y: clamp(y, 40, WORLD_SIZE - 40),
      vx: 0,
      vy: 0,
      aim: 0,
      hp: saved?.hp ?? NPC.hp,
      maxHp: NPC.hp,
      radius: NPC.radius,
      cooldown: 0,
      home: home || { cx: x, cy: y },
      targetId: null,
      role: saved?.role || "guard",
      gatherKind: saved?.gatherKind || null,
      color: saved?.color || this.factions.get(team)?.color || "#c4453c",
    };
    this.npcs.set(npc.id, npc);
    return npc;
  }

  ensureFaction(f) {
    if (!f) return f;
    if (!f.stock) f.stock = emptyStock(NPC_FACTION.startStock);
    else f.stock = capStock(emptyStock(f.stock));
    if (f.threat == null) f.threat = 0;
    if (f.recruitAt == null) f.recruitAt = 0;
    if (f.job === undefined) f.job = null;
    if (!f.desire) f.desire = "economy";
    return f;
  }

  ownerActor(id) {
    const p = this.players.get(id);
    if (p) return p;
    const a = this.accounts.get(id);
    if (a) return a;
    const f = this.factions.get(id);
    if (f) return this.ensureFaction(f);
    return null;
  }

  isPlayerTeam(team) {
    if (!team) return false;
    if (this.players.has(team)) return true;
    const acc = this.accounts.get(team);
    if (acc && !acc.isBot) return true;
    return typeof team === "string" && team.startsWith("p_");
  }

  isHumanSide(team) {
    if (!team) return false;
    if (typeof team === "string" && team.startsWith("bot_")) return true;
    return this.isPlayerTeam(team);
  }

  findAccountByName(name) {
    const label = (name || "").trim().slice(0, 16);
    if (!label) return null;
    for (const a of this.accounts.values()) {
      if (a.name === label && !a.isBot) return a;
    }
    return null;
  }

  loginWorldPlayer(name, password, tokenHint) {
    const label = (name || "Гість").slice(0, 16);
    if (!password || String(password).length < 4) {
      return { ok: false, text: "Пароль — мінімум 4 символи" };
    }
    let acc = this.findAccountByName(label);
    if (acc) {
      if (acc.passHash) {
        if (!verifyPassword(password, acc.passHash)) {
          return { ok: false, text: "Невірний пароль для цього імені" };
        }
      } else {
        acc.passHash = hashPassword(password);
      }
    } else {
      let id = typeof tokenHint === "string" && /^p_[a-z0-9]{8,32}$/i.test(tokenHint) ? tokenHint : nid("p");
      if (this.accounts.has(id)) id = nid("p");
      const spawn = this.findSpawn();
      acc = {
        id,
        name: label,
        passHash: hashPassword(password),
        color: pick(TEAM_COLORS),
        stock: { wood: 24, stone: 12, gold: 4 },
        treasury: emptyStock(),
        coins: 18,
        hero: emptyHero(),
        x: spawn.x,
        y: spawn.y,
        hp: PLAYER.hp,
        lastSeen: Date.now(),
      };
      this.accounts.set(id, acc);
    }
    if (this.players.has(acc.id)) {
      return { ok: false, text: "Цей гравець уже в світі. Вийдіть з іншої вкладки." };
    }
    return { ok: true, player: this.resumeAccount(acc.id, label, null) };
  }

  playerCore(ownerId) {
    if (!ownerId) return null;
    for (const b of this.buildings.values()) {
      if (b.type !== "core") continue;
      if (b.ownerId === ownerId || b.team === ownerId) return b;
    }
    return null;
  }

  fortOwnerKeys(fortId, hint = null) {
    const keys = new Set();
    if (fortId) keys.add(fortId);
    if (hint) {
      if (hint.ownerId) keys.add(hint.ownerId);
      if (hint.team) keys.add(hint.team);
    }
    return keys;
  }

  keepForCore(core) {
    if (!core) return null;
    const pad = coreZonePad(core.level || 1);
    return {
      team: core.team,
      tx: core.tx - pad,
      ty: core.ty - pad,
      tx1: core.tx + core.w - 1 + pad,
      ty1: core.ty + core.h - 1 + pad,
      level: core.level || 1,
    };
  }

  ensureTreasury(p) {
    if (!p.treasury) p.treasury = emptyStock();
    else p.treasury = emptyStock(p.treasury);
    const acc = this.accounts.get(p.id);
    if (acc) {
      if (!acc.treasury) acc.treasury = emptyStock();
      else acc.treasury = emptyStock(acc.treasury);
    }
    return p.treasury;
  }

  syncTreasuryFromAccount(p) {
    const acc = this.accounts.get(p.id);
    this.ensureTreasury(p);
    if (!acc) return p.treasury;
    if (!acc.treasury) acc.treasury = emptyStock();
    if (this.players.has(p.id)) {
      acc.treasury = emptyStock(p.treasury);
      return p.treasury;
    }
    p.treasury = emptyStock(acc.treasury);
    return p.treasury;
  }

  /** Гравець: рюкзак лише до цитаделі; далі будівництво/апгрейд/ремонт — зі скарбниці. */
  buildWallet(actor) {
    if (this.mode === "sandbox" && this.players.has(actor.id)) return actor.stock;
    const fac = this.factions.get(actor.id);
    if (fac?.npc) return this.ensureFaction(fac).stock;
    if (this.playerCore(actor.id)) {
      const live = this.players.get(actor.id) || this.bots.get(actor.id);
      if (live && this.players.has(actor.id)) this.syncTreasuryFromAccount(live);
      return this.ensureTreasury(live || actor);
    }
    return actor.stock;
  }

  isPlayerActor(actor) {
    if (!actor) return false;
    if (this.players.has(actor.id) || this.bots.has(actor.id)) return true;
    const acc = this.accounts.get(actor.id);
    return !!acc && !acc.isBot;
  }

  stepBotProxy(bot) {
    if (!bot.alive) return;
    bot.cooldown = Math.max(0, (bot.cooldown || 0) - DT);
    const regen = 2;
    if (bot.hp < bot.maxHp) bot.hp = Math.min(bot.maxHp, bot.hp + regen * DT);
  }

  spawnMonsters() {
    this.monsters.clear();
    for (let i = 0; i < MONSTER.count; i++) this.spawnOneMonster();
  }

  spawnOneMonster() {
    const s = this.findSpawn();
    const m = {
      id: nid("m"),
      kind: "monster",
      x: s.x,
      y: s.y,
      hp: MONSTER.hp,
      maxHp: MONSTER.hp,
      radius: MONSTER.radius,
      aim: 0,
      cooldown: 0,
      color: "#4d6644",
      name: "",
    };
    this.monsters.set(m.id, m);
    return m;
  }

  maintainMonsterPopulation() {
    if (this.mode !== "world") return;
    const period = Math.max(1, Math.round(MONSTER.respawnSec / DT));
    if (this.tick % period !== 0) return;
    while (this.monsters.size < MONSTER.count) this.spawnOneMonster();
  }

  killBot(bot) {
    bot.alive = false;
    bot.hp = 0;
    const s = this.findSpawn();
    bot.x = s.x;
    bot.y = s.y;
    bot.hp = PLAYER.hp;
    bot.maxHp = PLAYER.hp;
    bot.alive = true;
  }

  spawnWorldBots() {
    this.bots.clear();
    const labels = ["Олек", "Данко", "Мирос", "Тур"];
    for (let i = 0; i < WORLD_BOTS.count; i++) {
      const id = nid("bot");
      const spawn = this.findSpawn();
      const color = pick(TEAM_COLORS);
      const acc = {
        id,
        name: `Бот ${labels[i] || i + 1}`,
        isBot: true,
        color,
        stock: { wood: 0, stone: 0, gold: 0 },
        treasury: emptyStock(),
        coins: 0,
        hero: emptyHero(),
        x: spawn.x,
        y: spawn.y,
        hp: PLAYER.hp,
        lastSeen: Date.now(),
      };
      this.accounts.set(id, acc);
      this.bots.set(id, {
        id,
        kind: "bot",
        name: acc.name,
        team: id,
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        aim: 0,
        hp: PLAYER.hp,
        maxHp: PLAYER.hp,
        radius: PLAYER.radius,
        cooldown: 0,
        color,
        stock: acc.stock,
        treasury: acc.treasury,
        buildPlan: null,
        alive: true,
      });
    }
  }

  makeBotBuildPlan(bot) {
    const core = this.playerCore(bot.id);
    if (!core) return null;
    const list = this.prototypes.all();
    if (!list.length) return null;
    const proto = list[(Math.random() * list.length) | 0];
    const ox = core.tx;
    const oy = core.ty;
    const prio = (t) =>
      ({ core: 0, gate: 1, wall_stone: 2, wall_wood: 3, tower_arrow: 4, tower_magic: 4, mill: 5, quarry: 5, goldmine: 5, spikes: 6 }[t] ?? 9);
    const steps = proto.buildings
      .filter((b) => b.type !== "core")
      .map((b) => ({
        type: b.type,
        tx: ox + b.tx,
        ty: oy + b.ty,
        rot: b.rot || 0,
      }))
      .sort((a, b) => prio(a.type) - prio(b.type));
    return { protoName: proto.name, steps, index: 0, phase: "build", upgradeIndex: 0 };
  }

  depositCarryToTreasury(p) {
    if (this.mode !== "world" || p.sandbox) return false;
    const core = this.playerCore(p.id);
    if (!core) return false;
    if (dist2(p.x, p.y, core.x, core.y) > CORE.depositRadius ** 2) return false;
    let moved = false;
    const treasury = this.ensureTreasury(p);
    for (const k of ["wood", "stone", "gold"]) {
      const n = p.stock[k] || 0;
      if (n <= 0) continue;
      addResource(treasury, k, n);
      p.stock[k] = 0;
      moved = true;
    }
    if (moved) {
      const acc = this.accounts.get(p.id);
      if (acc) acc.treasury = emptyStock(treasury);
      if (!this._silent) this.events.push({ t: "deposit", playerId: p.id });
    }
    return moved;
  }

  spillTreasury(ownerId, x, y) {
    const acc = this.accounts.get(ownerId);
    const p = this.players.get(ownerId);
    const src = acc?.treasury || p?.treasury;
    if (!src) return;
    for (const k of ["wood", "stone", "gold"]) {
      const amt = src[k] || 0;
      if (amt > 0) this.spawnLoot(x + rand(-20, 20), y + rand(-20, 20), k, Math.max(1, Math.floor(amt * 0.45)));
    }
    const empty = emptyStock();
    if (acc) acc.treasury = empty;
    if (p) p.treasury = emptyStock();
  }

  factionCore(f) {
    const id = typeof f === "string" ? f : f?.core;
    const team = typeof f === "string" ? f : f?.id;
    if (id) {
      const b = this.buildings.get(id);
      if (b && b.type === "core" && (!team || b.team === team)) return b;
    }
    if (!team) return null;
    for (const b of this.buildings.values()) {
      if (b.team === team && b.type === "core") {
        if (typeof f === "object" && f && f.core !== b.id) f.core = b.id;
        return b;
      }
    }
    return null;
  }

  npcsOf(team) {
    const out = [];
    for (const n of this.npcs.values()) if (n.team === team) out.push(n);
    return out;
  }

  belongsToFort(b, fortId) {
    if (!b || !fortId) return false;
    return b.team === fortId || b.ownerId === fortId;
  }

  buildingsOf(fortId, hint = null) {
    const keys = this.fortOwnerKeys(fortId, hint);
    if (!keys.size) return [];
    const out = [];
    for (const b of this.buildings.values()) {
      if (keys.has(b.team) || keys.has(b.ownerId)) out.push(b);
    }
    return out;
  }

  applyPlayerFortLoss(ownerId, origin) {
    if (!this.isPlayerTeam(ownerId)) return;
    if (origin) this.spillTreasury(ownerId, origin.x, origin.y);
    else {
      const acc = this.accounts.get(ownerId);
      const p = this.players.get(ownerId);
      if (acc) acc.treasury = emptyStock();
      if (p) p.treasury = emptyStock();
    }
    const p = this.players.get(ownerId);
    if (p?.alive) this.killPlayer(p);
    this.toast(ownerId, "Цитадель зруйновано — усі споруди зникли");
    const bot = this.bots.get(ownerId);
    if (bot?.alive) this.killBot(bot);
  }

  destroySettlement(fortId, { spillOrigin = null, fortHint = null } = {}) {
    const ownerId = spillOrigin?.ownerId || fortHint?.ownerId || fortId;
    const batch = this.buildingsOf(fortId, fortHint);
    for (const other of batch) this.destroyBuilding(other, false, true);
    const faction = this.factions.get(fortId);
    if (faction?.npc) {
      faction.core = null;
      faction.job = null;
      faction.desire = "dead";
      for (const n of [...this.npcs.values()]) {
        if (n.team === fortId) this.npcs.delete(n.id);
      }
    } else if (this.isPlayerTeam(ownerId)) {
      this.applyPlayerFortLoss(ownerId, spillOrigin);
    }
    this.rebuildOccupancy();
  }

  gateAxis(gate, core) {
    let dx = 0;
    let dy = 1;
    if (core) {
      dx = gate.x - core.x;
      dy = gate.y - core.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    return { ux: dx / len, uy: dy / len };
  }

  gateHomes(f) {
    const team = typeof f === "string" ? f : f.id;
    const core = this.factionCore(f);
    const homes = [];
    for (const b of this.buildingsOf(team)) {
      if (b.type !== "gate") continue;
      const { ux, uy } = this.gateAxis(b, core);
      homes.push({
        cx: clamp(b.x + ux * 56, 40, WORLD_SIZE - 40),
        cy: clamp(b.y + uy * 56, 40, WORLD_SIZE - 40),
      });
    }
    if (!homes.length && core) {
      homes.push({ cx: core.x, cy: clamp(core.y + 72, 40, WORLD_SIZE - 40) });
    }
    return homes;
  }

  gateSpawnPoint(gate, core) {
    const { ux, uy } = this.gateAxis(gate, core);
    const out = TILE * 2.35;
    const px = -uy;
    const py = ux;
    const jitter = rand(-14, 14);
    const x = clamp(gate.x + ux * out + px * jitter, 40, WORLD_SIZE - 40);
    const y = clamp(gate.y + uy * out + py * jitter, 40, WORLD_SIZE - 40);
    const home = {
      cx: clamp(gate.x + ux * 56, 40, WORLD_SIZE - 40),
      cy: clamp(gate.y + uy * 56, 40, WORLD_SIZE - 40),
    };
    return { x, y, home };
  }

  spawnNpcOutsideGates(factionId, count, core, gates) {
    const list = gates.length ? gates : [];
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const gate = list[i % list.length];
      let pt = gate
        ? this.gateSpawnPoint(gate, core)
        : { x: core.x, y: core.y + 72, home: { cx: core.x, cy: core.y + 72 } };
      let npc = this.spawnNpc(factionId, pt.x, pt.y, pt.home);
      if (this.blockedCircle(npc.x, npc.y, npc.radius, npc)) {
        npc.x = pt.home.cx;
        npc.y = pt.home.cy;
      }
      if (this.blockedCircle(npc.x, npc.y, npc.radius, npc)) {
        npc.x = clamp(pt.home.cx + rand(-24, 24), 40, WORLD_SIZE - 40);
        npc.y = clamp(pt.home.cy + rand(-24, 24), 40, WORLD_SIZE - 40);
      }
      spawned.push(npc);
    }
    return spawned;
  }

  nearestFriendlyGate(unit) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.buildingsOf(unit.team)) {
      if (b.type !== "gate") continue;
      const d = dist2(unit.x, unit.y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  playerNearFaction(f, range) {
    const core = this.factionCore(f);
    if (!core) return false;
    const r2 = range * range;
    for (const p of this.players.values()) {
      if (!p.alive || p.team === f.id) continue;
      if (dist2(p.x, p.y, core.x, core.y) <= r2) return true;
    }
    return false;
  }

  countHarvestNodes(b, def) {
    if (!def?.harvest) return 0;
    const r2 = harvestRadius(def, b.level || 1) ** 2;
    const want = def.harvest.resource;
    let n = 0;
    for (const node of this.nodes.values()) {
      if (!node.alive) continue;
      if (NODE_TYPES[node.kind]?.resource !== want) continue;
      if (dist2(b.x, b.y, node.x, node.y) <= r2) n++;
    }
    return n;
  }

  wallRing(f, core) {
    const team = f.id;
    const keep = NPC_FACTION.keepTiles;
    let x0 = core.tx - 3;
    let y0 = core.ty - 3;
    let x1 = core.tx + core.w + 2;
    let y1 = core.ty + core.h + 2;
    let found = false;
    for (const b of this.buildingsOf(team)) {
      if (b.type !== "wall_wood" && b.type !== "wall_stone" && b.type !== "gate") continue;
      if (Math.abs(b.tx - core.tx) > keep || Math.abs(b.ty - core.ty) > keep) continue;
      found = true;
      x0 = Math.min(x0, b.tx);
      y0 = Math.min(y0, b.ty);
      x1 = Math.max(x1, b.tx + b.w - 1);
      y1 = Math.max(y1, b.ty + b.h - 1);
    }
    if (!found) {
      x0 = core.tx - 3;
      y0 = core.ty - 3;
      x1 = core.tx + core.w + 2;
      y1 = core.ty + core.h + 2;
    }
    const cells = this.perimeterCells(x0, y0, x1, y1);
    const holes = [];
    for (const cell of cells) {
      const occ = this.occupancy.get(`${cell.tx},${cell.ty}`);
      if (occ) {
        const b = this.buildings.get(occ);
        if (b && b.team === team) continue;
      }
      holes.push(cell);
    }
    const corners = [
      { tx: x0 + 1, ty: y0 + 1 },
      { tx: Math.max(x0 + 1, x1 - 2), ty: y0 + 1 },
      { tx: x0 + 1, ty: Math.max(y0 + 1, y1 - 2) },
      { tx: Math.max(x0 + 1, x1 - 2), ty: Math.max(y0 + 1, y1 - 2) },
    ];
    let next = null;
    const size = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    if (size < NPC_FACTION.expandMax && x0 > 2 && y0 > 2 && x1 < WORLD_TILES - 3 && y1 < WORLD_TILES - 3) {
      const nx0 = x0 - 1;
      const ny0 = y0 - 1;
      const nx1 = x1 + 1;
      const ny1 = y1 + 1;
      const ncells = this.perimeterCells(nx0, ny0, nx1, ny1);
      const nholes = [];
      for (const cell of ncells) {
        if (this.occupiedKey(cell.tx, cell.ty)) continue;
        nholes.push(cell);
      }
      next = { x0: nx0, y0: ny0, x1: nx1, y1: ny1, cells: ncells, holes: nholes, gates: ncells.filter((c) => c.gate) };
    }
    return { x0, y0, x1, y1, cells, holes, corners, gates: cells.filter((c) => c.gate), next, found };
  }

  perimeterCells(x0, y0, x1, y1) {
    const cells = [];
    const mx = (x0 + x1) >> 1;
    const my = (y0 + y1) >> 1;
    const add = (tx, ty, rot, gate) => {
      cells.push({ tx, ty, rot, gate: !!gate });
    };
    for (let x = x0; x <= x1; x++) {
      add(x, y0, 0, x === mx);
      if (y1 !== y0) add(x, y1, 0, x === mx);
    }
    for (let y = y0 + 1; y <= y1 - 1; y++) {
      add(x0, y, 1, y === my);
      if (x1 !== x0) add(x1, y, 1, y === my);
    }
    return cells;
  }

  canPlaceTile(type, tx, ty, rot, team) {
    const def = BUILDINGS[type];
    if (!def) return false;
    const fp = buildingFootprint(type, tx, ty, rot || 0);
    if (fp.tx < 1 || fp.ty < 1 || fp.tx + fp.w >= WORLD_TILES - 1 || fp.ty + fp.h >= WORLD_TILES - 1) return false;
    if (this.footprintBlocked(fp, null)) return false;
    if (this.insideEnemyKeep(fp, team)) return false;
    return true;
  }

  findHarvestSite(f, core, type, ring) {
    const def = BUILDINGS[type];
    if (!def?.harvest) return null;
    const want = def.harvest.resource;
    const scan2 = NPC_FACTION.harvestScan * NPC_FACTION.harvestScan;
    let best = null;
    let bestScore = 0;
    const radius = harvestRadius(def, 1);
    const r2 = radius * radius;
    for (const node of this.nodes.values()) {
      if (!node.alive || NODE_TYPES[node.kind]?.resource !== want) continue;
      if (dist2(core.x, core.y, node.x, node.y) > scan2) continue;
      for (let dx = -3; dx <= 1; dx++) {
        for (let dy = -3; dy <= 1; dy++) {
          const tx = node.tx + dx;
          const ty = node.ty + dy;
          if (!this.canPlaceTile(type, tx, ty, 0, f.id)) continue;
          const fp = buildingFootprint(type, tx, ty, 0);
          const cx = (fp.tx + fp.w / 2) * TILE;
          const cy = (fp.ty + fp.h / 2) * TILE;
          const inside = ring && fp.tx >= ring.x0 && fp.ty >= ring.y0 && fp.tx + fp.w - 1 <= ring.x1 && fp.ty + fp.h - 1 <= ring.y1;
          if (inside) continue;
          let score = 0;
          for (const other of this.nodes.values()) {
            if (!other.alive || NODE_TYPES[other.kind]?.resource !== want) continue;
            if (dist2(cx, cy, other.x, other.y) <= r2) score++;
          }
          if (score > bestScore) {
            bestScore = score;
            best = { tx, ty, score };
          }
        }
      }
    }
    return bestScore > 0 ? best : null;
  }

  repairCostFor(def, level) {
    return repairCost(def, level);
  }

  executeFactionJob(f, opts = {}) {
    const job = f.job;
    if (!job) return false;
    if (job.kind === "place") {
      return !!this.placeBuilding(f, {
        type: job.type,
        tx: job.tx,
        ty: job.ty,
        rot: job.rot || 0,
        quiet: true,
        skipRange: true,
      });
    }
    if (job.kind === "upgrade") {
      return this.upgradeBuilding(f.id, job.id, { quiet: opts.instant });
    }
    if (job.kind === "repair") {
      return this.repairBuilding(f.id, job.id, { quiet: true });
    }
    return false;
  }

  addPlayer(name, { skin, token } = {}) {
    const label = (name || "Гість").slice(0, 16);
    if (this.mode === "world" && token) {
      return this.resumeAccount(token, label, skin);
    }
    return this.spawnFreshPlayer(label, skin);
  }

  resumeAccount(token, name, skin) {
    let acc = this.accounts.get(token);
    if (!acc) {
      const spawn = this.findSpawn();
      const color = skin || TEAM_COLORS[this.accounts.size % TEAM_COLORS.length];
      acc = {
        id: token,
        name,
        color,
        stock: { wood: 24, stone: 12, gold: 4 },
        treasury: emptyStock(),
        coins: 18,
        hero: emptyHero(),
        x: spawn.x,
        y: spawn.y,
        hp: PLAYER.hp,
        lastSeen: Date.now(),
      };
      this.accounts.set(token, acc);
    } else {
      acc.name = name || acc.name;
      if (skin) acc.color = skin;
    }
    if (this.blockedCircle(acc.x, acc.y, PLAYER.radius, null)) {
      const core = [...this.buildings.values()].find((b) => b.ownerId === token && b.type === "core");
      if (core) {
        acc.x = core.x;
        acc.y = core.y;
      } else {
        const spawn = this.findSpawn();
        acc.x = spawn.x;
        acc.y = spawn.y;
      }
    }
    const existing = this.players.get(token);
    if (existing) return existing;
    const player = {
      id: acc.id,
      kind: "player",
      name: acc.name,
      team: acc.id,
      x: acc.x,
      y: acc.y,
      vx: 0,
      vy: 0,
      aim: 0,
      hp: acc.hp > 0 ? acc.hp : PLAYER.hp,
      maxHp: PLAYER.hp,
      radius: PLAYER.radius,
      cooldown: 0,
      color: acc.color,
      stock: acc.stock,
      treasury: emptyStock(acc.treasury),
      coins: acc.coins || 0,
      hero: parseHero(acc.hero),
      selected: null,
      rot: 0,
      alive: acc.hp > 0,
      respawnAt: 0,
      input: { mx: 0, my: 0, ax: 1, ay: 0, harvest: false, place: false },
      sandbox: false,
      lastDeathX: acc.lastDeathX,
      lastDeathY: acc.lastDeathY,
    };
    if (!player.alive) player.respawnAt = this.tick * DT + PLAYER.respawnDelay;
    acc.hero = player.hero;
    acc.coins = player.coins;
    if (!acc.treasury) acc.treasury = emptyStock();
    player.treasury = emptyStock(acc.treasury);
    this.applyHero(player);
    this.players.set(player.id, player);
    return player;
  }

  spawnFreshPlayer(name, skin) {
    const spawn = this.findSpawn();
    const color = TEAM_COLORS[this.players.size % TEAM_COLORS.length];
    const sandbox = this.mode === "sandbox";
    const player = {
      id: nid("p"),
      kind: "player",
      name,
      team: null,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      aim: 0,
      hp: PLAYER.hp,
      maxHp: PLAYER.hp,
      radius: PLAYER.radius,
      cooldown: 0,
      color: skin || color,
      stock: sandbox
        ? { wood: 9999, stone: 9999, gold: 9999 }
        : { wood: 24, stone: 12, gold: 4 },
      treasury: emptyStock(),
      coins: sandbox ? 9999 : 18,
      hero: emptyHero(),
      selected: null,
      rot: 0,
      alive: true,
      respawnAt: 0,
      input: { mx: 0, my: 0, ax: 1, ay: 0, harvest: false, place: false },
      sandbox,
    };
    player.team = player.id;
    this.applyHero(player);
    this.players.set(player.id, player);
    return player;
  }

  applyHero(p) {
    if (!p.hero) p.hero = emptyHero();
    const max = playerMaxHp(p.hero);
    const ratio = p.maxHp ? p.hp / p.maxHp : 1;
    p.maxHp = max;
    if (p.alive) p.hp = Math.max(1, Math.min(max, Math.round(p.hp || max * ratio)));
  }

  upgradeHero(playerId, stat) {
    const p = this.players.get(playerId);
    if (!p || !HERO.stats[stat]) return;
    p.hero = parseHero(p.hero);
    const level = p.hero[stat] || 0;
    const cost = heroUpgradeCost(stat, level);
    const free = this.mode === "sandbox";
    if (!free && (p.coins || 0) < cost) {
      this.toast(p.id, "Не вистачає монет");
      return;
    }
    if (!free) p.coins -= cost;
    p.hero[stat] = level + 1;
    this.applyHero(p);
    const acc = this.accounts.get(p.id);
    if (acc) {
      acc.hero = p.hero;
      acc.coins = p.coins;
    }
    this.toast(p.id, `${HERO.stats[stat].name}: ${p.hero[stat]}`);
  }

  stashPlayer(p) {
    if (this.mode !== "world") return;
    let acc = this.accounts.get(p.id);
    if (!acc) {
      acc = { id: p.id, stock: p.stock, treasury: emptyStock(p.treasury), color: p.color, name: p.name };
      this.accounts.set(p.id, acc);
    }
    acc.name = p.name;
    acc.color = p.color;
    capStock(p.stock);
    capStock(p.treasury);
    p.coins = capCoins(p.coins);
    acc.stock = p.stock;
    acc.treasury = emptyStock(p.treasury);
    acc.coins = p.coins;
    acc.hero = parseHero(p.hero);
    acc.x = p.x;
    acc.y = p.y;
    acc.hp = p.alive ? p.hp : 0;
    acc.lastSeen = Date.now();
    if (p.lastDeathX != null) acc.lastDeathX = p.lastDeathX;
    if (p.lastDeathY != null) acc.lastDeathY = p.lastDeathY;
  }

  findSpawn() {
    if (this.mode === "sandbox") {
      const c = WORLD_SIZE / 2;
      return { x: c, y: c };
    }
    for (let i = 0; i < 80; i++) {
      const x = rand(400, WORLD_SIZE - 400);
      const y = rand(400, WORLD_SIZE - 400);
      if (this.blockedCircle(x, y, 28, null)) continue;
      let far = true;
      for (const b of this.buildings.values()) {
        if (b.type === "core" && dist2(x, y, b.x, b.y) < 380 * 380) {
          far = false;
          break;
        }
      }
      if (far) return { x, y };
    }
    return { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) this.stashPlayer(p);
    this.players.delete(id);
  }

  setInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p) return;
    const wasPlace = p.input.place;
    p.input = {
      mx: clamp(input.mx || 0, -1, 1),
      my: clamp(input.my || 0, -1, 1),
      ax: input.ax ?? p.input.ax,
      ay: input.ay ?? p.input.ay,
      harvest: !!input.harvest,
      place: !!input.place,
      cursor: input.cursor && Number.isFinite(input.cursor.x)
        ? { x: input.cursor.x, y: input.cursor.y }
        : null,
    };
    if (input.selected && BUILDINGS[input.selected]) p.selected = input.selected;
    else p.selected = null;
    if (Number.isFinite(input.rot)) p.rot = ((input.rot % 4) + 4) % 4;
    if (p.input.place && !wasPlace) {
      this.tryPlace(p);
      p.placeAcc = 0.1;
    }
  }

  step() {
    this.tick++;
    this.events = [];
    for (const p of this.players.values()) this.stepPlayer(p);
    for (const b of this.bots.values()) this.stepBotProxy(b);
    for (const n of this.npcs.values()) this.stepNpc(n);
    const botEvery = Math.max(1, Math.round(WORLD_BOTS.brainPeriod / DT));
    if (this.tick % botEvery === 0) this.botBrain.step();
    this.monsterBrain.step();
    this.maintainMonsterPopulation();
    this.stepBuildings();
    this.stepBuildingRegen();
    this.stepProjectiles();
    this.stepLoot();
    this.stepNodes();
    this.brain.step();
    if (this.mode === "world") {
      const period = Math.max(1, Math.round(WORLD_NPC.repopulateSec / DT));
      if (this.tick % period === 0) this.maintainNpcSettlements();
    }
    const occEvery = Math.max(1, Math.round(OCCUPANCY_AUDIT_SEC / DT));
    if (this.tick % occEvery === 0) {
      const occFixed = this.repairOccupancyIntegrity();
      const nodeFixed = this.sanitizeAliveNodesVsBuildings();
      const npcFixed = this.mode === "world" ? this.reconcileNpcSettlements() : 0;
      if ((occFixed > 0 || nodeFixed > 0 || npcFixed > 0) && !this._silent) {
        console.log(
          `[world-audit] occupancy ${occFixed} · nodes ${nodeFixed} · npc ${npcFixed} · tick ${this.tick}`
        );
      }
    }
  }

  stepPlayer(p) {
    if (!p.alive) {
      if (this.tick * DT >= p.respawnAt) this.respawn(p);
      return;
    }
    this.ejectUnitIfBlocked(p);
    p.aim = Math.atan2(p.input.ay, p.input.ax);
    const mag = Math.hypot(p.input.mx, p.input.my);
    let vx = 0;
    let vy = 0;
    const speed = playerSpeed(p.hero);
    if (mag > 0.01) {
      vx = (p.input.mx / mag) * speed;
      vy = (p.input.my / mag) * speed;
    }
    this.moveCircle(p, vx * DT, vy * DT);
    p.cooldown = Math.max(0, p.cooldown - DT);
    const regen = playerRegen(p.hero);
    if (regen > 0 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + regen * DT);

    if (p.input.harvest && p.cooldown <= 0) {
      this.playerStrike(p);
      p.cooldown = PLAYER.attackCooldown;
    }

    if (p.input.place) {
      p.placeAcc = (p.placeAcc || 0) - DT;
      if (p.placeAcc <= 0) {
        this.tryPlace(p, { quiet: true });
        p.placeAcc = 0.1;
      }
    } else p.placeAcc = 0;

    this.pickupLoot(p);
    this.spikeContact(p);
    this.depositCarryToTreasury(p);
  }

  respawn(p) {
    const core = this.playerCore(p.id);
    if (core && this.mode === "world" && !p.sandbox) {
      const treasury = this.ensureTreasury(p);
      if ((treasury.gold || 0) >= CORE.respawnGold) {
        treasury.gold -= CORE.respawnGold;
        const acc = this.accounts.get(p.id);
        if (acc) acc.treasury = emptyStock(treasury);
        p.x = core.x;
        p.y = core.y;
      } else {
        const s = this.findSpawn();
        p.x = s.x;
        p.y = s.y;
        this.toast(p.id, "Нема золота в скарбниці — відродження далеко");
      }
    } else if (core) {
      p.x = core.x;
      p.y = core.y;
    } else {
      const s = this.findSpawn();
      p.x = s.x;
      p.y = s.y;
    }
    p.hp = playerMaxHp(p.hero);
    p.maxHp = p.hp;
    p.alive = true;
  }

  playerStrike(p) {
    const reach = PLAYER.harvestRange;
    const reachX = p.x + Math.cos(p.aim) * reach;
    const reachY = p.y + Math.sin(p.aim) * reach;
    const hitDmg = playerDamage(p.hero, PLAYER.attackDmg);
    const gatherDmg = playerDamage(p.hero, PLAYER.harvestDmg);
    const cursor = p.input.cursor;
    if (cursor) {
      const over = this.buildingAtWorld(cursor.x, cursor.y);
      if (over && over.team !== p.team) {
        const reachB = PLAYER.attackRange + Math.max(over.w, over.h) * TILE * 0.35;
        if (dist2(p.x, p.y, over.x, over.y) <= reachB * reachB) {
          this.damageBuilding(over, hitDmg, p.team, p);
          this.events.push({ t: "hit", x: over.x, y: over.y });
          return;
        }
      }
    }
    let best = null;
    let bestD = 48 * 48;

    for (const b of this.buildings.values()) {
      if (b.team === p.team) continue;
      const rect = footprintRect(b);
      if (circleHitsRect(reachX, reachY, 22, rect) || circleHitsRect(p.x, p.y, PLAYER.attackRange, rect)) {
        const d = dist2(p.x, p.y, b.x, b.y);
        if (d < bestD) {
          best = { kind: "building", ref: b };
          bestD = d;
        }
      }
    }
    for (const n of this.npcs.values()) {
      if (n.team === p.team) continue;
      const d = dist2(reachX, reachY, n.x, n.y);
      if (d < bestD && dist2(p.x, p.y, n.x, n.y) < (reach + n.radius) ** 2) {
        best = { kind: "npc", ref: n };
        bestD = d;
      }
    }
    for (const o of this.players.values()) {
      if (o.id === p.id || !o.alive || o.team === p.team) continue;
      const d = dist2(reachX, reachY, o.x, o.y);
      if (d < bestD && dist2(p.x, p.y, o.x, o.y) < (reach + o.radius) ** 2) {
        best = { kind: "player", ref: o };
        bestD = d;
      }
    }
    for (const o of this.bots.values()) {
      if (!o.alive || o.team === p.team) continue;
      const d = dist2(reachX, reachY, o.x, o.y);
      if (d < bestD && dist2(p.x, p.y, o.x, o.y) < (reach + o.radius) ** 2) {
        best = { kind: "bot", ref: o };
        bestD = d;
      }
    }
    for (const m of this.monsters.values()) {
      const d = dist2(reachX, reachY, m.x, m.y);
      if (d < bestD && dist2(p.x, p.y, m.x, m.y) < (reach + m.radius) ** 2) {
        best = { kind: "monster", ref: m };
        bestD = d;
      }
    }
    for (const n of this.nodes.values()) {
      if (!n.alive) continue;
      const d = dist2(reachX, reachY, n.x, n.y);
      if (d < bestD && dist2(p.x, p.y, n.x, n.y) < (reach + n.radius) ** 2) {
        best = { kind: "node", ref: n };
        bestD = d;
      }
    }

    if (!best) {
      this.events.push({ t: "swing", x: reachX, y: reachY, team: p.team });
      return;
    }
    if (best.kind === "node") this.hitNode(best.ref, gatherDmg, p);
    if (best.kind === "building") this.damageBuilding(best.ref, hitDmg, p.team, p);
    if (best.kind === "npc") this.damageNpc(best.ref, hitDmg, p);
    if (best.kind === "player") this.damagePlayer(best.ref, hitDmg, p.team);
    if (best.kind === "bot") this.damageBot(best.ref, hitDmg, p);
    if (best.kind === "monster") this.damageMonster(best.ref, hitDmg, p);
    this.events.push({ t: "hit", x: best.ref.x, y: best.ref.y });
  }

  hitNode(node, dmg, player) {
    node.hp -= dmg;
    if (!this._silent) this.events.push({ t: "chips", x: node.x, y: node.y, kind: node.kind });
    if (node.hp <= 0) {
      const def = NODE_TYPES[node.kind];
      if (player?.stock) addResource(player.stock, def.resource, def.yield);
      node.alive = false;
      node.respawnAt = this.tick + def.respawn / DT;
      if (!this._silent) this.events.push({ t: "gather", resource: def.resource, x: node.x, y: node.y });
    }
  }

  tryPlace(p, opts = {}) {
    const cursor = p.input.cursor;
    if (!cursor) return null;
    const gx = Math.floor(cursor.x / TILE);
    const gy = Math.floor(cursor.y / TILE);
    return this.placeBuilding(p, {
      type: p.selected,
      tx: gx,
      ty: gy,
      rot: p.rot,
      quiet: !!opts.quiet,
      fromX: p.x,
      fromY: p.y,
    });
  }

  placeBuilding(actor, { type, tx, ty, rot = 0, quiet = false, fromX, fromY, skipRange = false }) {
    const def = BUILDINGS[type];
    if (!def || !actor) return null;
    const note = (text) => {
      if (!quiet && this.players.has(actor.id)) this.toast(actor.id, text);
    };
    if (this.mode !== "sandbox" && def.limit === 1) {
      for (const b of this.buildings.values()) {
        if (b.ownerId === actor.id && b.type === def.id) {
          note("Цитадель уже стоїть");
          return null;
        }
      }
    }
    const fp = buildingFootprint(type, tx, ty, rot);
    const cx = (fp.tx + fp.w / 2) * TILE;
    const cy = (fp.ty + fp.h / 2) * TILE;
    if (!skipRange && this.mode !== "sandbox" && fromX != null) {
      if (dist2(fromX, fromY, cx, cy) > PLAYER.placeRange ** 2) {
        note("Занадто далеко");
        return null;
      }
    }
    if (fp.tx < 1 || fp.ty < 1 || fp.tx + fp.w >= WORLD_TILES - 1 || fp.ty + fp.h >= WORLD_TILES - 1) {
      note("Край мапи");
      return null;
    }
    if (this.footprintBlocked(fp, null)) return null;
    if (this.mode !== "sandbox" && this.insideEnemyKeep(fp, actor.team || actor.id)) {
      note("Не можна будувати в чужій цитаделі");
      return null;
    }
    const playerActor = this.isPlayerActor(actor);
    if (this.mode !== "world" || !playerActor || actor.sandbox) {
      // sandbox / npc — нижче
    } else if (type === "core") {
      if (this.playerCore(actor.id)) {
        note("Цитадель уже стоїть");
        return null;
      }
    } else {
      const core = this.playerCore(actor.id);
      if (!core) {
        note("Спочатку поставте цитадель");
        return null;
      }
      const keep = this.keepForCore(core);
      if (!this.footprintInKeep(fp, keep)) {
        note("Поза зоною цитаделі");
        return null;
      }
    }
    const free = this.mode === "sandbox" && this.players.has(actor.id);
    const wallet = this.buildWallet(actor);
    if (!canAfford(wallet, def.cost, free)) {
      note(type === "core" || !this.playerCore(actor.id) ? "Не вистачає ресурсів у рюкзаку" : "Не вистачає в скарбниці");
      return null;
    }
    payCost(wallet, def.cost, free);
    if (playerActor && wallet !== actor.stock) {
      const acc = this.accounts.get(actor.id);
      if (acc) acc.treasury = emptyStock(wallet);
    }
    const b = this.createBuilding({
      type,
      tx: fp.tx,
      ty: fp.ty,
      rot,
      ownerId: actor.id,
      team: actor.team || actor.id,
    });
    if (b) this.events.push({ t: "place", x: b.x, y: b.y, type: b.type });
    return b;
  }

  ownsBuilding(p, b) {
    if (!b || !p) return false;
    if (b.ownerId === p.id) return true;
    if (this.isPlayerTeam(p.id) && b.team === p.id) return true;
    return this.mode === "sandbox" && this.players.has(p.id);
  }

  applyLevel(b) {
    const def = BUILDINGS[b.type];
    const ratio = b.maxHp ? b.hp / b.maxHp : 1;
    b.maxHp = buildingMaxHp(def, b.level);
    b.hp = Math.max(1, Math.round(b.maxHp * ratio));
  }

  upgradeBuilding(actorId, buildingId, opts = {}) {
    const live = this.players.get(actorId);
    if (live) this.syncTreasuryFromAccount(live);
    const actor = live || this.ownerActor(actorId);
    const b = this.buildings.get(buildingId);
    const quiet = !!opts.quiet;
    if (!this.ownsBuilding(actor, b)) {
      if (!quiet && this.players.has(actorId)) this.toast(actorId, "Це не ваша споруда");
      return false;
    }
    if (b.level >= MAX_LEVEL) {
      if (!quiet && this.players.has(actorId)) this.toast(actorId, "Максимальний рівень");
      return false;
    }
    const def = BUILDINGS[b.type];
    const cost = upgradeCost(def, b.level);
    const free = this.mode === "sandbox" && this.players.has(actorId);
    const wallet = this.buildWallet(actor);
    if (!canAfford(wallet, cost, free)) {
      if (!quiet && this.players.has(actorId)) {
        this.toast(actorId, this.playerCore(actorId) ? "Не вистачає в скарбниці" : "Не вистачає ресурсів у рюкзаку");
      }
      return false;
    }
    payCost(wallet, cost, free);
    if (wallet !== actor.stock) {
      const acc = this.accounts.get(actorId);
      if (acc) acc.treasury = emptyStock(wallet);
    } else {
      const acc = this.accounts.get(actorId);
      if (acc) acc.stock = { ...actor.stock };
    }
    if (live) this.stashPlayer(live);
    b.level += 1;
    this.applyLevel(b);
    b.hp = b.maxHp;
    this.events.push({ t: "place", x: b.x, y: b.y, type: b.type });
    if (!quiet && this.players.has(actorId)) {
      const extra = b.type === "core" ? ` · зона ${coreZonePad(b.level) * 2 + (BUILDINGS.core.w)} кл.` : "";
      this.toast(actorId, `${def.name}: рівень ${b.level}${extra}`);
    }
    return true;
  }

  repairBuilding(actorId, buildingId, opts = {}) {
    const live = this.players.get(actorId);
    if (live) this.syncTreasuryFromAccount(live);
    const actor = live || this.ownerActor(actorId);
    const b = this.buildings.get(buildingId);
    const quiet = !!opts.quiet;
    if (!this.ownsBuilding(actor, b)) {
      if (!quiet && this.players.has(actorId)) this.toast(actorId, "Це не ваша споруда");
      return false;
    }
    if (b.hp >= b.maxHp - 0.5) {
      if (!quiet && this.players.has(actorId)) this.toast(actorId, "Споруда ціла");
      return false;
    }
    const def = BUILDINGS[b.type];
    const cost = repairCost(def, b.level);
    const free = this.mode === "sandbox" && this.players.has(actorId);
    const wallet = this.buildWallet(actor);
    if (!canAfford(wallet, cost, free)) {
      if (!quiet && this.players.has(actorId)) {
        this.toast(actorId, this.playerCore(actorId) ? "Не вистачає в скарбниці" : "Не вистачає ресурсів у рюкзаку");
      }
      return false;
    }
    payCost(wallet, cost, free);
    if (wallet !== actor.stock) {
      const acc = this.accounts.get(actorId);
      if (acc) acc.treasury = emptyStock(wallet);
    } else {
      const acc = this.accounts.get(actorId);
      if (acc) acc.stock = { ...actor.stock };
    }
    b.hp = b.maxHp;
    this.events.push({ t: "place", x: b.x, y: b.y, type: b.type });
    if (!quiet && this.players.has(actorId)) this.toast(actorId, `${def.name}: відремонтовано`);
    return true;
  }

  sellBuilding(playerId, buildingId, opts = {}) {
    const quiet = !!opts.quiet;
    const p = this.players.get(playerId);
    const b = this.buildings.get(buildingId);
    if (!this.ownsBuilding(p, b)) {
      if (!quiet && p) this.toast(p.id, "Це не ваша споруда");
      return false;
    }
    if (this.mode !== "sandbox") {
      const value = sellValue(BUILDINGS[b.type], b.level);
      const wallet = this.playerCore(p.id) ? this.ensureTreasury(p) : p.stock;
      for (const [k, v] of Object.entries(value)) addResource(wallet, k, v);
      if (wallet !== p.stock) {
        const acc = this.accounts.get(p.id);
        if (acc) acc.treasury = emptyStock(wallet);
      }
    }
    this.destroyBuilding(b, false);
    if (!quiet && p) this.toast(p.id, "Продано");
    return true;
  }

  playerBuildings(playerId) {
    const out = [];
    for (const b of this.buildings.values()) {
      if (this.belongsToFort(b, playerId)) out.push(b);
    }
    return out;
  }

  bulkUpgrade(playerId, buildType) {
    const p = this.players.get(playerId);
    if (!p || !buildType) return 0;
    let upgraded = 0;
    for (;;) {
      let did = false;
      const list = this.playerBuildings(playerId)
        .filter((b) => b.type === buildType && b.level < MAX_LEVEL)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const b of list) {
        if (this.upgradeBuilding(playerId, b.id, { quiet: true })) {
          upgraded++;
          did = true;
          break;
        }
      }
      if (!did) break;
    }
    if (upgraded > 0) {
      const label = BUILDINGS[buildType]?.name || buildType;
      this.toast(playerId, `${label}: покращено ×${upgraded}`);
    } else {
      this.toast(playerId, "Немає що покращити або не вистачає ресурсів");
    }
    return upgraded;
  }

  bulkSell(playerId, buildType) {
    const p = this.players.get(playerId);
    if (!p) return 0;
    const all = buildType === "*";
    const list = this.playerBuildings(playerId)
      .filter((b) => b.type !== "core" && (all || b.type === buildType))
      .sort((a, b) => a.id.localeCompare(b.id));
    let sold = 0;
    for (const b of list) {
      if (this.sellBuilding(playerId, b.id, { quiet: true })) sold++;
    }
    if (sold > 0) {
      const label = all ? "споруд" : BUILDINGS[buildType]?.name || buildType;
      this.toast(playerId, `Продано ${label}: ×${sold}`);
    } else {
      this.toast(playerId, "Немає споруд для продажу");
    }
    return sold;
  }

  exportPlayerBlueprint(playerId, name) {
    const list = this.playerBuildings(playerId);
    if (!list.length) return null;
    const core = this.playerCore(playerId);
    const ox = core ? core.tx : Math.round(list.reduce((s, b) => s + b.tx, 0) / list.length);
    const oy = core ? core.ty : Math.round(list.reduce((s, b) => s + b.ty, 0) / list.length);
    return {
      name: name || "Блупрінт",
      origin: { tx: ox, ty: oy },
      buildings: list.map((b) => ({
        type: b.type,
        tx: b.tx - ox,
        ty: b.ty - oy,
        rot: b.rot || 0,
        level: b.level || 1,
      })),
    };
  }

  pasteBlueprint(playerId, proto) {
    const p = this.players.get(playerId);
    if (!p || !proto?.buildings?.length) return { placed: 0, skipped: 0 };
    const core = this.playerCore(playerId);
    let ox;
    let oy;
    if (this.mode === "sandbox") {
      ox = Math.floor(p.x / TILE);
      oy = Math.floor(p.y / TILE);
    } else if (core) {
      ox = core.tx;
      oy = core.ty;
    } else {
      this.toast(playerId, "Спочатку поставте цитадель");
      return { placed: 0, skipped: 0 };
    }
    let placed = 0;
    let skipped = 0;
    const actor = p;
    for (const b of proto.buildings) {
      if (b.type === "core") {
        if (core || this.playerCore(playerId)) {
          skipped++;
          continue;
        }
      }
      const tx = ox + (b.tx | 0);
      const ty = oy + (b.ty | 0);
      const placedB = this.placeBuilding(actor, {
        type: b.type,
        tx,
        ty,
        rot: b.rot || 0,
        quiet: true,
        skipRange: true,
      });
      if (!placedB) {
        skipped++;
        continue;
      }
      if ((b.level || 1) > 1) {
        placedB.level = clamp(b.level, 1, MAX_LEVEL);
        this.applyLevel(placedB);
        placedB.hp = placedB.maxHp;
      }
      placed++;
    }
    if (placed > 0) {
      this.toast(playerId, `Вставлено споруд: ${placed}${skipped ? ` · пропущено ${skipped}` : ""}`);
    } else {
      this.toast(playerId, skipped ? "Не вдалося вставити (зайнято або поза зоною)" : "Блупрінт порожній");
    }
    return { placed, skipped };
  }

  createBuilding({ type, tx, ty, rot, ownerId, team, level = 1, id, hp, produceAcc, harvestTargetId, restore = false }) {
    const def = BUILDINGS[type];
    if (!def) return null;
    const fortId = team || ownerId;
    ownerId = ownerId || fortId;
    team = team || fortId;
    const fp = buildingFootprint(type, tx, ty, rot);
    if (this.footprintBlocked(fp, null)) return null;
    const rect = footprintRect(fp);
    const lvl = clamp(level || 1, 1, MAX_LEVEL);
    const maxHp = buildingMaxHp(def, lvl);
    const b = {
      id: id || nid("b"),
      type,
      tx: fp.tx,
      ty: fp.ty,
      w: fp.w,
      h: fp.h,
      rot: rot || 0,
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      level: lvl,
      hp: hp == null ? maxHp : Math.max(1, Math.min(maxHp, hp)),
      maxHp,
      ownerId,
      team,
      cooldown: 0,
      produceAcc: produceAcc || 0,
      harvestTargetId: harvestTargetId || null,
    };
    this.buildings.set(b.id, b);
    this.markFootprint(fp, b.id);
    this.clearNodesUnder([b]);
    if (!restore) {
      this.ejectUnitsFromFootprint(fp);
    }
    return b;
  }

  invalidateKeepsCache() {
    this._keeps = null;
    this._keepTick = -1;
  }

  rebuildOccupancy() {
    this.occupancy.clear();
    for (const b of this.buildings.values()) {
      this.syncBuildingFootprint(b);
      this.markFootprint({ tx: b.tx, ty: b.ty, w: b.w, h: b.h }, b.id);
    }
    this.invalidateKeepsCache();
  }

  /** Підганяє w/h і центр споруди під поточні defs (legacy save). */
  syncBuildingFootprint(b) {
    const def = BUILDINGS[b.type];
    if (!def) return false;
    const fp = buildingFootprint(b.type, b.tx, b.ty, b.rot || 0);
    let changed = false;
    if (b.w !== fp.w || b.h !== fp.h) {
      b.w = fp.w;
      b.h = fp.h;
      changed = true;
    }
    const rect = footprintRect(fp);
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    if (Math.abs(b.x - cx) > 0.01 || Math.abs(b.y - cy) > 0.01) {
      b.x = cx;
      b.y = cy;
      changed = true;
    }
    return changed;
  }

  /**
   * Знаходить «фантомні» клітини (зайняті, але без споруди або поза її footprint).
   * Повертає кількість виправлень; при конфлікті перекриття — повний rebuild.
   */
  repairOccupancyIntegrity() {
    let fixes = 0;
    for (const [key, bid] of [...this.occupancy.entries()]) {
      const b = this.buildings.get(bid);
      if (!b) {
        this.occupancy.delete(key);
        fixes++;
        continue;
      }
      const tx = Number(key.split(",")[0]);
      const ty = Number(key.split(",")[1]);
      if (tx < b.tx || ty < b.ty || tx >= b.tx + b.w || ty >= b.ty + b.h) {
        this.occupancy.delete(key);
        fixes++;
      }
    }
    for (const b of this.buildings.values()) {
      if (!BUILDINGS[b.type]) continue;
      if (this.syncBuildingFootprint(b)) fixes++;
      const fp = { tx: b.tx, ty: b.ty, w: b.w, h: b.h };
      for (let x = fp.tx; x < fp.tx + fp.w; x++) {
        for (let y = fp.ty; y < fp.ty + fp.h; y++) {
          const k = `${x},${y}`;
          const occ = this.occupancy.get(k);
          if (occ === b.id) continue;
          if (occ && this.buildings.has(occ)) {
            this.rebuildOccupancy();
            return fixes + 1;
          }
          this.occupancy.set(k, b.id);
          fixes++;
        }
      }
    }
    if (fixes) this.invalidateKeepsCache();
    return fixes;
  }

  purgeOccupancyAt(tx, ty) {
    const key = `${tx},${ty}`;
    const bid = this.occupancy.get(key);
    if (!bid) return false;
    const b = this.buildings.get(bid);
    if (!b) {
      this.occupancy.delete(key);
      return true;
    }
    if (tx < b.tx || ty < b.ty || tx >= b.tx + b.w || ty >= b.ty + b.h) {
      this.occupancy.delete(key);
      return true;
    }
    return false;
  }

  markFootprint(fp, buildingId) {
    for (let x = fp.tx; x < fp.tx + fp.w; x++) {
      for (let y = fp.ty; y < fp.ty + fp.h; y++) {
        this.occupancy.set(`${x},${y}`, buildingId);
      }
    }
  }

  unmarkFootprint(b) {
    for (let x = b.tx; x < b.tx + b.w; x++) {
      for (let y = b.ty; y < b.ty + b.h; y++) {
        const k = `${x},${y}`;
        if (this.occupancy.get(k) === b.id) this.occupancy.delete(k);
      }
    }
  }

  occupiedKey(tx, ty) {
    if (this.purgeOccupancyAt(tx, ty)) return false;
    return this.occupancy.has(`${tx},${ty}`);
  }

  footprintBlocked(fp, ignoreId) {
    for (let x = fp.tx; x < fp.tx + fp.w; x++) {
      for (let y = fp.ty; y < fp.ty + fp.h; y++) {
        const key = `${x},${y}`;
        const occ = this.occupancy.get(key);
        if (!occ || occ === ignoreId) continue;
        const ob = this.buildings.get(occ);
        if (!ob) {
          this.occupancy.delete(key);
          continue;
        }
        if (x < ob.tx || y < ob.ty || x >= ob.tx + ob.w || y >= ob.ty + ob.h) {
          this.occupancy.delete(key);
          continue;
        }
        return true;
      }
    }
    return false;
  }

  keepsList() {
    if (this._keepTick === this.tick && this._keeps) return this._keeps;
    const keeps = [];
    for (const core of this.buildings.values()) {
      if (core.type !== "core") continue;
      let pad = coreZonePad(core.level || 1);
      if (this.factions.get(core.team)?.npc) {
        pad = Math.max(pad, NPC_FACTION.keepTiles);
      }
      keeps.push({
        team: core.team,
        tx: core.tx - pad,
        ty: core.ty - pad,
        tx1: core.tx + core.w - 1 + pad,
        ty1: core.ty + core.h - 1 + pad,
        level: core.level || 1,
      });
    }
    this._keepTick = this.tick;
    this._keeps = keeps;
    return keeps;
  }

  footprintInKeep(fp, keep) {
    return fp.tx >= keep.tx
      && fp.ty >= keep.ty
      && fp.tx + fp.w - 1 <= keep.tx1
      && fp.ty + fp.h - 1 <= keep.ty1;
  }

  worldInKeep(x, y, keep) {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    return tx >= keep.tx && ty >= keep.ty && tx <= keep.tx1 && ty <= keep.ty1;
  }

  keepFor(b) {
    for (const keep of this.keepsList()) {
      if (keep.team !== b.team) continue;
      if (this.worldInKeep(b.x, b.y, keep)) return keep;
    }
    return null;
  }

  insideEnemyKeep(fp, team) {
    for (const keep of this.keepsList()) {
      if (keep.team === team) continue;
      if (this.footprintInKeep(fp, keep)) return true;
    }
    return false;
  }

  buildingAtWorld(x, y) {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (this.purgeOccupancyAt(tx, ty)) return null;
    const id = this.occupancy.get(`${tx},${ty}`);
    return id ? this.buildings.get(id) : null;
  }

  destroyBuilding(b, dropLoot, fromFortCascade = false) {
    const isCore = b.type === "core";
    const team = b.team;
    this.unmarkFootprint(b);
    this.buildings.delete(b.id);
    this.releaseNodesUnder(b);
    this.events.push({ t: "boom", x: b.x, y: b.y });
    if (dropLoot) {
      const cost = BUILDINGS[b.type].cost || {};
      for (const [res, amt] of Object.entries(cost)) {
        if (amt > 0) this.spawnLoot(b.x + rand(-10, 10), b.y + rand(-10, 10), res, Math.max(1, Math.floor(amt * 0.35)));
      }
    }
    if (isCore && !fromFortCascade) {
      const fortId = b.ownerId || b.team;
      const spillOrigin = { x: b.x, y: b.y, ownerId: b.ownerId, team: b.team };
      this.destroySettlement(fortId, { spillOrigin, fortHint: b });
      this.events.push({
        t: "fort_down",
        x: b.x,
        y: b.y,
        team: fortId,
        playerId: b.ownerId || fortId,
      });
    }
  }

  harvestSink(ownerId) {
    const owner = this.ownerActor(ownerId);
    if (!owner) return null;
    if (this.factions.get(ownerId)?.npc) return owner;
    if (this.playerCore(ownerId)) {
      const live = this.players.get(ownerId);
      if (live) return { stock: this.ensureTreasury(live) };
      if (owner.treasury) return { stock: emptyStock(owner.treasury) };
    }
    return owner;
  }

  damageBuilding(b, dmg, fromTeam, killer = null) {
    if (fromTeam === "__monster__") {
      if (!this.isHumanSide(b.team)) return;
    } else if (b.team === fromTeam) return;
    b.hp -= dmg;
    const fac = this.factions.get(b.team);
    if (fac?.npc) fac.threat = Math.min(1, (fac.threat || 0) + dmg / 90);
    if (!this._silent) this.events.push({ t: "chips", x: b.x, y: b.y, kind: "rock" });
    if (b.hp <= 0) {
      const isCore = b.type === "core";
      if (killer) {
        if (isCore) {
          this.awardCoins(killer, this.fortWipeCoinReward(b));
          this.awardFortBuildingValue(killer, b);
        } else {
          this.awardCoins(killer, this.buildingBounty(b));
        }
      }
      this.destroyBuilding(b, !isCore);
    }
  }

  buildingBounty(b) {
    const cost = BUILDINGS[b.type]?.cost || {};
    const sum = Object.values(cost).reduce((s, v) => s + v, 0);
    return Math.max(1, Math.ceil(sum / 18));
  }

  fortWipeCoinReward(core) {
    if (!core || core.type !== "core") return 0;
    const fortId = core.ownerId || core.team;
    let sum = 0;
    for (const x of this.buildingsOf(fortId, core)) sum += this.buildingBounty(x);
    const extra = Math.max(
      FORT_WIPE.coinBonusFlat,
      Math.round(sum * Math.max(0, FORT_WIPE.coinBonusMult - 1))
    );
    return sum + extra;
  }

  awardCoins(killer, amount) {
    if (!killer || amount <= 0) return;
    killer.coins = capCoins((killer.coins || 0) + amount);
    const acc = this.accounts.get(killer.id);
    if (acc) acc.coins = killer.coins;
  }

  /** Ресурси за знесений форт — сума sellValue усіх споруд (дерево, камінь, золото). */
  awardFortBuildingValue(killer, core) {
    if (!killer?.stock || !core || core.type !== "core") return;
    const fortId = core.ownerId || core.team;
    const totals = emptyStock();
    for (const b of this.buildingsOf(fortId, core)) {
      const def = BUILDINGS[b.type];
      if (!def) continue;
      const val = sellValue(def, b.level || 1);
      for (const [k, v] of Object.entries(val)) {
        if (v > 0) totals[k] = (totals[k] || 0) + v;
      }
    }
    let any = false;
    for (const k of ["wood", "stone", "gold"]) {
      const n = totals[k] || 0;
      if (n <= 0) continue;
      addResource(killer.stock, k, n);
      any = true;
    }
    if (any && killer.id && this.players.has(killer.id)) {
      const acc = this.accounts.get(killer.id);
      if (acc) acc.stock = { ...killer.stock };
      this.events.push({ t: "fort_loot", x: core.x, y: core.y, playerId: killer.id });
    }
  }

  fortWallet(teamId) {
    if (!teamId) return null;
    const fac = this.factions.get(teamId);
    if (fac?.npc) return this.ensureFaction(fac).stock;
    if (!this.playerCore(teamId) && !this.factionCore(teamId)) return null;
    const live = this.players.get(teamId) || this.bots.get(teamId);
    if (live) return this.ensureTreasury(live);
    const acc = this.accounts.get(teamId);
    if (acc?.treasury) return emptyStock(acc.treasury);
    return null;
  }

  persistFortWallet(teamId, wallet) {
    if (!wallet) return;
    const acc = this.accounts.get(teamId);
    if (acc) acc.treasury = emptyStock(wallet);
    const p = this.players.get(teamId);
    if (p) p.treasury = emptyStock(wallet);
    const bot = this.bots.get(teamId);
    if (bot) bot.treasury = emptyStock(wallet);
    const fac = this.factions.get(teamId);
    if (fac?.npc) fac.stock = emptyStock(wallet);
  }

  buildingInFortZone(b) {
    const core = this.playerCore(b.team) || this.factionCore(b.team);
    if (!core) return false;
    const keep = this.keepForCore(core);
    const fp = { tx: b.tx, ty: b.ty, w: b.w, h: b.h };
    return this.footprintInKeep(fp, keep);
  }

  stepBuildingRegen() {
    if (this.mode === "sandbox") {
      for (const b of this.buildings.values()) {
        if (b.hp >= b.maxHp - 0.5) continue;
        b.hp = Math.min(b.maxHp, b.hp + BUILD_REGEN.sandboxHpPerSec * DT);
      }
      return;
    }
    const period = BUILD_REGEN.paidIntervalSec;
    for (const b of this.buildings.values()) {
      if (b.hp >= b.maxHp - 0.5) continue;
      if (!this.buildingInFortZone(b)) continue;

      b.hp = Math.min(b.maxHp, b.hp + BUILD_REGEN.passiveHpPerSec * DT);
      if (b.hp >= b.maxHp - 0.5) continue;

      b.regenAcc = (b.regenAcc || 0) + DT;
      if (b.regenAcc < period) continue;
      b.regenAcc -= period;

      const wallet = this.fortWallet(b.team);
      if (!wallet) continue;
      const def = BUILDINGS[b.type];
      if (!def) continue;

      const missing = b.maxHp - b.hp;
      const chunk = Math.min(BUILD_REGEN.paidHpPerTick, missing);
      const fullCost = repairCost(def, b.level || 1);
      const tickCost = {};
      for (const [k, v] of Object.entries(fullCost)) {
        tickCost[k] = Math.max(1, Math.ceil(v * (chunk / Math.max(missing, 1))));
      }
      if (!canAfford(wallet, tickCost, false)) continue;
      payCost(wallet, tickCost, false);
      b.hp = Math.min(b.maxHp, b.hp + chunk);
      this.persistFortWallet(b.team, wallet);
    }
  }

  stepBuildings() {
    for (const b of this.buildings.values()) {
      const def = BUILDINGS[b.type];
      const s = levelScale(b.level || 1);
      b.cooldown = Math.max(0, b.cooldown - DT);
      if (def.harvest) {
        b.produceAcc += DT;
        const period = harvestPeriod(def, b.level || 1);
        if (b.produceAcc >= period) {
          const hit = this.harvestWithBuilding(b, def);
          b.produceAcc = hit ? 0 : Math.max(0, period - 0.45);
        }
      }
      if (def.turret && b.cooldown <= 0) {
        const range = def.turret.range * (1 + ((b.level || 1) - 1) * 0.08);
        const t = this.findTarget(b, range);
        if (t) {
          const turret = {
            ...def.turret,
            damage: Math.round(def.turret.damage * s),
            cooldown: def.turret.cooldown / (1 + ((b.level || 1) - 1) * 0.06),
          };
          this.shoot(b, t, turret);
          b.cooldown = turret.cooldown;
        }
      }
    }
  }

  harvestWithBuilding(b, def) {
    const owner = this.harvestSink(b.ownerId);
    if (!owner?.stock) return false;
    const radius = harvestRadius(def, b.level || 1);
    const r2 = radius * radius;
    const want = def.harvest.resource;
    let target = b.harvestTargetId ? this.nodes.get(b.harvestTargetId) : null;
    const locked = target
      && target.alive
      && NODE_TYPES[target.kind]?.resource === want
      && dist2(b.x, b.y, target.x, target.y) <= r2;
    if (!locked) {
      target = this.pickHarvestTarget(b, def, radius);
      b.harvestTargetId = target?.id || null;
    }
    if (!target) return false;
    this.hitNode(target, harvestDamage(def, b.level || 1), owner);
    if (!target.alive) b.harvestTargetId = null;
    return true;
  }

  pickHarvestTarget(b, def, radius) {
    const r2 = radius * radius;
    const want = def.harvest.resource;
    let best = null;
    let bestD = r2;
    let bestId = "";
    for (const n of this.nodes.values()) {
      if (!n.alive) continue;
      if (NODE_TYPES[n.kind]?.resource !== want) continue;
      const d = dist2(b.x, b.y, n.x, n.y);
      if (d > r2) continue;
      if (!best || d < bestD || (d === bestD && n.id < bestId)) {
        best = n;
        bestD = d;
        bestId = n.id;
      }
    }
    return best;
  }

  findTarget(from, range) {
    const team = from.team;
    const r2 = range * range;
    let best = null;
    let bestD = r2;
    const considerUnit = (e) => {
      if (!e || e.team === team) return;
      if (e.alive === false) return;
      const d = dist2(from.x, from.y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    };
    for (const p of this.players.values()) if (p.alive) considerUnit(p);
    for (const bot of this.bots.values()) if (bot.alive) considerUnit(bot);
    for (const n of this.npcs.values()) considerUnit(n);
    for (const m of this.monsters.values()) considerUnit(m);
    if (best) return best;
    const shooterIsHuman = this.isHumanSide(team) || this.factions.get(team)?.npc;
    bestD = r2;
    for (const b of this.buildings.values()) {
      if (b.team === team) continue;
      const targetIsHuman = this.isHumanSide(b.team);
      if (!shooterIsHuman && !targetIsHuman) continue;
      if (this.factions.get(team)?.npc && !targetIsHuman) continue;
      const d = dist2(from.x, from.y, b.x, b.y);
      if (d >= r2) continue;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  shoot(from, target, turret) {
    const ang = Math.atan2(target.y - from.y, target.x - from.x);
    const sid = nid("s");
    this.projectiles.set(sid, {
      id: sid,
      x: from.x,
      y: from.y,
      vx: Math.cos(ang) * turret.speed,
      vy: Math.sin(ang) * turret.speed,
      dmg: turret.damage,
      team: from.team,
      color: turret.color,
      life: 1.4,
      r: turret.damage > 20 ? 5 : 3,
    });
  }

  stepProjectiles() {
    for (const [id, s] of this.projectiles) {
      s.x += s.vx * DT;
      s.y += s.vy * DT;
      s.life -= DT;
      if (s.life <= 0 || s.x < 0 || s.y < 0 || s.x > WORLD_SIZE || s.y > WORLD_SIZE) {
        this.projectiles.delete(id);
        continue;
      }
      let hit = false;
      for (const p of this.players.values()) {
        if (!p.alive || p.team === s.team) continue;
        if (dist2(s.x, s.y, p.x, p.y) < (p.radius + s.r) ** 2) {
          this.damagePlayer(p, s.dmg, s.team);
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const n of this.npcs.values()) {
          if (n.team === s.team) continue;
          if (dist2(s.x, s.y, n.x, n.y) < (n.radius + s.r) ** 2) {
            this.damageNpc(n, s.dmg, null);
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const bot of this.bots.values()) {
          if (!bot.alive || bot.team === s.team) continue;
          if (dist2(s.x, s.y, bot.x, bot.y) < (bot.radius + s.r) ** 2) {
            this.damageBot(bot, s.dmg, this.unitByTeam(s.team));
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const m of this.monsters.values()) {
          if (dist2(s.x, s.y, m.x, m.y) < (m.radius + s.r) ** 2) {
            this.damageMonster(m, s.dmg, this.unitByTeam(s.team));
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        for (const b of this.buildings.values()) {
          if (b.team === s.team) continue;
          if (circleHitsRect(s.x, s.y, s.r + 6, footprintRect(b))) {
            this.damageBuilding(b, s.dmg, s.team);
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        this.projectiles.delete(id);
        this.events.push({ t: "spark", x: s.x, y: s.y });
      }
    }
  }

  stepNpc(n) {
    n.cooldown = Math.max(0, n.cooldown - DT);
    if (!n.home) n.home = { cx: n.x, cy: n.y };
    this.ejectUnitIfBlocked(n);
    if (!n.role) n.role = "guard";
    if (n.role === "gather") this.stepNpcGather(n);
    else if (n.role === "builder" || n.role === "repair") this.stepNpcWork(n);
    else if (n.role === "hunt") this.stepNpcCombat(n, { hunt: true });
    else this.stepNpcCombat(n, { hunt: false });
    this.spikeContact(n);
  }

  stepNpcCombat(n, { hunt }) {
    const leash = hunt ? NPC_FACTION.huntLeash : NPC.leash;
    const homeD = Math.hypot(n.x - n.home.cx, n.y - n.home.cy);
    const unit = this.closestEnemy(n.x, n.y, hunt ? NPC_FACTION.huntLeash : NPC.aggro, n.team, { buildings: false });
    const building = (!unit || homeD < leash)
      ? this.closestEnemy(n.x, n.y, NPC_FACTION.attackBuilding, n.team, { buildings: true, units: false })
      : null;
    let target = unit;
    if (!target) target = building;
    let tx = n.home.cx;
    let ty = n.home.cy;
    if (target && (hunt || homeD < leash)) {
      tx = target.x;
      ty = target.y;
      this.tryNpcAttack(n, target);
    }
    this.steerNpc(n, tx, ty);
  }

  stepNpcGather(n) {
    const threat = this.closestEnemy(n.x, n.y, NPC_FACTION.gatherAggro, n.team, { buildings: false });
    if (threat) {
      this.stepNpcCombat(n, { hunt: false });
      return;
    }
    const faction = this.factions.get(n.team);
    const node = this.npcGatherNode(n);
    if (!node) {
      this.steerNpc(n, n.home.cx, n.home.cy);
      return;
    }
    const reach = NPC.radius + node.radius + 10;
    const d = Math.hypot(node.x - n.x, node.y - n.y);
    if (d <= reach) {
      n.aim = Math.atan2(node.y - n.y, node.x - n.x);
      if (n.cooldown <= 0 && faction?.stock) {
        this.hitNode(node, NPC.attackDmg, faction);
        n.cooldown = NPC.attackCooldown;
        this.events.push({ t: "hit", x: node.x, y: node.y });
        if (!node.alive) n.targetId = null;
      }
      return;
    }
    n.targetId = node.id;
    this.steerNpc(n, node.x, node.y);
  }

  npcGatherNode(n) {
    const locked = n.targetId ? this.nodes.get(n.targetId) : null;
    const want = n.gatherKind;
    if (locked?.alive && (!want || NODE_TYPES[locked.kind]?.resource === want)) return locked;
    const core = this.factionCore(n.team);
    const origin = core || n;
    const scan2 = NPC_FACTION.harvestScan * NPC_FACTION.harvestScan;
    let best = null;
    let bestD = scan2;
    for (const node of this.nodes.values()) {
      if (!node.alive) continue;
      if (want && NODE_TYPES[node.kind]?.resource !== want) continue;
      const d = dist2(origin.x, origin.y, node.x, node.y);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
    }
    n.targetId = best?.id || null;
    return best;
  }

  stepNpcWork(n) {
    const faction = this.factions.get(n.team);
    const job = faction?.job;
    if (!job) {
      this.steerNpc(n, n.home.cx, n.home.cy);
      return;
    }
    let tx = n.home.cx;
    let ty = n.home.cy;
    if (job.kind === "place") {
      tx = (job.tx + 0.5) * TILE;
      ty = (job.ty + 0.5) * TILE;
    } else {
      const b = this.buildings.get(job.id);
      if (!b) {
        faction.job = null;
        return;
      }
      tx = b.x;
      ty = b.y;
    }
    const d = this.steerNpc(n, tx, ty);
    const reach = job.kind === "place" ? NPC_FACTION.placeReach : 46;
    const timedOut = this.tick - (job.started || 0) > NPC_FACTION.jobTimeout / DT;
    if (d <= reach || timedOut) {
      const ok = this.executeFactionJob(faction);
      if (ok || timedOut) faction.job = null;
    }
  }

  tryNpcAttack(n, target) {
    if (n.cooldown > 0) return;
    if (target.kind === "player") {
      if (Math.hypot(target.x - n.x, target.y - n.y) > 36) return;
      this.damagePlayer(target, NPC.attackDmg, n.team);
      n.cooldown = NPC.attackCooldown;
      this.events.push({ t: "hit", x: target.x, y: target.y });
      return;
    }
    if (target.kind === "bot") {
      if (!target.alive || Math.hypot(target.x - n.x, target.y - n.y) > 36) return;
      this.damageBot(target, NPC.attackDmg, null);
      n.cooldown = NPC.attackCooldown;
      this.events.push({ t: "hit", x: target.x, y: target.y });
      return;
    }
    if (target.type && BUILDINGS[target.type]) {
      if (!circleHitsRect(n.x, n.y, 28, footprintRect(target))) return;
      this.damageBuilding(target, NPC.attackDmg, n.team);
      n.cooldown = NPC.attackCooldown;
      this.events.push({ t: "hit", x: target.x, y: target.y });
    }
  }

  steerNpc(n, tx, ty) {
    const dist = Math.hypot(tx - n.x, ty - n.y);
    if (dist < 18) return dist;
    const ang = Math.atan2(ty - n.y, tx - n.x);
    n.aim = ang;
    const speed = NPC.speed * DT;
    const ox = n.x;
    const oy = n.y;
    this.moveCircle(n, Math.cos(ang) * speed, Math.sin(ang) * speed);
    const moved = Math.hypot(n.x - ox, n.y - oy);
    if (moved < speed * 0.25) {
      const gate = this.nearestFriendlyGate(n);
      if (gate && dist2(n.x, n.y, gate.x, gate.y) > 22 * 22) {
        const g = Math.atan2(gate.y - n.y, gate.x - n.x);
        n.aim = g;
        this.moveCircle(n, Math.cos(g) * speed, Math.sin(g) * speed);
      }
    }
    return Math.hypot(tx - n.x, ty - n.y);
  }

  closestEnemy(x, y, range, team, opts = {}) {
    const wantUnits = opts.units !== false;
    const wantBuildings = !!opts.buildings;
    const r2 = range * range;
    let best = null;
    let bestD = r2;
    if (wantUnits) {
      for (const p of this.players.values()) {
        if (!p.alive || p.team === team || !this.isHumanSide(p.team)) continue;
        const d = dist2(x, y, p.x, p.y);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      for (const bot of this.bots.values()) {
        if (!bot.alive || bot.team === team) continue;
        const d = dist2(x, y, bot.x, bot.y);
        if (d < bestD) {
          bestD = d;
          best = bot;
        }
      }
    }
    if (best) return best;
    if (!wantBuildings) return null;
    bestD = r2;
    for (const b of this.buildings.values()) {
      if (b.team === team || !this.isHumanSide(b.team)) continue;
      const d = dist2(x, y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  damageNpc(n, dmg, killer) {
    const fac = this.factions.get(n.team);
    if (fac?.npc) fac.threat = Math.min(1, (fac.threat || 0) + 0.12);
    n.hp -= dmg;
    if (n.hp <= 0) {
      this.npcs.delete(n.id);
      this.spawnLoot(n.x, n.y, "gold", 2 + ((Math.random() * 3) | 0));
      if (killer) {
        killer.stock.gold = (killer.stock.gold || 0) + 1;
        killer.coins = capCoins((killer.coins || 0) + 3);
      }
      this.events.push({ t: "boom", x: n.x, y: n.y });
    }
  }

  unitByTeam(team) {
    if (!team) return null;
    return this.players.get(team) || this.bots.get(team) || null;
  }

  damageBot(bot, dmg, killer) {
    if (!bot?.alive) return;
    bot.hp -= dmg;
    if (bot.hp <= 0) {
      this.spawnLoot(bot.x, bot.y, "gold", 3 + ((Math.random() * 4) | 0));
      if (killer?.stock) addResource(killer.stock, "gold", 2);
      this.events.push({ t: "boom", x: bot.x, y: bot.y });
      this.killBot(bot);
    }
  }

  damagePlayer(p, dmg, fromTeam) {
    if (!p.alive || p.team === fromTeam) return;
    p.hp -= dmg * playerArmorMul(p.hero);
    if (p.hp <= 0) this.killPlayer(p);
  }

  killPlayer(p) {
    p.alive = false;
    p.hp = 0;
    p.respawnAt = this.tick * DT + PLAYER.respawnDelay;
    for (const res of ["wood", "stone", "gold"]) {
      const drop = Math.floor((p.stock[res] || 0) * 0.35);
      if (drop > 0) {
        p.stock[res] -= drop;
        this.spawnLoot(p.x + rand(-16, 16), p.y + rand(-16, 16), res, drop);
      }
    }
    p.lastDeathX = p.x;
    p.lastDeathY = p.y;
    this.events.push({ t: "death", x: p.x, y: p.y, name: p.name, playerId: p.id });
  }

  spawnLoot(x, y, resource, amount) {
    const l = {
      id: nid("l"),
      x,
      y,
      resource,
      amount,
      life: LOOT_DESPAWN_SEC,
    };
    this.loot.set(l.id, l);
  }

  stepLoot() {
    for (const [id, l] of this.loot) {
      l.life -= DT;
      if (l.life <= 0) this.loot.delete(id);
    }
  }

  pickupLoot(p) {
    for (const [id, l] of this.loot) {
      if (dist2(p.x, p.y, l.x, l.y) < 28 * 28) {
        addResource(p.stock, l.resource, l.amount);
        this.loot.delete(id);
      }
    }
  }

  spikeContact(unit) {
    const b = this.buildingAtWorld(unit.x, unit.y);
    if (!b || b.type !== "spikes" || b.team === unit.team) return;
    const def = BUILDINGS.spikes;
    const period = Math.max(1, Math.round(def.contact.every / DT));
    if (this.tick % period !== 0) return;
    if (unit._spikeHitTick === this.tick) return;
    unit._spikeHitTick = this.tick;
    const dmg = Math.round(def.contact.damage * levelScale(b.level || 1));
    if (unit.kind === "player") this.damagePlayer(unit, dmg, b.team);
    else if (unit.kind === "bot") this.damageBot(unit, dmg, null);
    else if (unit.kind === "monster") this.damageMonster(unit, dmg, null);
    else this.damageNpc(unit, dmg, null);
    this.events.push({ t: "spark", x: unit.x, y: unit.y });
  }

  stepNodes() {
    for (const n of this.nodes.values()) {
      if (n.alive) {
        this.suppressNodeIfUnderBuilding(n);
        continue;
      }
      if (this.tick < n.respawnAt) continue;
      const spot = this.canSpawnNodeAt(n.tx, n.ty, n.id)
        ? { tx: n.tx, ty: n.ty }
        : this.findEmptyNodeTile(n.tx, n.ty);
      if (spot) {
        this.placeNodeOnTile(n, spot.tx, spot.ty);
        n.alive = true;
        n.hp = n.maxHp;
      } else {
        n.respawnAt = this.tick + 40;
      }
    }
  }

  ejectUnitsFromFootprint(fp) {
    const rect = footprintRect(fp);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (circleHitsRect(p.x, p.y, p.radius, rect)) this.ejectUnitIfBlocked(p);
    }
    for (const n of this.npcs.values()) {
      if (circleHitsRect(n.x, n.y, n.radius, rect)) this.ejectUnitIfBlocked(n);
    }
  }

  ejectUnitIfBlocked(unit) {
    const r = unit.radius;
    if (!this.blockedCircle(unit.x, unit.y, r, unit)) return false;
    const sx = unit.x;
    const sy = unit.y;
    let best = null;
    let bestD = Infinity;
    for (let ring = 1; ring <= 14; ring++) {
      const dist = ring * (TILE * 0.65);
      const steps = 10 + ring * 2;
      for (let i = 0; i < steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        const nx = clamp(sx + Math.cos(ang) * dist, r + 8, WORLD_SIZE - r - 8);
        const ny = clamp(sy + Math.sin(ang) * dist, r + 8, WORLD_SIZE - r - 8);
        if (this.blockedCircle(nx, ny, r, unit)) continue;
        const d = dist2(sx, sy, nx, ny);
        if (d < bestD) {
          bestD = d;
          best = { x: nx, y: ny };
        }
      }
      if (best) break;
    }
    if (best) {
      unit.x = best.x;
      unit.y = best.y;
      return true;
    }
    for (let i = 0; i < 48; i++) {
      const nx = clamp(sx + rand(-240, 240), r + 8, WORLD_SIZE - r - 8);
      const ny = clamp(sy + rand(-240, 240), r + 8, WORLD_SIZE - r - 8);
      if (!this.blockedCircle(nx, ny, r, unit)) {
        unit.x = nx;
        unit.y = ny;
        return true;
      }
    }
    return false;
  }

  moveCircle(unit, dx, dy) {
    const tryMove = (mx, my) => {
      const nx = clamp(unit.x + mx, unit.radius + 8, WORLD_SIZE - unit.radius - 8);
      const ny = clamp(unit.y + my, unit.radius + 8, WORLD_SIZE - unit.radius - 8);
      if (!this.blockedCircle(nx, ny, unit.radius, unit)) {
        unit.x = nx;
        unit.y = ny;
        return true;
      }
      return false;
    };
    if (!tryMove(dx, dy)) {
      if (!tryMove(dx, 0)) tryMove(0, dy);
    }
  }

  blockedCircle(x, y, r, self) {
    const t0x = Math.floor((x - r) / TILE);
    const t0y = Math.floor((y - r) / TILE);
    const t1x = Math.floor((x + r) / TILE);
    const t1y = Math.floor((y + r) / TILE);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let ty = t0y; ty <= t1y; ty++) {
        if (this.purgeOccupancyAt(tx, ty)) continue;
        const bid = this.occupancy.get(`${tx},${ty}`);
        if (!bid) continue;
        const b = this.buildings.get(bid);
        if (!b) continue;
        if (b.type === "gate" && self && b.team === self.team) continue;
        if (b.type === "spikes") continue;
        const rect = { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
        if (circleHitsRect(x, y, r, rect)) return true;
      }
    }
    return false;
  }

  damageMonster(m, dmg, killer) {
    if (!m) return;
    m.hp -= dmg;
    if (m.hp <= 0) {
      const lootAmt =
        MONSTER.goldLootMin
        + ((Math.random() * (MONSTER.goldLootMax - MONSTER.goldLootMin + 1)) | 0);
      this.spawnLoot(m.x, m.y, "gold", lootAmt);
      if (killer?.stock) {
        addResource(killer.stock, "gold", MONSTER.goldOnKill || 0);
        if (MONSTER.coinBonus > 0) this.awardCoins(killer, MONSTER.coinBonus);
        const acc = this.accounts.get(killer.id);
        if (acc) acc.stock = { ...killer.stock };
      }
      this.events.push({ t: "boom", x: m.x, y: m.y });
      this.events.push({ t: "gather", resource: "gold", x: m.x, y: m.y });
      this.monsters.delete(m.id);
    }
  }

  toast(playerId, text) {
    this.events.push({ t: "toast", playerId, text });
  }

  snapshotFor(player) {
    const r2 = AOI_RADIUS * AOI_RADIUS;
    const near = (e) => dist2(player.x, player.y, e.x, e.y) < r2;
    const buildings = [];
    for (const b of this.buildings.values()) if (near(b)) buildings.push(this.packBuilding(b));
    const nodes = [];
    for (const n of this.nodes.values()) if (n.alive && near(n)) nodes.push(this.packNode(n));
    const units = [];
    for (const p of this.players.values()) if (p.alive && near(p)) units.push(this.packUnit(p));
    for (const b of this.bots.values()) if (b.alive && near(b)) units.push(this.packUnit(b));
    for (const m of this.monsters.values()) if (near(m)) units.push(this.packUnit(m));
    for (const n of this.npcs.values()) if (near(n)) units.push(this.packUnit(n));
    const projectiles = [];
    for (const s of this.projectiles.values()) if (near(s)) {
      projectiles.push({ id: s.id, x: s.x, y: s.y, r: s.r, color: s.color });
    }
    const loot = [];
    for (const l of this.loot.values()) if (near(l)) {
      loot.push({ id: l.id, x: l.x, y: l.y, resource: l.resource, amount: l.amount });
    }
    const core = this.playerCore(player.id);
    const treasury = this.ensureTreasury(player);
    const inVault = !!core && dist2(player.x, player.y, core.x, core.y) <= CORE.depositRadius ** 2;
    return {
      tick: this.tick,
      you: {
        id: player.id,
        x: player.x,
        y: player.y,
        aim: player.aim,
        hp: player.hp,
        maxHp: player.maxHp,
        alive: player.alive,
        stock: player.stock,
        treasury,
        hasCore: !!core,
        coreLevel: core?.level || 0,
        inVault,
        respawnGold: CORE.respawnGold,
        coins: player.coins || 0,
        hero: parseHero(player.hero),
        selected: player.selected,
        rot: player.rot,
        respawnIn: player.alive ? 0 : Math.max(0, player.respawnAt - this.tick * DT),
        lastDeath:
          player.lastDeathX != null && player.lastDeathY != null
            ? { x: player.lastDeathX, y: player.lastDeathY }
            : null,
      },
      buildings,
      keeps: this.keepsList(),
      nodes,
      units,
      projectiles,
      loot,
      events: this.events.filter((e) => e.playerId === undefined || e.playerId === player.id),
    };
  }

  packBuilding(b) {
    return {
      id: b.id,
      type: b.type,
      tx: b.tx,
      ty: b.ty,
      w: b.w,
      h: b.h,
      rot: b.rot,
      x: b.x,
      y: b.y,
      hp: b.hp,
      maxHp: b.maxHp,
      team: b.team,
      ownerId: b.ownerId,
      level: b.level || 1,
      harvestTargetId: b.harvestTargetId || null,
    };
  }

  packNode(n) {
    return {
      id: n.id,
      kind: n.kind,
      x: n.x,
      y: n.y,
      hp: n.hp,
      maxHp: n.maxHp,
    };
  }

  packUnit(u) {
    return {
      id: u.id,
      kind: u.kind,
      name: u.name || "",
      x: u.x,
      y: u.y,
      aim: u.aim,
      hp: u.hp,
      maxHp: u.maxHp,
      color: u.color,
      team: u.team,
      r: u.radius,
    };
  }

  minimap() {
    const cores = [];
    for (const b of this.buildings.values()) {
      if (b.type === "core") cores.push({ x: b.x, y: b.y, team: b.team, npc: !!this.factions.get(b.team)?.npc });
    }
    return cores;
  }

  exportPrototype(name) {
    const buildings = [...this.buildings.values()];
    if (!buildings.length) return null;
    const core = buildings.find((b) => b.type === "core");
    const ox = core ? core.tx : Math.round(buildings.reduce((s, b) => s + b.tx, 0) / buildings.length);
    const oy = core ? core.ty : Math.round(buildings.reduce((s, b) => s + b.ty, 0) / buildings.length);
    return {
      name: name || "Прототип",
      origin: { tx: ox, ty: oy },
      buildings: buildings.map((b) => ({
        type: b.type,
        tx: b.tx - ox,
        ty: b.ty - oy,
        rot: b.rot,
        level: b.level || 1,
      })),
    };
  }

  loadPrototype(proto, atPlayer) {
    for (const b of [...this.buildings.values()]) this.destroyBuilding(b, false);
    const ox = Math.floor(atPlayer.x / TILE);
    const oy = Math.floor(atPlayer.y / TILE);
    for (const b of proto.buildings) {
      this.createBuilding({
        type: b.type,
        tx: ox + b.tx,
        ty: oy + b.ty,
        rot: b.rot || 0,
        ownerId: atPlayer.id,
        team: atPlayer.team,
        level: b.level || 1,
      });
    }
  }

  clearBuildings() {
    for (const b of [...this.buildings.values()]) this.destroyBuilding(b, false);
  }

  catchUp(seconds) {
    if (!(seconds > 1)) return;
    const cap = 30 * 60;
    const ticks = Math.min(Math.floor(seconds / DT), cap * (1 / DT));
    this._silent = true;
    const brainEvery = Math.max(1, Math.round(1 / DT));
    for (let i = 0; i < ticks; i++) {
      this.tick++;
      this.events = [];
      this.stepBuildings();
      this.stepNodes();
      if (i % brainEvery === 0) this.brain.step({ force: true, economyOnly: true });
    }
    this._silent = false;
    this.events = [];
  }

  serialize() {
    for (const p of this.players.values()) this.stashPlayer(p);
    return {
      tick: this.tick,
      seq: peekSeq(),
      savedAt: Date.now(),
      accounts: [...this.accounts.values()].filter((a) => !a.isBot).map((a) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        wood: a.stock.wood | 0,
        stone: a.stock.stone | 0,
        gold: a.stock.gold | 0,
        tWood: (a.treasury?.wood ?? 0) | 0,
        tStone: (a.treasury?.stone ?? 0) | 0,
        tGold: (a.treasury?.gold ?? 0) | 0,
        coins: a.coins | 0,
        hero: JSON.stringify(parseHero(a.hero)),
        x: a.x,
        y: a.y,
        hp: a.hp,
        lastSeen: a.lastSeen || Date.now(),
        lastDeathX: a.lastDeathX ?? null,
        lastDeathY: a.lastDeathY ?? null,
        passHash: a.passHash || "",
        isBot: a.isBot ? 1 : 0,
      })),
      monsters: [...this.monsters.values()].map((m) => ({
        id: m.id,
        x: m.x,
        y: m.y,
        hp: m.hp,
      })),
      bots: [...this.bots.values()].map((b) => ({
        id: b.id,
        name: b.name,
        color: b.color,
        x: b.x,
        y: b.y,
        hp: b.hp,
        stock: { ...b.stock },
        treasury: emptyStock(b.treasury),
        buildPlan: b.buildPlan ? JSON.stringify(b.buildPlan) : "",
      })),
      buildings: [...this.buildings.values()].map((b) => ({
        id: b.id,
        type: b.type,
        tx: b.tx,
        ty: b.ty,
        rot: b.rot || 0,
        level: b.level || 1,
        hp: b.hp,
        ownerId: b.ownerId,
        team: b.team,
        produceAcc: b.produceAcc || 0,
        harvestTargetId: b.harvestTargetId || null,
      })),
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id,
        kind: n.kind,
        tx: n.tx,
        ty: n.ty,
        hp: n.hp,
        alive: n.alive ? 1 : 0,
        respawnAt: n.respawnAt || 0,
      })),
      factions: [...this.factions.values()].map((f) => {
        this.ensureFaction(f);
        return {
          id: f.id,
          name: f.name,
          npc: f.npc ? 1 : 0,
          color: f.color,
          core: f.core || null,
          wood: f.stock.wood | 0,
          stone: f.stock.stone | 0,
          gold: f.stock.gold | 0,
          threat: f.threat || 0,
          recruitAt: f.recruitAt || 0,
          desire: f.desire || "",
          job: f.job ? JSON.stringify(f.job) : "",
        };
      }),
      npcs: [...this.npcs.values()].map((n) => ({
        id: n.id,
        team: n.team,
        x: n.x,
        y: n.y,
        hp: n.hp,
        homeX: n.home?.cx ?? n.x,
        homeY: n.home?.cy ?? n.y,
        color: n.color,
        role: n.role || "guard",
        gatherKind: n.gatherKind || "",
      })),
    };
  }

  hydrate(snap) {
    if (!snap) return false;
    setSeq(snap.seq || 1);
    this.tick = snap.tick || 0;
    this.buildings.clear();
    this.nodes.clear();
    this.npcs.clear();
    this.factions.clear();
    this.occupancy.clear();
    this.accounts.clear();
    this.loot.clear();
    this.projectiles.clear();
    this.monsters.clear();
    this.bots.clear();
    for (const f of snap.factions || []) {
      let job = null;
      if (f.job) {
        try { job = typeof f.job === "string" ? JSON.parse(f.job) : f.job; } catch { job = null; }
      }
      const faction = {
        id: f.id,
        name: f.name,
        npc: !!f.npc,
        color: f.color,
        core: f.core || null,
        stock: emptyStock({
          wood: f.wood ?? NPC_FACTION.startStock.wood,
          stone: f.stone ?? NPC_FACTION.startStock.stone,
          gold: f.gold ?? NPC_FACTION.startStock.gold,
        }),
        threat: Number(f.threat) || 0,
        recruitAt: Number(f.recruitAt) || 0,
        desire: f.desire || "economy",
        job,
      };
      if (f.wood == null && f.stone == null && f.gold == null) {
        faction.stock = emptyStock(NPC_FACTION.startStock);
      }
      this.factions.set(f.id, this.ensureFaction(faction));
    }
    for (const b of snap.buildings || []) {
      const ownerId = b.ownerId || b.team;
      const team = b.team || b.ownerId;
      this.createBuilding({
        id: b.id,
        type: b.type,
        tx: b.tx,
        ty: b.ty,
        rot: b.rot,
        ownerId: ownerId || team,
        team: team || ownerId,
        level: b.level,
        hp: b.hp,
        produceAcc: b.produceAcc,
        harvestTargetId: b.harvestTargetId,
        restore: true,
      });
    }
    this.rebuildOccupancy();
    for (const n of snap.nodes || []) {
      this.spawnNode(n.kind, n.tx, n.ty, n);
    }
    this.sanitizeAliveNodesVsBuildings();
    for (const n of snap.npcs || []) {
      this.spawnNpc(n.team, n.x, n.y, { cx: n.homeX, cy: n.homeY }, n);
    }
    for (const a of snap.accounts || []) {
      if (a.isBot) continue;
      this.accounts.set(a.id, {
        id: a.id,
        name: a.name,
        color: a.color,
        stock: { wood: a.wood | 0, stone: a.stone | 0, gold: a.gold | 0 },
        treasury: emptyStock({
          wood: a.tWood ?? 0,
          stone: a.tStone ?? 0,
          gold: a.tGold ?? 0,
        }),
        coins: a.coins | 0,
        hero: parseHero(a.hero),
        x: a.x,
        y: a.y,
        hp: a.hp,
        lastSeen: a.lastSeen,
        lastDeathX: a.lastDeathX ?? null,
        lastDeathY: a.lastDeathY ?? null,
        passHash: a.passHash || "",
        isBot: false,
      });
    }
    for (const m of snap.monsters || []) {
      this.monsters.set(m.id, {
        id: m.id,
        kind: "monster",
        x: m.x,
        y: m.y,
        hp: m.hp ?? MONSTER.hp,
        maxHp: MONSTER.hp,
        radius: MONSTER.radius,
        aim: 0,
        cooldown: 0,
        color: "#4d6644",
        name: "",
      });
    }
    for (const b of snap.bots || []) {
      let buildPlan = null;
      if (b.buildPlan) {
        try { buildPlan = typeof b.buildPlan === "string" ? JSON.parse(b.buildPlan) : b.buildPlan; } catch { buildPlan = null; }
      }
      const acc = {
        id: b.id,
        name: b.name,
        isBot: true,
        color: b.color,
        stock: emptyStock(b.stock),
        treasury: emptyStock(b.treasury),
        coins: 0,
        hero: emptyHero(),
        x: b.x,
        y: b.y,
        hp: b.hp,
        lastSeen: Date.now(),
      };
      this.accounts.set(b.id, acc);
      this.bots.set(b.id, {
        id: b.id,
        kind: "bot",
        name: b.name,
        team: b.id,
        x: b.x,
        y: b.y,
        aim: 0,
        hp: b.hp ?? PLAYER.hp,
        maxHp: PLAYER.hp,
        radius: PLAYER.radius,
        cooldown: 0,
        color: b.color,
        stock: acc.stock,
        treasury: acc.treasury,
        buildPlan,
        alive: true,
      });
    }
    let maxSeq = snap.seq || 1;
    const bump = (id) => {
      const n = parseInt(String(id).split("_").pop() || "0", 36);
      if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n + 1);
    };
    for (const id of this.buildings.keys()) bump(id);
    for (const id of this.nodes.keys()) bump(id);
    for (const id of this.npcs.keys()) bump(id);
    for (const id of this.accounts.keys()) bump(id);
    for (const id of this.monsters.keys()) bump(id);
    for (const id of this.bots.keys()) bump(id);
    setSeq(maxSeq);
    return true;
  }
}
