import {
  DT,
  NPC,
  BUILDINGS,
  NODE_TYPES,
  MAX_LEVEL,
  NPC_FACTION,
  dist2,
  canAfford,
  upgradeCost,
} from "../shared/defs.mjs";

const HARVEST_TYPES = ["mill", "quarry", "goldmine"];

export class NpcBrain {
  constructor(world) {
    this.world = world;
  }

  step(opts = {}) {
    const world = this.world;
    if (world.mode !== "world") return;
    const period = Math.max(1, Math.round(NPC_FACTION.brainPeriod / DT));
    if (!opts.force && world.tick % period !== 0) return;
    for (const f of world.factions.values()) {
      if (!f.npc) continue;
      this.tickFaction(f, opts);
    }
  }

  tickFaction(f, opts) {
    const world = this.world;
    world.ensureFaction(f);
    const core = world.factionCore(f);
    if (!core) {
      world.destroySettlement(f.id);
      f.job = null;
      f.desire = "dead";
      return;
    }

    f.threat = Math.max(0, (f.threat || 0) * 0.88);
    if (world.playerNearFaction(f, NPC.aggro)) {
      f.threat = Math.min(1, (f.threat || 0) + 0.22);
    }

    const stats = this.survey(f, core);
    if (!opts.economyOnly) this.maintainRoster(f, core, stats);

    let desire = this.pickDesire(f, stats);
    if (opts.economyOnly && (desire === "expand" || desire === "survive")) {
      desire = stats.damaged.length ? "survive" : "economy";
    }
    f.desire = desire;
    this.queueJob(f, core, stats, desire, opts);
    if (opts.economyOnly) this.resolveJobInstant(f, core, stats, desire);
    this.assignRoles(f, core, stats, desire);
  }

  survey(f, core) {
    const world = this.world;
    const buildings = world.buildingsOf(f.id);
    const ring = world.wallRing(f, core);
    const harvest = { wood: [], stone: [], gold: [] };
    const coverage = { wood: 0, stone: 0, gold: 0 };
    const towers = [];
    const gates = [];
    const walls = [];
    const damaged = [];
    for (const b of buildings) {
      const def = BUILDINGS[b.type];
      if (!def) continue;
      if (b.hp < b.maxHp * 0.98) damaged.push(b);
      if (def.turret) towers.push(b);
      if (b.type === "gate") gates.push(b);
      if (b.type === "wall_wood" || b.type === "wall_stone") walls.push(b);
      if (def.harvest) {
        harvest[def.harvest.resource].push(b);
        coverage[def.harvest.resource] += world.countHarvestNodes(b, def);
      }
    }
    damaged.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
    const nearby = { wood: 0, stone: 0, gold: 0 };
    const scan2 = NPC_FACTION.harvestScan * NPC_FACTION.harvestScan;
    for (const n of world.nodes.values()) {
      if (!n.alive) continue;
      if (dist2(core.x, core.y, n.x, n.y) > scan2) continue;
      const res = NODE_TYPES[n.kind]?.resource;
      if (res) nearby[res] += 1;
    }
    return { buildings, ring, harvest, coverage, nearby, towers, gates, walls, damaged };
  }

  pickDesire(f, stats) {
    const core = this.world.factionCore(f);
    const coreRatio = core.maxHp ? core.hp / core.maxHp : 1;
    const integrity = stats.ring.cells.length
      ? 1 - stats.ring.holes.length / stats.ring.cells.length
      : 0;
    if ((f.threat || 0) > 0.25 || coreRatio < 0.7 || integrity < 0.75) return "survive";

    for (const type of HARVEST_TYPES) {
      const res = BUILDINGS[type].harvest.resource;
      if (stats.nearby[res] > 0 && (stats.harvest[res].length === 0 || stats.coverage[res] === 0)) {
        return "economy";
      }
    }

    const woodWall = stats.walls.find((w) => w.type === "wall_wood" && w.level < MAX_LEVEL);
    const needSpikes = stats.gates.some((g) => !this.gateHasSpikes(g, stats.buildings));
    const needTower = stats.towers.length < 2 && stats.ring.corners.length;
    if (stats.ring.holes.length || woodWall || needSpikes || needTower) return "fortify";

    const size = Math.max(stats.ring.x1 - stats.ring.x0 + 1, stats.ring.y1 - stats.ring.y0 + 1);
    const rich = (f.stock.wood || 0) >= 40 && (f.stock.stone || 0) >= 20;
    if (size < NPC_FACTION.expandMax && rich && (f.threat || 0) < 0.12) return "expand";

    return "upgrade";
  }

