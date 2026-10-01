
export const metadata = {
  title: "Agent Workbench",
  description: "A workspace for people and AI agents to work side by side."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:3000 http://127.0.0.1:3000; worker-src 'self' blob:;"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
