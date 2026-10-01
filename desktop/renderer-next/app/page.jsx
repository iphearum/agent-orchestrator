"use client";

import dynamic from "next/dynamic";
import "../../../webview-ui/src/styles.css";
import "./desktop.css";

// The shared webview surfaces talk to the Electron bridge on load, so they render in the browser only.
const DesktopWorkbench = dynamic(() => import("../features/workbench/DesktopWorkbench"), { ssr: false });

export default function Home() {
  return <DesktopWorkbench />;
}
