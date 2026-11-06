"use client";

import { Icon } from "@/components/icons";

/** Download the document rendered with the authenticated page, without a
 * second request to a potentially different serverless SQLite instance. */
export function MarkdownDownload({ filename, content, label = false }: { filename: string; content: string; label?: boolean }) {
  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <button type="button" className="btn btn-sm" onClick={download} title="Download markdown" aria-label="Download markdown"><Icon name="download" size={13} />{label ? " Download Markdown" : null}</button>;
}
