interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** Preload API of the Agent Workbench desktop app (desktop/preload.cjs); only the parts the shared UI uses. */
interface DesktopWorkbenchApi {
  workbenchRpc(method: string, params: unknown): Promise<unknown>;
  onWorkbenchChanged(listener: (change: { scopes: Array<"agents" | "tasks" | "health" | "conversations">; taskIds?: string[] }) => void): () => void;
}
type RobotAnimationState = "idle" | "listening" | "thinking" | "working" | "talking" | "happy" | "error";
/** "jocy" and "ally" are the baked Meshy bots in media/bots/, rigged to the procedural robot's animation. */
type RobotModelName = "default" | "wanted" | "jocy" | "ally" | "vally" | "meshy" | "buddy" | "jarvis";
interface Window {
  workbench?: DesktopWorkbenchApi;
  /** Procedural 3D robot (webview-ui/src/robot-runtime.ts), loaded as a separate script; absent without WebGL. */
  AgentRobot3D?: {
    getAvatarSprite(model?: RobotModelName): Promise<string | undefined>;
    getAvatarSheet(state: RobotAnimationState, model?: RobotModelName): Promise<{ url: string; frames: number; duration: number } | undefined>;
    mount(canvas: HTMLCanvasElement, model?: RobotModelName): (() => void) | undefined;
  };
}

declare module "markdown-it" {
  interface MarkdownItOptions { html?: boolean; linkify?: boolean; breaks?: boolean; typographer?: boolean }
  export default class MarkdownIt {
    constructor(options?: MarkdownItOptions);
    render(source: string): string;
    renderInline(source: string): string;
  }
}

declare module "*.css";
