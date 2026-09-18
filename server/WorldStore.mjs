import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class WorldStore {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        wood INTEGER NOT NULL DEFAULT 0,
        stone INTEGER NOT NULL DEFAULT 0,
        gold INTEGER NOT NULL DEFAULT 0,
        x REAL NOT NULL,
        y REAL NOT NULL,
        hp REAL NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS buildings (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        tx INTEGER NOT NULL,
        ty INTEGER NOT NULL,
        rot INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        hp REAL NOT NULL,
        owner_id TEXT,
        team TEXT,
        produce_acc REAL NOT NULL DEFAULT 0,
        harvest_target TEXT
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tx INTEGER NOT NULL,
        ty INTEGER NOT NULL,
        hp REAL NOT NULL,
        alive INTEGER NOT NULL,
        respawn_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS factions (
        id TEXT PRIMARY KEY,
        name TEXT,
        npc INTEGER NOT NULL,
        color TEXT,
        core TEXT
      );
      CREATE TABLE IF NOT EXISTS npcs (
        id TEXT PRIMARY KEY,
        team TEXT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        hp REAL NOT NULL,
        home_x REAL,
        home_y REAL,
        color TEXT
      );
    `);
    this.migrate();
  }

  migrate() {
    const accCols = this.db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
    if (!accCols.includes("coins")) this.db.exec("ALTER TABLE accounts ADD COLUMN coins INTEGER NOT NULL DEFAULT 0");
    if (!accCols.includes("hero")) this.db.exec("ALTER TABLE accounts ADD COLUMN hero TEXT");
    if (!accCols.includes("t_wood")) this.db.exec("ALTER TABLE accounts ADD COLUMN t_wood INTEGER NOT NULL DEFAULT 0");
    if (!accCols.includes("t_stone")) this.db.exec("ALTER TABLE accounts ADD COLUMN t_stone INTEGER NOT NULL DEFAULT 0");
    if (!accCols.includes("t_gold")) this.db.exec("ALTER TABLE accounts ADD COLUMN t_gold INTEGER NOT NULL DEFAULT 0");
    if (!accCols.includes("last_death_x")) this.db.exec("ALTER TABLE accounts ADD COLUMN last_death_x REAL");
    if (!accCols.includes("last_death_y")) this.db.exec("ALTER TABLE accounts ADD COLUMN last_death_y REAL");
    if (!accCols.includes("pass_hash")) this.db.exec("ALTER TABLE accounts ADD COLUMN pass_hash TEXT NOT NULL DEFAULT ''");
    if (!accCols.includes("is_bot")) this.db.exec("ALTER TABLE accounts ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
    const facCols = this.db.prepare("PRAGMA table_info(factions)").all().map((c) => c.name);
    if (!facCols.includes("wood")) this.db.exec("ALTER TABLE factions ADD COLUMN wood INTEGER NOT NULL DEFAULT 48");
    if (!facCols.includes("stone")) this.db.exec("ALTER TABLE factions ADD COLUMN stone INTEGER NOT NULL DEFAULT 28");
    if (!facCols.includes("gold")) this.db.exec("ALTER TABLE factions ADD COLUMN gold INTEGER NOT NULL DEFAULT 12");
    if (!facCols.includes("threat")) this.db.exec("ALTER TABLE factions ADD COLUMN threat REAL NOT NULL DEFAULT 0");
    if (!facCols.includes("recruit_at")) this.db.exec("ALTER TABLE factions ADD COLUMN recruit_at INTEGER NOT NULL DEFAULT 0");
    if (!facCols.includes("desire")) this.db.exec("ALTER TABLE factions ADD COLUMN desire TEXT");
    if (!facCols.includes("job")) this.db.exec("ALTER TABLE factions ADD COLUMN job TEXT");
    const npcCols = this.db.prepare("PRAGMA table_info(npcs)").all().map((c) => c.name);
    if (!npcCols.includes("role")) this.db.exec("ALTER TABLE npcs ADD COLUMN role TEXT");
    if (!npcCols.includes("gather_kind")) this.db.exec("ALTER TABLE npcs ADD COLUMN gather_kind TEXT");
  }

  load() {
    const tick = this.getMeta("tick");
    if (tick == null) return null;
    return {
      tick: Number(tick) || 0,
      seq: Number(this.getMeta("seq") || 1),
      savedAt: Number(this.getMeta("saved_at") || Date.now()),
      accounts: this.db.prepare("SELECT * FROM accounts").all().map((a) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        wood: a.wood,
        stone: a.stone,
        gold: a.gold,
        tWood: a.t_wood ?? 0,
        tStone: a.t_stone ?? 0,
        tGold: a.t_gold ?? 0,
        coins: a.coins == null ? 18 : a.coins | 0,
        hero: a.hero,
        x: a.x,
        y: a.y,
        hp: a.hp,
        lastSeen: a.last_seen,
        lastDeathX: a.last_death_x ?? null,
        lastDeathY: a.last_death_y ?? null,
        passHash: a.pass_hash || "",
        isBot: a.is_bot ? 1 : 0,
      })),
      monsters: JSON.parse(this.getMeta("monsters") || "[]"),
      bots: JSON.parse(this.getMeta("bots") || "[]"),
      buildings: this.db.prepare("SELECT * FROM buildings").all().map((b) => ({
        id: b.id,
        type: b.type,
        tx: b.tx,
        ty: b.ty,
        rot: b.rot,
        level: b.level,
        hp: b.hp,
        ownerId: b.owner_id,
        team: b.team,
        produceAcc: b.produce_acc,
        harvestTargetId: b.harvest_target,
      })),
      nodes: this.db.prepare("SELECT * FROM nodes").all().map((n) => ({
        id: n.id,
        kind: n.kind,
        tx: n.tx,
        ty: n.ty,
        hp: n.hp,
        alive: n.alive,
        respawnAt: n.respawn_at,
      })),
      factions: this.db.prepare("SELECT * FROM factions").all().map((f) => ({
        id: f.id,
        name: f.name,
        npc: f.npc,
        color: f.color,
        core: f.core,
        wood: f.wood,
        stone: f.stone,
        gold: f.gold,
        threat: f.threat,
        recruitAt: f.recruit_at,
        desire: f.desire,
        job: f.job,
      })),
      npcs: this.db.prepare("SELECT * FROM npcs").all().map((n) => ({
        id: n.id,
        team: n.team,
        x: n.x,
        y: n.y,
        hp: n.hp,
        homeX: n.home_x,
        homeY: n.home_y,
        color: n.color,
        role: n.role || "guard",
        gatherKind: n.gather_kind || "",
      })),
    };
  }

  save(snap) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM accounts");
      this.db.exec("DELETE FROM buildings");
      this.db.exec("DELETE FROM nodes");
      this.db.exec("DELETE FROM factions");
      this.db.exec("DELETE FROM npcs");
      this.setMeta("tick", String(snap.tick || 0));
      this.setMeta("seq", String(snap.seq || 1));
      this.setMeta("saved_at", String(snap.savedAt || Date.now()));
      this.setMeta("monsters", JSON.stringify(snap.monsters || []));
      this.setMeta("bots", JSON.stringify(snap.bots || []));
      const insAcc = this.db.prepare(
        "INSERT INTO accounts(id,name,color,wood,stone,gold,t_wood,t_stone,t_gold,coins,hero,x,y,hp,last_seen,last_death_x,last_death_y,pass_hash,is_bot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const a of snap.accounts || []) {
        insAcc.run(
          a.id, a.name, a.color, a.wood, a.stone, a.gold,
          a.tWood || 0, a.tStone || 0, a.tGold || 0,
          a.coins || 0, a.hero || "{}", a.x, a.y, a.hp, a.lastSeen,
          a.lastDeathX ?? null, a.lastDeathY ?? null,
          a.passHash || "", a.isBot ? 1 : 0
        );
      }
      const insB = this.db.prepare(
        "INSERT INTO buildings(id,type,tx,ty,rot,level,hp,owner_id,team,produce_acc,harvest_target) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const b of snap.buildings || []) {
        insB.run(
          b.id, b.type, b.tx, b.ty, b.rot, b.level, b.hp,
          b.ownerId, b.team, b.produceAcc, b.harvestTargetId
        );
      }
      const insN = this.db.prepare(
        "INSERT INTO nodes(id,kind,tx,ty,hp,alive,respawn_at) VALUES (?,?,?,?,?,?,?)"
      );
      for (const n of snap.nodes || []) {
        insN.run(n.id, n.kind, n.tx, n.ty, n.hp, n.alive, n.respawnAt);
      }
      const insF = this.db.prepare(
        "INSERT INTO factions(id,name,npc,color,core,wood,stone,gold,threat,recruit_at,desire,job) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const f of snap.factions || []) {
        insF.run(
          f.id, f.name, f.npc, f.color, f.core,
          f.wood || 0, f.stone || 0, f.gold || 0,
          f.threat || 0, f.recruitAt || 0, f.desire || "", f.job || ""
        );
      }
      const insE = this.db.prepare(
        "INSERT INTO npcs(id,team,x,y,hp,home_x,home_y,color,role,gather_kind) VALUES (?,?,?,?,?,?,?,?,?,?)"
      );
      for (const n of snap.npcs || []) {
        insE.run(n.id, n.team, n.x, n.y, n.hp, n.homeX, n.homeY, n.color, n.role || "guard", n.gatherKind || "");
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  close() {
    this.db.close();
  }
}
