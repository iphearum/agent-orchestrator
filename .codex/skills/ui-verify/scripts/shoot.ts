// Screenshots a page with headless Chrome/Edge, or dumps its script errors.
//
//   bun .claude/skills/ui-verify/scripts/shoot.ts <page.html | http://…> [--out name.png] [--size 1100x620]
//        [--hash hover] [--widths 420,340,280] [--dump] [--wait 4000]
//
// Files land in .ui-check/ (inside the repo: the Windows bun used under WSL cannot write to WSL's /tmp).
// Open the PNG with the Read tool and look at it; a screenshot nobody looked at verifies nothing.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const target = args.find((value, i) => !value.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["dump"].includes(args[i - 1].slice(2))));
if (!target) {
  console.error("usage: shoot.ts <page.html | url> [--out name.png] [--size WxH] [--hash hover] [--widths 420,340] [--dump] [--wait ms]");
  process.exit(2);
}

const chrome = findBrowser();
const outDir = resolve(".ui-check");
mkdirSync(outDir, { recursive: true });
const [width, height] = (option("size") ?? "1100x620").split("x").map(Number);
const wait = option("wait") ?? "4000";
const hash = option("hash") ? `#${option("hash")}` : "";
let url = /^https?:|^file:/.test(target) ? target : pathToFileURL(resolve(target)).href;
url += hash;
const stem = option("out")?.replace(/\.png$/, "") ?? (/^https?:/.test(target) ? "page" : basename(target, extname(target)));

if (flag("dump")) {
  // Errors from scripts on file:// pages are masked ("Script error."), so render-chat inlines its scripts.
  const run = Bun.spawnSync([chrome, "--headless=new", "--disable-gpu", `--virtual-time-budget=${wait}`, "--dump-dom", url], { stdout: "pipe", stderr: "pipe" });
  const dom = run.stdout.toString();
  const err = dom.match(/data-err="([^"]*)"/)?.[1];
  const debug = dom.match(/data-debug="([^"]*)"/)?.[1];
  console.log(`errors: ${err ? err.replace(/&quot;/g, '"') : "none"}`);
  if (debug) console.log(`debug: ${debug}`);
  process.exit(err ? 1 : 0);
}

let page = url;
let windowWidth = width;
const widths = option("widths")?.split(",").map(Number).filter(Boolean);
if (widths?.length) {
  // Headless Chrome will not size a window below ~500px, so narrow layouts are shot inside fixed-width iframes.
  const frames = widths.map(w => `<figure style="margin:0"><figcaption style="font:12px sans-serif;margin-bottom:4px">${w}px</figcaption><iframe src="${url}" style="width:${w}px;height:${height}px;border:1px solid #999;background:#fff"></iframe></figure>`).join("");
  const file = join(outDir, `${stem}-frames.html`);
  writeFileSync(file, `<!doctype html><html><body style="margin:0;padding:12px;display:flex;gap:12px;align-items:flex-start;background:#ddd">${frames}</body></html>`);
  page = pathToFileURL(file).href;
  windowWidth = widths.reduce((sum, w) => sum + w + 14, 24);
}

const png = join(outDir, `${stem}${widths?.length ? "-widths" : ""}.png`);
const shot = Bun.spawnSync([chrome, "--headless=new", "--disable-gpu", "--force-device-scale-factor=1", `--window-size=${windowWidth},${height + (widths?.length ? 40 : 0)}`, `--virtual-time-budget=${wait}`, `--screenshot=${png}`, page], { stdout: "pipe", stderr: "pipe" });
if (!existsSync(png)) {
  console.error(`Screenshot failed:\n${shot.stderr.toString().slice(-1500)}`);
  process.exit(1);
}
console.log(`screenshot: ${png}`);

function findBrowser(): string {
  const candidates = [
    process.env.CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    ...["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(name => Bun.which(name) ?? undefined)
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error("No Chrome/Chromium/Edge found. Set CHROME=/path/to/browser (and WSLENV=CHROME under WSL).");
  return found;
}
