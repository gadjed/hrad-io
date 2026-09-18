import {
  TILE,
  WORLD_TILES,
  WORLD_SIZE,
  DT,
  AOI_RADIUS,
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
} from "../shared/defs.mjs";

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
  }

  generate() {
    this.scatterNodes();
    if (this.mode === "world") this.stampNpcKeeps();
  }

  scatterNodes() {
    const counts = { tree: 980, rock: 520, goldvein: 160 };
    for (const [kind, n] of Object.entries(counts)) {
      let placed = 0;
      let guard = 0;
      while (placed < n && guard++ < n * 8) {
        const tx = 2 + ((Math.random() * (WORLD_TILES - 4)) | 0);
        const ty = 2 + ((Math.random() * (WORLD_TILES - 4)) | 0);
        if (this.occupiedKey(tx, ty)) continue;
        if (this.nodeAt(tx, ty)) continue;
        this.spawnNode(kind, tx, ty);
        placed++;
      }
    }
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
    const list = this.prototypes.all();
    if (!list.length) return;
    const attempts = 14;
    let placed = 0;
    for (let i = 0; i < attempts; i++) {
      const proto = list[i % list.length];
      const margin = 16;
      const tx = margin + ((Math.random() * (WORLD_TILES - margin * 2)) | 0);
      const ty = margin + ((Math.random() * (WORLD_TILES - margin * 2)) | 0);
      if (!this.canStamp(proto, tx, ty)) continue;
      this.stampPrototype(proto, tx, ty, `npc_${placed}`);
      placed++;
      if (placed >= 10) break;
    }
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
    this.factions.set(factionId, {
      id: factionId,
      name: proto.name,
      npc: true,
      color,
      core: null,
    });
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
      if (building) created.push(building);
    }
    const core = created.find((b) => b.type === "core") || created[0];
    if (core) this.factions.get(factionId).core = core.id;
    const towers = created.filter((b) => BUILDINGS[b.type].turret).length;
    const guards = 2 + towers;
    const cx = core ? core.x : ox * TILE;
    const cy = core ? core.y : oy * TILE;
    for (let i = 0; i < guards; i++) {
      this.spawnNpc(factionId, cx + rand(-80, 80), cy + rand(-80, 80), { cx, cy });
    }
    this.clearNodesUnder(created);
    return created;
  }

  clearNodesUnder(buildings) {
    for (const b of buildings) {
      const rect = footprintRect(b);
      for (const n of this.nodes.values()) {
        if (!n.alive) continue;
        if (n.x >= rect.x && n.x <= rect.x + rect.w && n.y >= rect.y && n.y <= rect.y + rect.h) {
          n.alive = false;
          n.respawnAt = this.tick + 999999;
        }
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
      color: saved?.color || this.factions.get(team)?.color || "#c4453c",
    };
    this.npcs.set(npc.id, npc);
    return npc;
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
      coins: acc.coins || 0,
      hero: parseHero(acc.hero),
      selected: null,
      rot: 0,
      alive: acc.hp > 0,
      respawnAt: 0,
      input: { mx: 0, my: 0, ax: 1, ay: 0, harvest: false, place: false },
      sandbox: false,
    };
    if (!player.alive) player.respawnAt = this.tick * DT;
    acc.hero = player.hero;
    acc.coins = player.coins;
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
    if (level >= HERO.maxLevel) {
      this.toast(p.id, "Максимум");
      return;
    }
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
      acc = { id: p.id, stock: p.stock, color: p.color, name: p.name };
      this.accounts.set(p.id, acc);
    }
    acc.name = p.name;
    acc.color = p.color;
    acc.stock = p.stock;
    acc.coins = p.coins || 0;
    acc.hero = parseHero(p.hero);
    acc.x = p.x;
    acc.y = p.y;
    acc.hp = p.alive ? p.hp : 0;
    acc.lastSeen = Date.now();
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
    for (const n of this.npcs.values()) this.stepNpc(n);
    this.stepBuildings();
    this.stepProjectiles();
    this.stepLoot();
    this.stepNodes();
  }

  stepPlayer(p) {
    if (!p.alive) {
      if (this.tick * DT >= p.respawnAt) this.respawn(p);
      return;
    }
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
  }

  respawn(p) {
    const core = [...this.buildings.values()].find((b) => b.ownerId === p.id && b.type === "core");
    if (core) {
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
    this.events.push({ t: "hit", x: best.ref.x, y: best.ref.y });
  }

  hitNode(node, dmg, player) {
    node.hp -= dmg;
    if (!this._silent) this.events.push({ t: "chips", x: node.x, y: node.y, kind: node.kind });
    if (node.hp <= 0) {
      const def = NODE_TYPES[node.kind];
      if (player?.stock) {
        player.stock[def.resource] = (player.stock[def.resource] || 0) + def.yield;
      }
      node.alive = false;
      node.respawnAt = this.tick + def.respawn / DT;
      if (!this._silent) this.events.push({ t: "gather", resource: def.resource, x: node.x, y: node.y });
    }
  }

  tryPlace(p, opts = {}) {
    const def = BUILDINGS[p.selected];
    if (!def) return;
    const quiet = !!opts.quiet;
    const note = (text) => {
      if (!quiet) this.toast(p.id, text);
    };
    if (this.mode !== "sandbox" && def.limit === 1) {
      for (const b of this.buildings.values()) {
        if (b.ownerId === p.id && b.type === def.id) {
          note("Цитадель уже стоїть");
          return;
        }
      }
    }
    const cursor = p.input.cursor;
    if (!cursor) return;
    if (this.mode !== "sandbox" && dist2(p.x, p.y, cursor.x, cursor.y) > PLAYER.placeRange ** 2) {
      note("Занадто далеко");
      return;
    }
    const gx = Math.floor(cursor.x / TILE);
    const gy = Math.floor(cursor.y / TILE);
    const fp = buildingFootprint(p.selected, gx, gy, p.rot);
    if (fp.tx < 1 || fp.ty < 1 || fp.tx + fp.w >= WORLD_TILES - 1 || fp.ty + fp.h >= WORLD_TILES - 1) {
      note("Край мапи");
      return;
    }
    if (this.footprintBlocked(fp, null)) return;
    if (this.mode !== "sandbox" && this.insideEnemyKeep(fp, p.team)) {
      note("Не можна будувати в чужій цитаделі");
      return;
    }
    const free = this.mode === "sandbox";
    if (!canAfford(p.stock, def.cost, free)) {
      note("Не вистачає ресурсів");
      return;
    }
    payCost(p.stock, def.cost, free);
    const b = this.createBuilding({
      type: p.selected,
      tx: fp.tx,
      ty: fp.ty,
      rot: p.rot,
      ownerId: p.id,
      team: p.team,
    });
    if (b) this.events.push({ t: "place", x: b.x, y: b.y, type: b.type });
  }

  ownsBuilding(p, b) {
    return b && p && (b.ownerId === p.id || this.mode === "sandbox");
  }

  applyLevel(b) {
    const def = BUILDINGS[b.type];
    const ratio = b.maxHp ? b.hp / b.maxHp : 1;
    b.maxHp = buildingMaxHp(def, b.level);
    b.hp = Math.max(1, Math.round(b.maxHp * ratio));
  }

  upgradeBuilding(playerId, buildingId) {
    const p = this.players.get(playerId);
    const b = this.buildings.get(buildingId);
    if (!this.ownsBuilding(p, b)) {
      if (p) this.toast(p.id, "Це не ваша споруда");
      return;
    }
    if (b.level >= MAX_LEVEL) {
      this.toast(p.id, "Максимальний рівень");
      return;
    }
    const def = BUILDINGS[b.type];
    const cost = upgradeCost(def, b.level);
    const free = this.mode === "sandbox";
    if (!canAfford(p.stock, cost, free)) {
      this.toast(p.id, "Не вистачає ресурсів");
      return;
    }
    payCost(p.stock, cost, free);
    b.level += 1;
    this.applyLevel(b);
    b.hp = b.maxHp;
    this.events.push({ t: "place", x: b.x, y: b.y, type: b.type });
    this.toast(p.id, `${def.name}: рівень ${b.level}`);
  }

  sellBuilding(playerId, buildingId) {
    const p = this.players.get(playerId);
    const b = this.buildings.get(buildingId);
    if (!this.ownsBuilding(p, b)) {
      if (p) this.toast(p.id, "Це не ваша споруда");
      return;
    }
    if (this.mode !== "sandbox") {
      const value = sellValue(BUILDINGS[b.type], b.level);
      for (const [k, v] of Object.entries(value)) {
        p.stock[k] = (p.stock[k] || 0) + v;
      }
    }
    this.destroyBuilding(b, false);
    this.toast(p.id, "Продано");
  }

  createBuilding({ type, tx, ty, rot, ownerId, team, level = 1, id, hp, produceAcc, harvestTargetId, restore = false }) {
    const def = BUILDINGS[type];
    if (!def) return null;
    const fp = buildingFootprint(type, tx, ty, rot);
    if (!restore && this.footprintBlocked(fp, null)) return null;
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
    if (!restore) this.clearNodesUnder([b]);
    return b;
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
    return this.occupancy.has(`${tx},${ty}`);
  }

  footprintBlocked(fp, ignoreId) {
    for (let x = fp.tx; x < fp.tx + fp.w; x++) {
      for (let y = fp.ty; y < fp.ty + fp.h; y++) {
        const occ = this.occupancy.get(`${x},${y}`);
        if (occ && occ !== ignoreId) return true;
      }
    }
    return false;
  }

  keepsList() {
    if (this._keepTick === this.tick && this._keeps) return this._keeps;
    const cores = [];
    for (const b of this.buildings.values()) if (b.type === "core") cores.push(b);
    const r2 = (18 * TILE) ** 2;
    const keeps = [];
    for (const core of cores) {
      let x0 = core.tx;
      let y0 = core.ty;
      let x1 = core.tx + core.w - 1;
      let y1 = core.ty + core.h - 1;
      for (const b of this.buildings.values()) {
        if (b.team !== core.team) continue;
        if (dist2(b.x, b.y, core.x, core.y) > r2) continue;
        x0 = Math.min(x0, b.tx);
        y0 = Math.min(y0, b.ty);
        x1 = Math.max(x1, b.tx + b.w - 1);
        y1 = Math.max(y1, b.ty + b.h - 1);
      }
      keeps.push({ team: core.team, tx: x0, ty: y0, tx1: x1, ty1: y1 });
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
    const id = this.occupancy.get(`${tx},${ty}`);
    return id ? this.buildings.get(id) : null;
  }

  destroyBuilding(b, dropLoot) {
    this.unmarkFootprint(b);
    this.buildings.delete(b.id);
    this.events.push({ t: "boom", x: b.x, y: b.y });
    if (dropLoot) {
      const cost = BUILDINGS[b.type].cost || {};
      for (const [res, amt] of Object.entries(cost)) {
        if (amt > 0) this.spawnLoot(b.x + rand(-10, 10), b.y + rand(-10, 10), res, Math.max(1, Math.floor(amt * 0.35)));
      }
    }
    if (b.type === "core") {
      const faction = this.factions.get(b.team);
      if (faction?.npc) {
        for (const n of [...this.npcs.values()]) {
          if (n.team === b.team) this.npcs.delete(n.id);
        }
      }
    }
  }

  damageBuilding(b, dmg, fromTeam, killer = null) {
    if (b.team === fromTeam) return;
    b.hp -= dmg;
    if (!this._silent) this.events.push({ t: "chips", x: b.x, y: b.y, kind: "rock" });
    if (b.hp <= 0) {
      if (killer) killer.coins = (killer.coins || 0) + this.buildingBounty(b);
      this.destroyBuilding(b, true);
    }
  }

  buildingBounty(b) {
    const cost = BUILDINGS[b.type]?.cost || {};
    const sum = Object.values(cost).reduce((s, v) => s + v, 0);
    return Math.max(1, Math.ceil(sum / 18));
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
    const owner = this.players.get(b.ownerId) || this.accounts.get(b.ownerId);
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
    for (const n of this.npcs.values()) considerUnit(n);
    if (best) return best;
    const keep = this.keepFor(from);
    const shooterIsPlayer = typeof team === "string" && team.startsWith("p_");
    bestD = Infinity;
    for (const b of this.buildings.values()) {
      if (b.team === team) continue;
      const targetIsPlayer = typeof b.team === "string" && b.team.startsWith("p_");
      if (!shooterIsPlayer && !targetIsPlayer) continue;
      const d = dist2(from.x, from.y, b.x, b.y);
      const inKeep = keep && this.worldInKeep(b.x, b.y, keep);
      if (!inKeep && d >= r2) continue;
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
    const enemy = this.closestEnemy(n.x, n.y, NPC.aggro, n.team);
    const homeD = Math.hypot(n.x - n.home.cx, n.y - n.home.cy);
    let tx = n.home.cx;
    let ty = n.home.cy;
    if (enemy && homeD < NPC.leash) {
      tx = enemy.x;
      ty = enemy.y;
      const d = Math.hypot(enemy.x - n.x, enemy.y - n.y);
      if (d < 36 && n.cooldown <= 0) {
        if (enemy.kind === "player") this.damagePlayer(enemy, NPC.attackDmg, n.team);
        n.cooldown = NPC.attackCooldown;
        this.events.push({ t: "hit", x: enemy.x, y: enemy.y });
      }
    }
    const ang = Math.atan2(ty - n.y, tx - n.x);
    n.aim = ang;
    const dist = Math.hypot(tx - n.x, ty - n.y);
    if (dist > 20) {
      this.moveCircle(n, Math.cos(ang) * NPC.speed * DT, Math.sin(ang) * NPC.speed * DT);
    }
    this.spikeContact(n);
  }

  closestEnemy(x, y, range, team) {
    let best = null;
    let bestD = range * range;
    for (const p of this.players.values()) {
      if (!p.alive || p.team === team) continue;
      const d = dist2(x, y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  damageNpc(n, dmg, killer) {
    n.hp -= dmg;
    if (n.hp <= 0) {
      this.npcs.delete(n.id);
      this.spawnLoot(n.x, n.y, "gold", 2 + ((Math.random() * 3) | 0));
      if (killer) {
        killer.stock.gold = (killer.stock.gold || 0) + 1;
        killer.coins = (killer.coins || 0) + 3;
      }
      this.events.push({ t: "boom", x: n.x, y: n.y });
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
    this.events.push({ t: "death", x: p.x, y: p.y, name: p.name });
  }

  spawnLoot(x, y, resource, amount) {
    const l = {
      id: nid("l"),
      x,
      y,
      resource,
      amount,
      life: 40,
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
        p.stock[l.resource] = (p.stock[l.resource] || 0) + l.amount;
        this.loot.delete(id);
      }
    }
  }

  spikeContact(unit) {
    const b = this.buildingAtWorld(unit.x, unit.y);
    if (!b || b.type !== "spikes" || b.team === unit.team) return;
    const def = BUILDINGS.spikes;
    b.cooldown = b.cooldown || 0;
    if (b._spikeTick !== this.tick) {
      b._spikeTick = this.tick;
      if (this.tick % Math.round(def.contact.every / DT) === 0) {
        if (unit.kind === "player") this.damagePlayer(unit, Math.round(def.contact.damage * levelScale(b.level || 1)), b.team);
        else this.damageNpc(unit, Math.round(def.contact.damage * levelScale(b.level || 1)), null);
        this.events.push({ t: "spark", x: unit.x, y: unit.y });
      }
    }
  }

  stepNodes() {
    for (const n of this.nodes.values()) {
      if (!n.alive && this.tick >= n.respawnAt) {
        if (!this.occupiedKey(n.tx, n.ty)) {
          n.alive = true;
          n.hp = n.maxHp;
        } else {
          n.respawnAt = this.tick + 40;
        }
      }
    }
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
    for (const n of this.npcs.values()) if (near(n)) units.push(this.packUnit(n));
    const projectiles = [];
    for (const s of this.projectiles.values()) if (near(s)) {
      projectiles.push({ id: s.id, x: s.x, y: s.y, r: s.r, color: s.color });
    }
    const loot = [];
    for (const l of this.loot.values()) if (near(l)) {
      loot.push({ id: l.id, x: l.x, y: l.y, resource: l.resource, amount: l.amount });
    }
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
        coins: player.coins || 0,
        hero: parseHero(player.hero),
        selected: player.selected,
        rot: player.rot,
        respawnIn: player.alive ? 0 : Math.max(0, player.respawnAt - this.tick * DT),
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
    for (let i = 0; i < ticks; i++) {
      this.tick++;
      this.events = [];
      this.stepBuildings();
      this.stepNodes();
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
      accounts: [...this.accounts.values()].map((a) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        wood: a.stock.wood | 0,
        stone: a.stock.stone | 0,
        gold: a.stock.gold | 0,
        coins: a.coins | 0,
        hero: JSON.stringify(parseHero(a.hero)),
        x: a.x,
        y: a.y,
        hp: a.hp,
        lastSeen: a.lastSeen || Date.now(),
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
      factions: [...this.factions.values()].map((f) => ({
        id: f.id,
        name: f.name,
        npc: f.npc ? 1 : 0,
        color: f.color,
        core: f.core || null,
      })),
      npcs: [...this.npcs.values()].map((n) => ({
        id: n.id,
        team: n.team,
        x: n.x,
        y: n.y,
        hp: n.hp,
        homeX: n.home?.cx ?? n.x,
        homeY: n.home?.cy ?? n.y,
        color: n.color,
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
    for (const f of snap.factions || []) {
      this.factions.set(f.id, {
        id: f.id,
        name: f.name,
        npc: !!f.npc,
        color: f.color,
        core: f.core || null,
      });
    }
    for (const b of snap.buildings || []) {
      this.createBuilding({
        id: b.id,
        type: b.type,
        tx: b.tx,
        ty: b.ty,
        rot: b.rot,
        ownerId: b.ownerId,
        team: b.team,
        level: b.level,
        hp: b.hp,
        produceAcc: b.produceAcc,
        harvestTargetId: b.harvestTargetId,
        restore: true,
      });
    }
    for (const n of snap.nodes || []) {
      this.spawnNode(n.kind, n.tx, n.ty, n);
    }
    for (const n of snap.npcs || []) {
      this.spawnNpc(n.team, n.x, n.y, { cx: n.homeX, cy: n.homeY }, n);
    }
    for (const a of snap.accounts || []) {
      this.accounts.set(a.id, {
        id: a.id,
        name: a.name,
        color: a.color,
        stock: { wood: a.wood | 0, stone: a.stone | 0, gold: a.gold | 0 },
        coins: a.coins | 0,
        hero: parseHero(a.hero),
        x: a.x,
        y: a.y,
        hp: a.hp,
        lastSeen: a.lastSeen,
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
    setSeq(maxSeq);
    return true;
  }
}
