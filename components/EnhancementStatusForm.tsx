"use client";

import { useActionState } from "react";
import { setEnhancementStatusAction } from "@/app/actions/enhancements";

const stages = ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived", "Rejected"];
export function EnhancementStatusForm({ id, status }: { id: string; status: string }) {
  const [state, action, pending] = useActionState(setEnhancementStatusAction, {});
  return <form action={action} className="row" style={{ marginTop: 10, gap: 6 }}>
    <input type="hidden" name="id" value={id} />
    <select className="select select-sm" name="status" defaultValue={status} style={{ maxWidth: 160 }} aria-label="Enhancement status">
      {stages.map((stage) => <option key={stage}>{stage}</option>)}
    </select>
    <button className="btn btn-sm" type="submit" disabled={pending}>{pending ? "Saving…" : "Move stage"}</button>
    <span className="card-sub">Building publishes to GitHub. Archive a completed handover after its PR merges.</span>
    {state.error ? <span className="badge badge-red" role="alert">{state.error}</span> : null}
  </form>;
}