  queueJob(f, core, stats, desire, opts = {}) {
    if (f.job && this.jobStillValid(f)) return;
    f.job = null;
    if (desire === "survive") {
      const urgent = stats.damaged.find((b) => b.type === "core" || b.hp / b.maxHp < NPC_FACTION.repairHp)
        || stats.damaged[0];
      if (urgent && this.canRepair(f, urgent)) {
        f.job = this.makeJob("repair", { id: urgent.id });
        return;
      }
      const hole = stats.ring.holes[0];
      if (hole) {
        f.job = this.placeJob(f, hole.type || "wall_wood", hole.tx, hole.ty, hole.rot || 0);
        return;
      }
    }
    if (desire === "economy") {
      for (const type of HARVEST_TYPES) {
        const res = BUILDINGS[type].harvest.resource;
        if (stats.nearby[res] <= 0) continue;
        if (stats.harvest[res].length >= 2 && stats.coverage[res] > 0) continue;
        if (stats.harvest[res].length && stats.coverage[res] > 0) continue;
        const site = this.world.findHarvestSite(f, core, type, stats.ring);
        if (site) {
          f.job = this.placeJob(f, type, site.tx, site.ty, 0);
          return;
        }
      }
    }
    if (desire === "fortify") {
      const hole = stats.ring.holes[0];
      if (hole) {
        const type = (f.stock.stone || 0) >= BUILDINGS.wall_stone.cost.stone ? "wall_stone" : "wall_wood";
        f.job = this.placeJob(f, type, hole.tx, hole.ty, hole.rot || 0);
        return;
      }
      for (const g of stats.gates) {
        if (this.gateHasSpikes(g, stats.buildings)) continue;
        const spot = this.spikeSpot(g, core);
        if (spot && this.world.canPlaceTile("spikes", spot.tx, spot.ty, 0, f.id)) {
          f.job = this.placeJob(f, "spikes", spot.tx, spot.ty, 0);
          return;
        }
      }
      const wood = stats.walls.find((w) => w.type === "wall_wood" && w.level < MAX_LEVEL);
      if (wood && this.canUpgrade(f, wood)) {
        f.job = this.makeJob("upgrade", { id: wood.id });
        return;
      }
      if (stats.towers.length < Math.max(2, stats.ring.corners.length)) {
        const corner = this.weakestCorner(stats);
        if (corner && this.world.canPlaceTile("tower_arrow", corner.tx, corner.ty, 0, f.id)) {
          f.job = this.placeJob(f, "tower_arrow", corner.tx, corner.ty, 0);
          return;
        }
      }
    }
    if (desire === "expand" && !opts.economyOnly) {
      const next = stats.ring.next;
      if (next) {
        const cell = next.holes[0] || next.cells[0];
        if (cell) {
          const isGate = next.gates.some((g) => g.tx === cell.tx && g.ty === cell.ty);
          const type = isGate ? "gate" : ((f.stock.stone || 0) >= 24 ? "wall_stone" : "wall_wood");
          f.job = this.placeJob(f, type, cell.tx, cell.ty, cell.rot || 0);
          return;
        }
      }
    }
    if (desire === "upgrade" || desire === "expand") {
      const order = [core, ...stats.towers, ...HARVEST_TYPES.flatMap((t) => stats.harvest[BUILDINGS[t].harvest.resource])];
      for (const b of order) {
        if (!b || b.level >= MAX_LEVEL) continue;
        if (BUILDINGS[b.type]?.harvest && this.world.countHarvestNodes(b, BUILDINGS[b.type]) <= 0) continue;
        if (this.canUpgrade(f, b)) {
          f.job = this.makeJob("upgrade", { id: b.id });
          return;
        }
      }
    }
  }

  makeJob(kind, extra) {
    return { kind, started: this.world.tick, ...extra };
  }

  placeJob(f, type, tx, ty, rot) {
    if (!canAfford(f.stock, BUILDINGS[type]?.cost || {})) return null;
    return this.makeJob("place", { type, tx, ty, rot: rot || 0 });
  }

  jobStillValid(f) {
    const job = f.job;
    if (!job) return false;
    if (this.world.tick - (job.started || 0) > NPC_FACTION.jobTimeout / DT) return false;
    if (job.kind === "place") {
      return this.world.canPlaceTile(job.type, job.tx, job.ty, job.rot || 0, f.id);
    }
    if (job.kind === "upgrade" || job.kind === "repair") {
      return !!this.world.buildings.get(job.id);
    }
    return false;
  }

  canRepair(f, b) {
    const def = BUILDINGS[b.type];
    if (!def || b.hp >= b.maxHp - 0.5) return false;
    return canAfford(f.stock, this.world.repairCostFor(def, b.level));
  }

  canUpgrade(f, b) {
    const def = BUILDINGS[b.type];
    if (!def || b.level >= MAX_LEVEL) return false;
    return canAfford(f.stock, upgradeCost(def, b.level));
  }

