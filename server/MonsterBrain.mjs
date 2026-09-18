import { DT, MONSTER, dist2, clamp, WORLD_SIZE, footprintRect } from "../shared/defs.mjs";

function distToBuilding(m, b) {
  const rect = footprintRect(b);
  const nx = clamp(m.x, rect.x, rect.x + rect.w);
  const ny = clamp(m.y, rect.y, rect.y + rect.h);
  return dist2(m.x, m.y, nx, ny);
}

export class MonsterBrain {
  constructor(world) {
    this.world = world;
  }

  step() {
    const world = this.world;
    if (world.mode !== "world") return;
    for (const m of world.monsters.values()) {
      this.stepOne(m);
    }
  }

  stepOne(m) {
    const world = this.world;
    world.ejectUnitIfBlocked(m);
    m.cooldown = Math.max(0, (m.cooldown || 0) - DT);

    const target = this.pickTarget(m);
    if (target) {
      m.wanderTx = null;
      m.wanderTy = null;
      const reach2 =
        target.kind === "building"
          ? distToBuilding(m, target.ref)
          : dist2(m.x, m.y, target.x, target.y);
      const reach = Math.sqrt(reach2);
      let dx;
      let dy;
      if (target.kind === "building") {
        const rect = footprintRect(target.ref);
        const nx = clamp(m.x, rect.x, rect.x + rect.w);
        const ny = clamp(m.y, rect.y, rect.y + rect.h);
        dx = nx - m.x;
        dy = ny - m.y;
      } else {
        dx = target.x - m.x;
        dy = target.y - m.y;
      }
      m.aim = Math.atan2(dy, dx);
      const dist = reach || 1;
      const speed = MONSTER.speed;
      if (dist > MONSTER.attackRange * 0.85) {
        world.moveCircle(m, (dx / dist) * speed * DT, (dy / dist) * speed * DT);
      } else if (m.cooldown <= 0) {
        this.strike(m, target);
        m.cooldown = MONSTER.attackCooldown;
      }
      return;
    }

    if (m.wanderTx == null || dist2(m.x, m.y, m.wanderTx, m.wanderTy) < 48 * 48) {
      m.wanderTx = clamp(m.x + (Math.random() - 0.5) * MONSTER.wanderRadius, 80, WORLD_SIZE - 80);
      m.wanderTy = clamp(m.y + (Math.random() - 0.5) * MONSTER.wanderRadius, 80, WORLD_SIZE - 80);
    }
    const wx = m.wanderTx - m.x;
    const wy = m.wanderTy - m.y;
    const wl = Math.hypot(wx, wy) || 1;
    m.aim = Math.atan2(wy, wx);
    world.moveCircle(m, (wx / wl) * MONSTER.speed * 0.55 * DT, (wy / wl) * MONSTER.speed * 0.55 * DT);
  }

  pickTarget(m) {
    const world = this.world;
    const r2 = MONSTER.aggro * MONSTER.aggro;
    let best = null;
    let bestD = r2;
    for (const p of world.players.values()) {
      if (!p.alive) continue;
      const d = dist2(m.x, m.y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = { kind: "player", ref: p, x: p.x, y: p.y };
      }
    }
    for (const b of world.bots?.values() || []) {
      if (!b.alive) continue;
      const d = dist2(m.x, m.y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = { kind: "bot", ref: b, x: b.x, y: b.y };
      }
    }
    for (const b of world.buildings.values()) {
      if (!world.isHumanSide(b.team)) continue;
      const d = distToBuilding(m, b);
      if (d < bestD) {
        bestD = d;
        best = { kind: "building", ref: b, x: b.x, y: b.y };
      }
    }
    return best;
  }

  strike(m, target) {
    const world = this.world;
    if (target.kind === "building") {
      world.damageBuilding(target.ref, MONSTER.damage, "__monster__", null);
    } else {
      const u = target.ref;
      u.hp -= MONSTER.damage;
      if (u.hp <= 0) {
        if (target.kind === "player") world.killPlayer(u);
        else world.killBot(u);
      }
    }
    world.events.push({ t: "hit", x: target.x, y: target.y });
  }
}
