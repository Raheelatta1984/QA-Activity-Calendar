import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page" style={{ display: "grid", placeItems: "center", minHeight: "70vh" }}>
      <div className="card card-pad" style={{ maxWidth: 480, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.4rem" }}>Page not found</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          That route doesn&apos;t exist in the QA Calendar. Tabs live at their stable IDs — check the navigation or the
          ID catalogue in the docs.
        </p>
        <Link className="btn btn-primary" href="/" style={{ marginTop: 16 }}>
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
