import ScreenPart from "./ScreenPart";

export default function ChatWindow({ markup, resizeHandle }) {
  return <><ScreenPart name="agent-chat-aside" markup={markup} /><ScreenPart name="chat-resizer" markup={resizeHandle} /></>;
}
