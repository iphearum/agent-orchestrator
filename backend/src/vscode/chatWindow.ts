import * as vscode from "vscode";
import { randomBytes, randomUUID } from "crypto";
import { QueueEvent, TaskQueue } from "../core/taskQueue";
import { AgentMessageBus } from "../core/agentMessageBus";
import type { RunEvent } from "../core/orchestrator";
import type { ChatImageAttachment } from "../core/types";
import type { ReplyStep, ReplyTrace, SessionRepository } from "../storage/repositories/sessions";

export interface ChatModelOption { key: string; label: string; providerId?: string; model: string; }
export interface ChatComposerConfig { models: ChatModelOption[]; selectedModelKey: string; approvalMode: "ask" | "approve" | "full"; }
export interface ChatComposerSelection {
  approvalMode: "ask" | "approve" | "full";
  planMode: boolean;
  thinking: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  providerId?: string;
  model?: string;
  attachments: Array<{ name: string; content: string }>;
  images: ChatImageAttachment[];
}
export type ChatWindowMessage =
  | { type: "submit"; prompt: string; intent?: "discuss" | "assign"; approvalMode?: string; planMode?: boolean; thinking?: boolean; reasoningEffort?: string; modelKey?: string; attachmentIds?: string[] }
  | { type: "add-attachments" }
  | { type: "add-image-attachments"; files: unknown[] }
  | { type: "remove-attachment"; id: string }
  | { type: "chat-ready" }
  | { type: "new-session" }
  | { type: "open-settings" }
  | { type: "resume-laya" }
  | { type: "open-file"; path: string }
  | { type: "open-session"; id: string }
  | { type: "select-chat-mode"; mode: "team" | "supervisor" | "agent"; agentId?: string }
  | { type: "rename-session"; id: string }
  | { type: "archive-session"; id: string; archived: boolean }
  | { type: "remember"; text: string }
  | { type: "copy"; text: string };
/** conversationId identifies the chat session, so follow-up messages continue it. */
export type ChatSubmitHandler = (prompt: string, agentId: string, selection: ChatComposerSelection, progress: (message: string, event?: RunEvent) => void, conversationId: string, mode: "team" | "agent", intent: "discuss" | "assign") => Promise<string>;
/** Session persistence and memory, provided by the extension so this class stays free of SQL. */
export interface ChatSessionStore {
  sessions: SessionRepository;
  agentName(agentId: string): string | undefined;
  agents(): Array<{ id: string; name: string }>;
  remember(agentId: string, scope: "agent" | "all", text: string, conversationId?: string): void;
  /** Laya's pause state, or undefined when Laya is off or has no endpoint (then there is nothing to show). */
  layaStatus?(): { paused: boolean; pausedAt?: string; lastError?: string } | undefined;
}
export type ChatAttachmentPicker = () => Promise<Array<{ name: string; content: string }>>;
type ChatAttachment = { name: string; content: string } | ChatImageAttachment;
export const CHAT_VIEW_ID = "agentOrchestrator.agentChat";

const hasSecondarySidebar = () => {
  const [major, minor] = vscode.version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 106);
};

/** Agent chats open as editor tabs in the main workbench area. */
// Composer menu icons. Kept as ASCII SVG strings so file encoding can never corrupt them.
const SVG = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const SHIELD = '<path d="M12 3 19 6v5c0 4.5-3 7.7-7 10-4-2.3-7-5.5-7-10V6l7-3Z"/>';
const MENU_ICONS: Record<string, string> = {
  bot: SVG('<path d="M12 3v2.2"/><circle cx="12" cy="2.5" r="1.1" fill="currentColor" stroke="none"/><rect x="4.5" y="5.5" width="15" height="12.5" rx="4.3"/><path d="M4.5 10H3a1.5 1.5 0 0 0 0 3h1.5M19.5 10H21a1.5 1.5 0 0 1 0 3h-1.5"/><rect x="7.3" y="8.4" width="9.4" height="5.5" rx="2.3" fill="currentColor" fill-opacity=".14"/><circle cx="10" cy="11" r=".85" fill="currentColor" stroke="none"/><circle cx="14" cy="11" r=".85" fill="currentColor" stroke="none"/><path d="M10 12.4h4M8 19.2h8M9.5 18v1.2M14.5 18v1.2"/>'),
  ask: SVG(`${SHIELD}<path d="M10 9.6a2.1 2.1 0 1 1 2.9 1.9c-.6.3-.9.7-.9 1.3v.4"/><path d="M12 15.8h.01"/>`),
  approve: SVG(`${SHIELD}<path d="m9 12 2 2 4-4"/>`),
  full: SVG('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.8"/><path d="M12 15v2.2"/>'),
  model: SVG('<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'),
  effort: SVG('<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="m12 16 3.5-5"/><path d="M12 16h.01"/>'),
  effort_auto: SVG('<path d="m12 3 1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7Z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>'),
  effort_low: SVG('<path d="M6 19v-3"/><path d="M12 19v-7" opacity=".3"/><path d="M18 19V8" opacity=".3"/>'),
  effort_medium: SVG('<path d="M6 19v-3"/><path d="M12 19v-7"/><path d="M18 19V8" opacity=".3"/>'),
  effort_high: SVG('<path d="M6 19v-3"/><path d="M12 19v-7"/><path d="M18 19V8"/>'),
  history: SVG('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>'),
  compose: SVG('<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M17.5 2.8a2.1 2.1 0 0 1 3 3L12 14.3l-4 1 1-4Z"/>'),
  rename: SVG('<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="M14 8l2 2"/>'),
  archive: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  unarchive: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5"/>'),
  remember: SVG('<path d="M6 3h12v18l-6-4-6 4Z"/><path d="M12 7v6M9 10h6"/>'),
  copy: SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  search: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>')
};

const CHAT_COMPOSER_REFERENCE_STYLES = `
      .composer-area{padding:10px 10px 12px}
      .composer{padding:12px 14px 10px;border-color:color-mix(in srgb,var(--vscode-panel-border) 78%,transparent);border-radius:23px;background:var(--vscode-input-background);box-shadow:0 7px 22px #0000000c,0 2px 6px #00000008;transition:border-color .16s,box-shadow .16s}
      .composer:hover{box-shadow:0 8px 24px #00000010,0 2px 7px #00000008}
      .composer:focus-within{border-color:color-mix(in srgb,var(--vscode-focusBorder) 56%,var(--vscode-panel-border));box-shadow:0 7px 22px #0000000c,0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder) 9%,transparent)}
      textarea{min-height:44px;padding:2px 3px 8px;line-height:1.5}
      .composer-footer{gap:8px}.controls{gap:3px}
      .icon-button,.control-button{height:30px;border-radius:999px}
      .icon-button{width:30px}
      .control-button{gap:6px;padding:0 8px;font-size:11px}
      #approval-button{padding:0 10px}#approval-button>.chevron{width:11px}
      .model-button{max-width:250px}.effort-button{gap:5px}.control-prefix{display:none}
      .send{width:30px;height:30px;box-shadow:none}
      .send:hover{box-shadow:none;transform:none}
      #shell .menu,#shell .toast{border-radius:20px}
      #shell .menu{box-shadow:0 10px 30px #00000020,0 2px 6px #0000000c}
      #shell .menu button{border-radius:12px}
      #shell .menu-icon{border-radius:10px}
      #shell .message-actions{border-radius:12px}
      .footnote{display:none}
      @media(max-width:560px){.composer-area{padding:6px 8px 10px}.composer{padding:10px 11px 9px}.controls{gap:1px}.control-button{padding:0 6px}.model-button{max-width:clamp(90px,34vw,190px)}}
`;

const CHAT_REPLY_STYLES = `
      .message.response{padding:18px 20px;border-radius:18px;background:color-mix(in srgb,var(--vscode-textCodeBlock-background) 16%,var(--vscode-editor-background));box-shadow:0 5px 18px #0000000a}
      .message.response.pending{border-color:color-mix(in srgb,var(--vscode-panel-border) 78%,transparent);animation:chat-message-in .28s cubic-bezier(.2,.75,.25,1) var(--message-delay,0ms) both}
      .message.response .message-label{margin-bottom:9px;font-size:12px;font-weight:650;letter-spacing:.01em}
      .message-content{line-height:1.72;overflow-wrap:anywhere}
      .message-content h1,.message-content h2,.message-content h3{margin:18px 0 8px;line-height:1.35}
      .message-content h1{font-size:1.35em}.message-content h2{font-size:1.2em}.message-content h3{font-size:1.08em}
      .message-content ul,.message-content ol{padding-left:1.5em;margin:7px 0 12px}
      .message-content li+li{margin-top:4px}
      .message-content.streaming{min-height:12px;white-space:pre-wrap;border:0;padding:0}
      .response-status{display:inline-flex;align-items:center;gap:7px;margin-top:11px;padding:4px 9px;border:1px solid color-mix(in srgb,var(--vscode-panel-border) 72%,transparent);border-radius:999px;background:color-mix(in srgb,var(--vscode-editor-background) 72%,transparent);font-size:11px}
      .response-status:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--vscode-descriptionForeground);opacity:.7}
      .response-status.thinking:before{background:var(--vscode-progressBar-background);opacity:1;animation:chat-status-pulse 1.3s ease-in-out infinite}
      .response-status.failed:before{background:var(--vscode-errorForeground);opacity:1}
      @keyframes chat-status-pulse{50%{opacity:.35;transform:scale(.8)}}
      .response-activity{margin-top:13px;padding-top:11px;border-top:1px solid color-mix(in srgb,var(--vscode-panel-border) 75%,transparent)}
      .response-activity-item{line-height:1.45}
      @media(max-width:560px){.message.response{padding:15px 16px;border-radius:16px}}
`;

/** Live reply card: avatar header with status and timer, current step, loading placeholder, jump button, starters. */
const CHAT_LIVE_REPLY_STYLES = `
      .response-head{display:flex;align-items:center;gap:9px;min-width:0;margin-bottom:8px}
      .message.response .response-head .message-label{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .response-avatar{flex:none;width:24px;height:24px;display:grid;place-items:center;border-radius:8px;color:var(--agent-tone);background:color-mix(in srgb,var(--agent-tone) 15%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--agent-tone) 35%,transparent);font-size:11px;font-weight:700}
      .response-avatar svg{display:block;width:17px;height:17px}
      .response-head .response-status{margin:0;padding:2px 8px;font-size:10.5px;white-space:nowrap}
      .message.response.pending .response-status:not(.approval):before{background:var(--vscode-progressBar-background);opacity:1;animation:chat-status-pulse 1.3s ease-in-out infinite}
      .response-status.approval{color:var(--vscode-editorWarning-foreground);border-color:color-mix(in srgb,var(--vscode-editorWarning-foreground) 45%,transparent)}
      .response-status.approval:before{background:var(--vscode-editorWarning-foreground);opacity:1;animation:chat-status-pulse 1.3s ease-in-out infinite}
      .response-status.finished{padding-left:0;border-color:transparent;background:transparent;color:var(--vscode-descriptionForeground)}
      .response-status.finished:before{background:var(--vscode-testing-iconPassed);opacity:1;animation:none}
      .response-status.finished.failed:before{background:var(--vscode-errorForeground)}
      .response-elapsed{margin-left:auto;flex:none;color:var(--vscode-descriptionForeground);font-size:11px;font-variant-numeric:tabular-nums}
      .response-now{margin:-2px 0 10px 33px;color:var(--vscode-foreground);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .response-now:before{content:"";display:inline-block;width:9px;height:9px;margin-right:8px;vertical-align:-1px;border:1.5px solid var(--vscode-progressBar-background);border-top-color:transparent;border-radius:50%;animation:chat-spin .8s linear infinite}
      .response-now.idle{color:var(--vscode-descriptionForeground)}
      .response-now.approval{color:var(--vscode-editorWarning-foreground)}
      .response-now.approval:before{border-color:var(--vscode-editorWarning-foreground);animation:none}
      .message.response.pending .message-content.streaming:empty{--bar:color-mix(in srgb,var(--vscode-foreground) 9%,transparent);min-height:50px;margin-top:4px;background:linear-gradient(var(--bar) 0 0) 0 0/92% 9px no-repeat,linear-gradient(var(--bar) 0 0) 0 20px/76% 9px no-repeat,linear-gradient(var(--bar) 0 0) 0 40px/48% 9px no-repeat;animation:chat-skeleton 1.4s ease-in-out infinite}
      @keyframes chat-skeleton{50%{opacity:.45}}
      .message.response.pending .response-activity-list{max-height:170px;overflow-y:auto}
      .response-activity-list{display:grid;gap:5px;padding-top:8px}
      .composer-area{position:relative}
      .jump-latest{position:absolute;left:50%;top:-38px;z-index:6;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:999px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));color:var(--vscode-foreground);font:inherit;font-size:12px;box-shadow:0 4px 14px var(--vscode-widget-shadow,#00000029);cursor:pointer}
      .jump-latest svg{width:13px;height:13px}
      .jump-latest:hover{background:var(--vscode-list-hoverBackground)}
      .jump-latest:focus-visible,.welcome-starters button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
      .welcome-starters{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:20px}
      .welcome-starters button{height:30px;padding:0 13px;border:1px solid var(--vscode-panel-border);border-radius:999px;background:transparent;color:var(--vscode-foreground);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s,border-color .12s}
      .welcome-starters button:hover{background:var(--vscode-list-hoverBackground);border-color:color-mix(in srgb,var(--vscode-focusBorder) 60%,var(--vscode-panel-border))}
      .vscode-high-contrast .jump-latest,.vscode-high-contrast .welcome-starters button{border-color:var(--vscode-contrastBorder)}
      @media(max-width:560px){.response-now{margin-left:0}.response-head .response-status{display:none}.message.response.pending .response-head .response-status{display:inline-flex}}
`;

/** One pill for model + reasoning effort; its popup has an effort slider and a model list view. */
const CHAT_MODEL_EFFORT_STYLES = `
      .model-button .model-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .model-button .effort-chip{flex:none;color:var(--vscode-descriptionForeground)}
      #shell .model-effort-menu{padding:12px 14px 12px}
      .me-head{display:grid;grid-template-columns:30px minmax(0,1fr) 30px;align-items:center;gap:6px}
      .me-icon{display:grid;place-items:center;color:var(--vscode-descriptionForeground)}.me-icon svg{width:18px;height:18px}
      #shell .me-title{display:grid;justify-items:center;gap:1px;min-width:0;padding:3px 8px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}
      #shell .me-title:hover{background:var(--vscode-list-hoverBackground)}
      .me-level{display:inline-flex;align-items:center;gap:2px;color:var(--vscode-textLink-foreground);font-size:15px;font-weight:650}.me-level svg{width:13px;height:13px}
      .me-model{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-size:11.5px}
      .me-reset svg{width:16px;height:16px}.me-reset:disabled{opacity:.35;cursor:default}
      .me-slider{--f:0;--knob:26px;position:relative;margin:14px 0 6px;height:var(--knob)}
      #effort-slider{-webkit-appearance:none;appearance:none;display:block;width:100%;height:var(--knob);margin:0;border-radius:999px;background:linear-gradient(var(--vscode-button-background,#0078d4) 0 0) 0 0/calc(var(--knob) + (100% - var(--knob)) * var(--f)) 100% no-repeat,color-mix(in srgb,var(--vscode-foreground) 13%,transparent);cursor:pointer}
      #effort-slider::-webkit-slider-thumb{-webkit-appearance:none;position:relative;z-index:2;width:var(--knob);height:var(--knob);border-radius:50%;background:#fff;box-shadow:0 1px 4px #0000004d,0 0 0 1px #0000001f;transition:transform .12s}
      #effort-slider:active::-webkit-slider-thumb{transform:scale(1.08)}
      #effort-slider:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:3px}
      .me-stops{position:absolute;inset:0;pointer-events:none}
      .me-stops span{position:absolute;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:color-mix(in srgb,var(--vscode-foreground) 38%,transparent)}
      .me-stops span:nth-child(1){left:calc(var(--knob) / 2)}.me-stops span:nth-child(2){left:calc(var(--knob) / 2 + (100% - var(--knob)) / 3)}.me-stops span:nth-child(3){left:calc(var(--knob) / 2 + (100% - var(--knob)) * 2 / 3)}.me-stops span:nth-child(4){left:calc(100% - var(--knob) / 2)}
      .me-slider[data-index="1"] .me-stops span:nth-child(1),.me-slider[data-index="2"] .me-stops span:nth-child(-n+2),.me-slider[data-index="3"] .me-stops span:nth-child(-n+3){background:color-mix(in srgb,var(--vscode-button-foreground,#fff) 70%,transparent)}
      .me-slider[data-index="0"] .me-stops span:nth-child(1),.me-slider[data-index="1"] .me-stops span:nth-child(2),.me-slider[data-index="2"] .me-stops span:nth-child(3),.me-slider[data-index="3"] .me-stops span:nth-child(4){display:none}
      .me-scale{display:grid;grid-template-columns:repeat(4,1fr);margin:0 -2px;color:var(--vscode-descriptionForeground);font-size:10.5px}
      .me-scale span:nth-child(2){text-align:center;padding-right:18%}.me-scale span:nth-child(3){text-align:center;padding-left:18%}.me-scale span:nth-child(4){text-align:right}
      .me-caption{margin:8px 0 0;color:var(--vscode-descriptionForeground);font-size:11.5px;line-height:1.45;text-align:center}
      .me-models-head{display:flex;align-items:center;gap:4px;margin:-4px -4px 4px}.me-models-head svg{width:15px;height:15px}#shell .me-models-head #me-back,#shell .me-head #me-reset{flex:none;width:30px;height:30px;padding:0;justify-content:center}.me-models-head .menu-heading{flex:1;min-width:0;margin:0;padding:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .vscode-high-contrast #effort-slider{outline:1px solid var(--vscode-contrastBorder)}
      .vscode-high-contrast #effort-slider::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--vscode-contrastActiveBorder,#f38518)}
      @media(prefers-reduced-motion:reduce){#effort-slider::-webkit-slider-thumb{transition:none}}
`;

