import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listLoginAccounts } from "@/lib/org";
import { LoginForm } from "@/components/LoginForm";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; entity?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/calendar");

  const params = await searchParams;
  const scope = listLoginAccounts(params.company ?? null, params.entity ?? null);

  return (
    <div className="login-wrap">
      <section className="login-art">
        <div>
          <div className="row" style={{ gap: 10 }}>
            <div className="brand-mark">HF</div>
            <div>
              <div style={{ fontWeight: 700 }}>HFM Quality Engineering</div>
              <div style={{ fontSize: "0.72rem", color: "#7f93b3", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                AI-powered QA operations
              </div>
            </div>
          </div>
        </div>

        <div>
          <h1>The QA calendar that knows your capacity.</h1>
          <p style={{ marginTop: 14 }}>
            Activities, recording pipeline, release governance and defect progress in one auditable workspace — built
            for QA today and any department tomorrow.
          </p>
          <div className="feature-list">
            <div><Icon name="calendar" size={16} /> Fiscal calendar with NSW holidays and current-week highlighting</div>
            <div><Icon name="activity" size={16} /> Capacity and FTE kept as separate, defensible metrics</div>
            <div><Icon name="layers" size={16} /> Combined QA + pipeline view with overlap suppression</div>
            <div><Icon name="users" size={16} /> Downward-only visibility: teams see work, never their managers</div>
            <div><Icon name="sparkles" size={16} /> AI guidance notes and an enhancement vault on every tab</div>
          </div>
        </div>

        <div style={{ fontSize: "0.74rem", color: "#7f93b3" }}>
          Demo data is synthetic and clearly flagged. Schedule fields are date-only; timestamps display in
          Australia/Sydney.
        </div>
      </section>

      <section className="login-panel">
        <LoginForm scope={scope} />
      </section>
    </div>
  );
}
