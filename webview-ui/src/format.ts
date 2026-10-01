import type { AgentRunState, TaskStatus } from "@shared/protocol";

/** The only place raw statuses become words (design-spec §4). */
export function taskStatusLabel(status: TaskStatus, running: boolean): { label: string; tone: "success" | "accent" | "muted" | "warning" | "danger" } {
  if (running) return { label: "In Progress", tone: "success" };
  switch (status) {
    case "completed": return { label: "Done", tone: "success" };
    case "planning": return { label: "Planning", tone: "muted" };
    case "pending": return { label: "Queued", tone: "muted" };
    case "blocked": return { label: "Blocked", tone: "danger" };
    case "cancelled": return { label: "Cancelled", tone: "muted" };
    // Stored as active but no run is attached: the window closed or the run crashed mid-way.
    case "active": return { label: "Interrupted", tone: "warning" };
  }
}

export const priorityLabel = (priority: number) => ["Low", "Medium", "High", "Urgent"][Math.max(0, Math.min(3, priority))];

export const agentStateLabel: Record<AgentRunState, string> = {
  idle: "idle", thinking: "thinking", running: "working", delegating: "delegating", waiting: "waiting for approval", failed: "failed"
};

export function clock(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(iso: string | undefined) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? `Today ${clock(iso)}` : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function relative(iso: string | undefined) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

export function duration(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
