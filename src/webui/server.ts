import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Runtime, RuntimeEvent } from "../engine/runtime.js";
import { readRelationship, readMd, readSessionLog, sessionDate } from "../storage/md.js";
import { findStage } from "../presets/stages.js";
import type { ProfileConfig } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function startWebUI(rt: Runtime, port: number = 7777): Promise<string> {
  const token = crypto.randomBytes(16).toString("hex");
  const app = express();

  app.use(express.json());

  // Static files logic
  // in dev, src/webui/static
  // in prod dist is in root/dist, static is in root/src/webui/static
  let staticDir = path.join(__dirname, "static");
  if (!fs.existsSync(staticDir)) {
      staticDir = path.join(__dirname, "..", "src", "webui", "static");
  }

  app.get("/", (req, res) => {
    if (!req.query.token) {
      const landing = fs.readFileSync(path.join(staticDir, "landing.html"), "utf-8");
      return res.type("html").send(landing);
    }
    if (req.query.token !== token) {
      return res.status(401).send("bad token");
    }
    let html = fs.readFileSync(path.join(staticDir, "index.html"), "utf-8");
    html = html.replace("%%TOKEN%%", token);
    res.type("html").send(html);
  });

  app.use("/assets", express.static(path.join(staticDir, "assets")));



  // API State
  app.get("/api/state", async (req, res) => {
    if (req.query.token !== token) return res.status(401).json({ error: "bad token" });
    const snap = await getSnapshot(rt);
    res.json(snap);
  });

  // API Command
  app.post("/api/command", async (req, res) => {
    if (req.body.token !== token) return res.status(401).json({ ok: false, error: "bad token" });
    const line = req.body.line;
    if (!line || !line.startsWith(":")) return res.json({ ok: false, error: "invalid command" });

    try {
      const result = await handleCommand(rt, line);
      res.json({ ok: true, result });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });

  const server = app.listen(port, "0.0.0.0", () => {
    process.stderr.write(`[webui] listening on http://127.0.0.1:${port}/?token=${token}\n`);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (data: any) => {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  };

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.searchParams.get("token") !== token) {
      ws.close();
      return;
    }

    const snap = await getSnapshot(rt);
    ws.send(JSON.stringify({ type: "snapshot", data: snap }));
  });

  rt.on("event", (e: RuntimeEvent) => {
    broadcast({ type: "event", event: { ...e, t: Date.now() } });
  });

  return token;
}

async function getSnapshot(rt: Runtime) {
  let r: any = { score: { interest: 0, trust: 0, attraction: 0, annoyance: 0, cringe: 0 }, stage: "tg-given-cold" };
  try {
    r = await readRelationship(rt.cfg.slug);
  } catch (e) {}

  const stageLabel = findStage(r.stage as ProfileConfig["stage"])?.label || r.stage;

  return {
    profile: {
      slug: rt.cfg.slug,
      name: rt.cfg.name,
      age: rt.cfg.age,
      mode: rt.cfg.mode,
      nationality: rt.cfg.nationality,
      tz: rt.cfg.tz
    },
    stage: { id: r.stage, label: stageLabel },
    score: r.score,
    paused: (rt as any).paused,
    running: true,
    logs: [] // We don't keep full history in memory here currently, relying on live updates
  };
}

async function handleCommand(rt: Runtime, line: string): Promise<string> {
  const [head, ...rest] = line.slice(1).split(" ");
  switch (head) {
    case "status": return await rt.cmdStatus();
    case "reset": return await rt.cmdReset();
    case "stage": return await rt.cmdSetStage(rest.join(" "));
    case "wake": return await rt.cmdWake(rest[0]);
    case "debug": return await rt.cmdDebug(rest[0]);
    case "why": return await rt.cmdWhy(rest[0]);
    case "amnesia": return await rt.cmdAmnesia(rest[0], rest[1]);
    case "block": return await rt.cmdBlock(rest[0]);
    case "unblock": return await rt.cmdUnblock(rest[0]);
    case "read": return await rt.cmdRead(rest[0]);
    case "clear-chat": return await rt.cmdClearChat(rest.find(x => !x.startsWith("--")), rest.includes("--revoke"));
    case "report-spam": return await rt.cmdReportSpam(rest[0]);
    case "delete-last": return await rt.cmdDeleteLast(rest.find(x => !x.startsWith("--")), !rest.includes("--local"));
    case "edit-last": return await rt.cmdEditLast(rest.join(" "));
    case "sticker": return await rt.cmdSticker(rest[0]);
    case "pause": rt.pause(); return "⏸ pause";
    case "resume": rt.resume(); return "▶ resume";
    case "cringe": {
      const r = await readRelationship(rt.cfg.slug);
      return `cringe=${r.score.cringe}; см. memory/long-term.md и log/`;
    }
    case "relationship": {
      const r = await readRelationship(rt.cfg.slug);
      return `stage=${r.stage} score=${JSON.stringify(r.score)}`;
    }
    case "persona": {
      const p = await readMd(rt.cfg.slug, "persona.md");
      return p.slice(0, 4000);
    }
    case "log": {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(rest[0] ?? "") ? rest[0]! : sessionDate(rt.cfg.tz);
      const limit = Number(rest.find(x => /^\d+$/.test(x)) ?? 3000);
      const p = await readSessionLog(rt.cfg.slug, day);
      return p.trim() ? p.slice(-Math.max(500, Math.min(limit, 20000))) : `(log/${day}.md пуст)`;
    }
    case "help":
      return ":status :why :amnesia :reset :stage :wake :debug :pause :resume :cringe :relationship :persona :log :block :unblock :read :clear-chat :report-spam :delete-last :edit-last :sticker :snapshot :quit";
    case "quit":
    case "exit":
      setTimeout(() => rt.stop().then(() => process.exit(0)), 100);
      return "bye";
    default:
      throw new Error(`неизвестная команда: ${head}`);
  }
}
