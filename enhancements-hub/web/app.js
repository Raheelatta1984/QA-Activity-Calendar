/* Enhancements Hub — web console. Vanilla JS, talks only to the REST API. */

const state = { tab: "pipeline", enhancements: [], applications: [], tenants: [], docs: [], events: [], filter: { tenant: "", application: "", includeArchived: true } };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${isError ? " err" : ""}`;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), isError ? 6000 : 3200);
}

function api(path, options = {}) {
  const key = $("#apikey").value.trim();
  const headers = { "Content-Type": "application/json", "X-Actor": "console", ...(options.headers || {}) };
  if (key) headers["X-Api-Key"] = key;
  return fetch(path, { ...options, headers }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
    return data;
  });
}

document.getElementById("apikey").value = localStorage.getItem("hub-key") || "";
document.getElementById("apikey").addEventListener("change", (e) => {
  localStorage.setItem("hub-key", e.target.value.trim());
  toast("API key updated");
  refresh();
});

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b === btn);
  for (const section of document.querySelectorAll("main section")) section.hidden = section.id !== `view-${state.tab}`;
  refresh();
});

async function refresh() {
  try {
    const [health, meta, appsRes, tenantsRes] = await Promise.all([
      api("/api/v1/health"), api("/api/v1/meta"), api("/api/v1/applications"), api("/api/v1/tenants"),
    ]);
    state.applications = appsRes.applications;
    state.tenants = tenantsRes.tenants;
    const params = new URLSearchParams();
    if (state.filter.tenant) params.set("tenant", state.filter.tenant);
    if (state.filter.application) params.set("application", state.filter.application);
    params.set("includeArchived", String(state.filter.includeArchived));
    state.enhancements = (await api(`/api/v1/enhancements?${params}`)).enhancements;
    state.docs = (await api(`/api/v1/vault?${params}`)).documents;
    state.events = (await api("/api/v1/audit?limit=60")).events;
    state.meta = meta;
    render();
  } catch (error) {
    toast(error.message, true);
  }
}

const STATUS_FLOW = ["Submitted", "Reviewing", "Accepted", "Building", "Built", "Archived"];

function render() {
  ({ pipeline: renderPipeline, studio: renderStudio, registry: renderRegistry, vault: renderVault, audit: renderAudit })[state.tab]();
}

/* ---------------- Pipeline ---------------- */

function renderPipeline() {
  const byStatus = Object.fromEntries(STATUS_FLOW.map((s) => [s, []]));
  for (const item of state.enhancements) (byStatus[item.status] || (item.status === "Rejected" ? byStatus.Archived : byStatus.Submitted)).push(item);

  const counts = Object.fromEntries(STATUS_FLOW.map((s) => [s, byStatus[s].length]));
  const stats = `
    <div class="statgrid">
      ${STATUS_FLOW.map((s) => `<div class="stat"><b>${counts[s]}</b><span>${s}</span></div>`).join("")}
    </div>`;

  const filters = `
    <div class="row" style="margin-bottom:12px">
      <select id="f-tenant" style="width:auto"><option value="">All tenants</option>
        ${state.tenants.map((t) => `<option value="${esc(t.slug)}" ${state.filter.tenant === t.slug ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
      <select id="f-app" style="width:auto"><option value="">All applications</option>
        ${state.applications.filter((a) => !state.filter.tenant || a.tenant === state.filter.tenant)
          .map((a) => `<option value="${esc(a.slug)}" ${state.filter.application === a.slug ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
      <button class="act" id="f-clear">Clear</button>
      <span class="spacer"></span>
      <button class="act primary" onclick="switchToStudio()">＋ New request</button>
    </div>`;

  const board = `
    <div class="board">
      ${STATUS_FLOW.map((status) => `
        <div class="col">
          <h4>${status} · ${byStatus[status].length}</h4>
          ${byStatus[status].map((item) => `
            <div class="ticket" onclick="openTicket('${esc(item.id)}')">
              <div class="ref">${esc(item.ref)} · ${esc(item.application || "general")}</div>
              <div class="title">${esc(item.title)}</div>
              <div class="meta">${esc(item.tenant)} · ${esc(item.submitted_by || "anonymous")}</div>
            </div>`).join("") || `<div class="hint">—</div>`}
        </div>`).join("")}
    </div>`;

  $("#view-pipeline").innerHTML = stats + filters + board;

  $("#f-tenant").onchange = (e) => { state.filter.tenant = e.target.value; state.filter.application = ""; refresh(); };
  $("#f-app").onchange = (e) => { state.filter.application = e.target.value; refresh(); };
  $("#f-clear").onclick = () => { state.filter = { tenant: "", application: "", includeArchived: true }; refresh(); };
}

window.switchToStudio = () => {
  document.querySelector('#tabs button[data-tab="studio"]').click();
};

/* ---------------- Ticket drawer ---------------- */

window.openTicket = async (id) => {
  let item;
  try { ({ enhancement: item } = await api(`/api/v1/enhancements/${id}`)); } catch (e) { return toast(e.message, true); }
  const nexts = STATUS_FLOW.concat(["Rejected"]).filter((s) => s !== item.status);
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:#0008;z-index:30;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow:auto";
  overlay.innerHTML = `
    <div class="card" style="width:min(760px,100%);padding:20px">
      <div class="row"><span class="ref" style="color:var(--accent);font-family:ui-monospace,monospace">${esc(item.ref)}</span>
        <span class="pill ${esc(item.status)}">${esc(item.status)}</span>
        <span class="muted">${esc(item.tenant)} / ${esc(item.application || "general")}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="act" id="t-close">Close</button></div>
      <h3 style="margin:10px 0 4px;font-size:17px">${esc(item.title)}</h3>
      <p class="muted" style="margin:0 0 12px">Raised by ${esc(item.submitted_by || "anonymous")} · ${esc((item.created_at || "").slice(0, 10))}</p>
      <pre style="white-space:pre-wrap">${esc(
        ["Brief", item.brief, "Requirements", item.requirements, "Impacts", item.impacts, "Expected outcome", item.expected_outcome, "Success criteria", item.success_criteria]
          .filter(([, v]) => v)
          .map(([h, v]) => `## ${h}\n${v}`)
          .join("\n\n") || item.brief
      )}</pre>
      ${item.github_path ? `<p class="hint">Handover: <code>${esc(item.github_path)}</code></p>` : ""}
      <div class="row" style="margin-top:12px">
        <select id="t-status" style="width:auto">${nexts.map((s) => `<option value="${esc(s)}">Move to ${esc(s)}</option>`).join("")}</select>
        <button class="act primary" id="t-move">Apply</button>
        <button class="act" id="t-md">Markdown</button>
        <button class="act danger" id="t-del">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#t-close").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector("#t-move").onclick = async () => {
    try {
      const status = overlay.querySelector("#t-status").value;
      const res = await api(`/api/v1/enhancements/${item.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      toast(res.published ? `Published to ${res.published.filePath}` : `Moved to ${status}`);
      overlay.remove(); refresh();
    } catch (e) { toast(e.message, true); }
  };
  overlay.querySelector("#t-md").onclick = async () => {
    const res = await fetch(`/api/v1/enhancements/${item.id}/markdown`);
    const blob = new Blob([await res.text()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${item.ref}.md`;
    a.click();
  };
  overlay.querySelector("#t-del").onclick = async () => {
    try { await api(`/api/v1/enhancements/${item.id}`, { method: "DELETE" }); toast("Deleted"); overlay.remove(); refresh(); }
    catch (e) { toast(e.message, true); }
  };
};

/* ---------------- Studio ---------------- */

let studioFields = {};
function renderStudio() {
  const appOptions = state.applications
    .map((a) => `<option value="${esc(a.tenant)}|${esc(a.slug)}">${esc(a.tenant)} / ${esc(a.name)}</option>`)
    .join("");
  $("#view-studio").innerHTML = `
    <div class="split">
      <div class="card">
        <h3>Raise an enhancement</h3>
        <p class="hint">Describe the problem in plain words — the local drafting engine structures the rest. Nothing leaves this process.</p>
        <label>Target</label>
        <select id="s-app" style="width:auto;min-width:260px"><option value="">— general / unscoped —</option>${appOptions}</select>
        <label>The request (free text)</label>
        <textarea id="s-raw" placeholder="We need to be able to export the monthly capacity view so managers can share it with delivery leads..."></textarea>
        <div class="row" style="margin-top:10px">
          <button class="act primary" id="s-draft">⚡ Draft it</button>
          <button class="act" id="s-suggest">✨ Suggest fields</button>
        </div>
        <label>Title</label><input type="text" id="s-title" />
        <label>Brief</label><textarea id="s-brief"></textarea>
        <label>Requirements</label><textarea id="s-requirements"></textarea>
        <label>Impacts</label><textarea id="s-impacts"></textarea>
        <label>Expected outcome</label><textarea id="s-expectedOutcome"></textarea>
        <label>Success criteria</label><textarea id="s-successCriteria"></textarea>
        <label>Impacted sections (IDs, free text)</label><input type="text" id="s-sections" />
        <div class="row" style="margin-top:14px">
          <button class="act primary" id="s-save">Submit request</button>
          <span class="hint" id="s-note"></span>
        </div>
      </div>
      <div class="card">
        <h3>Handover preview</h3>
        <p class="hint">What will be published to the target repository when this request reaches Building.</p>
        <pre id="s-preview">— run “Draft it” to see the handover —</pre>
      </div>
    </div>`;

  $("#s-draft").onclick = async () => {
    const raw = $("#s-raw").value.trim();
    if (raw.length < 12) return toast("Write at least a sentence first.", true);
    try {
      const target = $("#s-app").value.split("|")[1];
      const { draft } = await api("/api/v1/draft", { body: JSON.stringify({ raw, applicationName: target }) });
      for (const [key, value] of Object.entries(draft)) if ($("#s-" + key)) $("#s-" + key).value = value;
      $("#s-preview").textContent = (await api("/api/v1/preview-handover", { body: JSON.stringify({ raw, ...collect() }) })).markdown;
      $("#s-note").textContent = `Drafted by: ${draft.provider}`;
    } catch (e) { toast(e.message, true); }
  };
  $("#s-suggest").onclick = async () => {
    const raw = $("#s-raw").value.trim();
    if (raw.length < 12) return toast("Write at least a sentence first.", true);
    try {
      const { suggestions } = await api("/api/v1/suggest", { body: JSON.stringify({ raw, ...collect() }) });
      const pick = {};
      for (const [field, options] of Object.entries(suggestions)) {
        if (!Array.isArray(options) || !options.length) continue;
        if (options.length === 1) { pick[field] = options[0]; continue; }
        pick[field] = options[0];
        console.info(`[hub] ${field} options:`, options);
      }
      for (const [key, value] of Object.entries(pick)) if ($("#s-" + key)) $("#s-" + key).value = value;
      $("#s-note").textContent = `Applied first suggestion per field — alternatives logged to the console (provider: ${suggestions.provider}).`;
    } catch (e) { toast(e.message, true); }
  };
  $("#s-save").onclick = async () => {
    const [tenant, application] = $("#s-app").value.split("|");
    try {
      const res = await api("/api/v1/enhancements", {
        body: JSON.stringify({ tenantSlug: tenant || undefined, applicationSlug: application || undefined, ...collect() }),
      });
      toast(`Created ${res.enhancement.ref} → ${res.vault.relativePath}`);
      document.querySelector('#tabs button[data-tab="pipeline"]').click();
    } catch (e) { toast(e.message, true); }
  };
}

function collect() {
  return Object.fromEntries(
    ["title", "brief", "requirements", "impacts", "expectedOutcome", "successCriteria", "sections"].map((k) => [k, $("#s-" + k)?.value.trim() || undefined])
  );
}

/* ---------------- Registry ---------------- */

function renderRegistry() {
  $("#view-registry").innerHTML = `
    <div class="split">
      <div>
        <div class="card" style="margin-bottom:14px">
          <h3>Connect an application</h3>
          <p class="hint">One row per project/product. The GitHub token itself stays in the server environment — register only its variable name.</p>
          <div class="grid" style="grid-template-columns:1fr 1fr">
            <div><label>Tenant slug</label><input type="text" id="r-tenant" placeholder="acme" /></div>
            <div><label>Application slug</label><input type="text" id="r-slug" placeholder="portal" /></div>
            <div><label>Display name</label><input type="text" id="r-name" placeholder="Acme Portal" /></div>
            <div><label>GitHub repo (owner/name — optional)</label><input type="text" id="r-repo" placeholder="acme/portal" /></div>
            <div><label>Branch</label><input type="text" id="r-branch" placeholder="main" /></div>
            <div><label>Handover dir in repo</label><input type="text" id="r-dir" placeholder="future-enhancements" /></div>
            <div style="grid-column:1/-1"><label>Token env var NAME (e.g. ACME_PORTAL_TOKEN)</label><input type="text" id="r-token" placeholder="GITHUB_TOKEN" /></div>
          </div>
          <div class="row" style="margin-top:12px"><button class="act primary" id="r-add">Register</button></div>
        </div>
      </div>
      <div>
        ${state.applications.map((a) => `
          <div class="card" style="margin-bottom:12px">
            <div class="row">
              <h3 style="margin:0">${esc(a.name)}</h3>
              <span class="pill ${a.connector.tokenPresent ? "Built" : ""}">${a.connector.tokenPresent ? "token ✓" : "no token"}</span>
              <span class="spacer" style="flex:1"></span>
              ${a.connector.repo ? `<button class="act" data-test="${esc(a.id)}">Test</button>` : `<span class="hint">local vault only</span>`}
            </div>
            <div class="muted" style="margin-top:6px">
              <code>${esc(a.tenant)}/${esc(a.slug)}</code> → ${a.connector.repo ? `<code>${esc(a.connector.repo)}</code>@${esc(a.connector.branch)}` : "<i>no repository</i>"} · handovers in <code>${esc(a.connector.handoverDir)}/</code>
              ${a.connector.tokenEnv ? ` · token env <code>${esc(a.connector.tokenEnv)}</code>` : ""}
            </div>
          </div>`).join("") || `<div class="card"><p class="hint">No applications registered yet — add the first one on the left.</p></div>`}
      </div>
    </div>`;

  $("#r-add").onclick = async () => {
    try {
      await api("/api/v1/applications", {
        method: "POST",
        body: JSON.stringify({
          tenantSlug: $("#r-tenant").value.trim() || "default",
          slug: $("#r-slug").value.trim(),
          name: $("#r-name").value.trim() || $("#r-slug").value.trim(),
          githubRepo: $("#r-repo").value.trim() || null,
          githubBranch: $("#r-branch").value.trim() || undefined,
          handoverDir: $("#r-dir").value.trim() || undefined,
          tokenEnv: $("#r-token").value.trim() || null,
        }),
      });
      toast("Application registered");
      refresh();
    } catch (e) { toast(e.message, true); }
  };
  for (const btn of document.querySelectorAll("[data-test]")) {
    btn.onclick = async () => {
      try {
        const res = await api(`/api/v1/applications/${btn.dataset.test}/test`, { method: "POST" });
        toast(res.connector.ok ? `✓ ${res.connector.detail}` : `✗ ${res.connector.detail}`, !res.connector.ok);
      } catch (e) { toast(e.message, true); }
    };
  }
}

/* ---------------- Vault ---------------- */

function renderVault() {
  $("#view-vault").innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <h3 style="margin:0">Handover vault</h3><span class="spacer" style="flex:1"></span>
        <button class="act" id="v-sync">Reconcile now</button>
      </div>
      <table><thead><tr><th>Document</th><th>Ref</th><th>Status</th><th>Title</th></tr></thead>
      <tbody>
        ${state.docs.map((d) => `<tr><td><code>${esc(d.relativePath)}</code></td><td>${esc(d.ref || "—")}</td>
          <td><span class="pill ${esc(d.status)}">${esc(d.status)}</span></td><td>${esc(d.title || "—")}</td></tr>`).join("") || `<tr><td colspan="4" class="hint">No handover documents yet. Move a request to Building to publish one.</td></tr>`}
      </tbody></table>
    </div>`;
  $("#v-sync").onclick = async () => {
    try {
      const res = await api("/api/v1/sync", { method: "POST", body: "{}" });
      toast(`Scanned ${res.scanned.active + res.scanned.archived} document(s), ${res.changes.length} change(s)`);
      refresh();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- Audit ---------------- */

function renderAudit() {
  $("#view-audit").innerHTML = `
    <div class="card">
      <h3>Audit trail</h3>
      <table><thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${state.events.map((ev) => `<tr>
        <td style="white-space:nowrap">${esc((ev.at || "").replace("T", " ").slice(0, 19))}</td>
        <td>${esc(ev.actor || "—")}</td>
        <td><code>${esc(ev.action)}</code></td>
        <td class="muted">${esc(summarise(ev))}</td></tr>`).join("") || `<tr><td colspan="4" class="hint">Nothing yet.</td></tr>`}
      </tbody></table>
    </div>`;
}

function summarise(ev) {
  try {
    const after = ev.after_json ? JSON.parse(ev.after_json) : null;
    const before = ev.before_json ? JSON.parse(ev.before_json) : null;
    if (ev.action === "enhancement.status") return `${before ?? "?"} → ${after ?? "?"}`;
    if (after?.title || after?.ref) return `${after.ref ? after.ref + " " : ""}${after.title ?? ""}`;
    if (ev.meta) return ev.meta;
    return ev.entity_id ?? "";
  } catch { return ""; }
}

refresh();
