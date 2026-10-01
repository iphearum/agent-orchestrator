// Renders exact poses (no clock, no easing) so acts and gaze can be checked frame-accurately. Headless Chrome's
// virtual time runs too few animation frames for the hero's eased real-time loop to reach its targets.
//
//   bun .claude/skills/robot-3d/scripts/pose-probe.ts   # → .ui-check/robot-probe.png (acts at mid-point, gaze 3 ways)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const outDir = resolve(".ui-check");
mkdirSync(outDir, { recursive: true });
const entry = join(outDir, "pose-probe-entry.ts");
writeFileSync(entry, `
import { Engine } from "@babylonjs/core/Engines/engine";
import { applyPose, clonePose, createScene, lookToward, playOver, poseAt, PLAY_LENGTH } from "${resolve("webview-ui/src/robot-runtime.ts")}";
const shots: Array<[string, (pose: ReturnType<typeof poseAt>, baseYaw: number) => void]> = [
  ...Object.keys(PLAY_LENGTH).filter(k => !["turn-around", "walk", "dance"].includes(k)).map(kind => [kind, (pose: any) => playOver(pose, kind as any, 0.5)] as [string, any]),
  // Locomotion is sampled at several points: mid-spin, walking each way, turning between.
  ...([["turn-around", 0.2], ["turn-around", 0.45], ["turn-around", 0.7], ["walk", 0.2], ["walk", 0.3], ["walk", 0.48], ["walk", 0.7], ["dance", 0.3], ["dance", 0.42]] as const)
    .map(([kind, u]) => [kind + " " + u, (pose: any) => playOver(pose, kind as any, u)] as [string, any]),
  ["look left", (pose: any, yaw: number) => lookToward(pose, -1, -0.2, 1, yaw)],
  ["look center", (pose: any, yaw: number) => lookToward(pose, 0, 0, 1, yaw)],
  ["look right", (pose: any, yaw: number) => lookToward(pose, 1, -0.2, 1, yaw)],
  ["look down", (pose: any, yaw: number) => lookToward(pose, 0.2, 1, 1, yaw)]
];
(async () => {
  for (const [name, apply] of shots) {
    // One engine at a time, copied to an <img> and disposed: browsers drop WebGL contexts beyond ~16.
    const figure = document.createElement("figure");
    const canvas = document.createElement("canvas");
    canvas.width = 150; canvas.height = 300;
    const image = new Image(150, 300);
    figure.append(image, Object.assign(document.createElement("figcaption"), { textContent: name }));
    document.body.append(figure);
    const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    const { scene, robot } = createScene(engine, "hero");
    await scene.whenReadyAsync();
    const pose = poseAt("idle", 0);
    apply(pose, robot.baseYaw);
    applyPose(robot, clonePose(pose), pose, 1);
    scene.render();
    image.src = canvas.toDataURL("image/png");
    scene.dispose();
    engine.dispose();
  }
  document.body.dataset.done = "1";
})().catch(e => { document.body.dataset.err = String(e); });
`);
const bundle = join(outDir, "pose-probe.js");
const build = Bun.spawnSync(["bun", "build", entry, "--target=browser", "--format=iife", "--outfile", bundle], { stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) { console.error(build.stderr.toString()); process.exit(1); }
const page = join(outDir, "pose-probe.html");
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:10px;background:#1e1e1e;color:#ccc;font:11px sans-serif;display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;display:grid;justify-items:center;gap:4px}img{background:linear-gradient(#a7c6d4,#9ac0cf);border-radius:8px}</style></head><body><script src="pose-probe.js"></script></body></html>`);
const chrome = [process.env.CHROME, ...["google-chrome", "chromium", "chromium-browser"].map(n => Bun.which(n) ?? undefined)].find((p): p is string => Boolean(p && existsSync(p)));
if (!chrome) { console.error("No Chrome found; set CHROME."); process.exit(1); }
const flags = ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-device-scale-factor=1", "--virtual-time-budget=30000"];
const dom = Bun.spawnSync([chrome, ...flags, "--dump-dom", pathToFileURL(page).href], { stdout: "pipe" }).stdout.toString();
console.log(`errors: ${dom.match(/data-err="([^"]*)"/)?.[1] ?? "none"}; ${dom.includes('data-done="1"') ? "all shots rendered" : "not finished"}`);
const png = join(outDir, "robot-probe.png");
Bun.spawnSync([chrome, ...flags, "--window-size=1000,1000", `--screenshot=${png}`, pathToFileURL(page).href], { stdout: "pipe", stderr: "pipe" });
console.log(existsSync(png) ? `probe: ${png}` : "probe screenshot failed");
