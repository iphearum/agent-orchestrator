// Render a baked bot through the real runtime (createBotScene + poseAt/playOver/applyPose) at exact poses, so
// rigging problems show without waiting on the eased hero loop. Needs `bun run build`-free access to
// webview-ui/src/robot-runtime.ts and media/bots/<bot>.bin (run scripts/bake-bots.ts first).
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot>             every state mid-loop, every act, 4 avatar faces
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> labels      parts coloured by bone: front / right / back / left
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> "<shot>"    one shot large, e.g. working, "walk 0.3", stretch
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> --stretch   no images: per shot, how far triangles stretch from rest
//                                                                 (worst edge ratio and where). Over ×3 is a tear (crack,
//                                                                 sliver, flap) and exits 1; ×2–3 is a hard bend ("~")
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> --faces     head close-ups of every eye shape, mouth, wink and tone
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> --fit       on the chat window's 170×300 hero canvas: every state,
//                                                                 act and 12 flights played with springs; per run the
//                                                                 smallest margin (px) to each edge. Exits 1 if clipped
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> --paths     3 seeded flight paths per shape (front and top views)
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> --motion fly [seed]  one seeded flight (other acts ignore the seed)
//   bun .claude/skills/glb-bot/scripts/probe.ts <bot> --motion <act>  the act played at 30 fps through the hero's spring
//                                                                 and face-motion layers (eye lead, squash, blinks), 12 frames
//   → .ui-check/glb-bot/probe-<bot>[-<mode>].png
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OUT, runPage, screenshot, withServer } from "./lib";

