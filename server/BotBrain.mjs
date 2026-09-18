import {
  DT,
  BUILDINGS,
  MAX_LEVEL,
  PLAYER,
  CORE,
  canAfford,
  dist2,
  upgradeCost,
  addResource,
} from "../shared/defs.mjs";

const BUILD_PRIO = {
  core: 0,
  gate: 1,
  wall_stone: 2,
  wall_wood: 3,
  tower_arrow: 4,
  tower_magic: 4,
  mill: 5,
  quarry: 5,
  goldmine: 5,
  spikes: 6,
};

export class BotBrain {
  constructor(world) {
    this.world = world;
  }

  step() {
    const world = this.world;
    if (world.mode !== "world" || !world.bots?.size) return;
    for (const b of world.bots.values()) {
      if (!b.alive) continue;
      this.tickBot(b);
    }
  }

  tickBot(bot) {
    const world = this.world;
    world.ejectUnitIfBlocked(bot);
    bot.cooldown = Math.max(0, (bot.cooldown || 0) - DT);
    const core = world.playerCore(bot.id);
    if (core && dist2(bot.x, bot.y, core.x, core.y) <= CORE.depositRadius ** 2) {
      const t = world.ensureTreasury(bot);
      for (const k of ["wood", "stone", "gold"]) {
        if (bot.stock[k] > 0) {
          addResource(t, k, bot.stock[k]);
          bot.stock[k] = 0;
        }
      }
      const acc = world.accounts.get(bot.id);
      if (acc) acc.treasury = { ...t };
    }

    if (!core) {
      this.gatherForCore(bot);
      return;
    }

    if (!bot.buildPlan) bot.buildPlan = world.makeBotBuildPlan(bot);
    const plan = bot.buildPlan;
    if (!plan?.steps?.length) {
      this.gatherIdle(bot);
      return;
    }

    if (plan.phase === "upgrade") {
      this.runUpgradeStep(bot, plan);
      return;
    }

    const step = plan.steps[plan.index];
    if (!step) {
      plan.phase = "upgrade";
      plan.upgradeIndex = 0;
      return;
    }

    const exists = [...world.buildings.values()].some(
      (x) => x.team === bot.id && x.type === step.type && x.tx === step.tx && x.ty === step.ty
    );
    if (exists) {
      plan.index++;
      return;
    }

    const def = BUILDINGS[step.type];
    if (!def) {
      plan.index++;
      return;
    }
    const wallet = world.buildWallet(bot);
    if (!canAfford(wallet, def.cost, false)) {
      this.gatherToward(bot, step.tx, step.ty);
      return;
    }

    const placed = world.placeBuilding(bot, {
      type: step.type,
      tx: step.tx,
      ty: step.ty,
      rot: step.rot || 0,
      quiet: true,
      skipRange: true,
      fromX: bot.x,
      fromY: bot.y,
    });
    if (placed) plan.index++;
    else this.gatherToward(bot, step.tx, step.ty);
  }

  runUpgradeStep(bot, plan) {
    const world = this.world;
    const owned = world.playerBuildings(bot.id).filter((b) => b.level < MAX_LEVEL);
    if (!owned.length) {
      plan.phase = "done";
      return;
    }
    owned.sort((a, b) => (BUILD_PRIO[a.type] ?? 9) - (BUILD_PRIO[b.type] ?? 9));
    const target = owned[plan.upgradeIndex % owned.length];
    const wallet = world.buildWallet(bot);
    const cost = upgradeCost(BUILDINGS[target.type], target.level);
    if (!canAfford(wallet, cost, false)) {
      this.gatherIdle(bot);
      return;
    }
    if (world.upgradeBuilding(bot.id, target.id, { quiet: true })) {
      plan.upgradeIndex++;
    } else {
      this.gatherIdle(bot);
    }
  }

  gatherForCore(bot) {
    const world = this.world;
    const def = BUILDINGS.core;
    const wallet = bot.stock;
    if (canAfford(wallet, def.cost, false)) {
      const node = this.nearestNode(bot);
      const tx = node ? node.tx : Math.floor(bot.x / 48);
      const ty = node ? node.ty : Math.floor(bot.y / 48);
      world.placeBuilding(bot, {
        type: "core",
        tx,
        ty,
        rot: 0,
        quiet: true,
        skipRange: true,
        fromX: bot.x,
        fromY: bot.y,
      });
      return;
    }
    this.harvestNearest(bot);
  }

  gatherIdle(bot) {
    this.harvestNearest(bot);
  }

  gatherToward(bot, tx, ty) {
    const cx = tx * 48 + 24;
    const cy = ty * 48 + 24;
    if (dist2(bot.x, bot.y, cx, cy) > 120 * 120) {
      this.walkToward(bot, cx, cy);
      return;
    }
    this.harvestNearest(bot);
  }

  harvestNearest(bot) {
    const world = this.world;
    const node = this.nearestNode(bot);
    if (!node) {
      this.walkToward(bot, bot.x + (Math.random() - 0.5) * 200, bot.y + (Math.random() - 0.5) * 200);
      return;
    }
    this.walkToward(bot, node.x, node.y);
    if (dist2(bot.x, bot.y, node.x, node.y) > (PLAYER.harvestRange + 10) ** 2) return;
    if (bot.cooldown > 0) return;
    bot.aim = Math.atan2(node.y - bot.y, node.x - bot.x);
    world.hitNode(node, PLAYER.harvestDmg, bot);
    bot.cooldown = PLAYER.attackCooldown;
  }

  nearestNode(bot) {
    const world = this.world;
    let best = null;
    let bestD = Infinity;
    for (const n of world.nodes.values()) {
      if (!n.alive) continue;
      const d = dist2(bot.x, bot.y, n.x, n.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  walkToward(bot, x, y) {
    const world = this.world;
    const dx = x - bot.x;
    const dy = y - bot.y;
    const len = Math.hypot(dx, dy) || 1;
    bot.aim = Math.atan2(dy, dx);
    world.moveCircle(bot, (dx / len) * PLAYER.speed * 0.92 * DT, (dy / len) * PLAYER.speed * 0.92 * DT);
  }
}