  gateHasSpikes(gate, buildings) {
    for (const b of buildings) {
      if (b.type !== "spikes") continue;
      if (Math.abs(b.tx - gate.tx) + Math.abs(b.ty - gate.ty) <= 1) return true;
    }
    return false;
  }

  spikeSpot(gate, core) {
    const dx = Math.sign(gate.x - core.x);
    const dy = Math.sign(gate.y - core.y);
    return { tx: gate.tx + dx, ty: gate.ty + dy };
  }

  weakestCorner(stats) {
    let best = null;
    let bestN = Infinity;
    for (const c of stats.ring.corners) {
      const n = stats.towers.filter((t) => Math.abs(t.tx - c.tx) <= 3 && Math.abs(t.ty - c.ty) <= 3).length;
      if (n < bestN) {
        bestN = n;
        best = c;
      }
    }
    return best;
  }

  resolveJobInstant(f, core, stats, desire) {
    let n = 0;
    while (f.job && n < 4) {
      const ok = this.world.executeFactionJob(f, { instant: true });
      n++;
      if (!ok) {
        f.job = null;
        break;
      }
      f.job = null;
      const next = this.survey(f, core);
      this.queueJob(f, core, next, desire, { economyOnly: true });
    }
  }

  maintainRoster(f, core, stats) {
    const world = this.world;
    const units = world.npcsOf(f.id);
    const desiredGuards = Math.min(NPC_FACTION.maxGuards, 2 + stats.towers.length);
    const needWood = stats.nearby.wood > 0 && stats.coverage.wood < 3;
    const needStone = stats.nearby.stone > 0 && stats.coverage.stone < 3;
    const needGold = stats.nearby.gold > 0 && stats.coverage.gold < 2;
    const desiredGather = Math.min(
      NPC_FACTION.maxGatherers,
      (needWood ? 1 : 0) + (needStone ? 1 : 0) + (needGold ? 1 : 0) + (f.desire === "economy" ? 1 : 0)
    );
    const desired = desiredGuards + desiredGather + NPC_FACTION.maxBuilders;
    if (units.length >= desired) return;
    if ((f.stock.gold || 0) < NPC_FACTION.recruitGold) return;
    if (world.tick < (f.recruitAt || 0)) return;
    const gates = world.buildingsOf(f.id).filter((b) => b.type === "gate");
    const spawned = world.spawnNpcOutsideGates(f.id, 1, core, gates);
    const npc = spawned[0];
    if (!npc) return;
    npc.role = "guard";
    f.stock.gold -= NPC_FACTION.recruitGold;
    f.recruitAt = world.tick + NPC_FACTION.recruitCooldown / DT;
  }

  assignRoles(f, core, stats, desire) {
    const world = this.world;
    const units = world.npcsOf(f.id);
    const homes = world.gateHomes(f);
    const hunt = desire === "survive" && (f.threat || 0) > 0.2 && world.playerNearFaction(f, NPC_FACTION.huntLeash);
    const gatherNeed = [];
    if (stats.nearby.wood) gatherNeed.push("wood");
    if (stats.nearby.stone) gatherNeed.push("stone");
    if (stats.nearby.gold) gatherNeed.push("gold");
    const gatherSlots = Math.min(NPC_FACTION.maxGatherers, Math.max(gatherNeed.length, desire === "economy" ? 1 : 0));
    const needBuilder = !!(f.job && (f.job.kind === "place" || f.job.kind === "upgrade"));
    const needRepair = f.job?.kind === "repair";

    units.sort((a, b) => a.id.localeCompare(b.id));
    let gi = 0;
    let assignedBuilder = false;
    let assignedRepair = false;
    let guardsLeft = hunt ? 0 : Math.min(units.length, 2);
    units.forEach((n, i) => {
      n.home = homes[i % homes.length] || { cx: core.x, cy: core.y };
      if (hunt) {
        n.role = "hunt";
        n.gatherKind = null;
        return;
      }
      if (guardsLeft > 0) {
        n.role = "guard";
        n.gatherKind = null;
        guardsLeft--;
        return;
      }
      if (needRepair && !assignedRepair) {
        n.role = "repair";
        n.gatherKind = null;
        assignedRepair = true;
        return;
      }
      if (needBuilder && !assignedBuilder) {
        n.role = "builder";
        n.gatherKind = null;
        assignedBuilder = true;
        return;
      }
      if (gi < gatherSlots) {
        n.role = "gather";
        n.gatherKind = gatherNeed[gi % gatherNeed.length] || "wood";
        gi++;
        return;
      }
      n.role = "guard";
      n.gatherKind = null;
    });
  }
}
