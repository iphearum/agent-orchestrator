// Shared helpers for the glb-bot scripts: find a Chromium browser, serve the repo over HTTP (fetch() can't read
// file:// URLs), and run headless Chrome with a software WebGL context. Run every script from the repo root.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const OUT = resolve(".ui-check/glb-bot");
mkdirSync(OUT, { recursive: true });

export function findChrome(): string {
  const playwright = join(homedir(), ".cache", "ms-playwright");
  const bundled = existsSync(playwright)
    ? readdirSync(playwright).filter(d => d.startsWith("chromium-")).map(d => join(playwright, d, "chrome-linux64", "chrome"))
    : [];
  const candidates = [
    process.env.CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ...bundled,
  ];
  const found = candidates.find((p): p is string => Boolean(p && existsSync(p)));
  if (!found) throw new Error("No Chrome/Chromium found; set CHROME=/path/to/browser (on WSL with Windows bun: WSLENV=CHROME).");
  return found;
}

/** Serve the repo root on a free port for the lifetime of `job`. */
export async function withServer<T>(job: (origin: string) => Promise<T>): Promise<T> {
  const root = resolve(".");
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const file = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  try {
    return await job(`http://localhost:${server.port}`);
  } finally {
    server.stop(true);
  }
}

const FLAGS = ["--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--force-device-scale-factor=1", "--hide-scrollbars"];

/**
 * Run Chrome asynchronously (a sync spawn would block the in-process server). `budget` is virtual time (ms): it
 * advances while the page renders, but not while Chrome waits on large image decodes or slow fetches.
 */
export async function chrome(args: string[], budget = 60000) {
  const proc = Bun.spawn([findChrome(), ...FLAGS, `--virtual-time-budget=${budget}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return stdout;
}

/** dump-dom, then report `data-err` / `data-done` set by the page. */
export async function runPage(url: string, budget?: number) {
  const dom = await chrome(["--dump-dom", url], budget);
  return { dom, error: dom.match(/data-err="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"'), done: dom.includes('data-done="1"') };
}

export async function screenshot(url: string, png: string, width: number, height: number, budget?: number) {
  await chrome([`--window-size=${width},${height}`, `--screenshot=${png}`, url], budget);
  return existsSync(png);
}
