// Renders the Babylon robot outside VS Code: a hero canvas on light and dark grounds plus the cached avatar sprite.
//
//   bun run build:webview                                   # produces dist/webview/robot-runtime.js
//   bun .claude/skills/robot-3d/scripts/preview.ts          # → .ui-check/robot-preview.html (runtime inlined)
//   bun .claude/skills/robot-3d/scripts/preview.ts --shot   # also → .ui-check/robot-preview.png via headless Chrome
//   bun .claude/skills/robot-3d/scripts/preview.ts --states   # → .ui-check/robot-states.png: hero per state + every avatar sheet
//   bun .claude/skills/robot-3d/scripts/preview.ts --compare  # also → .ui-check/robot-compare.png (target | render, same size)
//                                                            #   and .ui-check/parts/*.png: head, face, ears, body, claws side by side
//
// The runtime is inlined so file:// script errors are not masked; errors land in <body data-err>.
// Open the PNGs with the Read tool. The full-body reference is target/3d-robot-full.png; the head close-up is
// target/3d-robot-head.png (target/3d-robot.png is the original, legless concept).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimePath = resolve("dist/webview/robot-runtime.js");
if (!existsSync(runtimePath)) {
  console.error("dist/webview/robot-runtime.js missing — run `bun run build:webview` first.");
  process.exit(1);
}
const runtime = readFileSync(runtimePath, "utf8").replace(/<\/script/gi, "<\\/script");
const outDir = resolve(".ui-check");
mkdirSync(outDir, { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>robot preview</title><style>
body{margin:0;display:flex;gap:16px;padding:16px;background:#ddd;font:12px sans-serif}
figure{margin:0;display:grid;gap:6px;justify-items:center}
.ground{width:220px;height:470px;border-radius:12px;overflow:hidden}
.light{background:linear-gradient(#bfe0e6,#9ccbd6)}.dark{background:#1e1e1e}
canvas{width:100%;height:100%;display:block;outline:none}
.avatars{display:flex;gap:10px;align-items:center}.avatars img{border-radius:50%;background:#2b6fd6}
</style></head><body>
<figure><div class="ground light"><canvas id="hero-light"></canvas></div><figcaption>hero · light</figcaption></figure>
<figure><div class="ground dark"><canvas id="hero-dark"></canvas></div><figcaption>hero · dark</figcaption></figure>
<figure><div class="avatars" id="avatars"></div><figcaption>avatar sprite 96 / 48 / 24</figcaption></figure>
<script>
window.addEventListener("error", e => { document.body.dataset.err = (document.body.dataset.err || "") + e.message + "; "; });
window.addEventListener("unhandledrejection", e => { document.body.dataset.err = (document.body.dataset.err || "") + String(e.reason) + "; "; });
</script>
<script>${runtime}</script>
<script>
const api = window.AgentRobot3D;
if (!api) document.body.dataset.err = "window.AgentRobot3D not defined";
else {
  for (const id of ["hero-light", "hero-dark"]) if (!api.mount(document.getElementById(id))) document.body.dataset.err = (document.body.dataset.err || "") + id + " mount failed (WebGL?); ";
  api.getAvatarSprite().then(src => {
    if (!src) { document.body.dataset.err = (document.body.dataset.err || "") + "avatar sprite undefined; "; return; }
    for (const size of [96, 48, 24]) { const img = new Image(size, size); img.src = src; document.getElementById("avatars").append(img); }
    document.body.dataset.debug = "sprite " + src.length + " chars";
  });
}
</script></body></html>`;

const file = join(outDir, "robot-preview.html");
writeFileSync(file, html);
console.log(`preview: ${file}`);

const compareFile = join(outDir, "robot-compare.html");
// The render sits beside target/3d-robot-full.png at the image's true size (306×656, never stretched) with no gaps, so
// x 0–268 is the reference and x 269–537 the render: --parts crops the same regions from both.
const REF = { w: 306, h: 656 };
writeFileSync(compareFile, html
  .replace(/<body>[\s\S]*?<script>/, `<body><img class="ref" src="${pathToFileURL(resolve("target/3d-robot-full.png")).href}"><div class="ref ground light"><canvas id="hero-light"></canvas></div><div hidden><canvas id="hero-dark"></canvas><div id="avatars"></div></div>\n<script>`)
  .replace("</style>", `body{padding:0;gap:0}.ref{width:${REF.w}px;height:${REF.h}px;border-radius:0;display:block;flex:none}.light{background:linear-gradient(#a7c6d4 0 76%,#d6d2cc 76%)}</style>`));

// Straight-on head close-up (target/3d-robot-head.png, 451×433) beside the runtime's preview-only
// `data-robot-view="head-front"` render, framed to line up with it.
const HEAD_REF = { w: 451, h: 433, file: resolve("target/3d-robot-head.png") };
const headCompareFile = join(outDir, "robot-head-compare.html");
if (existsSync(HEAD_REF.file)) {
  writeFileSync(headCompareFile, html
    .replace(/<body>[\s\S]*?<script>/, `<body><img class="ref" src="${pathToFileURL(HEAD_REF.file).href}"><div class="ref ground light"><canvas id="hero-light" data-robot-view="head-front"></canvas></div><div hidden><canvas id="hero-dark"></canvas><div id="avatars"></div></div>\n<script>`)
    .replace("</style>", `body{padding:0;gap:0}.ref{width:${HEAD_REF.w}px;height:${HEAD_REF.h}px;border-radius:0;display:block;flex:none}.light{background:linear-gradient(#8fbccb,#9ac8d4)}</style>`));
}
const HEAD_PARTS: Array<[string, number, number, number, number]> = [
  ["h1-head", 60, 0, 360, 360],
  ["h2-screen", 120, 135, 245, 185],
  ["h3-antenna", 180, 0, 125, 115],
  ["h4-ear", 330, 160, 110, 140],
  ["h5-neck", 150, 300, 190, 100]
];

// Regions in reference pixels: [name, x, y, w, h]. Each part sheet is reference | render, scaled 3×.
const PARTS: Array<[string, number, number, number, number]> = [
  ["1-head", 40, 0, 240, 215],
  ["2-torso-arms", 0, 190, 306, 170],
  ["3-hips-thighs", 40, 300, 240, 180],
  ["4-hands", 0, 330, 306, 130],
  ["5-shins-feet", 30, 450, 246, 206]
];

// --states: one hero per animation state (live, mid-loop) and every avatar sheet laid out frame by frame.
const STATES = ["idle", "listening", "thinking", "working", "talking", "happy", "error"];
const statesFile = join(outDir, "robot-states.html");
writeFileSync(statesFile, `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:12px;background:#1e1e1e;color:#ccc;font:11px sans-serif}
.row{display:flex;gap:8px;margin-bottom:10px}figure{margin:0;display:grid;gap:4px;justify-items:center}
.hero{width:130px;height:260px;background:linear-gradient(#a7c6d4,#9ac0cf);border-radius:8px}
.strip{display:block;height:64px;image-rendering:auto;background:#2f7bea33;border-radius:6px}
.live{width:40px;height:40px;border-radius:50%;background:#2f7bea;overflow:hidden;position:relative}
.live span{position:absolute;inset:0;background-repeat:no-repeat;background-size:calc(var(--frames) * 100%) 100%;animation:sheet var(--duration) steps(var(--frames), jump-none) infinite}
@keyframes sheet{from{background-position:0 0}to{background-position:100% 0}}
</style></head><body>
<script>window.addEventListener("error",e=>{document.body.dataset.err=(document.body.dataset.err||"")+e.message+"; "});
// Headless virtual time runs few real animation frames, so the eased hero would lag its targets; drive frames from timers (20 fps keeps seven software-rendered heroes quick).
window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),50);</script>
<script>${runtime}</script>
<div class="row">${STATES.map(st => `<figure><canvas class="hero" data-robot-state="${st}"></canvas><figcaption>${st}</figcaption></figure>`).join("")}</div>
<div id="sheets"></div>
<script>
const api = window.AgentRobot3D;
if (!api) document.body.dataset.err = "no runtime";
for (const c of document.querySelectorAll("canvas.hero")) if (!api?.mount(c)) document.body.dataset.err = (document.body.dataset.err||"") + "mount failed; ";
(async () => {
  for (const st of ${JSON.stringify(STATES)}) {
    const sheet = await api.getAvatarSheet(st);
    const row = document.createElement("div"); row.className = "row";
    if (!sheet) { row.textContent = st + ": no sheet"; document.body.dataset.err = (document.body.dataset.err||"") + st + " sheet missing; "; }
    else row.innerHTML = '<figure><div class="live"><span style="background-image:url(' + sheet.url + ');--frames:' + sheet.frames + ';--duration:' + sheet.duration + 'ms"></span></div><figcaption>' + st + '</figcaption></figure><img class="strip" src="' + sheet.url + '">';
    document.getElementById("sheets").append(row);
  }
  document.body.dataset.debug = "sheets done";
})();
</script></body></html>`);

if (process.argv.includes("--states")) {
  const chrome = [process.env.CHROME, ...["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(n => Bun.which(n) ?? undefined)]
    .find((p): p is string => Boolean(p && existsSync(p)));
  if (!chrome) { console.error("No Chrome/Chromium found; set CHROME=/path/to/browser."); process.exit(1); }
  const flags = ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-device-scale-factor=1", "--virtual-time-budget=20000"];
  const url = pathToFileURL(statesFile).href;
  const dom = Bun.spawnSync([chrome, ...flags, "--dump-dom", url], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  const err = dom.match(/data-err="([^"]*)"/)?.[1];
  console.log(`states errors: ${err ?? "none"}; ${dom.match(/data-debug="([^"]*)"/)?.[1] ?? "sheets not finished"}`);
  const png = join(outDir, "robot-states.png");
  Bun.spawnSync([chrome, ...flags, "--window-size=1000,720", `--screenshot=${png}`, url], { stdout: "pipe", stderr: "pipe" });
  console.log(existsSync(png) ? `states: ${png}` : "states screenshot failed");
}

if (process.argv.includes("--shot") || process.argv.includes("--compare")) {
  const chrome = [process.env.CHROME, ...["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(n => Bun.which(n) ?? undefined)]
    .find((p): p is string => Boolean(p && existsSync(p)));
  if (!chrome) { console.error("No Chrome/Chromium found; set CHROME=/path/to/browser."); process.exit(1); }
  // SwiftShader gives headless Chrome a software WebGL context; --disable-gpu alone leaves Babylon without one.
  const flags = ["--headless=new", "--no-sandbox", "--disable-crash-reporter", "--disable-breakpad", "--disable-dev-shm-usage", "--allow-file-access-from-files", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-device-scale-factor=1", "--virtual-time-budget=5000"];
  const runChrome = (name: string, args: string[]) => {
    const profile = join(outDir, `.robot-chrome-${name}-${Date.now()}`);
    const result = Bun.spawnSync([chrome, ...flags, `--user-data-dir=${profile}`, ...args], { stdout: "pipe", stderr: "pipe" });
    rmSync(profile, { recursive: true, force: true });
    if (result.exitCode !== 0) throw new Error(`Chrome ${name} capture failed (${result.exitCode}): ${result.stderr.toString().slice(-1200)}`);
    return result.stdout.toString();
  };
  const url = pathToFileURL(file).href;
  const dom = runChrome("probe", ["--dump-dom", url]);
  const err = dom.match(/data-err="([^"]*)"/)?.[1];
  console.log(`errors: ${err ? err.replace(/&quot;/g, '"') : "none"}`);
  const debug = dom.match(/data-debug="([^"]*)"/)?.[1];
  if (debug) console.log(`debug: ${debug}`);
  const png = join(outDir, "robot-preview.png");
  rmSync(png, { force: true });
  runChrome("preview", ["--window-size=820,520", `--screenshot=${png}`, url]);
  console.log(existsSync(png) ? `screenshot: ${png}` : "screenshot failed");
  if (process.argv.includes("--compare")) {
    const comparePng = join(outDir, "robot-compare.png");
    // Reduced motion freezes the idle bob/yaw so the render lines up with the still reference.
    rmSync(comparePng, { force: true });
    runChrome("compare", ["--force-prefers-reduced-motion", `--window-size=${REF.w * 2},${REF.h}`, `--screenshot=${comparePng}`, pathToFileURL(compareFile).href]);
    console.log(existsSync(comparePng) ? `compare: ${comparePng}` : "compare screenshot failed");
    const magick = Bun.which("magick") ?? Bun.which("convert");
    if (existsSync(comparePng) && magick) {
      const partsDir = join(outDir, "parts");
      mkdirSync(partsDir, { recursive: true });
      for (const [name, x, y, w, h] of PARTS) {
        const out = join(partsDir, `${name}.png`);
        Bun.spawnSync([magick, comparePng, "(", "+clone", "-crop", `${w}x${h}+${x}+${y}`, "+repage", ")", "(", "-clone", "0", "-crop", `${w}x${h}+${x + REF.w}+${y}`, "+repage", ")", "-delete", "0", "-bordercolor", "#ddd", "-border", "2", "+append", "-resize", "200%", out]);
        console.log(`part: ${out}`);
      }
      if (existsSync(HEAD_REF.file)) {
        const headPng = join(outDir, "robot-head-compare.png");
        rmSync(headPng, { force: true });
        runChrome("head-compare", [`--window-size=${HEAD_REF.w * 2},${HEAD_REF.h}`, `--screenshot=${headPng}`, pathToFileURL(headCompareFile).href]);
        console.log(`head compare: ${headPng}`);
        for (const [name, x, y, w, h] of HEAD_PARTS) {
          const out = join(partsDir, `${name}.png`);
          Bun.spawnSync([magick, headPng, "(", "+clone", "-crop", `${w}x${h}+${x}+${y}`, "+repage", ")", "(", "-clone", "0", "-crop", `${w}x${h}+${x + HEAD_REF.w}+${y}`, "+repage", ")", "-delete", "0", "-bordercolor", "#ddd", "-border", "2", "+append", "-resize", "200%", out]);
          console.log(`part: ${out}`);
        }
      }
    } else if (!magick) console.log("parts skipped: ImageMagick not found");
  }
  if (err) process.exit(1);
}
