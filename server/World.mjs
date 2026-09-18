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
  buildingFootprint,
  footprintRect,
  rectsOverlap,
  dist2,
  clamp,
  id as makeId,
  canAfford,
  payCost,
  refundCost,
} from "../shared/defs.mjs";

let seq = 1;
function nid(prefix) {
  return `${prefix}_${(seq++).toString(36)}`;
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

  spawnNode(kind, tx, ty) {
    const def = NODE_TYPES[kind];
    const node = {
      id: nid("n"),
      kind,
      tx,
      ty,
      x: (tx + 0.5) * TILE,
      y: (ty + 0.5) * TILE,
      hp: def.hp,
      maxHp: def.hp,
      radius: def.radius,
      alive: true,
      respawnAt: 0,
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

  spawnNpc(team, x, y, home) {
    const npc = {
      id: nid("e"),
      kind: "npc",
      team,
      x: clamp(x, 40, WORLD_SIZE - 40),
      y: clamp(y, 40, WORLD_SIZE - 40),
      vx: 0,
      vy: 0,
      aim: 0,
      hp: NPC.hp,
      maxHp: NPC.hp,
      radius: NPC.radius,
      cooldown: 0,
      home: home || { cx: x, cy: y },
      targetId: null,
      color: this.factions.get(team)?.color || "#c4453c",
    };
    this.npcs.set(npc.id, npc);
    return npc;
  }

  addPlayer(name, skin) {
    const spawn = this.findSpawn();
    const color = TEAM_COLORS[this.players.size % TEAM_COLORS.length];
    const player = {
      id: nid("p"),
      kind: "player",
      name: (name || "Гість").slice(0, 16),
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
      stock: this.mode === "sandbox"
        ? { wood: 9999, stone: 9999, gold: 9999 }
        : { wood: 24, stone: 12, gold: 4 },
      selected: "wall_wood",
      rot: 0,
      alive: true,
      respawnAt: 0,
      input: { mx: 0, my: 0, ax: 1, ay: 0, harvest: false, place: false, demolish: false },
      placeLatch: false,
      demolishLatch: false,
      sandbox: this.mode === "sandbox",
    };
    player.team = player.id;
    this.players.set(player.id, player);
    return player;
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
    this.players.delete(id);
    if (this.mode === "world") {
      for (const b of [...this.buildings.values()]) {
        if (b.ownerId === id) this.destroyBuilding(b, false);
      }
    }
  }

  setInput(playerId, input) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.input = {
      mx: clamp(input.mx || 0, -1, 1),
      my: clamp(input.my || 0, -1, 1),
      ax: input.ax ?? p.input.ax,
      ay: input.ay ?? p.input.ay,
      harvest: !!input.harvest,
      place: !!input.place,
      demolish: !!input.demolish,
      cursor: input.cursor && Number.isFinite(input.cursor.x)
        ? { x: input.cursor.x, y: input.cursor.y }
        : null,
    };
    if (input.selected && BUILDINGS[input.selected]) p.selected = input.selected;
    if (Number.isFinite(input.rot)) p.rot = ((input.rot % 4) + 4) % 4;
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
    if (mag > 0.01) {
      vx = (p.input.mx / mag) * PLAYER.speed;
      vy = (p.input.my / mag) * PLAYER.speed;
    }
    this.moveCircle(p, vx * DT, vy * DT);
    p.cooldown = Math.max(0, p.cooldown - DT);

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

    if (p.input.demolish) {
      p.demoAcc = (p.demoAcc || 0) - DT;
      if (p.demoAcc <= 0) {
        this.tryDemolish(p);
        p.demoAcc = 0.12;
      }
    } else p.demoAcc = 0;

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
    p.hp = p.maxHp;
    p.alive = true;
  }

  playerStrike(p) {
    const reachX = p.x + Math.cos(p.aim) * PLAYER.harvestRange;
    const reachY = p.y + Math.sin(p.aim) * PLAYER.harvestRange;
    let best = null;
    let bestD = 42 * 42;

    for (const n of this.nodes.values()) {
      if (!n.alive) continue;
      const d = dist2(reachX, reachY, n.x, n.y);
      if (d < bestD && dist2(p.x, p.y, n.x, n.y) < (PLAYER.harvestRange + n.radius) ** 2) {
        best = { kind: "node", ref: n };
        bestD = d;
      }
    }
    for (const b of this.buildings.values()) {
      if (b.team === p.team) continue;
      const rect = footprintRect(b);
      if (circleHitsRect(reachX, reachY, 18, rect) || circleHitsRect(p.x, p.y, PLAYER.harvestRange, rect)) {
        const d = dist2(p.x, p.y, b.x, b.y);
        if (d < bestD + 2000) {
          best = { kind: "building", ref: b };
          bestD = d;
        }
      }
    }
    for (const n of this.npcs.values()) {
      if (n.team === p.team) continue;
      const d = dist2(reachX, reachY, n.x, n.y);
      if (d < bestD && dist2(p.x, p.y, n.x, n.y) < (PLAYER.harvestRange + n.radius) ** 2) {
        best = { kind: "npc", ref: n };
        bestD = d;
      }
    }
    for (const o of this.players.values()) {
      if (o.id === p.id || !o.alive || o.team === p.team) continue;
      const d = dist2(reachX, reachY, o.x, o.y);
      if (d < bestD && dist2(p.x, p.y, o.x, o.y) < (PLAYER.harvestRange + o.radius) ** 2) {
        best = { kind: "player", ref: o };
        bestD = d;
      }
    }

    if (!best) {
      this.events.push({ t: "swing", x: reachX, y: reachY, team: p.team });
      return;
    }
    if (best.kind === "node") this.hitNode(best.ref, PLAYER.harvestDmg, p);
    if (best.kind === "building") this.damageBuilding(best.ref, PLAYER.attackDmg, p.team);
    if (best.kind === "npc") this.damageNpc(best.ref, PLAYER.attackDmg, p);
    if (best.kind === "player") this.damagePlayer(best.ref, PLAYER.attackDmg, p.team);
    this.events.push({ t: "hit", x: best.ref.x, y: best.ref.y });
  }

  hitNode(node, dmg, player) {
    node.hp -= dmg;
    this.events.push({ t: "chips", x: node.x, y: node.y, kind: node.kind });
    if (node.hp <= 0) {
      const def = NODE_TYPES[node.kind];
      player.stock[def.resource] = (player.stock[def.resource] || 0) + def.yield;
      node.alive = false;
      node.respawnAt = this.tick + def.respawn / DT;
      this.events.push({ t: "gather", resource: def.resource, x: node.x, y: node.y });
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

  tryDemolish(p) {
    const cursor = p.input.cursor;
    const x = cursor ? cursor.x : p.x + Math.cos(p.aim) * 40;
    const y = cursor ? cursor.y : p.y + Math.sin(p.aim) * 40;
    const b = this.buildingAtWorld(x, y);
    if (!b) return;
    const own = b.ownerId === p.id || this.mode === "sandbox";
    if (!own) return;
    if (this.mode !== "sandbox") refundCost(p.stock, BUILDINGS[b.type].cost, 0.5);
    this.destroyBuilding(b, false);
  }

  createBuilding({ type, tx, ty, rot, ownerId, team }) {
    const def = BUILDINGS[type];
    if (!def) return null;
    const fp = buildingFootprint(type, tx, ty, rot);
    if (this.footprintBlocked(fp, null)) return null;
    const rect = footprintRect(fp);
    const b = {
      id: nid("b"),
      type,
      tx: fp.tx,
      ty: fp.ty,
      w: fp.w,
      h: fp.h,
      rot: rot || 0,
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      hp: def.hp,
      maxHp: def.hp,
      ownerId,
      team,
      cooldown: 0,
      produceAcc: 0,
    };
    this.buildings.set(b.id, b);
    this.markFootprint(fp, b.id);
    this.clearNodesUnder([b]);
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

  damageBuilding(b, dmg, fromTeam) {
    if (b.team === fromTeam) return;
    b.hp -= dmg;
    if (b.hp <= 0) this.destroyBuilding(b, true);
  }

  stepBuildings() {
    for (const b of this.buildings.values()) {
      const def = BUILDINGS[b.type];
      b.cooldown = Math.max(0, b.cooldown - DT);
      if (def.produces) {
        b.produceAcc += DT;
        if (b.produceAcc >= def.produces.every) {
          b.produceAcc = 0;
          const owner = this.players.get(b.ownerId);
          if (owner && owner.alive) {
            owner.stock[def.produces.resource] =
              (owner.stock[def.produces.resource] || 0) + def.produces.amount;
          }
        }
      }
      if (def.turret && b.cooldown <= 0) {
        const t = this.findTarget(b.x, b.y, def.turret.range, b.team);
        if (t) {
          this.shoot(b, t, def.turret);
          b.cooldown = def.turret.cooldown;
        }
      }
    }
  }

  findTarget(x, y, range, team) {
    let best = null;
    let bestD = range * range;
    const consider = (e) => {
      if (!e || e.team === team) return;
      if (e.alive === false) return;
      const d = dist2(x, y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    };
    for (const p of this.players.values()) if (p.alive) consider(p);
    for (const n of this.npcs.values()) consider(n);
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
      if (killer) killer.stock.gold = (killer.stock.gold || 0) + 1;
      this.events.push({ t: "boom", x: n.x, y: n.y });
    }
  }

  damagePlayer(p, dmg, fromTeam) {
    if (!p.alive || p.team === fromTeam) return;
    p.hp -= dmg;
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
        if (unit.kind === "player") this.damagePlayer(unit, def.contact.damage, b.team);
        else this.damageNpc(unit, def.contact.damage, null);
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
        selected: player.selected,
        rot: player.rot,
        respawnIn: player.alive ? 0 : Math.max(0, player.respawnAt - this.tick * DT),
      },
      buildings,
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
      });
    }
  }

  clearBuildings() {
    for (const b of [...this.buildings.values()]) this.destroyBuilding(b, false);
  }
}