const bot = process.argv[2];
if (!bot) { console.error("usage: probe.ts <bot> [labels|<shot>]"); process.exit(1); }
const STRETCH = process.argv[3] === "--stretch";
const FACES = process.argv[3] === "--faces";
const MOTION = process.argv[3] === "--motion" ? (process.argv[4] ?? "giggle") : undefined;
const SEED = Number(process.argv[5] ?? 1);
const PATHS = process.argv[3] === "--paths";
const FIT = process.argv[3] === "--fit";
const only = STRETCH || FACES || MOTION || PATHS || FIT ? undefined : process.argv[3];
const [W, H] = FIT ? [170, 300] : only === "labels" ? [300, 540] : only ? [520, 940] : MOTION ? [200, 360] : [150, 270];
const tag = PATHS ? "-paths" : FACES ? "-faces" : MOTION ? `-motion-${MOTION}` : only ? `-${only.replace(/\W+/g, "-")}` : "";
const entry = join(OUT, `probe-${bot}-entry.ts`);
writeFileSync(entry, `
import { Engine } from "@babylonjs/core/Engines/engine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { flightPath, applyPose, clonePose, createBotScene, express, EXPRESSIONS, faceMotion, locomote, playOver, playsFor, poseAt, PLAY_LENGTH } from ${JSON.stringify(resolve("webview-ui/src/robot-runtime.ts"))};
(window as any).AgentRobot3DBotsBase = "/media/bots/";
const BOT = ${JSON.stringify(bot)} as any;
const ONLY = ${JSON.stringify(only ?? null)};
const STATES = ["idle", "listening", "thinking", "working", "talking", "happy", "error"] as const;
// A moment in each state's loop where its signature motion is visible.
const AT = { idle: 1.1, listening: 0.8, thinking: 1.2, working: 0.5, talking: 0.7, happy: 0.6, error: 1.0 };
// The bot's locomotion ("walk" | "fly" | "both"), set once the bot is built; every shot plays in it.
let MODE: any = "walk";
let ROOM: any = undefined;
const act = (k: string, u: number) => () => { const p = poseAt("idle", 0); playOver(p, k as any, u, MODE, 1, ROOM); locomote(p, MODE, u * (PLAY_LENGTH as any)[k], ROOM); return p; };
const state = (st: (typeof STATES)[number]) => () => { const p = poseAt(st, AT[st]); locomote(p, MODE, AT[st], ROOM); return p; };
let shots: Array<[string, () => any]> = [];
const listShots = () => {
  const plays = ["giggle", ...playsFor(MODE)];
  shots = [
    ...STATES.map(st => [st, state(st)] as [string, () => any]),
    ...plays.filter(k => !["turn-around", "walk", "dance", "fly"].includes(k)).map(k => [k, act(k, 0.5)] as [string, () => any]),
    ...([["turn-around", 0.3], ["walk", 0.3], ["walk", 0.62], ["dance", 0.3], ["dance", 0.42], ["fly", 0.25], ["fly", 0.55]] as const)
      .filter(([k]) => plays.includes(k)).map(([k, u]) => [k + " " + u, act(k, u)] as [string, () => any]),
  ];
};
// Bone colours, in scripts/bake-bots.ts BONES order.
const PALETTE = [[0.5,0.5,0.5],[0.95,0.95,0.95],[1,0.85,0.2],[1,0,1],[0.9,0.2,0.2],[1,0.6,0.6],[0.2,0.4,1],[0.6,0.75,1],[0.1,0.7,0.2],[0.5,0.95,0.4],[0.05,0.35,0.1],[0.6,0.2,0.8],[0.85,0.6,1],[0.3,0.1,0.45]];
const show = (canvas: HTMLCanvasElement, w: number, h: number, caption: string, cls = "") => {
  const fig = document.createElement("figure");
  const img = new Image(w, h); img.src = canvas.toDataURL("image/png"); img.className = cls;
  fig.append(img, Object.assign(document.createElement("figcaption"), { textContent: caption }));
  document.body.append(fig);
};
(async () => {
  const canvas = document.createElement("canvas"); canvas.width = ${W}; canvas.height = ${H};
  const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const { scene, robot } = await createBotScene(engine, "hero", BOT);
  MODE = robot.locomotion ?? "walk";
  ROOM = robot.room;
  listShots();
  if (ONLY === "labels") {
    const mesh = scene.getMeshByName("bot-" + BOT + "-body")!;
    const j = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)!;
    const w = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!;
    const colors: number[] = [];
    for (let i = 0; i < j.length / 4; i++) colors.push(...(PALETTE[w[4 * i] >= w[4 * i + 1] ? j[4 * i] : j[4 * i + 1]] ?? [0, 0, 0]), 1);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    const flat = new PBRMaterial("labels", scene); flat.unlit = true; flat.albedoColor.set(1, 1, 1); flat.backFaceCulling = false;
    mesh.material = flat;
    await scene.whenReadyAsync();
    for (const [yaw, label] of [[0, "front"], [Math.PI / 2, "from -X (its left side)"], [Math.PI, "back"], [-Math.PI / 2, "from +X (its right side)"]] as const) {
      robot.root.rotation.y = yaw; scene.render(); show(canvas, ${W}, ${H}, label);
    }
    document.body.dataset.done = "1";
    return;
  }
  await scene.whenReadyAsync();
  if (${FIT}) {
    // The bot's silhouette (alpha > 0.5; the soft shadow is fainter) per frame, as the hero plays it.
    const runs: Array<[string, (t: number) => any, number]> = [
      ...STATES.map(st => [st, (t: number) => { const p = poseAt(st, t); locomote(p, MODE, t, ROOM); return p; }, 6] as [string, (t: number) => any, number]),
      ...[...playsFor(MODE), "giggle"].filter(k => k !== "fly").map(k => [k, (t: number) => { const p = poseAt("idle", t); playOver(p, k as any, t / (PLAY_LENGTH as any)[k], MODE, 1, ROOM); locomote(p, MODE, t, ROOM); return p; }, (PLAY_LENGTH as any)[k]] as [string, (t: number) => any, number]),
    ];
    if (playsFor(MODE).includes("fly" as any)) for (let seed = 1; seed <= 12; seed++) {
      const shape = flightPath(seed, MODE !== "fly", ROOM).shape;
      runs.push(["fly #" + seed + " " + shape, (t: number) => { const p = poseAt("idle", t); playOver(p, "fly", t / (PLAY_LENGTH as any).fly, MODE, seed, ROOM); locomote(p, MODE, t, ROOM); return p; }, (PLAY_LENGTH as any).fly]);
    }
    const report: any[] = [{ name: "room", top: ROOM ? +ROOM.up.toFixed(2) : -1, bottom: 0, left: ROOM ? +ROOM.side.toFixed(2) : -1, right: 0, note: true }];
    for (const [name, at, length] of runs) {
      const current = poseAt("idle", 0);
      const springs: any = { dt: 1 / 30, velocity: new Map(), face: faceMotion() };
      const m = { top: ${H}, bottom: ${H}, left: ${W}, right: ${W}, seen: 0 };
      for (let f = 0; f <= Math.round(length * 30); f++) {
        applyPose(robot, current, at(f / 30), 1 - Math.exp(-springs.dt * 7), springs);
        if (f % 3) continue;
        scene.render();
        const px = await engine.readPixels(0, 0, ${W}, ${H}) as Uint8Array;
        let x0 = ${W}, x1 = -1, y0 = ${H}, y1 = -1;
        for (let y = 0; y < ${H}; y++) for (let x = 0; x < ${W}; x++) if (px[(y * ${W} + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) continue;
        m.seen++;
        // readPixels rows run bottom-up.
        m.top = Math.min(m.top, ${H} - 1 - y1); m.bottom = Math.min(m.bottom, y0); m.left = Math.min(m.left, x0); m.right = Math.min(m.right, ${W} - 1 - x1);
      }
      report.push({ name, ...m });
    }
    document.body.dataset.result = JSON.stringify(report);
    document.body.dataset.done = "1";
    return;
  }
  if (${PATHS}) {
    // Front (x–y) and top (x–z) views of 12 seeded flights, with the region the hero frame keeps in view.
    const grounded = MODE !== "fly";
    const room = ROOM;
    // Three seeds of each shape.
    const seeds: number[] = [], per: Record<string, number> = {};
    for (let k = 1; seeds.length < 12 && k < 500; k++) { const shape = flightPath(k, grounded, room).shape; if ((per[shape] = (per[shape] ?? 0) + 1) <= 3) seeds.push(k); }
    seeds.sort((a, b) => flightPath(a, grounded, room).shape.localeCompare(flightPath(b, grounded, room).shape));
    for (const k of seeds) {
      const flight = flightPath(k, grounded, room);
      const c = document.createElement("canvas"); c.width = 260; c.height = 130;
      const g = c.getContext("2d")!;
      g.fillStyle = "#2a2d33"; g.fillRect(0, 0, 260, 130);
      const views: Array<[number, (p: number[]) => [number, number], string]> = [[0, p => [65 - p[0] * 100, 115 - p[1] * 100], "front"], [130, p => [65 - p[0] * 100, 65 - p[2] * 60], "top"]];
      for (const [ox, map, label] of views) {
        g.strokeStyle = "#556"; g.strokeRect(ox + 5, 5, 120, 120);
        g.fillStyle = "#99a"; g.font = "10px sans-serif"; g.fillText(label, ox + 8, 16);
        g.beginPath();
        for (let i = 0; i <= 100; i++) { const [x, y] = map(flight.at(i / 100)); i ? g.lineTo(ox + x, y) : g.moveTo(ox + x, y); }
        g.strokeStyle = "#5fd0ff"; g.lineWidth = 2; g.stroke();
        const [sx, sy] = map([0, 0, 0]); g.fillStyle = "#ff7ad9"; g.fillRect(ox + sx - 3, sy - 3, 6, 6);
      }
      show(c, 260, 130, "seed " + k + " · " + flight.shape);
    }
    document.body.dataset.done = "1";
    return;
  }
  if (${JSON.stringify(Boolean(FACES))}) {
    // Every expression on the avatar close-up (static: no motion layer).
    const ac = document.createElement("canvas"); ac.width = 220; ac.height = 220;
    const studio = await createBotScene(new Engine(ac, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true }), "avatar", BOT);
    await studio.scene.whenReadyAsync();
    // Every expression preset, as this bot's rig draws it (its wiring applies: "a → b" marks a re-wired preset).
    const wire = (studio.robot as any).faceWire ?? {};
    const motion: Record<string, any> = { laugh: { open: 0.8 }, surprised: { open: 0.5 }, curious: { open: 0.2 }, yawn: { open: 1, lid: 0.6 }, smug: { lid: 0.7 }, talking: { open: 0.6 }, thinking: { open: 1 }, sleepy: { lid: 0.6 } };
    for (const name of Object.keys(EXPRESSIONS)) {
      const pose = poseAt("idle", 0); Object.assign(pose.face, { lookX: 0, lookY: 0 }, motion[name] ?? {});
      express(pose.face, name as any);
      const label = wire[name] ? name + " → " + wire[name] : name;
      applyPose(studio.robot, clonePose(pose), pose, 1); studio.scene.render();
      show(ac, 130, 130, label, "avatar");
    }
    document.body.dataset.done = "1";
    return;
  }
  if (${JSON.stringify(MOTION ?? null)}) {
    // The act played at 30 fps exactly as the hero loop does (eased pose, springs, face motion), 12 frames sampled.
    const kind = ${JSON.stringify(MOTION ?? "")} as any;
    const length = (PLAY_LENGTH as any)[kind] ?? 2;
    const current = poseAt("idle", 0);
    const springs: any = { dt: 1 / 30, velocity: new Map(), face: faceMotion() };
    const frames = Math.round(length * 30), every = Math.max(1, Math.floor(frames / 12));
    for (let f = 0; f <= frames; f++) {
      const target = poseAt("idle", f / 30);
      playOver(target, kind, f / frames, MODE, ${SEED}, ROOM);
      locomote(target, MODE, f / 30, ROOM);
      applyPose(robot, current, target, 1 - Math.exp(-springs.dt * 7), springs);
      if (f % every === 0 && f / every < 12) { scene.render(); show(canvas, ${W}, ${H}, kind + " " + (f / 30).toFixed(2) + "s"); }
    }
    document.body.dataset.done = "1";
    return;
  }
  if (${STRETCH}) {
    // Skinned positions per shot vs rest: a crack, sliver or flap is a triangle whose edge grows far beyond its
    // rest length. Edges under 0.01 are skipped (sub-pixel slivers stretch harmlessly by large ratios).
    const mesh = scene.getMeshByName("bot-" + BOT + "-body")!;
    const rest = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const idx = mesh.getIndices()!;
    const report: any[] = [];
    for (const [name, make] of shots) {
      const pose = make();
      applyPose(robot, clonePose(pose), pose, 1);
      scene.render();
      const posed = mesh.getPositionData(true)!;
      let worst = 1, at = [0, 0, 0], over = 0;
      for (let t = 0; t < idx.length; t += 3) {
        let ratio = 1;
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
          const i = idx[t + a] * 3, j = idx[t + b] * 3;
          const r0 = Math.hypot(rest[i] - rest[j], rest[i + 1] - rest[j + 1], rest[i + 2] - rest[j + 2]);
          if (r0 < 0.01) continue;
          ratio = Math.max(ratio, Math.hypot(posed[i] - posed[j], posed[i + 1] - posed[j + 1], posed[i + 2] - posed[j + 2]) / r0);
        }
        if (ratio > 3) over++;
        if (ratio > worst) { worst = ratio; const i = idx[t] * 3; at = [rest[i], rest[i + 1], rest[i + 2]]; }
      }
      report.push({ name, worst: +worst.toFixed(2), over, at: at.map(v => +v.toFixed(2)) });
    }
    document.body.dataset.result = JSON.stringify(report);
    document.body.dataset.done = "1";
    return;
  }
  for (const [name, make] of shots) {
    if (ONLY && name !== ONLY) continue;
    const pose = make();
    applyPose(robot, clonePose(pose), pose, 1);
    scene.render();
    show(canvas, ${W}, ${H}, name);
  }
  if (ONLY) { document.body.dataset.done = shots.some(([n]) => n === ONLY) ? "1" : ""; if (!shots.some(([n]) => n === ONLY)) document.body.dataset.err = "no shot named " + ONLY + "; try " + shots.map(([n]) => n).join(", "); return; }
  const ac = document.createElement("canvas"); ac.width = 256; ac.height = 256;
  const studio = await createBotScene(new Engine(ac, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true }), "avatar", BOT);
  await studio.scene.whenReadyAsync();
  for (const st of ["idle", "talking", "happy", "error"] as const) {
    const pose = poseAt(st, AT[st]); pose.face.bold = true;
    applyPose(studio.robot, clonePose(pose), pose, 1); studio.scene.render();
    show(ac, 96, 96, "avatar " + st, "avatar");
  }
  document.body.dataset.done = "1";
})().catch(e => { document.body.dataset.err = String(e && e.stack || e); });
`);
const build = Bun.spawnSync([process.execPath, "build", entry, "--target=browser", "--format=iife", "--outfile", join(OUT, `probe-${bot}.js`)], { stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) { console.error(build.stderr.toString()); process.exit(1); }
writeFileSync(join(OUT, `probe-${bot}.html`), `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:8px;background:#1e1e1e;color:#ccc;font:11px sans-serif;display:flex;flex-wrap:wrap;gap:6px}figure{margin:0;display:grid;justify-items:center;gap:3px}img{background:linear-gradient(#a7c6d4,#9ac0cf);border-radius:8px}img.avatar{background:#2f7bea;border-radius:50%}</style></head><body><script src="probe-${bot}.js"></script></body></html>`);

await withServer(async origin => {
  const url = `${origin}/.ui-check/glb-bot/probe-${bot}.html`;
  const { error, done, dom } = await runPage(url, FIT ? 600000 : undefined);
  if (FIT) {
    const report: Array<{ name: string; top: number; bottom: number; left: number; right: number }> = JSON.parse((dom.match(/data-result="([^"]*)"/)?.[1] ?? "[]").replace(/&quot;/g, '"'));
    const room = report.shift() as any;
    console.log(room.top < 0 ? "room: default (no hero room)" : `room: side ${room.left} units, up ${room.top} units`);
    for (const r of report) {
      // Nothing drawn at all (e.g. the camera past its far plane) counts as a failure, not as a wide margin.
      const worst = (r as any).seen ? Math.min(r.top, r.bottom, r.left, r.right) : -1;
      console.log(`${worst <= 0 ? "!" : worst < 6 ? "~" : " "} ${r.name.padEnd(22)} top ${String(r.top).padStart(3)}  bottom ${String(r.bottom).padStart(3)}  left ${String(r.left).padStart(3)}  right ${String(r.right).padStart(3)}`);
    }
    const clipped = report.filter(r => !(r as any).seen || Math.min(r.top, r.bottom, r.left, r.right) <= 0);
    console.log(error ? `errors: ${error}` : `fit (170×300): ${clipped.length ? `${clipped.length} of ${report.length} runs touch the edge (${clipped.map(r => r.name).join(", ")})` : `all ${report.length} runs inside; tightest margin ${Math.min(...report.map(r => Math.min(r.top, r.bottom, r.left, r.right)))} px`}`);
    process.exit(error || clipped.length ? 1 : 0);
  }
  if (STRETCH) {
    // The outside of a sharp bend stretches up to ~×2–3; a tear (an edge across a gap, a weld, a mislabelled part)
    // goes well past ×3 and reads as a streak, sliver or flap.
    const report: Array<{ name: string; worst: number; over: number; at: number[] }> = JSON.parse((dom.match(/data-result="([^"]*)"/)?.[1] ?? "[]").replace(/&quot;/g, '"'));
    for (const r of report) console.log(`${r.over ? "!" : r.worst > 2 ? "~" : " "} ${r.name.padEnd(16)} worst ×${r.worst.toFixed(2)} at ${r.at.join(",")}${r.over ? `  — ${r.over} triangles over ×3` : ""}`);
    const bad = report.filter(r => r.over).length;
    console.log(error ? `errors: ${error}` : `stretch: ${bad ? `${bad} of ${report.length} shots tear (triangles over ×3)` : `no tears in ${report.length} shots (worst ×${Math.max(...report.map(r => r.worst)).toFixed(2)})`}`);
    process.exit(error || bad ? 1 : 0);
  }
  console.log(`errors: ${error ?? "none"}; ${done ? "all shots rendered" : "not finished"}`);
  const png = join(OUT, `probe-${bot}${tag}.png`);
  const size: [number, number] = PATHS ? [1100, 560] : FACES ? [1100, 520] : MOTION ? [1300, 900] : only === "labels" ? [1260, 590] : only ? [560, 1000] : [1300, 1180];
  console.log((await screenshot(url, png, ...size)) ? `probe: ${png}` : "screenshot failed");
  if (error) process.exit(1);
});
