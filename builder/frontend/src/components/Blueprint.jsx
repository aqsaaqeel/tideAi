/**
 * Pre-deploy "Transparency Gate". The user sees the architecture (DigitalOcean
 * artifacts that will be provisioned) and the monthly cost, then approves or
 * cancels. Nothing has been provisioned yet at this point — the build is parked
 * server-side at `awaiting_approval`.
 */

const SERVICE_PRESENTATION = {
  "serverless inference": {
    icon: "🧠",
    role: "LLM + image inference (DigitalOcean Gradient AI)",
  },
  "knowledge bases": {
    icon: "📚",
    role: "Indexed vector retrieval for RAG document Q&A",
  },
  spaces: {
    icon: "🗂️",
    role: "Object storage for raw PDF / Word uploads",
  },
  "managed database": {
    icon: "🛢️",
    role: "Managed Postgres / MySQL",
  },
};

const IMPLIED_ARTIFACTS = [
  {
    name: "App Platform",
    icon: "🚀",
    role: "Hosts the deployed app (basic-xxs container)",
  },
  {
    name: "Container Registry",
    icon: "📦",
    role: "Stores the built image (Starter tier)",
  },
];

function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return "Free";
  if (n < 0.01) return "<$0.01/mo";
  return `$${n.toFixed(2)}/mo`;
}

function describeArtifacts(do_services) {
  const out = [];
  const seen = new Set();
  for (const s of do_services || []) {
    const key = String(s).toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const pres =
      SERVICE_PRESENTATION[key] ||
      SERVICE_PRESENTATION[
        Object.keys(SERVICE_PRESENTATION).find((k) => key.includes(k)) || ""
      ];
    out.push({
      name: s,
      icon: pres?.icon || "🔧",
      role: pres?.role || "Used by the generated app",
    });
  }
  for (const a of IMPLIED_ARTIFACTS) {
    out.push(a);
  }
  return out;
}

export default function Blueprint({
  buildState,
  onApprove,
  onCancel,
  busy,
}) {
  const status = buildState?.status || "inferring";
  const spec = buildState?.app_spec;
  const ready = status === "awaiting_approval" && spec && spec.cost_estimate;

  if (!ready) {
    return (
      <div className="ta-blueprint">
        <div className="ta-blueprint-inner">
          <div className="ta-section-label">Planning your app</div>
          <h2 className="ta-blueprint-title">
            {status === "inferring"
              ? "Understanding your prompt…"
              : "Generating the architecture…"}
          </h2>
          <p className="ta-blueprint-desc">
            tideAI is sketching the DigitalOcean blueprint. This usually takes
            10–20 seconds.
          </p>
          <div className="ta-card" style={{ display: "grid", gap: "0.85rem" }}>
            <div className="ta-skeleton" style={{ width: "60%" }} />
            <div className="ta-skeleton" style={{ width: "85%" }} />
            <div className="ta-skeleton" style={{ width: "40%" }} />
            <div className="ta-skeleton" style={{ width: "70%" }} />
          </div>
        </div>
      </div>
    );
  }

  const artifacts = describeArtifacts(spec.do_services);
  const lines = spec.cost_estimate.lines || [];
  const total = Number(spec.cost_estimate.total_usd_monthly) || 0;

  return (
    <div className="ta-blueprint">
      <div className="ta-blueprint-inner">
        <div className="ta-section-label">Plan & Price</div>
        <h2 className="ta-blueprint-title">{spec.app_name || "Your app"}</h2>
        <p className="ta-blueprint-desc">
          {spec.description || "Review the proposed architecture and monthly cost."}
        </p>

        <div className="ta-blueprint-grid">
          <div className="ta-card">
            <div className="ta-section-label">Architecture</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {artifacts.map((a) => (
                <div key={a.name} className="ta-arch-item">
                  <div className="ta-arch-icon" aria-hidden>
                    {a.icon}
                  </div>
                  <div>
                    <div className="ta-arch-name">{a.name}</div>
                    <div className="ta-arch-role">{a.role}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="ta-card">
            <div className="ta-section-label">Estimated monthly cost</div>
            <div>
              {lines.map((line) => (
                <div key={line.key || line.label} className="ta-cost-line">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="ta-cost-line-label">{line.label}</div>
                    <div className="ta-cost-line-detail">{line.usage}</div>
                  </div>
                  <div
                    className={
                      "ta-cost-line-amount" +
                      (line.monthlyUsd > 0 ? "" : " free")
                    }
                  >
                    {fmtUsd(line.monthlyUsd)}
                  </div>
                </div>
              ))}
            </div>
            <div className="ta-cost-total">
              <span className="ta-cost-total-label">Estimated total</span>
              <span className="ta-cost-total-value">
                ~${total.toFixed(2)} / month
              </span>
            </div>
            <p className="ta-blueprint-disclaimer">
              Numbers assume small hobby usage. Verify on{" "}
              <a
                href="https://www.digitalocean.com/pricing"
                target="_blank"
                rel="noreferrer"
              >
                DigitalOcean pricing
              </a>{" "}
              before going to production.
            </p>
          </div>
        </div>

        <div className="ta-blueprint-footer">
          <button
            type="button"
            className="ta-button ta-button-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ta-button ta-button-primary"
            onClick={onApprove}
            disabled={busy}
          >
            {busy ? "Starting deploy…" : "Approve and deploy →"}
          </button>
        </div>
      </div>
    </div>
  );
}