/** Codex-style layout: no side rail; a compact header, recent chats on the home screen, history as its own page. */
const CHAT_CODEX_STYLES = `
      #shell.shell,#shell.shell.rail-collapsed{grid-template-columns:minmax(0,1fr)}
      #shell .sessions,#shell.rail-collapsed .sessions{position:fixed;inset:0;z-index:30;width:auto;border-right:0;box-shadow:none;visibility:hidden;opacity:0;transform:translateX(-10px);transition:opacity .15s ease,transform .15s ease,visibility 0s linear .15s}
      #shell.history-open .sessions{visibility:visible;opacity:1;transform:none;transition:opacity .15s ease,transform .15s ease}
      #shell .sessions-resizer,#shell .sessions-scrim{display:none}
      #shell .sessions-head{height:40px;gap:4px;justify-content:flex-start;padding:0 8px;border-bottom:0}
      #shell .sessions-title{flex:1;text-transform:none;letter-spacing:0;font-size:13px;font-weight:600}
      #shell .topbar{height:40px;min-height:40px;gap:2px;padding:0 6px 0 8px;border-bottom:0}
      #shell .topbar .agent{flex:1;min-width:0;gap:0}
      .bar-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--vscode-foreground)}
      #shell.is-home .bar-title{font-weight:400;color:var(--vscode-descriptionForeground);padding-left:4px}
      #shell .topbar .icon-button,#shell .sessions-head .icon-button{width:28px;height:28px;margin:0;border-radius:6px}
      #shell .topbar .icon-button svg,#shell .sessions-head .icon-button svg{width:16px;height:16px}
      #shell #chat-back{margin-right:4px}
      .topbar-actions{gap:2px}
      #shell .bar-menu{min-width:190px;padding:5px}
      #shell .bar-menu button{justify-content:flex-start;gap:10px;padding:7px 9px;border-radius:6px;font-size:13px}
      #shell .bar-menu button svg{width:16px;height:16px;flex:none}
      .home-recents{margin:0 -8px 20px}
      .home-recent{display:flex;align-items:center;gap:12px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:var(--vscode-foreground);font:inherit;font-size:13px;text-align:left;cursor:pointer}
      .home-recent:hover{background:var(--vscode-list-hoverBackground)}
      .home-recent:focus-visible,.home-view-all:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
      .home-recent-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .home-recent-time{flex:none;color:var(--vscode-descriptionForeground);font-size:12px;font-variant-numeric:tabular-nums}
      .home-view-all{margin:2px 0 0 8px;padding:2px 0;border:0;background:none;color:var(--vscode-descriptionForeground);font:inherit;font-size:12px;cursor:pointer}
      .home-view-all:hover{color:var(--vscode-foreground)}
      #shell.is-home .conversation{padding-top:6px}
      @media(prefers-reduced-motion:reduce){#shell .sessions{transition:none}}
`;

const CHAT_MODE_SWITCH_STYLES = `
      #shell .topbar .chat-modes{display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:100%}
      #shell .chat-mode{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;max-width:128px;height:27px;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--vscode-descriptionForeground);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
      #shell .chat-mode:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}
      #shell .chat-mode[aria-pressed="true"]{border-color:var(--vscode-widget-border,var(--vscode-panel-border));background:var(--vscode-editorWidget-background,var(--vscode-editor-background));color:var(--vscode-foreground);font-weight:600}
      #shell .chat-mode:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
      #shell .chat-mode-agent{min-width:72px;max-width:132px;justify-content:flex-start}
      #shell .chat-mode-agent .mode-agent-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
      #shell .chat-mode-agent .mode-chevron{width:11px;height:11px;flex:none;opacity:.75}
      #shell .agent-picker{position:relative;flex:none;min-width:0}
      #shell .agent-picker .menu{min-width:190px;max-width:min(260px,calc(100vw - 20px));max-height:min(360px,calc(100vh - 20px));overflow:auto;padding:5px}
      #shell .agent-picker .menu button{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:7px 9px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
      #shell .agent-picker .menu button:hover,#shell .agent-picker .menu button:focus-visible{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground));outline:none}
      #shell .agent-picker .menu button[aria-checked="true"]{font-weight:600}
      .mode-agent-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mode-agent-check{width:14px;height:14px;flex:none;color:var(--vscode-testing-iconPassed);opacity:0}
      [aria-checked="true"] .mode-agent-check{opacity:1}
      .vscode-high-contrast #shell .chat-mode[aria-pressed="true"]{outline:1px solid var(--vscode-contrastActiveBorder,var(--vscode-focusBorder))}
      @media(max-width:480px){#shell .topbar .chat-modes{gap:1px}#shell .chat-mode{height:26px;padding:0 6px;font-size:11px}#shell .chat-mode-agent{max-width:95px;min-width:56px}#shell .topbar-actions{gap:0}}
      @media(max-width:360px){#shell .chat-mode{padding:0 4px;font-size:10px}#shell .chat-mode-agent{max-width:74px;min-width:48px}}
`;

/** Round 2: Codex-like composer, history dropdown, calmer menus and a focus ring on the slider knob. */
const CHAT_POLISH_STYLES = `
      #shell .composer-footer{gap:4px}
      #shell .model-group{flex:0 1 auto;min-width:0}
      #shell .model-group .model-button{max-width:230px}
      #shell #approval-button>.chevron{display:none}
      #shell .send{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--vscode-button-background);color:var(--vscode-button-foreground);transition:background-color .12s,opacity .12s}
      #shell .send:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
      #shell .send:disabled{background:color-mix(in srgb,var(--vscode-foreground) 22%,transparent);color:var(--vscode-editor-background);opacity:1}
      #shell .send svg{width:16px;height:16px}
      #shell .sessions,#shell.rail-collapsed .sessions{inset:auto;top:42px;left:8px;right:8px;max-height:min(460px,calc(100vh - 150px));display:flex;flex-direction:column;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:12px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));box-shadow:0 12px 32px var(--vscode-widget-shadow,#00000030);transform:translateY(-6px);overflow:hidden}
      #shell.history-open .sessions{transform:none}
      #shell .sessions-head,#shell .sessions-tabs{display:none}
      #shell .sessions-search{padding:10px 10px 4px}
      #shell .sessions-search input{height:32px;border:0;border-radius:8px;background:transparent;font-size:13px}
      #shell .sessions-search input:focus{outline:none;border:0;background:color-mix(in srgb,var(--vscode-foreground) 5%,transparent)}
      .history-filter-row{display:flex;align-items:center;padding:0 10px 4px}
      .history-filter{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--vscode-foreground);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
      .history-filter:hover{background:var(--vscode-list-hoverBackground)}.history-filter .chevron{width:12px;height:12px}
      #shell .sessions-list{padding:0 6px 8px}
      #shell .session,#shell .session-open{border-radius:7px}
      #shell .session-open{flex-direction:row;align-items:center;gap:12px;padding:6px 10px}
      #shell .session-title{flex:1;min-width:0;font-size:13px}
      #shell .session.current .session-title{font-weight:400}
      #shell .session-meta{flex:none;font-size:12px;font-variant-numeric:tabular-nums}
      #shell .session:hover .session-title,#shell .session:focus-within .session-title{padding-right:0}
      #shell .session:hover .session-meta,#shell .session:focus-within .session-meta{visibility:hidden}
      #shell .session-actions{top:50%;transform:translateY(-50%);right:6px}
      #shell .session.current{background:color-mix(in srgb,var(--vscode-foreground) 7%,transparent);color:inherit}
      #shell .bar-menu button:hover,#shell .bar-menu button:focus-visible,#shell #history-filter-menu button:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground);outline:none}
      #shell #history-filter-menu{min-width:150px;padding:5px}
      #shell #history-filter-menu button{padding:7px 9px;border-radius:6px;font-size:13px}
      #shell #history-filter-menu button[aria-checked="true"]{font-weight:600}
      #shell #effort-slider:focus,#shell #effort-slider:focus-visible{outline:none}
      #shell #effort-slider:focus-visible::-webkit-slider-thumb{box-shadow:0 1px 4px #0000004d,0 0 0 3px color-mix(in srgb,var(--vscode-focusBorder) 55%,transparent)}
      #shell .model-effort-menu{padding:12px;border-radius:16px}
      #shell .me-head{grid-template-columns:28px minmax(0,1fr) 28px;align-items:start;gap:4px}
      #shell .me-icon,#shell .me-head #me-reset{height:24px;width:28px;display:grid;place-items:center;color:var(--vscode-foreground)}
      #shell .me-icon{opacity:.85}#shell .me-icon svg,#shell .me-reset svg{width:18px;height:18px}
      #shell .me-title{justify-self:stretch;justify-content:center;width:100%;padding:0 4px;gap:2px}
      #shell .me-level{position:relative;line-height:24px;font-size:15px;font-weight:600}
      #shell .me-level svg{position:absolute;left:100%;top:50%;margin:-6px 0 0 5px;width:12px;height:12px}
      #shell .me-model{font-size:12px;line-height:16px}
      #shell .me-slider{--knob:28px;--track:24px;margin:16px 0 0;height:var(--knob)}
      #shell .me-slider:before,#shell .me-slider:after{content:"";position:absolute;left:0;top:50%;height:var(--track);margin-top:calc(var(--track) / -2);border-radius:999px}
      #shell .me-slider:before{right:0;background:color-mix(in srgb,var(--vscode-foreground) 11%,transparent)}
      #shell .me-slider:after{width:calc(var(--knob) / 2 + (100% - var(--knob)) * var(--f));border-radius:999px 0 0 999px;background:var(--vscode-button-background,#0078d4)}
      #shell .me-stops{z-index:1}
      #shell #effort-slider{position:relative;z-index:2;height:var(--knob);border-radius:0;background:transparent}
      #shell #effort-slider::-webkit-slider-thumb{width:var(--knob);height:var(--knob);box-shadow:0 1px 3px #00000040,0 0 0 .5px #0000001f}
      #shell #effort-slider:focus-visible::-webkit-slider-thumb{box-shadow:0 1px 3px #00000040,0 0 0 3px color-mix(in srgb,var(--vscode-focusBorder) 55%,transparent)}
      #shell .me-stops span{width:4px;height:4px;margin:-2px 0 0 -2px}
      .vscode-high-contrast #shell #effort-slider{outline:none}
      .vscode-high-contrast #shell .me-slider:before{box-shadow:inset 0 0 0 1px var(--vscode-contrastBorder)}
      .vscode-high-contrast #shell .me-slider:after{background:var(--vscode-contrastActiveBorder,#f38518)}
      .vscode-high-contrast #shell .sessions{border-color:var(--vscode-contrastBorder)}
`;

/** Codex-style replies: plain text on the page, a "Worked for" line that folds the steps, icon steps, edited-files card. */
const CHAT_CODEX_REPLY_STYLES = `
      #shell .message.response{display:flex;flex-direction:column;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;animation:chat-message-in .28s cubic-bezier(.2,.75,.25,1) both}
      #shell .message.response .response-head{order:0;display:flex;align-items:center;gap:6px;width:100%;margin:0 0 12px;padding:0 0 9px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 80%,transparent);color:var(--vscode-descriptionForeground);font-size:12.5px;cursor:pointer;user-select:none}
      #shell .message.response.pending .response-head{cursor:default}
      #shell .response-head .response-avatar,#shell .response-head .message-label,#shell .response-head .response-status{display:none}
      #shell .response-head .response-elapsed{margin:0;font-size:12.5px;color:inherit}
      #shell .message.response:not(.pending) .response-head .response-elapsed:after{content:"";display:inline-block;width:6px;height:6px;margin:0 0 1px 7px;border:solid currentColor;border-width:0 1.4px 1.4px 0;transform:rotate(-45deg);transition:transform .15s}
      #shell .message.response.process-open:not(.pending) .response-head .response-elapsed:after{transform:rotate(45deg);margin-bottom:3px}
      #shell .message.response .response-head:hover{color:var(--vscode-foreground)}
      #shell .message.response .response-head:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
      #shell .message.response.pending .response-elapsed{background:linear-gradient(90deg,var(--vscode-descriptionForeground) 0 35%,var(--vscode-foreground) 50%,var(--vscode-descriptionForeground) 65% 100%) 0 0/300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:chat-shimmer 1.8s linear infinite}
      @keyframes chat-shimmer{from{background-position:100% 0}to{background-position:0 0}}
      #shell .message.response .response-now{display:none}
      #shell .message.response .response-thinking{order:1;margin:0 0 10px;padding:0;border:0}
      #shell .thinking-text{white-space:normal}
      #shell .thinking-text p{margin:0 0 10px}
      #shell .thinking-text ul,#shell .thinking-text ol{margin:7px 0 12px;padding-left:1.5em}
      #shell .thinking-text li+li{margin-top:4px}
      #shell .thinking-text li p{margin:0}
      #shell .thinking-text>:first-child{margin-top:0}
      #shell .thinking-text>:last-child{margin-bottom:0}
      #shell .message.response .response-activity{order:2;margin:0 0 12px;padding:0;border:0}
      #shell .message.response .message-content{order:3}
      #shell .message.response .message-content.streaming:not(:empty){white-space:normal}
      #shell .message.response .response-files{order:4}
      #shell .message.response .message-actions{order:5}
      #shell .message.response:not(.pending):not(.process-open) :is(.response-thinking,.response-activity){display:none}
      #shell .response-activity summary{gap:6px;color:var(--vscode-descriptionForeground);font-size:12.5px}
      #shell .response-activity summary:before{display:none}
      #shell .response-activity summary>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #shell .response-activity .activity-summary-count{flex:none;white-space:nowrap}
      #shell .response-activity summary:after{content:"";width:5px;height:5px;margin-left:2px;border:solid currentColor;border-width:0 1.4px 1.4px 0;transform:rotate(-45deg);transition:transform .15s}
      #shell .response-activity[open] summary:after{transform:rotate(45deg);margin-top:-3px}
      #shell .response-activity-list,#shell .message.response.pending .response-activity-list{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;margin-top:8px;padding:0 0 0 2px}
      #shell .response-activity-item{gap:9px;min-height:18px;color:var(--vscode-descriptionForeground);font-size:12.5px}
      #shell .response-activity-item .activity-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #shell .response-activity-item .activity-marker,#shell .response-activity-item.complete .activity-marker,#shell .response-activity-item.working .activity-marker,#shell .response-activity-item.failed .activity-marker,#shell .response-activity-item.approval .activity-marker{position:static;display:grid;place-items:center;width:15px;height:15px;border:0;border-radius:0;background:none;opacity:.85;animation:none}
      #shell .response-activity-item .activity-marker:after{display:none}
      #shell .response-activity-item .activity-marker svg{width:15px;height:15px}
      #shell .response-activity-item.working:not(.delegate-group)>.activity-label,#shell .delegate-group.working>.delegate-head .activity-label{color:var(--vscode-foreground);animation:chat-status-pulse 1.4s ease-in-out infinite}
      #shell .response-activity-item.approval{color:var(--vscode-editorWarning-foreground)}
      #shell .response-activity-item.delegate-group{flex-direction:column;align-items:stretch;gap:4px}
      /* The running list scrolls at a fixed height; rows keep their size instead of shrinking into each other. */
      #shell .response-activity-list>*,#shell .delegate-steps>*{flex-shrink:0}
      #shell .delegate-head{display:flex;align-items:center;gap:9px;min-width:0}
      #shell .delegate-group.complete>.delegate-head,#shell .delegate-group.working>.delegate-head{color:var(--vscode-foreground)}
      #shell .delegate-request{margin-left:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic}
      #shell .delegate-steps{display:flex;flex-direction:column;gap:6px;margin:2px 0 0 7px;padding:2px 0 2px 16px;border-left:1px solid color-mix(in srgb,var(--vscode-panel-border) 90%,transparent)}
      #shell .delegate-steps:empty{display:none}
      #shell .message.response .delegate-steps .response-thinking{margin:0;order:0}
      /* Live progress is capped so it does not push the answer away; a finished reply shows its steps in full. */
      #shell .message.response:not(.pending) .response-activity-list{max-height:none;overflow:visible}
      #shell .delegate-answer{margin:2px 0 0 24px}
      #shell .delegate-answer summary{color:var(--vscode-descriptionForeground);font-size:12px;cursor:pointer}
      #shell .delegate-answer-text{margin-top:6px;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--vscode-foreground) 4%,transparent);color:var(--vscode-foreground);font-size:12.5px;white-space:normal}
      #shell .response-activity-item.failed{color:var(--vscode-errorForeground)}
      .response-files{margin-top:14px;border:1px solid color-mix(in srgb,var(--vscode-panel-border) 85%,transparent);border-radius:12px;overflow:hidden;background:var(--vscode-editor-background);box-shadow:0 4px 14px #0000000d}
      .response-files-head{padding:10px 14px;font-size:12.5px;font-weight:600;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 70%,transparent)}
      .response-file{display:flex;align-items:center;gap:9px;width:100%;padding:8px 14px;border:0;background:transparent;color:var(--vscode-foreground);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
      .response-file+.response-file{border-top:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent)}
      .response-file:hover{background:var(--vscode-list-hoverBackground)}.response-file svg{flex:none;width:14px;height:14px;color:var(--vscode-descriptionForeground)}
      .response-file span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
      #shell .message.response .message-actions{position:static;display:flex;gap:2px;width:auto;margin-top:8px;padding:0;border:0;background:transparent;box-shadow:none;transform:none;opacity:0;pointer-events:none}
      #shell .message.response:hover .message-actions,#shell .message.response:focus-within .message-actions,#shell #messages>.message.response:last-child .message-actions{opacity:1;pointer-events:auto}
      #shell .message.response.pending .message-actions{display:none}
      /* Restored history appears at once; only new messages animate in. */
      #messages .message.restored,#messages .message.restored *{animation:none!important}
      #shell .message.response .message-actions button{width:26px;height:26px;padding:0;justify-content:center}
      #shell .message.response .message-actions svg{width:15px;height:15px}
      .user-images{align-self:flex-end;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:85%;margin-bottom:-12px}
      #shell .user-images .user-image-preview{width:88px;height:64px;max-width:none;max-height:none;margin:0;object-fit:cover;border:1px solid color-mix(in srgb,var(--vscode-panel-border) 85%,transparent);border-radius:10px;box-shadow:0 4px 12px #00000014}
      #shell .jump-latest{width:32px;height:32px;padding:0;justify-content:center;border-radius:50%;top:-44px}
      #shell .jump-latest svg{width:15px;height:15px}
      @media(prefers-reduced-motion:reduce){#shell .message.response.pending .response-elapsed{animation:none;color:var(--vscode-descriptionForeground);background:none}}
`;

/**
 * Codex-style surface: the chat sits on the sidebar colour edge to edge (VS Code's default 20px webview padding removed),
 * grey user bubbles without borders, and thin rounded overlay-style scrollbars everywhere.
 */
