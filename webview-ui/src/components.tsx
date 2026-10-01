import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AgentRef, AgentRunState } from "@shared/protocol";
import { agentStyle } from "./agentColors";
import { agentStateLabel } from "./format";
import { Icon, RobotGlyph, type IconName } from "./icons";
import MarkdownIt from "markdown-it";

/** Agent run state → avatar animation; idle and anything unknown show the still. */
const AVATAR_ANIMATION: Record<AgentRunState, RobotAnimationState> = {
  idle: "idle", thinking: "thinking", running: "working", delegating: "talking", waiting: "listening", failed: "error"
};

export function Avatar({ agent, size = 28 }: { agent: Pick<AgentRef, "id" | "color"> & { state?: AgentRunState }; size?: number }) {
  const [hovered, setHovered] = useState(false);
  // Re-derive the animation only when the run state or hover changes, not on every parent render.
  // An idle avatar waves while hovered; a busy one keeps showing what it is doing.
  const animation = useMemo<RobotAnimationState>(() => {
    const busy = agent.state ? AVATAR_ANIMATION[agent.state] : "idle";
    return hovered && busy === "idle" ? "happy" : busy;
  }, [agent.state, hovered]);
  return (
    <span
      className="avatar"
      style={{ ...agentStyle(agent.color || agent.id), width: size, height: size }}
      aria-hidden="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <RobotGlyph state={animation} />
    </span>
  );
}

export function PersonAvatar({ name, size = 28 }: { name: string; size?: number }) {
  return <span className="avatar person" style={{ width: size, height: size }} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

export function StatusDot({ state, name }: { state: AgentRunState; name?: string }) {
  const label = name ? `${name}: ${agentStateLabel[state]}` : agentStateLabel[state];
  return <span className={`status-dot state-${state}`} role="img" aria-label={label} title={label} />;
}

export function Pill({ tone, children, icon }: { tone: string; children: ReactNode; icon?: "dot" | IconName }) {
  return (
    <span className={`pill tone-${tone}`}>
      {icon === "dot" ? <span className="pill-dot" aria-hidden="true" /> : icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export function AgentChip({ agent }: { agent?: AgentRef }) {
  if (!agent) return <span className="agent-chip muted-chip">System</span>;
  return <span className="agent-chip" style={agentStyle(agent.color || agent.id)}>{agent.name}</span>;
}

/** Accessible tab strip: arrow keys move between tabs. */
export function Tabs<T extends string>({ tabs, value, onChange, label, variant = "boxed" }: {
  tabs: Array<{ id: T; label: string; count?: number }>; value: T; onChange: (id: T) => void; label: string; variant?: "boxed" | "underline";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className={`tabs tabs-${variant}`} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={element => { refs.current[index] = element; }}
          role="tab"
          type="button"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          className={`tab ${tab.id === value ? "selected" : ""}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={event => onKey(event, index)}
        >
          {tab.label}{tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function IconButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon name={icon} /></button>;
}

export function Empty({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return <div className="empty">{icon && <Icon name={icon} size={20} />}<span>{children}</span></div>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="toggle-label">{label}</span>
      <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
    </button>
  );
}

/**
 * Drag handle that resizes the neighbouring pane. "vertical" handles change widths (drag sideways),
 * "horizontal" handles change heights. `invert` is for panes that sit after the handle (right / below).
 * Keyboard: arrows (Shift for bigger steps), Home/End, Enter or double-click to reset.
 */
export function Splitter({ orientation, value, min, max, onChange, onReset, label, invert }: {
  orientation: "vertical" | "horizontal"; value: number; min: number; max: number;
  onChange: (value: number) => void; onReset: () => void; label: string; invert?: boolean;
}) {
  const clampValue = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  const sign = invert ? -1 : 1;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = orientation === "vertical" ? event.clientX : event.clientY;
    const startValue = value;
    document.body.classList.add(orientation === "vertical" ? "resizing-x" : "resizing-y");
    const move = (moveEvent: PointerEvent) => {
      const position = orientation === "vertical" ? moveEvent.clientX : moveEvent.clientY;
      onChange(clampValue(startValue + sign * (position - start)));
    };
    const stop = () => {
      document.body.classList.remove("resizing-x", "resizing-y");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const grow = orientation === "vertical" ? ["ArrowRight"] : ["ArrowDown"];
    const shrink = orientation === "vertical" ? ["ArrowLeft"] : ["ArrowUp"];
    if (grow.includes(event.key)) onChange(clampValue(value + sign * step));
    else if (shrink.includes(event.key)) onChange(clampValue(value - sign * step));
    else if (event.key === "Home") onChange(min);
    else if (event.key === "End") onChange(max);
    else if (event.key === "Enter") onReset();
    else return;
    event.preventDefault();
  };
  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

/** True while the webview is narrower than the breakpoint; panes stack and resizing is off there. */
export function useNarrow(maxWidth = 1000) {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

// Agent output is rendered as Markdown with raw HTML disabled, so model text can never inject markup.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`markdown ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: markdown.render(text) }} />;
}

export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  return <span className={`inline-markdown ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: markdown.renderInline(text) }} />;
}
