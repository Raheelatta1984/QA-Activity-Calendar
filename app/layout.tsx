import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ensureBootstrapped } from "@/lib/bootstrap";

export const metadata: Metadata = {
  title: "HFM QA Activity Calendar",
  description:
    "AI-powered QA calendar: activities, capacity, recording pipeline, release governance and continuous improvement.",
};

export const viewport: Viewport = {
  themeColor: "#070b14",
  width: "device-width",
  initialScale: 1,
};

const themeScript = `
(function(){
  try {
    var stored = localStorage.getItem('qa-theme');
    var theme = stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ensureBootstrapped();
  return (
    <html lang="en-AU" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
