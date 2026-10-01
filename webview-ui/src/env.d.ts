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
interface Window { workbench?: DesktopWorkbenchApi }

declare module "markdown-it" {
  interface MarkdownItOptions { html?: boolean; linkify?: boolean; breaks?: boolean; typographer?: boolean }
  export default class MarkdownIt {
    constructor(options?: MarkdownItOptions);
    render(source: string): string;
  }
}

declare module "*.css";
