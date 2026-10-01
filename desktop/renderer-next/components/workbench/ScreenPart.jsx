export default function ScreenPart({ name, markup }) {
  return <div className="contents" data-screen-part={name} dangerouslySetInnerHTML={{ __html: markup }} />;
}