const CHAT_SURFACE_STYLES = `
      html,body{padding:0!important;margin:0}
      body,#shell,#shell .app,#shell .conversation,#shell .topbar{background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
      #shell .composer-area{padding:6px 12px 12px;background:linear-gradient(transparent,var(--vscode-sideBar-background,var(--vscode-editor-background)) 16px)}
      #shell .composer{background:var(--vscode-input-background,var(--vscode-editor-background))}
      #shell .conversation{padding:14px 22px 12px}
      #shell .topbar{padding:0 10px 0 14px}
      #shell .conversation-inner{width:min(100%,760px)}
      #shell #messages{gap:26px}
      #shell .message.user{max-width:82%;padding:9px 15px;border:0;border-radius:16px;background:color-mix(in srgb,var(--vscode-foreground) 7.5%,transparent);color:var(--vscode-foreground);box-shadow:none}
      #shell .message.response.result .message-label{display:none}
      #shell .message-content pre{background:var(--vscode-textCodeBlock-background,color-mix(in srgb,var(--vscode-foreground) 5%,transparent))}
      /* VS Code's default webview CSS styles every <code> like inline code; inside a block that paints a band behind each line. */
      #shell .message-content pre code{display:block;padding:0;border-radius:0;background:transparent;color:inherit;font-size:inherit;white-space:pre}
      .vscode-high-contrast #shell .message.user{border:1px solid var(--vscode-contrastBorder)}
      ::-webkit-scrollbar{width:10px;height:10px}
      ::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
      ::-webkit-scrollbar-thumb{min-height:36px;border:3px solid transparent;border-radius:999px;background:color-mix(in srgb,var(--vscode-foreground) 20%,transparent) padding-box}
      ::-webkit-scrollbar-thumb:hover{border-width:2px;background:color-mix(in srgb,var(--vscode-foreground) 34%,transparent) padding-box}
      ::-webkit-scrollbar-thumb:active{background:color-mix(in srgb,var(--vscode-foreground) 42%,transparent) padding-box}
      .vscode-high-contrast ::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,#6f6f6f) padding-box}
      .laya-line{display:flex;align-items:center;gap:8px;margin:0 14px 4px;padding:5px 6px 5px 10px;border:1px solid color-mix(in srgb,var(--vscode-editorWarning-foreground) 35%,transparent);border-radius:8px;background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 8%,transparent);color:var(--vscode-foreground);font-size:12px}
      .laya-line-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--vscode-editorWarning-foreground)}
      .laya-line-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #laya-resume{flex:none;height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;font-size:12px;cursor:pointer}
      #laya-resume:hover{background:var(--vscode-list-hoverBackground)}#laya-resume:focus-visible{outline:1px solid var(--vscode-focusBorder)}
      .vscode-high-contrast .laya-line{border-color:var(--vscode-contrastBorder)}
      #shell .topbar .chat-modes{gap:2px;align-self:stretch}
      #shell .chat-mode{height:26px;align-self:center;padding:0 9px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--vscode-descriptionForeground)}
      #shell .chat-mode[aria-pressed="true"]{border-color:transparent;background:var(--vscode-tab-activeBackground,color-mix(in srgb,var(--vscode-foreground) 8%,transparent));color:var(--vscode-tab-activeForeground,var(--vscode-foreground));font-weight:500}
      #shell .chat-mode:hover{background:var(--vscode-tab-hoverBackground,color-mix(in srgb,var(--vscode-foreground) 5%,transparent))}
      #shell .chat-mode[aria-pressed="true"]:hover{background:var(--vscode-tab-activeBackground,color-mix(in srgb,var(--vscode-foreground) 8%,transparent))}
      #shell .topbar-assign{height:24px;min-width:86px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px;border:0;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font:inherit;font-size:12px;font-weight:500;line-height:1;text-align:center;white-space:nowrap}
      #shell .topbar-assign svg{display:block;flex:none;width:12px;height:12px}
      #shell .topbar-assign .assign-label{display:inline-block;line-height:1;text-align:center}
      #shell .topbar-assign:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
      #shell .topbar-assign:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
      #shell .topbar-assign:disabled{opacity:.5;cursor:default}
      .vscode-high-contrast #shell .topbar-assign{outline:1px solid var(--vscode-contrastBorder,var(--vscode-focusBorder))}
      @media(max-width:560px){#shell .conversation{padding:12px 14px 10px}#shell .composer-area{padding:6px 8px 10px}}
      @media(max-width:480px){#shell .topbar{gap:0;padding:0 6px}#shell .chat-mode{padding:0 7px}#shell .chat-mode-agent{min-width:52px;max-width:88px}#shell .topbar-actions{gap:0}#shell .topbar-assign{width:28px;min-width:28px;padding:0}#shell .topbar-assign .assign-label{display:none}}
      @container composer (max-width:360px){#shell .composer-footer{gap:3px}#shell .controls{display:grid;grid-template-columns:30px 30px minmax(88px,1fr);gap:2px;flex:1 1 0;min-width:0}#shell .controls>.control-group{width:30px;min-width:0;flex:none}#shell .controls>.model-group{width:auto;min-width:88px}#shell .model-group .model-button{display:flex;width:100%;max-width:none;min-width:0;gap:4px;padding:0 4px}#shell .model-button .model-label{width:auto;min-width:0;flex:1 1 auto}#shell .model-button .effort-chip{flex:none}#shell #approval-button{width:30px;min-width:30px;padding:0;justify-content:center}}
      @media(max-width:360px){#shell .chat-mode{padding:0 5px;font-size:10px}#shell .chat-mode-agent{min-width:48px;max-width:72px}}
`;

