import { createRoot } from "react-dom/client";
import type { Surface } from "@shared/protocol";
import { ready } from "./bridge";
import { SidebarApp } from "./sidebar/SidebarApp";
import { TaskApp } from "./task/TaskApp";
import { OverviewApp } from "./overview/OverviewApp";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  const surface = (root.dataset.surface ?? "task") as Surface;
  createRoot(root).render(surface === "sidebar" ? <SidebarApp /> : surface === "overview" ? <OverviewApp /> : <TaskApp />);
  ready(surface);
}
