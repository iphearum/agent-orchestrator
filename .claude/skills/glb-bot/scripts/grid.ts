// Orthographic measuring views of a .glb, normalised exactly as scripts/bake-bots.ts does (X mirrored like Babylon's
// glTF loader, 8.7 units tall, floor at y = 0, centred in X/Z), with a 0.25-unit grid. Read joint positions straight
// off these, never off a perspective render.
//   bun .claude/skills/glb-bot/scripts/grid.ts backend/src/bots/<name>.glb [--y0=-0.3] [--y1=9.3] [--yaw=0] [--cx=0] [--cz=0] [--beta=90]
// --beta tilts the camera (degrees from straight up; > 90 looks up from below; the rulers are then only a guide).
// --cx/--cz centre the views there (for a zoomed --y0/--y1 window off the body's centre line). --yaw turns the model about Y (degrees, same convention as a bot's `yaw` in the bake CONFIG) before normalising.
//   → .ui-check/glb-bot/grid-<name>-front-side.png   front (+Z camera, screen-right = −X) | side (+X camera, screen-right = +Z)
//   → .ui-check/glb-bot/grid-<name>-back-side.png    back (−Z camera, screen-right = +X) | side (−X camera, screen-right = −Z)
// Loads Babylon + its glTF loader from cdn.babylonjs.com (preview only; the runtime never loads GLBs).
import { writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { OUT, runPage, withServer } from "./lib";

const file = process.argv[2];
if (!file) { console.error("usage: grid.ts <file.glb> [--y0=-0.3] [--y1=9.3] [--yaw=0]"); process.exit(1); }
const arg = (name: string, fallback: number) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const name = basename(file).replace(/\.glb$/i, "");
const glbUrl = "/" + relative(resolve("."), resolve(file)).split("\\").join("/");
const W = 560, H = 760;

const page = (views: Array<[string, number, string]>) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:4px;background:#fff;font:11px monospace;display:flex;gap:4px}
.v{position:relative;width:${W}px;height:${H}px}.v img,.v canvas{position:absolute;inset:0;width:100%;height:100%}
.v b{position:absolute;left:6px;top:4px;background:#fff8;padding:1px 4px;font-size:13px}
</style></head><body>
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script src="https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js"></script>
<script>
const W = ${W}, HH = ${H}, Y0 = ${arg("y0", -0.3)}, Y1 = ${arg("y1", 9.3)}, SX = (Y1 - Y0) * W / HH / 2, CX = ${arg("cx", 0)}, CZ = ${arg("cz", 0)};
const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = HH;
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
(async () => {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
  const res = await BABYLON.SceneLoader.ImportMeshAsync("", "", ${JSON.stringify(glbUrl)}, scene);
  const root = res.meshes[0];
  const holder = new BABYLON.TransformNode("holder", scene);
  const spin = new BABYLON.TransformNode("spin", scene); spin.parent = holder; root.parent = spin;
  spin.rotation.y = ${arg("yaw", 0)} * Math.PI / 180;
  // Bounds from the vertices themselves: a turned mesh's bounding box is the rotated box's AABB, which is too wide.
  const min = new BABYLON.Vector3(Infinity, Infinity, Infinity), max = min.scale(-1), v = new BABYLON.Vector3();
  for (const m of res.meshes) {
    const data = m.getPositionData?.();
    if (!data) continue;
    const world = m.computeWorldMatrix(true);
    for (let i = 0; i < data.length; i += 3) {
      BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(data[i], data[i + 1], data[i + 2], world, v);
      min.minimizeInPlace(v); max.maximizeInPlace(v);
    }
  }
  const s = 8.7 / (max.y - min.y);
  holder.scaling.setAll(s);
  holder.position.set(-(min.x + max.x) / 2 * s, -min.y * s, -(min.z + max.z) / 2 * s);
  new BABYLON.HemisphericLight("h", new BABYLON.Vector3(0.2, 1, 0.6), scene).intensity = 1.6;
  scene.createDefaultEnvironment({ createGround: false, createSkybox: false });
  const cam = new BABYLON.ArcRotateCamera("c", 0, ${arg("beta", 90)} * Math.PI / 180, 30, new BABYLON.Vector3(CX, (Y0 + Y1) / 2, CZ), scene);
  cam.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  cam.orthoLeft = -SX; cam.orthoRight = SX; cam.orthoTop = (Y1 - Y0) / 2; cam.orthoBottom = -(Y1 - Y0) / 2;
  await scene.whenReadyAsync();
  // The page composites the sheet itself (render + grid per view, side by side) and hands back a PNG data URL, so
  // there's no screenshot to race against loading.
  const sheet = document.createElement("canvas"); sheet.width = W * ${views.length}; sheet.height = HH;
  const sc = sheet.getContext("2d"); sc.fillStyle = "#fff"; sc.fillRect(0, 0, sheet.width, HH);
  let slot = 0;
  for (const [label, alpha, axis] of ${JSON.stringify(views)}) {
    cam.alpha = alpha; scene.render();
    const x0 = W * slot++;
    sc.drawImage(canvas, x0, 0);
    const c = sc;
    c.save(); c.translate(x0, 0);
    // axis: which model coordinate grows to the screen's right ("x", "-x", "z", "-z").
    const sign = axis.startsWith("-") ? -1 : 1;
    const centre = axis.endsWith("x") ? CX : CZ;
    const px = u => W / 2 + sign * (u - centre) / SX * W / 2;
    const py = v => (Y1 - v) / (Y1 - Y0) * HH;
    c.font = "10px monospace";
    for (let v = Math.ceil(Y0 * 4) / 4; v <= Y1; v += 0.25) {
      c.strokeStyle = Math.abs(v % 1) > 1e-6 ? "rgba(0,120,255,0.18)" : "rgba(0,120,255,0.6)";
      c.beginPath(); c.moveTo(0, py(v)); c.lineTo(W, py(v)); c.stroke();
      if (Math.abs(v * 2 % 1) < 1e-6) { c.fillStyle = "#06c"; c.fillText(v.toFixed(1), 2, py(v) - 2); }
    }
    for (let u = Math.ceil((centre - SX) * 4) / 4; u <= centre + SX; u += 0.25) {
      c.strokeStyle = Math.abs(u % 1) > 1e-6 ? "rgba(255,80,0,0.15)" : "rgba(255,80,0,0.6)";
      c.beginPath(); c.moveTo(px(u), 0); c.lineTo(px(u), HH); c.stroke();
      if (Math.abs(u * 2 % 1) < 1e-6) { c.fillStyle = "#c40"; c.fillText(u.toFixed(1), px(u) + 2, HH - 4); }
    }
    c.font = "bold 13px monospace"; c.fillStyle = "rgba(255,255,255,0.8)"; c.fillRect(4, 4, c.measureText(label).width + 8, 18);
    c.fillStyle = "#000"; c.fillText(label, 8, 17);
    c.restore();
  }
  const pre = document.createElement("pre"); pre.id = "png"; pre.textContent = sheet.toDataURL("image/png"); document.body.append(pre);
  document.body.dataset.bbox = JSON.stringify({ scale: s, width: +((max.x - min.x) * s).toFixed(3), depth: +((max.z - min.z) * s).toFixed(3) });
  document.body.dataset.done = "1";
})().catch(e => document.body.dataset.err = String(e && e.message || e));
</script></body></html>`;

// Labels name the model axis that grows to the screen's right; the bottom ruler prints that axis's value.
const sheets: Array<[string, Array<[string, number, string]>]> = [
  ["front-side", [[`${name} front (+Z cam): ruler = x, +x on screen-LEFT`, Math.PI / 2, "-x"], [`${name} side (+X cam): ruler = z, +z on screen-right`, 0, "z"]]],
  ["back-side", [[`${name} back (−Z cam): ruler = x, +x on screen-right`, -Math.PI / 2, "x"], [`${name} side (−X cam): ruler = z, +z on screen-LEFT`, Math.PI, "-z"]]],
];
await withServer(async origin => {
  for (const [suffix, views] of sheets) {
    const html = join(OUT, `grid-${name}-${suffix}.html`);
    writeFileSync(html, page(views));
    const url = `${origin}/.ui-check/glb-bot/grid-${name}-${suffix}.html`;
    const { error, done, dom } = await runPage(url, 90000);
    if (error || !done) { console.error(`grid ${suffix}: ${error ?? "page did not finish (CDN unreachable?)"}`); process.exit(1); }
    if (suffix === "front-side") console.log(`baked size: ${dom.match(/data-bbox="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"')}`);
    const png = join(OUT, `grid-${name}-${suffix}.png`);
    const data = dom.match(/<pre id="png">data:image\/png;base64,([^<]*)<\/pre>/)?.[1];
    if (!data) { console.error(`grid ${suffix}: no image in the page`); process.exit(1); }
    writeFileSync(png, Buffer.from(data, "base64"));
    console.log(`grid: ${png}`);
  }
});
