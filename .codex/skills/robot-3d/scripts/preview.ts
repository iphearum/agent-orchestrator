// Renders the Babylon robot outside VS Code: a hero canvas on light and dark grounds plus the cached avatar sprite.
//
//   bun run build:webview                                   # produces dist/webview/robot-runtime.js
//   bun .codex/skills/robot-3d/scripts/preview.ts          # → .ui-check/robot-preview.html (runtime inlined)
//   bun .codex/skills/robot-3d/scripts/preview.ts --shot   # also → .ui-check/robot-preview.png via headless Chrome
//   bun .codex/skills/robot-3d/scripts/preview.ts --compare  # also → .ui-check/robot-compare.png: target image | render, same size
//
// The runtime is inlined so file:// script errors are not masked; errors land in <body data-err>.
// Open the PNG with the Read tool and compare it to target/3d-robot.png.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const wanted = process.argv.includes("--wanted");
const model = wanted ? "wanted" : "default";
const targetOption = process.argv.indexOf("--target");
const targetPath = targetOption >= 0 ? resolve(process.argv[targetOption + 1]) : resolve(wanted ? "target/wanted-robot.png" : "target/3d-robot.png");
const targetData = readFileSync(targetPath);
const targetWidth = targetData.readUInt32BE(16);
const targetHeight = targetData.readUInt32BE(20);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>robot preview</title><style>
body{margin:0;display:flex;gap:16px;padding:16px;background:#ddd;font:12px sans-serif}
figure{margin:0;display:grid;gap:6px;justify-items:center}
.ground{width:320px;height:360px;border-radius:12px;overflow:hidden}
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
  for (const id of ["hero-light", "hero-dark"]) if (!api.mount(document.getElementById(id), "${model}")) document.body.dataset.err = (document.body.dataset.err || "") + id + " mount failed (WebGL?); ";
  api.getAvatarSprite("${model}").then(src => {
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
// Same box size and backdrop as target/3d-robot.png (271×410), so proportions can be judged side by side.
writeFileSync(compareFile, html
  .replace(/<body>[\s\S]*?<script>/, `<body><img class="ref" src="${pathToFileURL(targetPath).href}"><div class="ref ground light"><canvas id="hero-light"></canvas></div><div hidden><canvas id="hero-dark"></canvas><div id="avatars"></div></div>\n<script>`)
  .replace("</style>", `.ref{width:${targetWidth}px;height:${targetHeight}px;border-radius:0;display:block}.light{background:linear-gradient(#a9d3dc,#8fc4d0)}</style>`));

if (process.argv.includes("--shot") || process.argv.includes("--compare")) {
  const chrome = [process.env.CHROME, ...["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(n => Bun.which(n) ?? undefined)]
    .find((p): p is string => Boolean(p && existsSync(p)));
  if (!chrome) { console.error("No Chrome/Chromium found; set CHROME=/path/to/browser."); process.exit(1); }
  // SwiftShader gives headless Chrome a software WebGL context; --disable-gpu alone leaves Babylon without one.
    const flags = ["--headless=new", "--no-sandbox", "--disable-crash-reporter", "--disable-breakpad", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-device-scale-factor=1", "--virtual-time-budget=5000", `--user-data-dir=${join(outDir, `chrome-robot-${process.pid}`)}`];
  const url = pathToFileURL(file).href;
  const dom = Bun.spawnSync([chrome, ...flags, "--dump-dom", url], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  const err = dom.match(/data-err="([^"]*)"/)?.[1];
  console.log(`errors: ${err ? err.replace(/&quot;/g, '"') : "none"}`);
  const debug = dom.match(/data-debug="([^"]*)"/)?.[1];
  if (debug) console.log(`debug: ${debug}`);
  const png = join(outDir, "robot-preview.png");
  Bun.spawnSync([chrome, ...flags, "--window-size=1000,420", `--screenshot=${png}`, url], { stdout: "pipe", stderr: "pipe" });
  console.log(existsSync(png) ? `screenshot: ${png}` : "screenshot failed");
  if (process.argv.includes("--compare")) {
    const comparePng = join(outDir, "robot-compare.png");
    Bun.spawnSync([chrome, ...flags, `--window-size=${targetWidth * 2 + 64},${targetHeight + 64}`, `--screenshot=${comparePng}`, pathToFileURL(compareFile).href], { stdout: "pipe", stderr: "pipe" });
    console.log(existsSync(comparePng) ? `compare: ${comparePng}` : "compare screenshot failed");
  }
  if (err) process.exit(1);
}
