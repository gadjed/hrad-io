import { TILE, WORLD_SIZE, RESOURCES, BUILDINGS, NODE_TYPES, harvestRadius } from "/shared/defs.mjs";

function hash(x, y) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.minimap = minimap;
    this.mctx = minimap.getContext("2d");
    this.cam = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    this.zoom = 1;
    this.shake = 0;
    this.particles = [];
    this.dpr = 1;
    this.ghost = null;
    this.focus = null;
    this.mode = "world";
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  screenToWorld(sx, sy) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      x: this.cam.x + (sx - w / 2) / this.zoom,
      y: this.cam.y + (sy - h / 2) / this.zoom,
    };
  }

  follow(x, y, dt) {
    this.cam.x += (x - this.cam.x) * Math.min(1, dt * 8);
    this.cam.y += (y - this.cam.y) * Math.min(1, dt * 8);
  }

  burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 40 + Math.random() * 90;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.35 + Math.random() * 0.35,
        max: 0.7,
        r: 1.5 + Math.random() * 2.5,
        color,
      });
    }
  }

  ingest(events) {
    for (const e of events || []) {
      if (e.t === "hit" || e.t === "spark") this.burst(e.x, e.y, "#f4e7c3", 6);
      if (e.t === "chips") {
        const c = e.kind === "tree" ? "#6ea35a" : e.kind === "goldvein" ? "#efc94a" : "#9aa4b2";
        this.burst(e.x, e.y, c, 10);
      }
      if (e.t === "boom") {
        this.burst(e.x, e.y, "#c4453c", 16);
        this.shake = 7;
      }
      if (e.t === "place") this.burst(e.x, e.y, "#d7b056", 8);
      if (e.t === "death") {
        this.burst(e.x, e.y, "#ff6b6b", 20);
        this.shake = 10;
      }
    }
  }

  draw(state, youId, dt) {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.shake > 0) this.shake *= 0.86;
    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + sx, h / 2 + sy);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.cam.x, -this.cam.y);

    this.drawGround(state);
    if (this.mode === "sandbox") this.drawGrid();
    for (const n of state.nodes) this.drawNode(n);
    for (const l of state.loot) this.drawLoot(l);
    const buildings = [...state.buildings].sort((a, b) => a.y - b.y);
    for (const b of buildings) this.drawBuilding(b, youId);
    for (const b of buildings) this.drawBuildingHp(b, youId);
    this.drawHarvestRange(this.focus || this.ghost, state.nodes);
    if (this.focus) this.drawFocus(this.focus);
    if (this.ghost && !this.focus) this.drawGhost(this.ghost);
    for (const u of [...state.units].sort((a, b) => a.y - b.y)) this.drawUnit(u, youId);
    for (const p of state.projectiles) this.drawShot(p);
    this.stepParticles(dt);

    ctx.restore();
    this.drawMinimap(state, youId);
  }

  drawGround() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth / this.zoom;
    const h = this.canvas.clientHeight / this.zoom;
    const x0 = this.cam.x - w / 2 - TILE;
    const y0 = this.cam.y - h / 2 - TILE;
    const x1 = this.cam.x + w / 2 + TILE;
    const y1 = this.cam.y + h / 2 + TILE;
    const t0x = Math.max(0, Math.floor(x0 / TILE));
    const t0y = Math.max(0, Math.floor(y0 / TILE));
    const t1x = Math.min(WORLD_SIZE / TILE, Math.ceil(x1 / TILE));
    const t1y = Math.min(WORLD_SIZE / TILE, Math.ceil(y1 / TILE));
    for (let ty = t0y; ty < t1y; ty++) {
      for (let tx = t0x; tx < t1x; tx++) {
        const n = hash(tx, ty);
        const g = n > 0.72 ? "#35563a" : n > 0.4 ? "#2c4933" : "#26422e";
        ctx.fillStyle = g;
        ctx.fillRect(tx * TILE, ty * TILE, TILE + 0.5, TILE + 0.5);
        if (n > 0.93) {
          ctx.fillStyle = "rgba(210, 190, 90, 0.07)";
          ctx.beginPath();
          ctx.arc(tx * TILE + 24, ty * TILE + 24, 6 + n * 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  drawGrid() {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(232, 223, 200, 0.08)";
    ctx.lineWidth = 1;
    const w = this.canvas.clientWidth / this.zoom;
    const h = this.canvas.clientHeight / this.zoom;
    const x0 = Math.floor((this.cam.x - w / 2) / TILE) * TILE;
    const y0 = Math.floor((this.cam.y - h / 2) / TILE) * TILE;
    ctx.beginPath();
    for (let x = x0; x < this.cam.x + w / 2; x += TILE) {
      ctx.moveTo(x, this.cam.y - h / 2);
      ctx.lineTo(x, this.cam.y + h / 2);
    }
    for (let y = y0; y < this.cam.y + h / 2; y += TILE) {
      ctx.moveTo(this.cam.x - w / 2, y);
      ctx.lineTo(this.cam.x + w / 2, y);
    }
    ctx.stroke();
  }

  drawNode(n) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(n.x, n.y);
    if (n.kind === "tree") {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(2, 10, 16, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5a3a22";
      ctx.fillRect(-4, -2, 8, 14);
      ctx.fillStyle = "#3f7a45";
      blob(ctx, 0, -12, 18);
      ctx.fillStyle = "#4f9154";
      blob(ctx, -6, -16, 12);
      ctx.fillStyle = "#2f5c34";
      blob(ctx, 7, -14, 10);
    } else if (n.kind === "rock") {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(1, 8, 14, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7d8694";
      poly(ctx, [
        [-14, 4], [-8, -10], [4, -14], [14, -2], [8, 10], [-10, 10],
      ]);
      ctx.fillStyle = "#9aa4b2";
      poly(ctx, [[-4, -2], [2, -10], [8, -2], [2, 4]]);
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(0, 8, 13, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4a4034";
      poly(ctx, [[-12, 6], [-6, -8], [8, -10], [13, 4], [-2, 10]]);
      ctx.fillStyle = "#efc94a";
      ctx.beginPath();
      ctx.moveTo(-2, -2);
      ctx.lineTo(4, -8);
      ctx.lineTo(6, 0);
      ctx.closePath();
      ctx.fill();
    }
    if (n.hp < n.maxHp) bar(ctx, -14, 16, 28, n.hp / n.maxHp, "#e8dfc8");
    ctx.restore();
  }

  drawBuilding(b, youId) {
    const ctx = this.ctx;
    const x = b.tx * TILE;
    const y = b.ty * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(4, 6, w, h);
    drawKind(ctx, b.type, w, h, b.rot, b.team === youId);
    if ((b.level || 1) > 1) {
      ctx.fillStyle = "rgba(12,16,14,0.75)";
      ctx.fillRect(4, 4, 16, 12);
      ctx.fillStyle = "#d7b056";
      ctx.font = "bold 10px Figtree, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(b.level), 12, 13);
    }
    ctx.restore();
  }

  drawBuildingHp(b, youId) {
    if (b.hp >= b.maxHp - 0.5) return;
    const ctx = this.ctx;
    const x = b.tx * TILE;
    const y = b.ty * TILE;
    const w = b.w * TILE;
    ctx.save();
    ctx.translate(x, y);
    bar(ctx, 4, -8, w - 8, b.hp / b.maxHp, b.team === youId ? "#7bed9f" : "#ff6b6b");
    ctx.restore();
  }

  drawHarvestRange(b, nodes) {
    if (!b) return;
    const def = BUILDINGS[b.type];
    if (!def?.harvest) return;
    const radius = harvestRadius(def, b.level || 1);
    const cx = b.x ?? (b.tx + b.w / 2) * TILE;
    const cy = b.y ?? (b.ty + b.h / 2) * TILE;
    const ctx = this.ctx;
    const r2 = radius * radius;
    let sources = 0;
    ctx.save();
    for (const n of nodes || []) {
      if (NODE_TYPES[n.kind]?.resource !== def.harvest.resource) continue;
      const dx = n.x - cx;
      const dy = n.y - cy;
      if (dx * dx + dy * dy > r2) continue;
      sources++;
      const active = b.harvestTargetId && n.id === b.harvestTargetId;
      ctx.strokeStyle = active ? "#f0d48a" : "#d7b056";
      ctx.lineWidth = active ? 4 : 2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, active ? 20 : 16, 0, Math.PI * 2);
      ctx.stroke();
    }
    const color = sources ? "#d7b056" : "#c4453c";
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawGhost(g) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(g.tx * TILE, g.ty * TILE);
    const w = g.w * TILE;
    const h = g.h * TILE;
    ctx.fillStyle = g.ok ? "rgba(80, 180, 120, 0.35)" : "rgba(180, 50, 50, 0.4)";
    ctx.fillRect(0, 0, w, h);
    drawKind(ctx, g.type, w, h, g.rot, true);
    ctx.restore();
  }

  drawFocus(b) {
    const ctx = this.ctx;
    const w = b.w * TILE;
    const h = b.h * TILE;
    ctx.save();
    ctx.translate(b.tx * TILE, b.ty * TILE);
    ctx.strokeStyle = "#d7b056";
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.restore();
  }

  drawUnit(u, youId) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(u.x, u.y);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(2, 10, u.r, u.r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(u.aim);
    ctx.fillStyle = u.color;
    ctx.beginPath();
    ctx.arc(0, 0, u.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1a140c";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#1a140c";
    ctx.fillRect(u.r - 4, -3, 14, 6);
    ctx.restore();
    ctx.save();
    ctx.translate(u.x, u.y);
    if (u.name) {
      ctx.fillStyle = "rgba(12,16,14,0.7)";
      ctx.fillRect(-28, -u.r - 22, 56, 12);
      ctx.fillStyle = "#e8dfc8";
      ctx.font = "10px Figtree, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(u.name, 0, -u.r - 13);
    }
    bar(ctx, -16, u.r + 8, 32, u.hp / u.maxHp, u.id === youId ? "#d7b056" : "#c4453c");
    ctx.restore();
  }

  drawLoot(l) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.fillStyle = RESOURCES[l.resource].color;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1a140c";
    ctx.stroke();
    ctx.restore();
  }

  drawShot(p) {
    const ctx = this.ctx;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 1, 0, Math.PI * 2);
    ctx.fill();
  }

  stepParticles(dt) {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 40 * dt;
      if (p.life <= 0) return false;
      ctx.globalAlpha = p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return true;
    });
  }

  drawMinimap(state, youId) {
    const ctx = this.mctx;
    const s = this.minimap.width;
    ctx.fillStyle = "#152018";
    ctx.fillRect(0, 0, s, s);
    const scale = s / WORLD_SIZE;
    ctx.fillStyle = "#c4453c";
    for (const b of state.minimap || []) {
      ctx.fillStyle = b.npc ? "#c4453c" : "#d7b056";
      ctx.fillRect(b.x * scale - 2, b.y * scale - 2, 4, 4);
    }
    const you = state.units.find((u) => u.id === youId);
    if (you) {
      ctx.fillStyle = "#e8dfc8";
      ctx.beginPath();
      ctx.arc(you.x * scale, you.y * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(215,176,86,0.4)";
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
  }
}

function blob(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

function rounded(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function bar(ctx, x, y, w, t, color) {
  ctx.fillStyle = "#1a140c";
  ctx.fillRect(x, y, w, 6);
  ctx.strokeStyle = "rgba(232, 223, 200, 0.35)";
  ctx.strokeRect(x, y, w, 6);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, t)), 6);
}

function drawKind(ctx, type, w, h, rot, own) {
  const stroke = "#1a140c";
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  if (type === "wall_wood") {
    ctx.fillStyle = own ? "#b6793a" : "#8a5a32";
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.strokeStyle = "rgba(40,20,8,0.45)";
    for (let i = 10; i < h - 6; i += 10) {
      ctx.beginPath();
      ctx.moveTo(6, i);
      ctx.lineTo(w - 6, i);
      ctx.stroke();
    }
  } else if (type === "wall_stone") {
    ctx.fillStyle = own ? "#8d97a6" : "#66707e";
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.fillStyle = "rgba(20,24,28,0.18)";
    ctx.fillRect(4, 4, (w - 8) / 2, (h - 8) / 2);
    ctx.fillRect(w / 2, h / 2, (w - 8) / 2, (h - 8) / 2);
  } else if (type === "gate") {
    ctx.fillStyle = own ? "#c9843c" : "#7d4e28";
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.fillStyle = "#1c241c";
    if (rot % 2 === 0) ctx.fillRect(w * 0.32, 6, w * 0.36, h - 12);
    else ctx.fillRect(6, h * 0.32, w - 12, h * 0.36);
    ctx.strokeRect(2, 2, w - 4, h - 4);
  } else if (type === "spikes") {
    ctx.fillStyle = "#4a4034";
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.fillStyle = "#cfd3d8";
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const px = 10 + i * 14;
        const py = 10 + j * 14;
        ctx.beginPath();
        ctx.moveTo(px, py - 7);
        ctx.lineTo(px + 5, py + 5);
        ctx.lineTo(px - 5, py + 5);
        ctx.fill();
      }
    }
  } else if (type === "core") {
    ctx.fillStyle = own ? "#5a3d24" : "#3d2424";
    ctx.fillRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = own ? "#d7b056" : "#c4453c";
    ctx.beginPath();
    ctx.moveTo(w / 2, 10);
    ctx.lineTo(w - 14, w / 2);
    ctx.lineTo(w / 2, h - 10);
    ctx.lineTo(14, h / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e8dfc8";
    ctx.fillRect(w / 2 - 3, 4, 6, 18);
  } else if (type === "mill") {
    ctx.fillStyle = "#6b4423";
    ctx.fillRect(6, 18, w - 12, h - 24);
    ctx.fillStyle = "#8b5a2b";
    ctx.beginPath();
    ctx.moveTo(8, 22);
    ctx.lineTo(w / 2, 6);
    ctx.lineTo(w - 8, 22);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#cfd3d8";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2 + 6, 10, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "quarry") {
    ctx.fillStyle = "#5d6570";
    ctx.fillRect(8, 16, w - 16, h - 24);
    ctx.fillStyle = "#9aa4b2";
    poly(ctx, [[16, h - 12], [28, 22], [w - 20, 18], [w - 12, h - 14]]);
    ctx.fillStyle = "#7a8490";
    ctx.fillRect(w / 2 - 4, 8, 8, h - 22);
  } else if (type === "goldmine") {
    ctx.fillStyle = "#3a3228";
    ctx.fillRect(8, 16, w - 16, h - 22);
    ctx.fillStyle = "#1a140c";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2 + 4, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#efc94a";
    ctx.beginPath();
    ctx.arc(w / 2 + 4, h / 2, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "tower_arrow" || type === "tower_cannon") {
    ctx.fillStyle = own ? "#70543a" : "#4a3030";
    rounded(ctx, 10, 14, w - 20, h - 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = own ? "#d7b056" : "#c4453c";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, type === "tower_cannon" ? 14 : 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a140c";
    if (type === "tower_cannon") ctx.fillRect(w / 2, h / 2 - 4, 22, 8);
    else ctx.fillRect(w / 2, h / 2 - 2, 20, 4);
  } else {
    ctx.fillStyle = "#4a4034";
    ctx.fillRect(4, 4, w - 8, h - 8);
  }
}

export function paintIcon(canvas, type) {
  const ctx = canvas.getContext("2d");
  canvas.width = 32;
  canvas.height = 32;
  ctx.translate(2, 2);
  drawKind(ctx, type, 28, 28, 0, true);
}
