"use client";

import { useEffect, useState } from "react";
import ScreenPart from "../components/workbench/ScreenPart";
import TitleBar from "../components/workbench/TitleBar";
import ActivityRail from "../components/workbench/ActivityRail";
import WorkspaceSidebar from "../components/workbench/WorkspaceSidebar";
import EditorArea from "../components/workbench/EditorArea";
import ChatWindow from "../components/workbench/ChatWindow";
import StatusBar from "../components/workbench/StatusBar";
import { AgentProvider } from "../features/agents/AgentProvider";
import { hasDesktopBridge } from "../lib/desktopBridge";

export default function WorkbenchScreen({ sections }) {
  const [startupError, setStartupError] = useState("");
  useEffect(() => {
    const onRuntimeError = event => {
      const error = event.error || event.reason || event.message || "A renderer action failed.";
      setStartupError(error?.stack || error?.message || String(error));
    };
    const onUnhandledRejection = event => onRuntimeError({ reason: event.reason });
    window.addEventListener("error", onRuntimeError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    if (!hasDesktopBridge()) {
      setStartupError("Desktop features require the Agent Workbench desktop app. This page was opened without the Electron bridge.");
      return () => {
        window.removeEventListener("error", onRuntimeError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      };
    }
    import("../compat/main.js").catch(error => {
      console.error("Could not initialize Agent Workbench", error);
      setStartupError(error?.stack || error?.message || String(error));
    });
    return () => {
      window.removeEventListener("error", onRuntimeError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return <AgentProvider>
    <div className="app-shell nextjs-screen h-dvh min-h-0 w-full grid grid-rows-[38px_minmax(0,1fr)_23px] overflow-hidden">
      <a className="editor-return" href="/" onClick={event => { event.preventDefault(); window.location.href = window.location.protocol === "file:" ? "./index.html" : "/"; }}>Agent Orchestration</a>
      <TitleBar markup={sections.topbar} />
      <main className="workbench min-h-0 min-w-0">
        <ActivityRail markup={sections.activityRail} />
        <WorkspaceSidebar markup={sections.sidebar} resizeHandle={sections.sidebarResizer} />
        <EditorArea markup={sections.editorWorkspace} />
        <ChatWindow markup={sections.chatAside} resizeHandle={sections.chatResizer} />
      </main>
      <ScreenPart name="image-viewer" markup={sections.imageViewer} />
      <StatusBar markup={sections.statusBar} />
      {startupError && <div className="renderer-startup-error" role="alert"><strong>Workbench features did not initialize</strong><pre>{startupError}</pre></div>}
    </div>
  </AgentProvider>;
}
