const STEPS_DOCR = [
  "Understanding your prompt",
  "Generating code",
  "Building static site",
  "Pushing to DOCR",
  "Deploying to DigitalOcean",
  "Going live...",
];

const STEPS_GITHUB = [
  "Understanding your prompt",
  "Generating code",
  "Creating GitHub repo",
  "Pushing files",
  "Deploying to DigitalOcean",
  "Going live...",
];

const STEPS_LOCAL = [
  "Understanding your prompt",
  "Generating code",
  "Building static site",
  "Going live...",
];

function statusIcon(status) {
  if (status === "done") {
    return (
      <span style={{ color: "#3ecf8e", fontSize: "1.1rem", width: 22, textAlign: "center" }} aria-hidden>
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span style={{ color: "#ff6b6b", fontSize: "1.1rem", width: 22, textAlign: "center" }} aria-hidden>
        ✕
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        style={{
          width: 18,
          height: 18,
          border: "2px solid #444",
          borderTopColor: "#0069ff",
          borderRadius: "50%",
          display: "inline-block",
          animation: "spin 0.8s linear infinite",
        }}
        aria-label="In progress"
      />
    );
  }
  return (
    <span style={{ width: 22, display: "inline-block", opacity: 0.35 }} aria-hidden>
      ○
    </span>
  );
}

function mergeSteps(incoming, stepOrder) {
  const map = new Map();
  for (const s of incoming || []) {
    if (s && s.step) map.set(s.step, s);
  }
  return stepOrder.map((name) => {
    const hit = map.get(name);
    return {
      step: name,
      status: hit?.status || "pending",
      detail: hit?.detail || "",
    };
  });
}

export default function BuildProgress({ buildState }) {
  const mode =
    buildState?.deploy_mode === "github"
      ? "github"
      : buildState?.deploy_mode === "local"
      ? "local"
      : "docr";
  const stepOrder =
    mode === "github" ? STEPS_GITHUB : mode === "local" ? STEPS_LOCAL : STEPS_DOCR;
  const steps = mergeSteps(buildState?.steps, stepOrder);

  return (
    <div
      style={{
        maxWidth: 520,
        margin: "0 auto",
        padding: "2rem 1.25rem",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <h2 style={{ margin: "0 0 1rem", fontSize: "1.35rem" }}>Building…</h2>
      <p style={{ margin: "0 0 1.5rem", opacity: 0.8, fontSize: "0.95rem" }}>
        {mode === "github"
          ? "Sit tight — this uses your DigitalOcean and GitHub accounts."
          : mode === "local"
          ? "Sit tight — generating code and serving it from this machine."
          : "Sit tight — this uses your DigitalOcean account (Container Registry + App Platform)."}
      </p>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {steps.map((s) => (
          <li
            key={s.step}
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "flex-start",
              padding: "0.65rem 0.75rem",
              borderRadius: 8,
              background: "#111",
              border: "1px solid #1c1c1c",
            }}
          >
            <div style={{ marginTop: 2 }}>{statusIcon(s.status)}</div>
            <div>
              <div style={{ fontWeight: 600 }}>{s.step}</div>
              {s.detail ? (
                <div style={{ fontSize: "0.85rem", opacity: 0.75, marginTop: "0.2rem" }}>
                  {s.detail}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