const CHAT_MOTION_STYLES = `
      .message{animation:chat-message-in .28s cubic-bezier(.2,.75,.25,1) both;animation-delay:var(--message-delay,0ms)}
      .message.response.pending{animation:chat-message-in .28s cubic-bezier(.2,.75,.25,1) var(--message-delay,0ms) both,chat-response-pulse 2.2s ease-in-out calc(var(--message-delay,0ms) + .28s) infinite}
      @keyframes chat-message-in{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes chat-response-pulse{50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--vscode-focusBorder) 9%,transparent)}}
      .response-status.thinking:after{content:" ···";display:inline-block;overflow:hidden;max-width:0;vertical-align:bottom;white-space:nowrap;animation:chat-thinking-dots 1.2s steps(4,end) infinite}
      @keyframes chat-thinking-dots{to{max-width:1.5em}}
      @media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

/** A hand-off's result, shortened but still valid JSON, so a reopened chat can show its answer. */
function handoffAnswer(resultJson: string | undefined): string | undefined {
  if (!resultJson) return undefined;
  try {
    const data = JSON.parse(resultJson) as { result?: unknown; error?: unknown };
    if (typeof data.error === "string") return JSON.stringify({ error: data.error.slice(0, 1000) });
    if (typeof data.result === "string") return JSON.stringify({ result: data.result.slice(0, 1000) });
  } catch { /* not JSON: keep the start of the text */ }
  return JSON.stringify({ result: resultJson.slice(0, 1000) });
}

export class ChatWindowProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private view?: vscode.WebviewView;
  private selectedAgent = { id: "lead", name: "Lead" };
  private teamMode = true;
  /** The open chat session; undefined until the first message of a new chat. */
  private conversationId?: string;
  private running = 0;
  private composerConfig: ChatComposerConfig;
  private readonly attachments = new Map<string, ChatAttachment>();
  private readonly disposables: vscode.Disposable[] = [];
  private viewDisposables: vscode.Disposable[] = [];
  private panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly queue: TaskQueue,
    private readonly submit: ChatSubmitHandler,
    private readonly getComposerConfig: (agentId: string) => ChatComposerConfig,
    private readonly pickAttachments: ChatAttachmentPicker,
    messageBus?: AgentMessageBus,
    private readonly extensionUri?: vscode.Uri,
    private readonly store?: ChatSessionStore
  ) {
    this.composerConfig = getComposerConfig(this.selectedAgent.id);
    this.disposables.push(queue.onDidChange(event => this.postQueueEvent(event)));
    if (messageBus) this.disposables.push(messageBus.onDidMessage(message => this.post({ type: "agent-message", text: `${message.fromAgentId} \u2192 ${message.toAgentId} \u00b7 ${message.kind}\n${message.content}` })));
  }

  openAgent(id: string, name: string) {
    if (this.running > 0 && this.hasSurface()) {
      this.showChat();
      void vscode.window.showInformationMessage("Wait for the current reply to finish before switching agents.");
      return;
    }
    this.selectAgent(id, name);
    this.teamMode = false;
    this.conversationId = undefined;
    this.showChat();
    this.postAgent();
    this.postSession();
    this.postSessions();
  }

  openTeamChat() {
    if (this.running > 0 && this.hasSurface()) { this.showChat(); return; }
    this.selectAgent("lead", "Team");
    this.teamMode = true;
    this.conversationId = undefined;
    this.showChat();
    this.postAgent();
    this.postSession();
    this.postSessions();
  }

  /** Reopen a saved chat and continue it with the agent it belongs to. */
  openSession(conversationId: string) {
    const summary = this.store?.sessions.get(conversationId);
    if (!summary) {
      void vscode.window.showInformationMessage("That chat no longer exists.");
      return;
    }
    if (this.running > 0 && this.hasSurface() && conversationId !== this.conversationId) {
      this.showChat();
      void vscode.window.showInformationMessage("Wait for the current reply to finish before opening another chat.");
      return;
    }
    const agentId = summary.agentId ?? this.selectedAgent.id;
    this.selectAgent(agentId, summary.chatMode === "team" ? "Team" : this.store?.agentName(agentId) ?? agentId);
    this.teamMode = summary.chatMode === "team";
    this.conversationId = conversationId;
    this.showChat();
    this.postAgent();
    this.postSession();
    this.postSessions();
  }

  dispose() {
    vscode.Disposable.from(...this.disposables, ...this.viewDisposables, ...this.panelDisposables).dispose();
    this.panel?.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, ...(this.extensionUri ? { localResourceRoots: [this.extensionUri] } : {}) };
    view.webview.html = this.html(view.webview);
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: ChatWindowMessage) => void this.receive(message)),
      view.onDidDispose(() => {
        vscode.Disposable.from(...this.viewDisposables).dispose();
        this.viewDisposables = [];
        if (this.view === view) this.view = undefined;
      })
    );
  }

  private selectAgent(id: string, name: string) {
    this.selectedAgent = { id, name };
    this.attachments.clear();
    this.composerConfig = this.getComposerConfig(id);
  }

  private hasSurface() { return !!(this.view || this.panel); }

  private showChat() {
    if (hasSecondarySidebar()) {
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`).then(undefined, () => this.ensurePanel());
      return;
    }
    this.ensurePanel();
  }

  private ensurePanel() {
    const title = this.teamMode ? "Team Chat" : `Chat · ${this.selectedAgent.name}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentOrchestrator.agentChat",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, ...(this.extensionUri ? { localResourceRoots: [this.extensionUri] } : {}) }
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    this.panelDisposables.push(panel.webview.onDidReceiveMessage((message: ChatWindowMessage) => void this.receive(message)));
    this.panelDisposables.push(panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      vscode.Disposable.from(...this.panelDisposables).dispose();
      this.panelDisposables = [];
    }));
  }

  private async receive(message: ChatWindowMessage) {
    if (!message || typeof message !== "object") return;
    const id = "id" in message && typeof message.id === "string" ? message.id : "";
    switch (message.type) {
      case "submit": if (typeof message.prompt === "string" && (message.prompt.trim() || message.intent === "assign")) void this.run(message); return;
      case "add-attachments": void this.addAttachments(); return;
      case "add-image-attachments": this.addImageAttachments(Array.isArray(message.files) ? message.files : []); return;
      case "remove-attachment": this.attachments.delete(message.id); return;
      // The page loaded (or reloaded): send the history and the chat it should show.
      case "chat-ready": this.postAgent(); this.postSession(); this.postSessions(); this.refreshLayaStatus(); return;
      case "select-chat-mode": {
        if (message.mode === "team") { this.openTeamChat(); return; }
        if (message.mode === "supervisor") { this.openAgent("lead", this.store?.agentName("lead") ?? "Lead"); return; }
        const agent = typeof message.agentId === "string" ? this.store?.agents().find(item => item.id === message.agentId && item.id !== "lead") : undefined;
        if (agent) this.openAgent(agent.id, agent.name);
        return;
      }
      case "resume-laya": await vscode.commands.executeCommand("agentOrchestrator.resumeLaya"); return;
      case "new-session":
        if (this.running > 0) { void vscode.window.showInformationMessage("Wait for the current reply to finish before starting a new chat."); return; }
        const pendingIds = [...this.attachments.keys()];
        this.attachments.clear();
        this.post({ type: "attachments-cleared", ids: pendingIds });
        this.conversationId = undefined;
        this.postSession();
        this.postSessions();
        return;
      case "open-session": if (id) this.openSession(id); return;
      case "rename-session": {
        const session = id && this.store?.sessions.get(id);
        if (!session) return;
        const title = await vscode.window.showInputBox({ title: "Rename chat", value: session.title, validateInput: value => value.trim() ? undefined : "Enter a name." });
        if (!title?.trim()) return;
        this.store!.sessions.rename(id, title);
        if (id === this.conversationId) this.postSessionMeta();
        this.postSessions();
        return;
      }
      case "archive-session":
        if (!id || !this.store?.sessions.get(id)) return;
        this.store.sessions.setArchived(id, message.archived === true);
        if (id === this.conversationId) this.postSessionMeta();
        this.postSessions();
        this.post({ type: "toast", text: message.archived ? "Chat archived. Find it under Archived." : "Chat restored." });
        return;
      case "open-settings": await vscode.commands.executeCommand("agentOrchestrator.openSettings"); return;
      case "open-file": {
        // Only workspace-relative paths the agents reported; never absolute paths or "..".
        const folder = vscode.workspace.workspaceFolders?.[0];
        const relative = typeof message.path === "string" ? message.path : "";
        const segments = relative.split(/[\\/]+/).filter(segment => segment && segment !== ".");
        if (!folder || !segments.length || segments.includes("..") || /^([a-z]:|[\\/])/i.test(relative)) return;
        await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, ...segments), { preview: true });
        return;
      }
      case "remember": await this.remember(typeof message.text === "string" ? message.text : ""); return;
      case "copy":
        if (typeof message.text === "string" && message.text) {
          await vscode.env.clipboard.writeText(message.text);
          this.post({ type: "toast", text: "Copied." });
        }
        return;
    }
  }

  private async remember(text: string) {
    const content = text.trim().slice(0, 4000);
    if (!content || !this.store) return;
    const agent = this.selectedAgent;
    const preview = content.replace(/\s+/g, " ").slice(0, 90);
    const pick = await vscode.window.showQuickPick([
      { label: `$(person) Remember for ${agent.name}`, description: "Only this agent recalls it", scope: "agent" as const },
      { label: "$(organization) Remember for all agents", description: "Shared project memory", scope: "all" as const }
    ], { title: "Remember this", placeHolder: preview });
    if (!pick) return;
    this.store.remember(agent.id, pick.scope, content, this.conversationId);
    this.post({ type: "toast", text: pick.scope === "agent" ? `Saved to ${agent.name}'s memory.` : "Saved to shared project memory." });
  }

  private async addAttachments() {
    try {
      const picked = await this.pickAttachments();
      const added = picked.map(file => {
        const id = randomBytes(12).toString("hex");
        this.attachments.set(id, file);
        return { id, name: file.name };
      });
      if (added.length) this.post({ type: "attachments", files: added });
    } catch (error) {
      this.post({ type: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  private addImageAttachments(files: unknown[]) {
    const currentImages = [...this.attachments.values()].filter((item): item is ChatImageAttachment => "dataUrl" in item);
    let totalBytes = currentImages.reduce((sum, image) => sum + Math.floor((image.dataUrl.length * 3) / 4), 0);
    const added: Array<{ id: string; name: string; mimeType: string; dataUrl: string; image: true }> = [];
    for (const raw of files.slice(0, 8)) {
      if (!raw || typeof raw !== "object") continue;
      const file = raw as { name?: unknown; mimeType?: unknown; dataUrl?: unknown };
      if (typeof file.name !== "string" || typeof file.mimeType !== "string" || typeof file.dataUrl !== "string") continue;
      if (file.dataUrl.length > 7 * 1024 * 1024) continue;
      const mimeType = file.mimeType.toLowerCase();
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) continue;
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z\d+/]+=*)$/i.exec(file.dataUrl);
      if (!match || match[1].toLowerCase() !== mimeType) continue;
      const bytes = Math.floor((match[2].length * 3) / 4);
      if (bytes > 5 * 1024 * 1024 || totalBytes + bytes > 10 * 1024 * 1024 || currentImages.length + added.length >= 4) continue;
      const image: ChatImageAttachment = { name: file.name.slice(0, 120), mimeType, dataUrl: file.dataUrl };
      const id = randomBytes(12).toString("hex");
      this.attachments.set(id, image);
      added.push({ id, name: image.name, mimeType, dataUrl: image.dataUrl, image: true });
      totalBytes += bytes;
    }
    if (added.length) this.post({ type: "attachments", files: added });
    else if (files.length) this.post({ type: "toast", text: "Images must be PNG, JPEG, WebP, or GIF, with a 10 MB total limit." });
  }

  private async run(message: Extract<ChatWindowMessage, { type: "submit" }>) {
    const intent = message.intent === "assign" ? "assign" : "discuss";
    const prompt = message.prompt.trim() || (intent === "assign" ? "Please carry out the task we agreed on in this discussion." : "");
    if (!prompt) return;
    const agentId = this.selectedAgent.id;
    const approvalMode = message.approvalMode === "approve" || message.approvalMode === "full" ? message.approvalMode : "ask";
    const reasoningEffort = message.reasoningEffort === "low" || message.reasoningEffort === "medium" || message.reasoningEffort === "high" ? message.reasoningEffort : undefined;
    const model = this.composerConfig.models.find(option => option.key === message.modelKey);
    const attachmentIds = Array.isArray(message.attachmentIds) ? message.attachmentIds : [];
    const selectedAttachments = attachmentIds.map(id => this.attachments.get(id)).filter((file): file is ChatAttachment => !!file);
    const attached = selectedAttachments.filter((file): file is { name: string; content: string } => "content" in file);
    const images = selectedAttachments.filter((file): file is ChatImageAttachment => "dataUrl" in file);
    const selection: ChatComposerSelection = {
      approvalMode,
      planMode: message.planMode === true,
      thinking: message.thinking === true,
      reasoningEffort,
      providerId: model?.providerId,
      model: model?.model,
      attachments: attached,
      images
    };
    // First message starts a session; every later message continues it, so the agent sees the earlier turns.
    const conversationId = this.conversationId ??= randomUUID();
    if (this.store) {
      this.store.sessions.ensure(conversationId, prompt, agentId, this.teamMode ? "team" : agentId === "lead" ? "supervisor" : "agent");
      if (this.store.sessions.get(conversationId)?.archived) this.store.sessions.setArchived(conversationId, false);
    }
    this.post({ type: "user", text: prompt, images: attachmentIds.flatMap(id => {
      const image = this.attachments.get(id);
      return image && "dataUrl" in image ? [{ id, name: image.name }] : [];
    }) });
    this.postSessionMeta();
    this.postSessions();
    this.running++;
    // Record what the chat shows live (steps, thinking, time) so the reply looks the same when the chat is reopened.
    const startedAt = Date.now();
    const startRowid = this.store?.sessions.lastMessageRowid(conversationId) ?? 0;
    const steps: ReplyStep[] = [];
    const thinking = new Map<string, string>();
    const addThinking = (agent: string, text: string, separate: boolean) => {
      const before = thinking.get(agent) ?? "";
      thinking.set(agent, (before + (separate && before ? "\n\n" : "") + text).slice(-20_000));
    };
    const trace = (): ReplyTrace => ({ version: 1, durationMs: Date.now() - startedAt, steps, thinking: [...thinking].map(([agent, text]) => ({ agentId: agent, text })) });
    try {
      const result = await this.queue.enqueue((intent === "assign" ? "Assign: " : "Discuss: ") + prompt.slice(0, 72), () => this.submit(prompt, agentId, selection, (text, event) => {
        if (!event) { this.post({ type: "progress", text }); steps.push({ type: "progress", text: text.slice(0, 300) }); return; }
        if (event.type === "chunk") this.post({ type: "chunk", text: event.text });
        else if (event.type === "thinking_chunk") { this.post({ type: "thinking_chunk", text: event.text, agentId: event.agentId }); addThinking(event.agentId, event.text, false); }
        else if (event.type === "thinking_message") { this.post({ type: "thinking_message", text: event.text, agentId: event.agentId }); addThinking(event.agentId, event.text, true); }
        else if (event.type === "stream_reset") this.post({ type: "stream_reset" });
        else if (event.type === "start" || event.type === "delegate" || event.type === "tool") {
          this.post({ type: "activity", event });
          // Tool output can be large; retain bounded errors so the reason survives reopening the chat.
          const handoff = event.toolName === "ask_agent" || event.toolName === "delegate_task";
          const text = event.type === "tool"
            ? (event.text?.startsWith("Waiting for approval:") ? event.text.slice(0, 120) : handoff && event.phase !== "start" ? handoffAnswer(event.text) : event.phase === "error" ? event.text?.slice(0, 1500) : undefined)
            : event.text?.slice(0, 300);
          steps.push({ type: event.type, agentId: event.agentId, toolName: event.toolName, toolCallId: event.toolCallId, phase: event.phase, path: event.path, text, targetAgentId: event.targetAgentId, delegateMode: event.delegateMode });
        }
      }, conversationId, this.teamMode ? "team" : "agent", intent));
      this.post({ type: "result", text: result });
      try { this.store?.sessions.saveReplyTrace(conversationId, startRowid, trace()); } catch (error) { console.warn("Could not save the reply record", error); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.post({ type: "error", text: message });
      try { this.store?.sessions.addFailedReply(randomUUID(), conversationId, agentId, message, trace()); } catch (saveError) { console.warn("Could not save the failed reply", saveError); }
    } finally {
      this.running--;
      for (const id of attachmentIds) this.attachments.delete(id);
      this.post({ type: "attachments-cleared", ids: attachmentIds });
      this.postSessions();
      this.refreshLayaStatus();
    }
  }

  /** Tell the chat whether Laya is paused, so it can say routing uses the fallback and offer to resume. */
  refreshLayaStatus() {
    const status = this.store?.layaStatus?.();
    this.post({ type: "laya-status", paused: Boolean(status?.paused), pausedAt: status?.pausedAt, reason: status?.lastError });
  }

  private postAgent() { this.post({ type: "agent", id: this.selectedAgent.id, name: this.selectedAgent.name, teamMode: this.teamMode, agents: this.store?.agents().filter(agent => agent.id !== "lead") ?? [], config: this.composerConfig }); }

  /** The chat on screen: its transcript (empty for a new chat) and its title. */
  private postSession() {
    const summary = this.conversationId ? this.store?.sessions.get(this.conversationId) : undefined;
    const messages = summary ? this.store!.sessions.messages(summary.id).map(message => ({
      role: message.role, text: message.text, at: message.at, trace: message.trace,
      author: message.role === "user" ? "You" : this.store!.agentName(message.agentId ?? "") ?? this.selectedAgent.name
    })) : [];
    this.post({ type: "session", id: summary?.id ?? null, title: summary?.title ?? null, archived: summary?.archived ?? false, messages });
  }

  private postSessionMeta() {
    const summary = this.conversationId ? this.store?.sessions.get(this.conversationId) : undefined;
    this.post({ type: "session-meta", id: summary?.id ?? null, title: summary?.title ?? null, archived: summary?.archived ?? false });
  }

  private postSessions() {
    if (!this.store || !this.hasSurface()) return;
    const decorate = (items: ReturnType<SessionRepository["list"]>) => items.map(item => ({ ...item, agentName: item.chatMode === "team" ? "Team" : item.chatMode === "supervisor" ? "Supervisor" : item.agentId ? this.store!.agentName(item.agentId) ?? item.agentId : "" }));
    this.post({
      type: "sessions",
      currentId: this.conversationId ?? null,
      recent: decorate(this.store.sessions.list({ archived: false })),
      archived: decorate(this.store.sessions.list({ archived: true }))
    });
  }

  private postQueueEvent(event: QueueEvent) { this.post({ type: "queue", id: event.id, status: event.status, label: event.label, error: event.error }); }
  private post(message: unknown) { void (this.view?.webview ?? this.panel?.webview)?.postMessage(message); }

  private html(webview: vscode.Webview) {
    const nonce = randomBytes(18).toString("base64");
    const csp = webview.cspSource;
    const markdownScript = this.extensionUri ? webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "markdown-it.min.js")) : undefined;
    const agentName = this.selectedAgent.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
    const configJson = JSON.stringify(this.composerConfig).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:; script-src ${csp} 'nonce-${nonce}';"><style>
      :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
      .app{height:100%;display:flex;flex-direction:column}.topbar{height:56px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid var(--vscode-panel-border)}.agent{display:flex;align-items:center;gap:10px}.avatar{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;background:var(--vscode-textCodeBlock-background);color:var(--vscode-textLink-foreground);font-size:15px}.agent-name{font-size:13px;font-weight:600}.agent-caption{margin-top:2px;color:var(--vscode-descriptionForeground);font-size:11px}.quiet-button{border:0;background:transparent;color:var(--vscode-descriptionForeground);padding:6px 9px;border-radius:7px;cursor:pointer;font:inherit}.quiet-button:hover,.menu button:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}
      .conversation{flex:1;min-height:0;overflow:auto;padding:30px 24px 18px}.conversation-inner{width:min(100%,820px);min-height:100%;margin:0 auto;display:flex;flex-direction:column}.welcome{margin:auto auto 38px;text-align:center;max-width:520px;padding:32px 12px}.welcome-mark{width:42px;height:42px;display:grid;place-items:center;margin:0 auto 18px;border:1px solid var(--vscode-panel-border);border-radius:15px;color:var(--vscode-textLink-foreground);font-size:22px}.welcome-mark svg{display:block;width:27px;height:27px}.welcome h1{font-size:20px;line-height:1.35;font-weight:500;margin:0 0 9px}.welcome p{margin:0;color:var(--vscode-descriptionForeground);line-height:1.6}
      #messages{display:flex;flex-direction:column;gap:22px;margin-top:auto}.message{max-width:min(88%,720px);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}.message.user{align-self:flex-end;padding:11px 15px;border:1px solid color-mix(in srgb,var(--vscode-focusBorder) 24%,var(--vscode-panel-border));border-radius:18px 18px 5px 18px;background:color-mix(in srgb,var(--vscode-textLink-foreground) 8%,var(--vscode-editor-background));box-shadow:0 7px 20px #00000012,0 2px 5px #0000000a}.message.result{align-self:flex-start;width:100%;max-width:100%;padding:16px 18px;border:1px solid var(--vscode-panel-border);border-radius:16px;background:var(--vscode-textCodeBlock-background);box-shadow:0 5px 16px #0000000a}.message.progress,.message.agent-message{align-self:flex-start;color:var(--vscode-descriptionForeground);font-size:.92em}.message.error{align-self:flex-start;color:var(--vscode-errorForeground)}.message-label{display:block;margin-bottom:5px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600}.message-content{white-space:normal}.message-content>:first-child{margin-top:0}.message-content>:last-child{margin-bottom:0}.message-content p{margin:0 0 10px}.message-content pre{overflow:auto;padding:12px;border-radius:9px;background:var(--vscode-textCodeBlock-background)}.message-content code{font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}.message-content img{display:block;max-width:100%;max-height:520px;object-fit:contain;border-radius:9px}.message-content table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.message-content th,.message-content td{padding:6px 9px;border:1px solid var(--vscode-panel-border)}.queue{width:min(100%,820px);min-height:19px;margin:0 auto 8px;color:var(--vscode-descriptionForeground);font-size:11px}
      .message.response{align-self:flex-start;width:100%;max-width:100%;padding:16px 18px;border:1px solid color-mix(in srgb,var(--vscode-panel-border) 78%,transparent);border-radius:17px;background:color-mix(in srgb,var(--vscode-textCodeBlock-background) 22%,var(--vscode-editor-background));box-shadow:0 8px 24px #00000010,0 2px 6px #00000008}.message.response.pending{border-color:color-mix(in srgb,var(--vscode-focusBorder) 36%,var(--vscode-panel-border))}.message.response.error{border-color:color-mix(in srgb,var(--vscode-errorForeground) 42%,var(--vscode-panel-border));background:color-mix(in srgb,var(--vscode-errorForeground) 5%,var(--vscode-editor-background))}.message.response .message-label{color:var(--vscode-foreground)}.message-content.streaming{min-height:12px;border-left:2px solid var(--vscode-focusBorder);padding-left:10px}.response-status{margin-top:9px;color:var(--vscode-descriptionForeground);font-size:11px}.response-status.failed{color:var(--vscode-errorForeground)}.response-activity{margin-top:11px;padding-top:9px;border-top:1px solid var(--vscode-panel-border)}.response-activity summary{display:flex;align-items:center;gap:7px;min-height:19px;color:var(--vscode-descriptionForeground);font-size:11px;cursor:pointer;list-style:none}.response-activity summary::-webkit-details-marker{display:none}.response-activity summary:before{content:"›";width:10px;color:var(--vscode-descriptionForeground);font-size:15px;line-height:1;transition:transform .12s}.response-activity[open] summary:before{transform:rotate(90deg)}.activity-summary-count{color:var(--vscode-descriptionForeground);opacity:.78}.response-activity-list{display:flex;flex-direction:column;gap:5px;margin-top:7px;padding-left:17px}.response-activity-item{display:flex;align-items:center;gap:8px;min-height:19px;color:var(--vscode-descriptionForeground);font-size:11px}.activity-marker{width:12px;height:12px;flex:none;border:1px solid var(--vscode-disabledForeground);border-radius:50%;opacity:.8}.response-activity-item.working .activity-marker{border-color:var(--vscode-progressBar-background);border-top-color:transparent;animation:chat-spin .8s linear infinite}.response-activity-item.approval .activity-marker{border-color:var(--vscode-editorWarning-foreground)}.response-activity-item.complete .activity-marker{position:relative;border-color:var(--vscode-testing-iconPassed);background:var(--vscode-testing-iconPassed);opacity:1}.response-activity-item.complete .activity-marker:after{content:"";position:absolute;left:3.5px;top:1.5px;width:3px;height:6px;border:solid var(--vscode-editor-background);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}.response-activity-item.failed{color:var(--vscode-errorForeground)}.response-activity-item.failed .activity-marker{border-color:var(--vscode-errorForeground)}@keyframes chat-spin{to{transform:rotate(360deg)}}.queue:empty{display:none}
      .composer-area{flex:none;padding:8px 22px 18px;background:linear-gradient(transparent,var(--vscode-editor-background) 18px)}.composer{container-type:inline-size;container-name:composer;position:relative;width:min(100%,820px);margin:0 auto;padding:14px 15px 12px;border:1px solid var(--vscode-panel-border);border-radius:21px;background:var(--vscode-input-background);box-shadow:0 18px 42px #0000001a,0 3px 10px #00000012,inset 0 1px 0 #ffffff10;transition:border-color .16s,box-shadow .16s,transform .16s}.composer:hover{box-shadow:0 20px 48px #00000020,0 4px 12px #00000012,inset 0 1px 0 #ffffff10}.composer:focus-within{border-color:var(--vscode-focusBorder);box-shadow:0 18px 44px #00000020,0 0 0 3px color-mix(in srgb,var(--vscode-focusBorder) 13%,transparent)}textarea{display:block;width:100%;min-height:52px;max-height:180px;resize:none;border:0;outline:0;padding:2px 3px 10px;color:var(--vscode-input-foreground);background:transparent;font:inherit;line-height:1.55}textarea::placeholder{color:var(--vscode-input-placeholderForeground)}.composer-footer{display:flex;align-items:center;justify-content:space-between;gap:10px}.controls,.control-group{display:flex;align-items:center;gap:6px;min-width:0}.control-group{position:relative}.icon-button,.control-button{height:32px;border:1px solid transparent;border-radius:11px;background:transparent;color:var(--vscode-foreground);font:inherit;cursor:pointer;transition:background .14s,border-color .14s,transform .14s}.icon-button{width:32px;display:grid;place-items:center;color:var(--vscode-descriptionForeground)}.icon-button:hover,.control-button:hover{background:var(--vscode-toolbar-hoverBackground);border-color:var(--vscode-panel-border);color:var(--vscode-foreground)}.icon-button:active,.control-button:active{transform:scale(.97)}.control-button{display:flex;align-items:center;gap:7px;padding:0 10px;color:var(--vscode-descriptionForeground);font-size:12px}.control-button svg,.icon-button svg,.send svg{width:16px;height:16px;flex:none}.control-button .chevron{width:12px;height:12px;opacity:.65}.approval-button{border-radius:999px;background:color-mix(in srgb,var(--vscode-foreground) 6%,transparent);padding:0 11px}.model-button{max-width:210px}.model-button .model-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.effort-button{min-width:0;justify-content:space-between}.send{width:34px;height:34px;flex:none;display:grid;place-items:center;border:0;border-radius:50%;background:var(--vscode-button-background);color:var(--vscode-button-foreground);box-shadow:0 2px 7px #00000024;cursor:pointer;transition:transform .15s,box-shadow .15s,background .15s}.send:hover{background:var(--vscode-button-hoverBackground);box-shadow:0 4px 12px #00000030;transform:translateY(-1px)}.send:active{transform:scale(.94)}.send:disabled{opacity:.48;cursor:default;box-shadow:none;transform:none}
      .menu{position:absolute;z-index:5;left:0;bottom:42px;width:min(320px,calc(100vw - 28px));max-height:min(420px,65vh);overflow:auto;padding:8px;border:1px solid var(--vscode-panel-border);border-radius:15px;background:var(--vscode-editorWidget-background,var(--vscode-menu-background));box-shadow:0 20px 50px #00000030,0 4px 12px #00000018;backdrop-filter:blur(14px);animation:menu-in .12s ease-out}.menu.align-right{left:auto;right:0}.menu.below{top:42px;bottom:auto}.menu[hidden]{display:none}@keyframes menu-in{from{opacity:0;transform:translateY(5px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}.menu-heading{padding:7px 10px 9px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600;letter-spacing:.02em}.menu button{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:0;border-radius:9px;background:transparent;color:var(--vscode-foreground);text-align:left;font:inherit;cursor:pointer;transition:background .12s}.menu button:hover,.menu button.selected{background:var(--vscode-list-hoverBackground)}.menu-copy{display:flex;flex-direction:column;gap:3px}.menu-title{font-size:12px}.menu-description{color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.4}.menu .danger{color:var(--vscode-editorWarning-foreground)}.menu-separator{height:1px;margin:6px 5px;background:var(--vscode-panel-border)}.menu-check{color:var(--vscode-textLink-foreground);font-size:14px}.attachments{display:flex;flex-wrap:wrap;gap:9px;margin:0 0 11px}.attachment{position:relative;display:flex;align-items:center;gap:7px;max-width:220px;padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-size:11px;box-shadow:0 3px 9px #00000012,0 1px 2px #0000000a}.attachment-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachment button{width:20px;height:20px;flex:none;border:0;border-radius:50%;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer}.attachment button:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.image-attachment{width:148px;max-width:148px;display:grid;grid-template-columns:minmax(0,1fr) 22px;gap:5px 7px;padding:7px;border-radius:13px;overflow:hidden}.image-attachment img{grid-column:1 / -1;width:100%;height:86px;object-fit:cover;border-radius:8px;background:var(--vscode-textCodeBlock-background)}.image-attachment .attachment-name{align-self:center}.image-attachment button{position:absolute;right:9px;top:9px;background:color-mix(in srgb,var(--vscode-editor-background) 88%,transparent);box-shadow:0 1px 4px #00000020}.composer.dragging{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 3px color-mix(in srgb,var(--vscode-focusBorder) 18%,transparent),0 18px 44px #00000020}.composer.dragging:after{content:"Drop image to attach";position:absolute;inset:8px;display:grid;place-items:center;border:1px dashed var(--vscode-focusBorder);border-radius:15px;background:color-mix(in srgb,var(--vscode-editor-background) 88%,transparent);color:var(--vscode-foreground);font-size:13px;font-weight:600;pointer-events:none;backdrop-filter:blur(8px)}.assign-task svg{display:none;width:16px;height:16px}.assign-task{height:34px;flex:none;padding:0 12px;border:1px solid color-mix(in srgb,var(--vscode-button-background) 75%,transparent);border-radius:11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font:inherit;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer;transition:background .14s,transform .14s}.assign-task:hover:not(:disabled){background:var(--vscode-button-hoverBackground);transform:translateY(-1px)}.assign-task:disabled{opacity:.48;cursor:default}.assign-task:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.user-image-preview{display:block;width:auto;max-width:min(100%,360px);max-height:260px;margin-top:9px;border:1px solid var(--vscode-panel-border);border-radius:12px;object-fit:contain;box-shadow:0 6px 18px #00000018}.footnote{width:min(100%,820px);margin:8px auto 0;text-align:center;color:var(--vscode-descriptionForeground);font-size:10px}
      
      
      @media(max-width:680px){.topbar{padding:0 14px}.conversation{padding:20px 14px 12px}.composer-area{padding:6px 12px 12px}.message{max-width:96%}.menu{width:min(320px,calc(100vw - 28px))}}
    .menu button .menu-copy{flex:1;min-width:0}.menu-icon{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:9px;color:var(--tone);background:color-mix(in srgb,var(--tone) 14%,transparent)}.menu-icon svg{width:17px;height:17px}.tone-ask{--tone:var(--vscode-textLink-foreground,#3794ff)}.tone-approve{--tone:var(--vscode-testing-iconPassed,#388a34)}.tone-full{--tone:var(--vscode-editorWarning-foreground,#bf8803)}.tone-model{--tone:var(--vscode-charts-purple,#8b5cf6)}.tone-effort{--tone:var(--vscode-charts-blue,#3794ff)}.menu button[aria-checked="true"]{background:color-mix(in srgb,var(--vscode-focusBorder,#0078d4) 11%,transparent)}.menu button[aria-checked="true"] .menu-title{font-weight:600}.menu button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.menu-check{flex:none;width:16px;height:16px;display:grid;place-items:center}.menu-check.checked::after{content:"";width:9px;height:5px;margin-top:-3px;border-left:2px solid var(--vscode-textLink-foreground,#3794ff);border-bottom:2px solid var(--vscode-textLink-foreground,#3794ff);transform:rotate(-45deg)}.approval-icon{display:grid;place-items:center}.approval-icon svg{width:15px;height:15px}#approval-button[data-mode="ask"] .approval-icon{color:var(--vscode-textLink-foreground,#3794ff)}#approval-button[data-mode="approve"] .approval-icon{color:var(--vscode-testing-iconPassed,#388a34)}#approval-button[data-mode="full"]{color:var(--vscode-editorWarning-foreground,#bf8803);background:color-mix(in srgb,var(--vscode-editorWarning-foreground,#bf8803) 13%,transparent)}.effort-button>svg:first-child{width:15px;height:15px}.composer-footer{display:flex;align-items:center;gap:8px}.controls{flex:1;display:flex;flex-wrap:nowrap;align-items:center;gap:2px;min-width:0}.controls>.control-group{flex:none}.controls>.control-group:has(#model-button){flex:0 1 auto;min-width:0}.model-button{width:100%;max-width:280px;min-width:0}.model-button .model-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.control-button{white-space:nowrap}.control-text{white-space:nowrap}.send{flex:none}@container composer (max-width:560px){.composer{padding:12px 12px 10px}.control-button{padding:0 7px;gap:5px}.control-prefix{display:none}}@container composer (max-width:430px){#approval-button .control-text{display:none}.control-button .chevron{display:none}.control-button{padding:0 6px}}@container composer (max-width:320px){.effort-button .control-text{display:none}.assign-task{width:34px;padding:0;display:grid;place-items:center}.assign-label{display:none}.assign-task svg{display:block}.composer{border-radius:16px}}.topbar{gap:12px}.agent{min-width:0}.agent>div:last-child{min-width:0}.agent-name,.agent-caption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#new-chat{flex:none;white-space:nowrap}.shell{display:grid;grid-template-columns:var(--rail-width,264px) minmax(0,1fr);height:100vh;transition:grid-template-columns .18s ease}.shell.resizing{transition:none}.shell.rail-collapsed{grid-template-columns:0 minmax(0,1fr)}.shell>.app{min-width:0;height:100vh}.sessions{position:relative;display:flex;flex-direction:column;min-width:0;overflow:hidden;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}.shell.rail-collapsed .sessions{visibility:hidden;border-right:0}.sessions-head{display:flex;align-items:center;justify-content:space-between;height:56px;flex:none;padding:0 10px 0 16px;border-bottom:1px solid var(--vscode-panel-border)}.sessions-title{font-weight:600;font-size:13px}.sessions-head svg{width:16px;height:16px}.sessions-search{position:relative;padding:10px 12px 6px}.sessions-search-icon{position:absolute;left:21px;top:17px;color:var(--vscode-descriptionForeground)}.sessions-search-icon svg{width:14px;height:14px}.sessions-search input{width:100%;box-sizing:border-box;height:30px;padding:0 10px 0 30px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground,var(--vscode-foreground));font:inherit;font-size:12px;outline:none}.sessions-search input:focus{border-color:var(--vscode-focusBorder)}.sessions-tabs{display:flex;gap:4px;padding:4px 12px 8px}.sessions-tabs button{flex:1;height:26px;border:0;border-radius:7px;background:transparent;color:var(--vscode-descriptionForeground);font:inherit;font-size:12px;cursor:pointer}.sessions-tabs button[aria-selected="true"]{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground);font-weight:600}.sessions-tabs .count{margin-left:2px;opacity:.7;font-weight:400}.sessions-list{flex:1;overflow-y:auto;padding:0 8px 14px}.session-group{padding:12px 8px 4px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600}.sessions-empty{padding:28px 14px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.5}.session{position:relative;border-radius:9px}.session:hover,.session:focus-within{background:var(--vscode-list-hoverBackground)}.session.current{background:color-mix(in srgb,var(--vscode-focusBorder) 13%,transparent)}.session-open{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 10px;border:0;border-radius:9px;background:transparent;color:var(--vscode-foreground);font:inherit;text-align:left;cursor:pointer}.session-open:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.session-title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.session.current .session-title{font-weight:600}.session:hover .session-title,.session:focus-within .session-title{padding-right:56px}.session-meta{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.session-actions{position:absolute;top:5px;right:5px;display:none;gap:2px}.session:hover .session-actions,.session:focus-within .session-actions{display:flex}.session-actions button{width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:6px;background:var(--vscode-editor-background);color:var(--vscode-descriptionForeground);cursor:pointer}.session-actions button:hover{color:var(--vscode-foreground)}.session-actions svg{width:14px;height:14px}.topbar-toggle{margin:0 6px 0 -8px;flex:none}.topbar-toggle svg{width:17px;height:17px}.topbar-actions{display:flex;align-items:center;gap:4px;flex:none}#archive-session svg{width:16px;height:16px}#new-chat{display:inline-flex;align-items:center;gap:6px}#new-chat svg{width:15px;height:15px}.message{position:relative}.message-actions{position:absolute;top:-12px;right:12px;z-index:2;display:flex;gap:2px;padding:2px;border:1px solid var(--vscode-panel-border);border-radius:9px;background:var(--vscode-editor-background);box-shadow:0 4px 12px #0000001f;white-space:normal;opacity:0;pointer-events:none;transition:opacity .12s}.message:hover .message-actions,.message:focus-within .message-actions{opacity:1;pointer-events:auto}.message.pending .message-actions{display:none}.message-actions button{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:var(--vscode-descriptionForeground);font:inherit;font-size:11px;cursor:pointer}.message-actions button:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground)}.message-actions svg{width:13px;height:13px}@media(hover:none){.message-actions{opacity:1;pointer-events:auto}}.topbar>.agent{flex:1;min-width:0}.toast{position:fixed;left:50%;bottom:132px;transform:translateX(-50%);padding:7px 14px;border-radius:9px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));color:var(--vscode-foreground);box-shadow:0 8px 24px #00000030;font-size:12px;z-index:40}.sessions-scrim{display:none}@media(max-width:759px){.shell,.shell.rail-collapsed{grid-template-columns:minmax(0,1fr)}.sessions,.shell.rail-collapsed .sessions{position:fixed;top:0;bottom:0;left:0;width:min(300px,86vw);z-index:30;visibility:visible;border-right:1px solid var(--vscode-panel-border);transform:translateX(-102%);transition:transform .18s ease;box-shadow:0 12px 40px #00000040}.shell:not(.drawer-open) .sessions{visibility:hidden}.shell.drawer-open .sessions{transform:none}.shell.drawer-open .sessions-scrim{display:block;position:fixed;inset:0;z-index:25;background:#00000030}.topbar-toggle{margin-left:-4px}#new-chat span{display:none}}@media(prefers-reduced-motion:reduce){.shell,.sessions{transition:none}}[hidden]{display:none!important}.activity-count{margin-left:2px;padding:0 6px;border-radius:8px;background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 16%,transparent);color:var(--vscode-editorWarning-foreground);font-size:10px;font-weight:600}.sessions-resizer{position:absolute;top:0;right:0;width:5px;height:100%;cursor:col-resize;z-index:5;touch-action:none;outline:none;transition:background-color .1s ease .15s}.sessions-resizer:hover,.sessions-resizer:focus-visible,.sessions-resizer.active{background:var(--vscode-sash-hoverBorder,var(--vscode-focusBorder))}@media(max-width:759px){.sessions-resizer{display:none}}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-button{display:none;width:0;height:0}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(121,121,121,.4))}::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,.7))}::-webkit-scrollbar-thumb:active{background:var(--vscode-scrollbarSlider-activeBackground,rgba(191,191,191,.4))}html,body{scrollbar-color:auto!important;scrollbar-width:auto!important}body{background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}.app,.conversation{background:var(--vscode-editor-background)}.topbar{background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-editorGroupHeader-tabsBorder,var(--vscode-panel-border))}.avatar,.welcome-mark{background:var(--vscode-chat-avatarBackground,var(--vscode-badge-background));color:var(--vscode-chat-avatarForeground,var(--vscode-badge-foreground));border:0}.agent-caption{color:var(--vscode-descriptionForeground)}.sessions{background:var(--vscode-sideBar-background,var(--vscode-editor-background));color:var(--vscode-sideBar-foreground,var(--vscode-foreground));border-right:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border))}.sessions-head{border-bottom-color:var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border))}.sessions-title{color:var(--vscode-sideBarTitle-foreground,var(--vscode-foreground));text-transform:uppercase;font-size:11px;letter-spacing:.04em}.sessions-search input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px}.sessions-search input::placeholder,#prompt::placeholder{color:var(--vscode-input-placeholderForeground)}.sessions-search input:focus{border-color:var(--vscode-focusBorder)}.sessions-tabs button{height:24px;border-radius:4px}.sessions-tabs button[aria-selected="true"]{background:color-mix(in srgb,var(--vscode-foreground) 11%,transparent);color:var(--vscode-panelTitle-activeForeground,var(--vscode-foreground))}.session,.session-open{border-radius:4px;color:inherit}.session:hover,.session:focus-within{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground,inherit)}.session.current{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground,inherit)}.sessions:focus-within .session.current{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground,inherit)}.sessions:focus-within .session.current .session-meta{color:inherit;opacity:.8}.session-actions button{background:transparent;color:inherit}.session-actions button:hover{background:var(--vscode-toolbar-hoverBackground)}.session-group{text-transform:uppercase;letter-spacing:.04em;font-size:10.5px}.message{line-height:1.6}.message.user{background:var(--vscode-chat-requestBubbleBackground,var(--vscode-chat-requestBackground,color-mix(in srgb,var(--vscode-foreground) 7%,transparent)));border:1px solid var(--vscode-chat-requestBorder,transparent);border-radius:10px;box-shadow:none;color:var(--vscode-foreground);padding:8px 13px}.message.user .message-label{display:none}.message.response,.message.result{background:transparent;border:0;border-radius:0;box-shadow:none;padding:2px 2px 6px}.message.response .message-label,.message.result .message-label{color:var(--vscode-foreground);font-size:12px;font-weight:600;margin-bottom:4px}.message.error{border-left:2px solid var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground));padding-left:12px}.message-content a{color:var(--vscode-textLink-foreground)}.message-content a:hover{color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground))}.message-content pre{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border,transparent);border-radius:6px;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);line-height:1.5}.message-content :not(pre)>code{background:var(--vscode-textPreformat-background,var(--vscode-textCodeBlock-background));color:var(--vscode-textPreformat-foreground,inherit);padding:1px 4px;border-radius:3px}.message-content blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid var(--vscode-textBlockQuote-border,var(--vscode-panel-border));background:var(--vscode-textBlockQuote-background,transparent)}.message-content table{border-collapse:collapse}.message-content th,.message-content td{border:1px solid var(--vscode-panel-border);padding:4px 8px}.message-content hr{border:0;border-top:1px solid var(--vscode-panel-border)}.response-activity{border-top:0;margin-top:6px;padding-top:2px}.message-actions{background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border-color:var(--vscode-editorWidget-border,var(--vscode-widget-border,var(--vscode-panel-border)));border-radius:6px;box-shadow:0 2px 8px var(--vscode-widget-shadow,#00000029)}.message.response .message-actions,.message.result .message-actions{top:-4px;right:0}.message.user .message-actions{top:50%;right:calc(100% + 6px);transform:translateY(-50%)}.message-actions,.message-actions button{white-space:nowrap;width:max-content}.composer{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,var(--vscode-panel-border)));border-radius:10px;box-shadow:none}.composer:hover{box-shadow:none}.composer:focus-within{border-color:var(--vscode-focusBorder);box-shadow:none}#prompt{color:var(--vscode-input-foreground);background:transparent;font-family:var(--vscode-font-family)}.send{border-radius:6px;box-shadow:none}.send:hover{box-shadow:none;transform:none;background:var(--vscode-button-hoverBackground)}.send:disabled{background:transparent;color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground));opacity:1}.control-button,.icon-button{border-radius:5px}.control-button:hover,.icon-button:hover{background:var(--vscode-toolbar-hoverBackground);border-color:transparent}.menu{background:var(--vscode-menu-background,var(--vscode-editorWidget-background));color:var(--vscode-menu-foreground,var(--vscode-foreground));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,var(--vscode-panel-border)));border-radius:8px;box-shadow:0 2px 8px var(--vscode-widget-shadow,#00000029)}.menu button{border-radius:4px;color:inherit}.menu button:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,inherit)}.menu button:hover .menu-description{color:inherit;opacity:.85}.menu-separator{background:var(--vscode-menu-separatorBackground,var(--vscode-panel-border))}.toast{background:var(--vscode-notifications-background,var(--vscode-editorWidget-background));color:var(--vscode-notifications-foreground,var(--vscode-foreground));border:1px solid var(--vscode-notifications-border,var(--vscode-widget-border,transparent));border-radius:6px;box-shadow:0 2px 8px var(--vscode-widget-shadow,#00000029)}@media(max-width:759px){.sessions,.shell.rail-collapsed .sessions{box-shadow:0 0 16px var(--vscode-widget-shadow,#00000040)}}.vscode-high-contrast .message.user,.vscode-high-contrast .composer,.vscode-high-contrast .menu,.vscode-high-contrast .toast,.vscode-high-contrast .message-actions{border:1px solid var(--vscode-contrastBorder)}.vscode-high-contrast .session.current,.vscode-high-contrast .session:hover,.vscode-high-contrast .menu button:hover{outline:1px dashed var(--vscode-contrastActiveBorder);outline-offset:-1px}${CHAT_MOTION_STYLES}${CHAT_COMPOSER_REFERENCE_STYLES}${CHAT_REPLY_STYLES}${CHAT_LIVE_REPLY_STYLES}${CHAT_MODEL_EFFORT_STYLES}${CHAT_CODEX_STYLES}${CHAT_MODE_SWITCH_STYLES}${CHAT_POLISH_STYLES}${CHAT_CODEX_REPLY_STYLES}${CHAT_SURFACE_STYLES}</style></head><body><div class="shell" id="shell"><aside class="sessions" id="sessions" aria-label="Chat history"><div class="sessions-head"><button class="icon-button" id="sessions-back" type="button" title="Back" aria-label="Close chat history"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg></button><span class="sessions-title">All chats</span><button class="icon-button" id="sessions-new" type="button" title="New chat" aria-label="New chat">${MENU_ICONS.compose}</button></div><div class="sessions-search"><span class="sessions-search-icon" aria-hidden="true">${MENU_ICONS.search}</span><input id="sessions-search" type="search" placeholder="Search recent chats" aria-label="Search recent chats"></div><div class="sessions-tabs" role="tablist" aria-label="Chat lists"><button type="button" role="tab" data-tab="recent" aria-selected="true">Recent <span class="count"></span></button><button type="button" role="tab" data-tab="archived" aria-selected="false">Archived <span class="count"></span></button></div><div class="history-filter-row"><div class="control-group"><button type="button" class="history-filter" id="history-filter" aria-haspopup="menu"><span id="history-filter-label">All chats</span><svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 6 5 5 5-5"/></svg></button><div class="menu" id="history-filter-menu" role="menu" aria-label="Show" hidden><button type="button" role="menuitemradio" data-filter="recent" aria-checked="true">All chats</button><button type="button" role="menuitemradio" data-filter="archived" aria-checked="false">Archived</button></div></div></div><div class="sessions-list" id="sessions-list" role="list"></div><div class="sessions-resizer" id="sessions-resizer" role="separator" aria-orientation="vertical" aria-label="Resize chat history" tabindex="0" title="Drag to resize (double-click to reset)"></div></aside><div class="app"><header class="topbar"><button class="icon-button" id="chat-back" type="button" title="Back to chats" aria-label="Back to chats" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg></button><span class="agent-name" id="agent" hidden>${agentName}</span><div class="chat-modes" role="group" aria-label="Chat mode"><button class="chat-mode" id="mode-team" type="button" aria-pressed="true" title="Chat with the agent team">Team</button><button class="chat-mode" id="mode-supervisor" type="button" aria-pressed="false" title="Chat with the supervisor">Supervisor</button><div class="control-group agent-picker"><button class="chat-mode chat-mode-agent" id="mode-agent" type="button" aria-pressed="false" aria-haspopup="menu" aria-expanded="false" title="Choose an individual agent"><span class="mode-agent-label" id="mode-agent-label">Agent</span><svg class="mode-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 6 5 5 5-5"/></svg></button><div class="menu" id="agent-picker-menu" role="menu" aria-label="Choose an agent" hidden></div></div><span id="session-caption" hidden>Chats</span></div><div class="topbar-actions"><button class="assign-task topbar-assign" id="assign-task" type="button" title="Assign the discussed request to the agent team" aria-label="Assign task" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg><span class="assign-label">Assign task</span></button><div class="control-group bar-more"><button class="icon-button" id="chat-more" type="button" title="More actions" aria-label="More actions" aria-haspopup="menu" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/></svg></button><div class="menu bar-menu" id="chat-more-menu" role="menu" aria-label="Chat actions" hidden><button type="button" role="menuitem" id="more-rename">${MENU_ICONS.rename}<span>Rename</span></button><button type="button" role="menuitem" id="archive-session">${MENU_ICONS.archive}<span>Archive</span></button><button type="button" role="menuitem" id="more-copy">${MENU_ICONS.copy}<span>Copy conversation</span></button></div></div><button class="icon-button topbar-toggle" id="toggle-sessions" type="button" aria-controls="sessions" aria-expanded="false" title="Chat history" aria-label="Chat history">${MENU_ICONS.history}</button><button class="icon-button" id="open-settings" type="button" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg></button><button class="icon-button" id="new-chat" type="button" title="New chat" aria-label="New chat">${MENU_ICONS.compose}</button></div></header><div class="laya-line" id="laya-line" role="status" hidden><span class="laya-line-dot" aria-hidden="true"></span><span class="laya-line-text" id="laya-line-text">Laya paused · routing uses the fallback</span><button type="button" id="laya-resume" title="Call Laya again on the next request">Resume</button></div><main class="conversation" id="conversation"><div class="conversation-inner"><section class="home-recents" id="home-recents" aria-label="Recent chats" hidden><div id="home-recents-list" role="list"></div><button type="button" class="home-view-all" id="home-view-all">View all</button></section><section class="welcome" id="welcome"><div class="welcome-mark" aria-hidden="true">${MENU_ICONS.bot}</div><h1>What would you like to work on?</h1><p id="welcome-copy">Discuss goals and requirements here. Choose Assign task when you are ready to start work.</p><div class="welcome-starters" aria-label="Suggested prompts"><button type="button" data-starter="Explain how this project is structured and where the main entry points are.">Explain this project</button><button type="button" data-starter="Find and fix the bug in ">Find and fix a bug</button><button type="button" data-starter="Write tests for ">Write tests</button><button type="button" data-starter="Plan how to build this feature: ">Plan a feature</button></div></section><div id="messages" aria-live="polite"></div></div></main><div class="queue" id="queue" role="status"></div><footer class="composer-area"><button class="jump-latest" id="jump-latest" type="button" title="Jump to latest" aria-label="Jump to latest" hidden><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg></button><form class="composer" id="composer"><div class="attachments" id="attachments"></div><textarea id="prompt" aria-label="Message the selected agent" placeholder="Discuss with ${agentName}…" rows="2"></textarea><div class="composer-footer"><div class="controls"><div class="control-group"><button class="icon-button" id="add-button" type="button" aria-label="Add context" title="Add context"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button><div class="menu" id="add-menu" hidden><button type="button" id="add-attachments"><span class="menu-copy"><span class="menu-title">Files and folders</span><span class="menu-description">Add files, or paste/drop an image</span></span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5 13.7 6.8a3.2 3.2 0 1 1 4.5 4.5l-7.1 7.1a5 5 0 0 1-7.1-7.1l7.1-7.1"/></svg></button><div class="menu-separator"></div><button type="button" id="think-toggle"><span class="menu-copy"><span class="menu-title">Thinking mode</span><span class="menu-description">Spend more effort reasoning before answering</span></span><span id="think-status" class="menu-description">Off</span></button><button type="button" id="plan-toggle"><span class="menu-copy"><span class="menu-title">Plan mode</span><span class="menu-description">Create a plan without making edits</span></span><span id="plan-status" class="menu-description">Off</span></button></div></div><div class="control-group"><button class="control-button" id="approval-button" type="button" aria-label="Approval: Ask for approval" aria-haspopup="menu" data-mode="ask"><span class="approval-icon" id="approval-icon" aria-hidden="true">${MENU_ICONS.ask}</span><span class="control-text" id="approval-label">Ask for approval</span><svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 6 5 5 5-5"/></svg></button><div class="menu" id="approval-menu" role="menu" aria-label="Approval mode" hidden><div class="menu-heading">How should agent actions be approved?</div><button type="button" role="menuitemradio" aria-checked="false" data-approval="ask"><span class="menu-icon tone-ask" aria-hidden="true">${MENU_ICONS.ask}</span><span class="menu-copy"><span class="menu-title">Ask for approval</span><span class="menu-description">Ask before workspace writes and memory changes</span></span><span class="menu-check" aria-hidden="true"></span></button><button type="button" role="menuitemradio" aria-checked="false" data-approval="approve"><span class="menu-icon tone-approve" aria-hidden="true">${MENU_ICONS.approve}</span><span class="menu-copy"><span class="menu-title">Approve for me</span><span class="menu-description">Allow workspace writes and memory changes automatically</span></span><span class="menu-check" aria-hidden="true"></span></button><button type="button" role="menuitemradio" aria-checked="false" data-approval="full"><span class="menu-icon tone-full" aria-hidden="true">${MENU_ICONS.full}</span><span class="menu-copy"><span class="menu-title danger">Full access</span><span class="menu-description">Also enable shell commands with your user permissions</span></span><span class="menu-check" aria-hidden="true"></span></button></div></div></div><div class="control-group model-group"><button class="control-button model-button" id="model-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="model-menu"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.2 2.5 5 13h5l-.8 8.5L19 10.7h-5.2l-.6-8.2Z"/></svg><span class="model-label" id="model-label">Model</span><span class="effort-chip" id="effort-label">Auto</span><svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 6 5 5 5-5"/></svg></button><div class="menu model-effort-menu" id="model-menu" data-width="292" role="dialog" aria-label="Model and reasoning effort" hidden><div class="me-view" id="me-effort"><div class="me-head"><span class="me-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 2.8 5.6 13.4h5.9l-.9 7.8 7.8-10.9h-6.1l.9-7.5Z"/></svg></span><button type="button" class="me-title" id="me-open-models" title="Change model"><span class="me-level"><span id="me-effort-name">Auto</span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></span><span class="me-model" id="me-model-name">Model</span></button><button type="button" class="icon-button me-reset" id="me-reset" title="Reset to Auto" aria-label="Reset reasoning effort to Auto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4v5h5"/></svg></button></div><div class="me-slider"><input type="range" id="effort-slider" min="0" max="3" step="1" value="0" aria-label="Reasoning effort"><div class="me-stops" aria-hidden="true"><span></span><span></span><span></span><span></span></div></div></div><div class="me-view" id="me-models" hidden><div class="me-models-head"><button type="button" class="icon-button" id="me-back" aria-label="Back to reasoning effort" title="Back"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg></button><span class="menu-heading">Choose a model</span></div><div id="model-options"></div></div></div></div><button class="send" id="send" type="submit" title="Discuss message" aria-label="Send message" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></div></form><div class="footnote">Reasoning effort is sent only when supported by the selected API.</div></footer></div><div class="sessions-scrim" id="sessions-scrim"></div><div class="toast" id="toast" role="status" aria-live="polite" hidden></div></div><script src="${markdownScript || ''}" nonce="${nonce}"></script><script nonce="${nonce}">
      const menuIcons=${JSON.stringify(MENU_ICONS)};
      const vscode=acquireVsCodeApi(),messages=document.querySelector('#messages'),prompt=document.querySelector('#prompt'),queue=document.querySelector('#queue'),welcome=document.querySelector('#welcome'),send=document.querySelector('#send'),assignButton=document.querySelector('#assign-task'),conversation=document.querySelector('#conversation'),attachmentArea=document.querySelector('#attachments');
      let currentConversationId=null;
      const markdown=window.markdownit?window.markdownit({html:false,linkify:true,breaks:false}):null;const renderMarkdown=(element,text)=>{if(markdown){element.innerHTML=markdown.render(text||'');}else{element.textContent=text||'';}};let config=${configJson},approvalMode=config.approvalMode||'ask',planMode=false,thinking=false,attachmentIds=[],imagePreviews=new Map(),modelKey=config.selectedModelKey,reasoningEffort='auto';
      const resize=()=>{prompt.style.height='auto';prompt.style.height=Math.min(prompt.scrollHeight,180)+'px';};
      const updateModel=()=>{const selected=(config.models||[]).find(item=>item.key===modelKey)||(config.models||[])[0];if(selected){modelKey=selected.key;document.querySelector('#model-label').textContent=selected.model||selected.label;document.querySelector('#me-model-name').textContent=selected.label;}};
      const renderModels=()=>{const area=document.querySelector('#model-options');area.replaceChildren();for(const item of config.models||[]){const button=document.createElement('button');button.type='button';button.dataset.modelKey=item.key;button.className=item.key===modelKey?'selected':'';const copy=document.createElement('span');copy.className='menu-copy';const title=document.createElement('span');title.className='menu-title';title.textContent=item.model;const description=document.createElement('span');description.className='menu-description';description.textContent=item.label===item.model?'Configured model':item.label.replace(' · '+item.model,'');copy.append(title,description);const check=document.createElement('span');check.className='menu-check';check.classList.toggle('checked',item.key===modelKey);check.setAttribute('aria-hidden','true');const icon=document.createElement('span');icon.className='menu-icon tone-model';icon.setAttribute('aria-hidden','true');icon.innerHTML=menuIcons.model;button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(item.key===modelKey));button.append(icon,copy,check);button.addEventListener('click',()=>{modelKey=item.key;updateModel();renderModels();renderEfforts();showModelList(false);});area.append(button);}};
      const EFFORTS=[['auto','Auto','The model decides'],['low','Low','Faster, lighter reasoning'],['medium','Medium','Balanced speed and depth'],['high','High','Deeper, slower reasoning']];const renderEfforts=()=>{const index=Math.max(0,EFFORTS.findIndex(([value])=>value===reasoningEffort));const [value,label,caption]=EFFORTS[index];document.querySelector('#effort-label').textContent=label;document.querySelector('#me-effort-name').textContent=label;document.querySelector('#effort-slider').title=label+': '+caption+(value==='auto'?'':' (sent only when the model supports reasoning effort)');const slider=document.querySelector('#effort-slider');slider.value=String(index);slider.setAttribute('aria-valuetext',label);slider.parentElement.style.setProperty('--f',String(index/(EFFORTS.length-1)));slider.parentElement.dataset.index=String(index);document.querySelector('#me-reset').disabled=index===0;document.querySelector('#model-button').title='Model and reasoning effort: '+(document.querySelector('#me-model-name').textContent||'')+' \u00b7 '+label;};const showModelList=show=>{document.querySelector('#me-effort').hidden=show;document.querySelector('#me-models').hidden=!show;const menu=document.querySelector('#model-menu');if(!menu.hidden)placeMenu(menu);(show?document.querySelector('#model-options button[aria-checked="true"]')||document.querySelector('#model-options button'):document.querySelector('#me-open-models'))?.focus();};
      const applyConfig=next=>{config=next||config;modelKey=config.selectedModelKey||modelKey;approvalMode=config.approvalMode||'ask';updateModel();renderModels();renderEfforts();updateApproval();};
      const updateApproval=()=>{const names={ask:'Ask for approval',approve:'Approve for me',full:'Full access'};const button=document.querySelector('#approval-button');document.querySelector('#approval-label').textContent=names[approvalMode];document.querySelector('#approval-icon').innerHTML=menuIcons[approvalMode];button.dataset.mode=approvalMode;button.title='Approval: '+names[approvalMode];button.setAttribute('aria-label','Approval: '+names[approvalMode]);document.querySelectorAll('[data-approval]').forEach(item=>{const on=item.dataset.approval===approvalMode;item.setAttribute('aria-checked',String(on));item.classList.toggle('selected',on);item.querySelector('.menu-check').classList.toggle('checked',on);});};
      const placeMenu=target=>{const anchor=target.parentElement.getBoundingClientRect(),width=Math.max(120,Math.min(Number(target.dataset.width)||320,innerWidth-20));target.classList.remove('align-right','below');target.style.position='fixed';target.style.width=width+'px';target.style.maxHeight=Math.max(120,innerHeight-20)+'px';target.style.left=Math.max(10,Math.min(anchor.left+width>innerWidth-10?anchor.right-width:anchor.left,innerWidth-width-10))+'px';target.style.right='auto';target.style.top='auto';target.style.bottom='auto';const height=target.getBoundingClientRect().height,above=anchor.top-height-8>=10;target.style.top=(above?anchor.top-height-8:Math.max(10,Math.min(anchor.bottom+8,innerHeight-height-10)))+'px';};
      const toggleMenu=id=>{const target=document.querySelector(id),show=target.hidden;document.querySelectorAll('.menu').forEach(menu=>{menu.hidden=true;menu.style.position='';menu.style.width='';menu.style.maxHeight='';menu.style.left='';menu.style.right='';menu.style.top='';menu.style.bottom='';});target.hidden=!show;if(show)placeMenu(target);};
      const updateSend=()=>{const hasDraft=Boolean(prompt.value.trim()||attachmentIds.length);send.disabled=!hasDraft;if(assignButton)assignButton.disabled=!hasDraft&&!currentConversationId;};
      const renderAttachments=files=>{for(const file of files){if(attachmentIds.includes(file.id))continue;attachmentIds.push(file.id);const chip=document.createElement(file.image?'div':'span');chip.className=file.image?'attachment image-attachment':'attachment';chip.dataset.id=file.id;if(file.image){imagePreviews.set(file.id,file.dataUrl);const preview=document.createElement('img');preview.src=file.dataUrl;preview.alt=file.name;preview.loading='lazy';chip.append(preview);const caption=document.createElement('span');caption.className='attachment-name';caption.textContent=file.name;chip.append(caption);}else{chip.append(document.createTextNode(file.name));}const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title='Remove attachment';remove.setAttribute('aria-label','Remove '+file.name);remove.addEventListener('click',()=>{attachmentIds=attachmentIds.filter(id=>id!==file.id);imagePreviews.delete(file.id);chip.remove();vscode.postMessage({type:'remove-attachment',id:file.id});updateSend();});chip.append(remove);attachmentArea.append(chip);}updateSend();};
      const readImage=file=>new Promise(resolve=>{if(!file||!file.type||!file.type.startsWith('image/'))return resolve(null);const reader=new FileReader();reader.onload=()=>resolve({name:file.name||('pasted-image-'+Date.now()+'.'+(file.type.split('/')[1]||'png')),mimeType:file.type,dataUrl:reader.result});reader.onerror=()=>resolve(null);reader.readAsDataURL(file);});
      const attachImages=async files=>{const images=(await Promise.all(Array.from(files||[]).filter(file=>file.type&&file.type.startsWith('image/')).slice(0,4).map(readImage))).filter(Boolean);if(images.length)vscode.postMessage({type:'add-image-attachments',files:images});};
      const submit=(intent='discuss')=>{const text=prompt.value.trim()||(intent==='assign'?'Please carry out the task we agreed on in this discussion.':attachmentIds.length?'Please review the attached image.':'');if(!text)return;prompt.value='';resize();send.disabled=true;if(assignButton)assignButton.disabled=true;welcome.hidden=true;vscode.postMessage({type:'submit',prompt:text,intent,approvalMode,planMode,thinking,reasoningEffort,modelKey,attachmentIds:[...attachmentIds]});};
      applyConfig(config);
      document.querySelector('#composer').addEventListener('submit',event=>{event.preventDefault();submit('discuss');});assignButton.addEventListener('click',()=>submit('assign'));prompt.addEventListener('input',()=>{resize();updateSend();});prompt.addEventListener('paste',event=>{const items=Array.from(event.clipboardData?.items||[]);const images=items.filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(images.length)void attachImages(images);});const composer=document.querySelector('#composer');composer.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer?.items||[]).some(item=>item.kind==='file'&&item.type.startsWith('image/'))){event.preventDefault();composer.classList.add('dragging');}});composer.addEventListener('dragleave',event=>{if(!composer.contains(event.relatedTarget))composer.classList.remove('dragging');});composer.addEventListener('drop',event=>{composer.classList.remove('dragging');const files=Array.from(event.dataTransfer?.files||[]).filter(file=>file.type.startsWith('image/'));if(files.length){event.preventDefault();void attachImages(files);}});prompt.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit();}});
      document.querySelector('#new-chat').addEventListener('click',()=>vscode.postMessage({type:'new-session'}));
      document.querySelector('#add-button').addEventListener('click',()=>toggleMenu('#add-menu'));document.querySelector('#add-attachments').addEventListener('click',()=>{document.querySelector('#add-menu').hidden=true;vscode.postMessage({type:'add-attachments'});});
      document.querySelector('#think-toggle').addEventListener('click',()=>{thinking=!thinking;document.querySelector('#think-status').textContent=thinking?'On':'Off';document.querySelector('#think-toggle').classList.toggle('selected',thinking);document.querySelector('#add-menu').hidden=true;});
      document.querySelector('#plan-toggle').addEventListener('click',()=>{planMode=!planMode;document.querySelector('#plan-status').textContent=planMode?'On':'Off';document.querySelector('#add-menu').hidden=true;});
      document.querySelector('#approval-button').addEventListener('click',()=>toggleMenu('#approval-menu'));document.querySelectorAll('[data-approval]').forEach(button=>button.addEventListener('click',()=>{approvalMode=button.dataset.approval;updateApproval();document.querySelector('#approval-menu').hidden=true;}));
      document.querySelector('#model-button').addEventListener('click',()=>{const menu=document.querySelector('#model-menu');if(menu.hidden){document.querySelector('#me-effort').hidden=false;document.querySelector('#me-models').hidden=true;}toggleMenu('#model-menu');document.querySelector('#model-button').setAttribute('aria-expanded',String(!menu.hidden));});document.querySelector('#effort-slider').addEventListener('input',event=>{reasoningEffort=EFFORTS[Number(event.target.value)]?.[0]||'auto';renderEfforts();});document.querySelector('#me-reset').addEventListener('click',()=>{reasoningEffort='auto';renderEfforts();document.querySelector('#effort-slider').focus();});document.querySelector('#model-menu').addEventListener('keydown',event=>{if(event.key!=='Escape')return;event.stopPropagation();document.querySelector('#model-menu').hidden=true;const button=document.querySelector('#model-button');button.setAttribute('aria-expanded','false');button.focus();});window.addEventListener('click',()=>{if(document.querySelector('#model-menu').hidden)document.querySelector('#model-button').setAttribute('aria-expanded','false');});document.querySelector('#me-open-models').addEventListener('click',()=>showModelList(true));document.querySelector('#me-back').addEventListener('click',()=>showModelList(false));
      window.addEventListener('click',event=>{if(!event.target.closest('.control-group'))document.querySelectorAll('.menu').forEach(menu=>{menu.hidden=true;menu.style.position='';menu.style.width='';menu.style.maxHeight='';menu.style.left='';menu.style.right='';menu.style.top='';menu.style.bottom='';});});window.addEventListener('resize',()=>document.querySelectorAll('.menu:not([hidden])').forEach(placeMenu));
      let activeResponse=null,activeContent=null,activeStatus=null,activityList=null,toolRows=new Map(),statusTimer=null,responseStartedAt=0;
      const addMessage=(kind,labelText,text='')=>{const item=document.createElement('article');item.className='message '+kind;item.style.setProperty('--message-delay',Math.min(messages.children.length*35,280)+'ms');const label=document.createElement('span');label.className='message-label';label.textContent=labelText;const content=document.createElement('div');content.className='message-content';content.textContent=text;item.append(label,content);messages.append(item);return {item,content};};
      let thinkingViews=new Map(),currentAgentId=null;const formatElapsed=ms=>{const total=Math.max(0,Math.floor(ms/1000));return total<60?total+'s':Math.floor(total/60)+'m '+String(total%60).padStart(2,'0')+'s';};const updateWorkingTime=()=>{if(!activeResponse?.classList.contains('pending'))return;const elapsed=activeResponse.querySelector('.response-elapsed');if(elapsed)elapsed.textContent='Working for '+formatElapsed(Date.now()-responseStartedAt)+(waitingOn()?' \u00b7 waiting for '+waitingOn():'');};const AGENT_TONES=['var(--vscode-charts-blue,#3794ff)','var(--vscode-charts-purple,#b180d7)','var(--vscode-charts-green,#89d185)','var(--vscode-charts-orange,#d18616)','var(--vscode-charts-yellow,#cca700)','var(--vscode-charts-red,#f14c4c)'];const agentTone=name=>{let hash=0;for(const ch of String(name))hash=(hash*31+ch.charCodeAt(0))>>>0;return AGENT_TONES[hash%AGENT_TONES.length];};let pinnedToLatest=true;const followLatest=(force=false)=>{if(force||pinnedToLatest)conversation.scrollTop=conversation.scrollHeight;const jump=document.querySelector('#jump-latest');if(jump)jump.hidden=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<80;};const beginResponse=()=>{const response=addMessage('response',document.querySelector('#agent').textContent);response.item.classList.add('pending');activeResponse=response.item;activeContent=response.content;activeContent.classList.add('streaming');const name=document.querySelector('#agent').textContent;const label=response.item.querySelector('.message-label');const head=document.createElement('div');head.className='response-head';const avatar=document.createElement('span');avatar.className='response-avatar';avatar.setAttribute('aria-hidden','true');avatar.innerHTML=menuIcons.bot;avatar.style.setProperty('--agent-tone',agentTone(name));activeStatus=document.createElement('span');activeStatus.className='response-status thinking';activeStatus.textContent='Thinking';const elapsed=document.createElement('span');elapsed.className='response-elapsed';elapsed.title='Time spent on this reply';label.replaceWith(head);head.append(avatar,label,activeStatus,elapsed);head.setAttribute('role','button');head.tabIndex=0;head.setAttribute('aria-expanded','true');head.title='Show or hide the steps for this reply';const item=response.item;head.addEventListener('click',()=>{if(item.classList.contains('pending'))return;head.setAttribute('aria-expanded',String(item.classList.toggle('process-open')));});head.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();head.click();}});const now=document.createElement('div');now.className='response-now';now.hidden=true;head.after(now);responseStartedAt=Date.now();updateWorkingTime();statusTimer=setInterval(updateWorkingTime,1000);activityList=null;toolRows=new Map();thinkingViews.clear();handoffs.clear();pendingHandoffCalls.clear();};
      const appendThinking=(text,agentId=currentAgentId,separate=false)=>{if(!activeResponse||!text)return;const key=agentId||'agent';let view=thinkingViews.get(key);if(!view){const details=document.createElement('details');details.className='response-thinking';const summary=document.createElement('summary');summary.textContent=key===currentAgentId?'Thinking':'Thinking · '+key.charAt(0).toUpperCase()+key.slice(1);summary.style.cssText='color:var(--vscode-descriptionForeground);font-size:11px;cursor:pointer';const content=document.createElement('div');content.className='thinking-text';content.style.cssText='margin:7px 0 0;padding-left:16px;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.55;overflow-wrap:anywhere';details.append(summary,content);(handoffs.get(key)?.steps||activeResponse).append(details);view={details,content};thinkingViews.set(key,view);}const raw=(view.content.dataset.raw||'')+(separate&&view.content.dataset.raw?'\\n\\n':'')+text;view.content.dataset.raw=raw;renderMarkdown(view.content,raw);};
      const ensureActivity=()=>{if(!activityList){const details=document.createElement('details');details.className='response-activity';details.open=false;const summary=document.createElement('summary');summary.className='activity-summary';const title=document.createElement('span');title.textContent='Activity';const count=document.createElement('span');count.className='activity-summary-count';count.textContent='0 steps';summary.append(title,count);activityList=document.createElement('div');activityList.className='response-activity-list';details.append(summary,activityList);summary.addEventListener('click',()=>{details.dataset.userToggled='1';});activeResponse.append(details);}return activityList;};
      const STEP_ICONS={read:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2"/></svg>',edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',run:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 4 4-4 4"/><path d="M12 16h7"/></svg>',agent:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',plan:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>',memory:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',start:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m8 5 11 7-11 7z"/></svg>',other:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/></svg>'};
      const TOOL_WORDS={read_file:['Reading','Read'],file_outline:['Outlining','Outlined'],expand_tool_result:['Reading tool output','Read tool output'],search_workspace:['Searching the workspace','Searched the workspace'],write_file:['Editing','Edited'],run_command:['Running a command','Ran a command'],ask_agent:['Asking a specialist','Asked a specialist'],delegate_task:['Delegating','Delegated'],delegate_team:['Running a team','Ran a team'],find_agent:['Finding an agent','Found an agent'],list_agents:['Listing agents','Listed agents'],create_plan:['Planning','Created a plan'],remember:['Saving a note','Saved a note'],remember_entity:['Updating project context','Updated project context'],remember_relation:['Linking project context','Linked project context']};
      const TOOL_KINDS={read_file:'read',file_outline:'read',expand_tool_result:'read',search_workspace:'search',write_file:'edit',run_command:'run',ask_agent:'agent',delegate_task:'agent',delegate_team:'agent',find_agent:'agent',list_agents:'agent',create_plan:'plan',remember:'memory',remember_entity:'memory',remember_relation:'memory'};
      const activityKind=event=>event.type==='start'?'start':event.type==='delegate'?'agent':event.type==='tool'?TOOL_KINDS[event.toolName]||'other':'other';
      const activityError=event=>{if(event.phase!=='error')return '';try{const parsed=JSON.parse(event.text||'');return typeof parsed.error==='string'?parsed.error:'';}catch{return String(event.text||'');}};
      const activityTitle=event=>{if(event.type==='progress')return event.text||'Working';if(event.type==='start'){const who=String(event.agentId||'Agent');return who.charAt(0).toUpperCase()+who.slice(1)+' started';}if(event.type==='delegate'){const target=(event.text||'').match(/->\\s*([^:]+)/);return 'Handed off to '+(target?target[1].trim():'a specialist');}const name=String(event.toolName||'tool').replaceAll('_',' ');const [doing,done]=TOOL_WORDS[event.toolName]||['Using '+name,'Used '+name];const file=event.path&&['read_file','file_outline','write_file'].includes(event.toolName)?' '+String(event.path).split('/').pop():'';const approval=String(event.text||'').startsWith('Waiting for approval:');const error=activityError(event);return approval?'Waiting for approval: '+doing.toLowerCase()+file:event.phase==='error'?'Failed: '+doing.toLowerCase()+file+(error?' — '+error.slice(0,120):''):event.phase&&event.phase!=='start'?done+file:doing+file;};
      const KIND_PHRASES={read:'read files',search:'searched the workspace',edit:'edited files',run:'ran commands',agent:'worked with agents',plan:'made a plan',memory:'saved notes',other:'used tools'};
      const updateActivityCount=()=>{if(!activityList||!activeResponse)return;const kinds=[...new Set([...activityList.querySelectorAll('[data-kind]')].map(row=>row.dataset.kind).filter(kind=>kind&&kind!=='start'))];const phrase=kinds.map(kind=>KIND_PHRASES[kind]||KIND_PHRASES.other).join(', ')||'Getting started';const title=activeResponse.querySelector('.activity-summary > span:first-child');if(title)title.textContent=phrase.charAt(0).toUpperCase()+phrase.slice(1);const count=activeResponse.querySelector('.activity-summary-count');if(count){const total=activityList.querySelectorAll('[data-kind]').length;count.textContent=total+(total===1?' step':' steps');}};
      /** Hand-offs to other agents: one group per request, holding that agent's own steps, thinking and answer. */
      const handoffs=new Map(),pendingHandoffCalls=new Map();
      const waitingOn=()=>{const open=[...handoffs.values()];return open.length?open[open.length-1].name:'';};
      const openHandoff=event=>{const named=((event.text||'').match(/->\\s*([^:]+)/)?.[1]||'').trim();const target=event.targetAgentId||named.toLowerCase();const name=named||target||'a specialist';const ask=(event.delegateMode||String(event.text||'').split(' ')[0])==='ask';const request=String(event.text||'').replace(/^[^:]*:\\s*/,'').replace(/^Consultation request from [^:]+:\\s*/,'').trim();
        const group=document.createElement('div');group.className='response-activity-item delegate-group working';group.dataset.kind='agent';
        const head=document.createElement('div');head.className='delegate-head';const marker=document.createElement('span');marker.className='activity-marker';marker.innerHTML=STEP_ICONS.agent;const label=document.createElement('span');label.className='activity-label';label.textContent=(ask?'Asking ':'Delegating to ')+name;head.append(marker,label);
        const req=document.createElement('div');req.className='delegate-request';req.textContent=request;req.title=request;req.hidden=!request;
        const steps=document.createElement('div');steps.className='delegate-steps';group.append(head,req,steps);
        (handoffs.get(event.agentId)?.steps||ensureActivity()).append(group);
        // A team member's hand-off carries its own id; the matching tool event closes it.
        if(event.toolCallId)toolRows.set(event.toolCallId,group);
        // The caller's "Delegating" tool row becomes this group, so the tool's completion closes it.
        const callId=pendingHandoffCalls.get(event.agentId);if(callId){const toolRow=toolRows.get(callId);if(toolRow&&!toolRow.classList.contains('delegate-group'))toolRow.remove();toolRows.set(callId,group);pendingHandoffCalls.delete(event.agentId);}
        handoffs.set(target,{group,steps,name,ask});updateActivityCount();updateWorkingTime();};
      const closeHandoff=(group,event)=>{const entry=[...handoffs.entries()].find(([,value])=>value.group===group);if(entry)handoffs.delete(entry[0]);const info=entry?.[1]||{name:'the specialist',ask:false};
        let answer='',error='';try{const data=JSON.parse(event.text||'');answer=typeof data?.result==='string'?data.result:'';error=typeof data?.error==='string'?data.error:'';}catch{answer=String(event.text||'');}
        const failed=event.phase==='error'||Boolean(error);group.classList.remove('working');group.classList.add(failed?'failed':'complete');
        group.querySelector('.delegate-head .activity-label').textContent=failed?'Could not get help from '+info.name:info.ask?'Asked '+info.name:info.name+' finished';
        const text=error||answer;if(text){const details=document.createElement('details');details.className='delegate-answer';const summary=document.createElement('summary');summary.textContent=error?'Error':'Answer';const body=document.createElement('div');body.className='delegate-answer-text message-content';renderMarkdown(body,text);details.append(summary,body);group.append(details);}updateWorkingTime();};
      const addActivityRow=event=>{if(!activeResponse)return;if(activeStatus)activeStatus.classList.remove('thinking');
        if(event.type==='delegate'){openHandoff(event);return;}
        // The group heading already says the agent is working, so its own "started" row is left out.
        if(event.type==='start'&&handoffs.has(event.agentId))return;
        if(event.type==='tool'&&(event.toolName==='ask_agent'||event.toolName==='delegate_task')&&event.phase==='start')pendingHandoffCalls.set(event.agentId,event.toolCallId);
        let row=event.toolCallId?toolRows.get(event.toolCallId):null;
        if(row&&row.classList.contains('delegate-group')&&event.type==='tool'&&event.phase!=='start'){closeHandoff(row,event);return;}if(event.type==='tool'&&event.phase!=='start'&&row){row.classList.remove('working','approval');row.classList.add(event.phase==='error'?'failed':'complete');row.querySelector('.activity-label').textContent=activityTitle(event);row.title=activityError(event)||event.path||'';const prev=row.previousElementSibling;if(prev&&prev.classList.contains('complete')&&row.classList.contains('complete')&&prev.querySelector('.activity-label').textContent===row.querySelector('.activity-label').textContent){const count=(Number(prev.dataset.count)||1)+1;prev.dataset.count=String(count);let badge=prev.querySelector('.activity-count');if(!badge){badge=document.createElement('span');badge.className='activity-count';prev.append(badge);}badge.textContent='\u00d7'+count;badge.title='Repeated '+count+' times';row.remove();toolRows.set(event.toolCallId,prev);}return;}row=document.createElement('div');row.className='response-activity-item '+(event.type==='tool'?(event.text?.startsWith('Waiting for approval:')?'approval':'working'):'progress');const marker=document.createElement('span');marker.className='activity-marker';row.dataset.kind=activityKind(event);marker.innerHTML=STEP_ICONS[row.dataset.kind]||STEP_ICONS.other;const label=document.createElement('span');label.className='activity-label';label.textContent=activityTitle(event);if(event.path)label.title=event.path;row.title=activityError(event)||event.path||'';row.append(marker,label);const mainList=ensureActivity();(handoffs.get(event.agentId)?.steps||mainList).append(row);updateActivityCount();if(event.toolCallId)toolRows.set(event.toolCallId,row);};
      /** Keep the live header and the current-step line in sync with the latest activity. */
      /** Files the agents wrote during this reply, listed after the answer like Codex's "Edited N files" card. */
      const trackEditedFile=event=>{if(!activeResponse||event.type!=='tool'||event.toolName!=='write_file'||event.phase!=='complete'||!event.path)return;let card=activeResponse.querySelector('.response-files');if(!card){card=document.createElement('div');card.className='response-files';const head=document.createElement('div');head.className='response-files-head';const list=document.createElement('div');list.className='response-files-list';card.append(head,list);activeResponse.append(card);}const list=card.querySelector('.response-files-list');if(![...list.children].some(row=>row.dataset.path===event.path)){const row=document.createElement('button');row.type='button';row.className='response-file';row.dataset.path=event.path;row.title='Open '+event.path;row.innerHTML=STEP_ICONS.edit;const text=document.createElement('span');text.textContent=event.path;row.append(text);row.addEventListener('click',()=>vscode.postMessage({type:'open-file',path:event.path}));list.append(row);}const total=list.children.length;card.querySelector('.response-files-head').textContent='Edited '+total+(total===1?' file':' files');};
      const addActivity=event=>{addActivityRow(event);trackEditedFile(event);if(!activeResponse?.classList.contains('pending'))return;const approval=event.type==='tool'&&event.phase==='start'&&String(event.text||'').startsWith('Waiting for approval:');const finished=event.type==='tool'&&event.phase&&event.phase!=='start';if(activeStatus){activeStatus.classList.remove('thinking');activeStatus.classList.toggle('approval',approval);activeStatus.textContent=approval?'Needs approval':'Working';}const now=activeResponse.querySelector('.response-now');if(now){now.hidden=false;now.textContent=activityTitle(event).replace(/^Working on /,'').replace(' - ',' \u00b7 ');now.classList.toggle('approval',approval);now.classList.toggle('idle',Boolean(finished));}const details=activeResponse.querySelector('.response-activity');if(details&&!details.dataset.userToggled)details.open=true;};
      /** Streaming text is rendered as Markdown as it arrives, at most every 70 ms; an unclosed code fence renders as a growing code block. */
      // A timer, not requestAnimationFrame: frame callbacks pause while the view is hidden, and the text should keep up.
      let streamTimer=0,lastStreamRender=0;
      const cancelStreamRender=()=>{if(streamTimer){clearTimeout(streamTimer);streamTimer=0;}};
      const scheduleStreamRender=()=>{if(streamTimer)return;const target=activeContent;streamTimer=setTimeout(()=>{streamTimer=0;lastStreamRender=Date.now();if(target&&target===activeContent&&target.classList.contains('streaming')){renderMarkdown(target,target.dataset.raw||'');followLatest();}},Math.max(0,70-(Date.now()-lastStreamRender)));};
      const finishResponse=(text,error=false)=>{cancelStreamRender();if(!activeResponse)return;for(const {group} of handoffs.values()){group.classList.remove('working');group.classList.add(error?'failed':'complete');}handoffs.clear();pendingHandoffCalls.clear();if(statusTimer){clearInterval(statusTimer);statusTimer=null;}activeResponse.querySelectorAll('.response-activity-item.working,.response-activity-item.progress,.response-activity-item.approval').forEach(row=>{row.classList.remove('working','progress','approval');row.classList.add(error?'failed':'complete');const label=row.querySelector('.activity-label');if(label)label.textContent=label.textContent.replace(' is working',error?' stopped':' finished');});const details=activeResponse.querySelector('.response-activity');if(details)details.open=false;activeContent.dataset.raw=text||'';renderMarkdown(activeContent,text||'');activeContent.classList.remove('streaming');activeResponse.classList.remove('pending');activeResponse.classList.toggle('error',error);activeContent.classList.toggle('streaming',false);const took=formatElapsed(Date.now()-responseStartedAt);if(activeStatus){activeStatus.classList.remove('thinking','approval');activeStatus.classList.add('finished');activeStatus.textContent=error?'Stopped':'Done';activeStatus.classList.toggle('failed',error);}const elapsedEl=activeResponse.querySelector('.response-elapsed');if(elapsedEl)elapsedEl.textContent=(error?'Stopped after ':'Worked for ')+took;activeResponse.querySelector('.response-now')?.remove();activeResponse.querySelector('.response-head')?.setAttribute('aria-expanded','false');updateSend();followLatest();};
      window.addEventListener('message',event=>{const data=event.data;if(data.type==='agent'){if(statusTimer){clearInterval(statusTimer);statusTimer=null;}activeResponse=activeContent=activeStatus=activityList=null;thinkingViews.clear();toolRows.clear();return;}if(data.type==='queue'){queue.textContent=data.status==='queued'?'Queued: '+data.label:data.status==='running'?'':'';send.disabled=data.status==='queued'||data.status==='running'||(!prompt.value.trim()&&!attachmentIds.length);if(assignButton)assignButton.disabled=data.status==='queued'||data.status==='running'||(!prompt.value.trim()&&!attachmentIds.length&&!currentConversationId);event.stopImmediatePropagation();return;}if(data.type==='user'){welcome.hidden=true;const userMessage=addMessage('user','You',data.text||'');for(const image of data.images||[]){if(!image||typeof image.id!=='string')continue;const dataUrl=imagePreviews.get(image.id);if(!dataUrl)continue;const preview=document.createElement('img');preview.src=dataUrl;preview.alt=image.name||'Pasted image';preview.loading='lazy';preview.className='user-image-preview';let strip=userMessage.item.previousElementSibling;if(!strip||!strip.classList.contains('user-images')){strip=document.createElement('div');strip.className='user-images';userMessage.item.before(strip);}strip.append(preview);}beginResponse();followLatest(true);event.stopImmediatePropagation();return;}if(data.type==='progress'&&activeResponse){addActivity({type:'progress',text:data.text||'Working'});event.stopImmediatePropagation();return;}if(data.type==='chunk'&&activeContent){if(activeStatus){activeStatus.classList.remove('thinking','approval');activeStatus.textContent='Writing';}activeResponse?.querySelector('.response-now')?.setAttribute('hidden','');activeContent.dataset.raw=(activeContent.dataset.raw||'')+(data.text||'');scheduleStreamRender();event.stopImmediatePropagation();return;}if(data.type==='thinking_chunk'){appendThinking(data.text||'',data.agentId);followLatest();event.stopImmediatePropagation();return;}if(data.type==='thinking_message'){appendThinking(data.text||'',data.agentId,true);followLatest();event.stopImmediatePropagation();return;}if(data.type==='stream_reset'&&activeContent){cancelStreamRender();activeContent.dataset.raw='';activeContent.replaceChildren();event.stopImmediatePropagation();return;}if(data.type==='activity'&&activeResponse){addActivity(data.event||{});followLatest();event.stopImmediatePropagation();return;}if(data.type==='result'&&activeResponse){finishResponse(data.text||'');event.stopImmediatePropagation();return;}if(data.type==='error'&&activeResponse){finishResponse(data.text||'Task failed',true);event.stopImmediatePropagation();return;}} ,true);
      const modeButtons=[...document.querySelectorAll('#mode-team,#mode-supervisor,#mode-agent')],agentModeButton=document.querySelector('#mode-agent'),agentModeMenu=document.querySelector('#agent-picker-menu');const updateModeTabs=(id,teamMode,name)=>{const team=teamMode===true,supervisor=!team&&id==='lead',individual=!team&&id!=='lead';document.querySelector('#mode-team').setAttribute('aria-pressed',String(team));document.querySelector('#mode-supervisor').setAttribute('aria-pressed',String(supervisor));agentModeButton.setAttribute('aria-pressed',String(individual));document.querySelector('#mode-agent-label').textContent=individual?(name||'Agent'):'Agent';agentModeButton.title=individual?'Chat with '+(name||'agent')+'. Choose another agent':'Choose an individual agent';agentModeMenu.querySelectorAll('[data-agent-id]').forEach(option=>option.setAttribute('aria-checked',String(individual&&option.dataset.agentId===id)));};const renderAgentOptions=agents=>{agentModeMenu.replaceChildren();for(const agent of agents||[]){if(!agent||typeof agent.id!=='string'||agent.id==='lead'||typeof agent.name!=='string')continue;const option=document.createElement('button');option.type='button';option.role='menuitemradio';option.dataset.agentId=agent.id;option.setAttribute('aria-checked','false');const label=document.createElement('span');label.className='mode-agent-name';label.textContent=agent.name;const check=document.createElement('span');check.className='mode-agent-check';check.setAttribute('aria-hidden','true');check.textContent='✓';option.append(label,check);option.addEventListener('click',()=>{toggleMenu('#agent-picker-menu');agentModeButton.setAttribute('aria-expanded','false');vscode.postMessage({type:'select-chat-mode',mode:'agent',agentId:agent.id});});agentModeMenu.append(option);}if(!agentModeMenu.children.length){const empty=document.createElement('div');empty.className='menu-heading';empty.textContent='No individual agents available';agentModeMenu.append(empty);}};agentModeButton.addEventListener('click',()=>{toggleMenu('#agent-picker-menu');agentModeButton.setAttribute('aria-expanded',String(!agentModeMenu.hidden));});document.querySelector('#mode-team').addEventListener('click',()=>{if(document.querySelector('#mode-team').getAttribute('aria-pressed')!=='true')vscode.postMessage({type:'select-chat-mode',mode:'team'});});document.querySelector('#mode-supervisor').addEventListener('click',()=>{if(document.querySelector('#mode-supervisor').getAttribute('aria-pressed')!=='true')vscode.postMessage({type:'select-chat-mode',mode:'supervisor'});});modeButtons.forEach((button,index)=>button.addEventListener('keydown',event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();modeButtons[(index+(event.key==='ArrowRight'?1:modeButtons.length-1))%modeButtons.length].focus();}));document.addEventListener('click',event=>{if(!event.target.closest('.agent-picker'))agentModeButton.setAttribute('aria-expanded','false');});document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!agentModeMenu.hidden){agentModeMenu.hidden=true;agentModeButton.setAttribute('aria-expanded','false');agentModeButton.focus();}});window.addEventListener('message',event=>{const data=event.data;if(data.type==='agent'){currentAgentId=data.id;renderAgentOptions(data.agents);updateModeTabs(data.id,data.teamMode,data.name);document.querySelector('#agent').textContent=data.name;document.querySelector('#welcome-copy').textContent=data.teamMode?'Discuss goals and requirements here. Choose Assign task when you are ready to start work.':data.id==='lead'?'Discuss the task with your supervisor. The Supervisor consults relevant agents; say “ask all agents” for the whole team. Choose Assign task when you are ready.':'Discuss the request with '+data.name+' first, then choose Assign task when it is ready.';prompt.placeholder=data.teamMode?'Discuss a task with your team…':data.id==='lead'?'Discuss with your supervisor…': 'Discuss with '+data.name+'…';messages.replaceChildren();attachmentArea.replaceChildren();attachmentIds=[];imagePreviews.clear();welcome.hidden=false;queue.textContent='';planMode=false;thinking=false;reasoningEffort='auto';document.querySelector('#think-status').textContent='Off';document.querySelector('#think-toggle').classList.remove('selected');document.querySelector('#plan-status').textContent='Off';applyConfig(data.config);return;}if(data.type==='attachments'){renderAttachments(data.files||[]);return;}if(data.type==='attachments-cleared'){for(const id of data.ids||[]){attachmentIds=attachmentIds.filter(item=>item!==id);imagePreviews.delete(id);attachmentArea.querySelector('[data-id="'+CSS.escape(id)+'"]')?.remove();}updateSend();return;}if(data.type==='queue'){queue.textContent=data.status==='queued'?'Queued: '+data.label:data.status==='running'?'':data.status==='failed'?'Task failed: '+(data.error||''):'';if(data.status==='completed'||data.status==='failed')updateSend();return;}if(['sessions','session','session-meta','toast','activity','chunk','stream_reset','thinking_chunk','thinking_message','agent-message','laya-status'].includes(data.type)||!data.text)return;welcome.hidden=true;const item=document.createElement('article');item.className='message '+data.type;const label=document.createElement('span');label.className='message-label';label.textContent=data.type==='user'?'You':data.type==='progress'?'Working':data.type==='agent-message'?'Agent handoff':document.querySelector('#agent').textContent;const content=document.createElement('div');content.className='message-content';if(data.type==='agent-message')renderMarkdown(content,data.text||'');else content.textContent=data.text||'';item.append(label,content);messages.append(item);followLatest();});
    </script><script nonce="${nonce}">
      (()=>{const shell=document.querySelector('#shell'),list=document.querySelector('#sessions-list'),search=document.querySelector('#sessions-search'),caption=document.querySelector('#session-caption'),archiveButton=document.querySelector('#archive-session'),toggle=document.querySelector('#toggle-sessions'),scrim=document.querySelector('#sessions-scrim'),toast=document.querySelector('#toast'),icons=menuIcons;
      let data={recent:[],archived:[],currentId:null},tab='recent',currentId=null,toastTimer=0;
      const saved=()=>vscode.getState()||{};
      const openHistory=()=>{shell.classList.add('history-open');toggle.setAttribute('aria-expanded','true');setTimeout(()=>search.focus(),0);};
      // The history dropdown closes on any click outside it, like a menu.
      window.addEventListener('click',event=>{if(shell.classList.contains('history-open')&&!event.target.closest('#sessions,#toggle-sessions,#home-view-all,.menu'))closeDrawer();});
      const filterLabel=document.querySelector('#history-filter-label');document.querySelector('#history-filter').addEventListener('click',()=>toggleMenu('#history-filter-menu'));
      document.querySelectorAll('[data-filter]').forEach(option=>option.addEventListener('click',()=>{document.querySelector('[data-tab="'+option.dataset.filter+'"]').click();filterLabel.textContent=option.textContent;document.querySelectorAll('[data-filter]').forEach(item=>item.setAttribute('aria-checked',String(item===option)));document.querySelector('#history-filter-menu').hidden=true;}));
      const closeDrawer=()=>{shell.classList.remove('history-open');toggle.setAttribute('aria-expanded','false');};
      toggle.addEventListener('click',()=>shell.classList.contains('history-open')?closeDrawer():openHistory());
      document.querySelector('#sessions-back').addEventListener('click',()=>{closeDrawer();toggle.focus();});scrim.addEventListener('click',closeDrawer);
      document.addEventListener('keydown',event=>{if(event.key==='Escape'&&shell.classList.contains('history-open')){closeDrawer();toggle.focus();}});
      document.querySelector('#chat-back').addEventListener('click',()=>vscode.postMessage({type:'new-session'}));
      document.querySelector('#open-settings').addEventListener('click',()=>vscode.postMessage({type:'open-settings'}));
      const moreMenu=document.querySelector('#chat-more-menu');document.querySelector('#chat-more').addEventListener('click',()=>toggleMenu('#chat-more-menu'));
      document.querySelector('#more-rename').addEventListener('click',()=>{moreMenu.hidden=true;if(currentId)vscode.postMessage({type:'rename-session',id:currentId});});
      document.querySelector('#more-copy').addEventListener('click',()=>{moreMenu.hidden=true;const text=[...messages.querySelectorAll('article.message')].map(item=>{const who=item.classList.contains('user')?'You':(item.querySelector('.message-label')?.textContent||'Agent');const body=item.querySelector('.message-content');return (body?.dataset.raw||body?.textContent||'').trim()?'**'+who+':** '+(body.dataset.raw||body.textContent).trim():'';}).filter(Boolean).join('\\n\\n');if(text)vscode.postMessage({type:'copy',text});});
      /** Codex-style short ages for the home list: now, 5m, 18h, 3d, 2w. */
      const shortAgo=iso=>{const time=Date.parse(iso);if(!time)return '';const m=Math.round((Date.now()-time)/60000);if(m<1)return 'now';if(m<60)return m+'m';const h=Math.round(m/60);if(h<24)return h+'h';const d=Math.round(h/24);return d<14?d+'d':Math.round(d/7)+'w';};
      /** Home = no open chat and nothing sent yet: show recent chats, hide the back button and chat menu. */
      const renderHome=()=>{const isHome=!currentId&&!messages.children.length,recent=data.recent||[],archived=data.archived||[];shell.classList.toggle('is-home',isHome);prompt.placeholder=isHome?'Message '+document.querySelector('#agent').textContent+'\u2026':'Ask for follow-up changes';document.querySelector('#chat-back').hidden=isHome;document.querySelector('#chat-more').hidden=!currentId;const home=document.querySelector('#home-recents');home.hidden=!isHome||!recent.length;const area=document.querySelector('#home-recents-list');area.replaceChildren();for(const s of recent.slice(0,5)){const b=document.createElement('button');b.type='button';b.className='home-recent';b.setAttribute('role','listitem');b.title=s.title;const t=document.createElement('span');t.className='home-recent-title';t.textContent=s.title;const w=document.createElement('span');w.className='home-recent-time';w.textContent=shortAgo(s.updatedAt);b.append(t,w);b.addEventListener('click',()=>vscode.postMessage({type:'open-session',id:s.id}));area.append(b);}const all=document.querySelector('#home-view-all');all.textContent='View all ('+(recent.length+archived.length)+')';all.hidden=recent.length<=5&&!archived.length;};
      document.querySelector('#home-view-all').addEventListener('click',openHistory);
      document.querySelector('#laya-resume').addEventListener('click',()=>vscode.postMessage({type:'resume-laya'}));
      window.addEventListener('message',event=>{const d=event.data;if(!d||d.type!=='laya-status')return;const line=document.querySelector('#laya-line');line.hidden=!d.paused;if(d.paused){const since=d.pausedAt?new Date(d.pausedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';document.querySelector('#laya-line-text').textContent='Laya paused'+(since?' since '+since:'')+' \u00b7 routing uses the fallback';line.title=d.reason||'';}});new MutationObserver(()=>renderHome()).observe(messages,{childList:true});renderHome();
      const showToast=text=>{toast.textContent=text;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},2600);};
      const ago=iso=>{const time=Date.parse(iso);if(!time)return '';const s=Math.round((Date.now()-time)/1000);if(s<60)return 'just now';const m=Math.round(s/60);if(m<60)return m+'m ago';const h=Math.round(m/60);if(h<24)return h+'h ago';const d=Math.round(h/24);return d<30?d+'d ago':new Date(time).toLocaleDateString();};
      const groupOf=iso=>{const time=Date.parse(iso)||0,now=new Date(),day=86400000,start=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();return time>=start?'Today':time>=start-day?'Yesterday':time>=start-6*day?'Previous 7 days':'Older';};
      const iconButton=(label,icon,onClick)=>{const b=document.createElement('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML=icon;b.addEventListener('click',onClick);return b;};
      const renderList=()=>{renderHome();const q=search.value.trim().toLowerCase(),source=tab==='archived'?data.archived:data.recent,items=source.filter(s=>!q||(s.title+' '+s.preview+' '+s.agentName).toLowerCase().includes(q));list.replaceChildren();
        document.querySelectorAll('[data-tab]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.tab===tab));b.querySelector('.count').textContent=String((b.dataset.tab==='archived'?data.archived:data.recent).length||'');});
        if(!items.length){const empty=document.createElement('div');empty.className='sessions-empty';empty.textContent=q?'No chats match your search.':tab==='archived'?'Archived chats appear here.':'No chats yet. Send a message to start one.';list.append(empty);return;}
        for(const s of items){
          const row=document.createElement('div');row.className='session'+(s.id===currentId?' current':'');row.setAttribute('role','listitem');
          const open=document.createElement('button');open.type='button';open.className='session-open';open.title=s.title;if(s.id===currentId)open.setAttribute('aria-current','true');
          const title=document.createElement('span');title.className='session-title';title.textContent=s.title;const meta=document.createElement('span');meta.className='session-meta';meta.textContent=shortAgo(s.updatedAt);meta.title=[s.agentName,s.turns?s.turns+(s.turns===1?' message':' messages'):'',ago(s.updatedAt)].filter(Boolean).join(' \u00b7 ');open.append(title,meta);
          open.addEventListener('click',()=>{vscode.postMessage({type:'open-session',id:s.id});closeDrawer();});
          const actions=document.createElement('div');actions.className='session-actions';actions.append(iconButton('Rename',icons.rename,()=>vscode.postMessage({type:'rename-session',id:s.id})),iconButton(s.archived?'Restore from archive':'Archive',s.archived?icons.unarchive:icons.archive,()=>vscode.postMessage({type:'archive-session',id:s.id,archived:!s.archived})));
          row.append(open,actions);list.append(row);}};
      search.addEventListener('input',renderList);
      document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.tab;renderList();}));
      conversation.addEventListener('scroll',()=>{pinnedToLatest=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<80;const jump=document.querySelector('#jump-latest');if(jump&&pinnedToLatest)jump.hidden=true;},{passive:true});document.querySelector('#jump-latest').addEventListener('click',()=>{pinnedToLatest=true;conversation.scrollTo({top:conversation.scrollHeight,behavior:'smooth'});});
      // Starters fill the composer instead of sending, so the prompt can be finished or edited first.
      document.querySelectorAll('[data-starter]').forEach(button=>button.addEventListener('click',()=>{prompt.value=button.dataset.starter;prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.focus();prompt.setSelectionRange(prompt.value.length,prompt.value.length);}));
      const resizer=document.querySelector('#sessions-resizer'),railWidth=()=>parseInt(getComputedStyle(shell).getPropertyValue('--rail-width'))||264;const setRailWidth=width=>{const next=Math.max(200,Math.min(480,Math.round(width)));shell.style.setProperty('--rail-width',next+'px');resizer.setAttribute('aria-valuenow',String(next));return next;};const keepRailWidth=width=>vscode.setState(Object.assign({},saved(),{railWidth:width}));if(saved().railWidth)setRailWidth(saved().railWidth);resizer.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();resizer.setPointerCapture(event.pointerId);resizer.classList.add('active');shell.classList.add('resizing');document.body.style.cursor='col-resize';const move=moveEvent=>setRailWidth(moveEvent.clientX-shell.getBoundingClientRect().left);const stop=()=>{resizer.classList.remove('active');shell.classList.remove('resizing');document.body.style.cursor='';resizer.removeEventListener('pointermove',move);resizer.removeEventListener('pointerup',stop);resizer.removeEventListener('pointercancel',stop);keepRailWidth(railWidth());};resizer.addEventListener('pointermove',move);resizer.addEventListener('pointerup',stop);resizer.addEventListener('pointercancel',stop);});resizer.addEventListener('dblclick',()=>{shell.style.removeProperty('--rail-width');keepRailWidth(0);});resizer.addEventListener('keydown',event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();keepRailWidth(setRailWidth(railWidth()+(event.key==='ArrowRight'?16:-16)));});
      document.querySelector('#sessions-new').addEventListener('click',()=>{vscode.postMessage({type:'new-session'});closeDrawer();prompt.focus();});
      const setMeta=d=>{currentId=d.id||null;currentConversationId=currentId;updateSend();caption.textContent=d.id?(d.title||'Untitled chat')+(d.archived?' \u00b7 Archived':''):'Chats';caption.title=caption.textContent;archiveButton.innerHTML=(d.archived?icons.unarchive:icons.archive)+'<span>'+(d.archived?'Restore from archive':'Archive')+'</span>';archiveButton.dataset.archived=d.archived?'1':'';renderHome();};
      archiveButton.addEventListener('click',()=>{moreMenu.hidden=true;if(currentId)vscode.postMessage({type:'archive-session',id:currentId,archived:archiveButton.dataset.archived!=='1'});});
      /** A saved reply is replayed through the live renderer, so it shows the same "Worked for", steps, thinking and files. */
      const renderStoredReply=m=>{const trace=m.trace||{};beginResponse();const label=activeResponse.querySelector('.message-label');if(label)label.textContent=m.author||'Agent';for(const step of trace.steps||[])addActivity(step);for(const item of trace.thinking||[])appendThinking(item.text||'',item.agentId,true);responseStartedAt=Date.now()-(Number(trace.durationMs)||0);finishResponse(m.text||'',Boolean(trace.failed));};
      const addActions=item=>{if(item.querySelector(':scope > .message-actions'))return;const bar=document.createElement('div');bar.className='message-actions';const text=()=>{const c=item.querySelector('.message-content');return c?(c.dataset.raw||c.textContent||''):'';};
        const remember=iconButton('Remember this',icons.remember,()=>vscode.postMessage({type:'remember',text:text()}));
        bar.append(iconButton('Copy',icons.copy,()=>vscode.postMessage({type:'copy',text:text()})),remember);item.append(bar);};
      new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){if(node.nodeType===1&&node.matches('article.message.user,article.message.response'))addActions(node);}}).observe(messages,{childList:true});
      window.addEventListener('message',event=>{const d=event.data;if(!d||typeof d!=='object')return;
        if(d.type==='sessions'){data=d;currentId=d.currentId;renderList();return;}
        if(d.type==='session-meta'){setMeta(d);renderList();return;}
        if(d.type==='toast'){showToast(d.text||'');return;}
        if(d.type==='session'){setMeta(d);messages.replaceChildren();queue.textContent='';const items=d.messages||[];for(const m of items){if(m.role==='user'){addMessage('user','You',m.text||'');}else if(m.trace){renderStoredReply(m);}else{const r=addMessage('response result',m.author||'Agent','');r.content.dataset.raw=m.text||'';renderMarkdown(r.content,m.text||'');}}activeResponse=activeContent=activeStatus=activityList=null;messages.querySelectorAll('.message').forEach(item=>item.classList.add('restored'));welcome.hidden=items.length>0;followLatest(true);renderList();}});
      vscode.postMessage({type:'chat-ready'});})();
    </script></body></html>`;
  }
}
