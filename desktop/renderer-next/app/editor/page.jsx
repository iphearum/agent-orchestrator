import { readFile } from "node:fs/promises";
import path from "node:path";
import WorkbenchScreen from "../workbench-screen";
// Editor-only styles: the orchestration home page uses the extension's webview styles instead.
import "../globals.css";
import "@xterm/xterm/css/xterm.css";
import "../../../../frontend/styles/style.css";
import "../../../../frontend/styles/workbench.css";
import "../../../../frontend/styles/vscode-theme.css";
import "../../../../frontend/styles/responsive.css";
import "../../../../media/overview.css";

const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function extractElement(source, openingPattern) {
  const opening = openingPattern.exec(source);
  if (!opening) return "";
  const tagName = opening[0].match(/^<([\w:-]+)/)?.[1]?.toLowerCase();
  if (!tagName) return "";
  const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  tags.lastIndex = opening.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (!match[1] || match[0].startsWith("<!--")) continue;
    const currentTag = match[1].toLowerCase();
    if (currentTag !== tagName) continue;
    if (match[0].startsWith("</")) depth -= 1;
    else if (!voidElements.has(currentTag) && !/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return source.slice(opening.index, tags.lastIndex);
  }
  return "";
}

function byAttribute(source, tag, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return extractElement(source, new RegExp(`<${tag}\\b(?=[^>]*\\b${attribute}=["']${escaped}["'])[^>]*>`, "i"));
}

function byClass(source, tag, className) {
  return extractElement(source, new RegExp(`<${tag}\\b(?=[^>]*\\bclass=["'][^"']*\\b${className}\\b)[^>]*>`, "i"));
}

export default async function Editor() {
  const legacyPath = path.resolve(process.cwd(), "../../frontend/templates/workbench.html");
  const source = await readFile(legacyPath, "utf8");
  const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || "";
  const shell = byClass(body, "div", "app-shell");
  const workbench = byClass(shell, "main", "workbench");
  return <WorkbenchScreen sections={{
    topbar: byClass(shell, "header", "titlebar"),
    activityRail: byClass(workbench, "nav", "activity-bar"),
    sidebar: byClass(workbench, "aside", "side-panel"),
    sidebarResizer: byAttribute(workbench, "div", "id", "side-resize"),
    editorWorkspace: byClass(workbench, "section", "main-column"),
    chatAside: byClass(workbench, "aside", "chat-panel"),
    chatResizer: byAttribute(workbench, "div", "id", "chat-resize"),
    imageViewer: byAttribute(shell, "div", "id", "image-viewer"),
    statusBar: byClass(shell, "footer", "statusbar")
  }} />;
}
