import ScreenPart from "./ScreenPart";

export default function WorkspaceSidebar({ markup, resizeHandle }) {
  return <><ScreenPart name="workspace-sidebar" markup={markup} /><ScreenPart name="sidebar-resizer" markup={resizeHandle} /></>;
}
