export default function Result({ buildState, onReset }) {
  const failed = buildState?.status === "failed";

  if (failed) {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "2rem 1.25rem" }}>
        <h2 style={{ margin: "0 0 0.75rem" }}>Something went wrong</h2>
        <p style={{ margin: "0 0 1.25rem", opacity: 0.85, whiteSpace: "pre-wrap" }}>
          {buildState?.error || "Unknown error"}
        </p>
        <button
          type="button"
          onClick={onReset}
          style={{
            padding: "0.65rem 1rem",
            borderRadius: 8,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const url = buildState?.url;
  const repo = buildState?.repo;
  const mode = buildState?.deploy_mode;
  const isGithub = mode === "github";
  const isLocal = mode === "local";

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h2 style={{ margin: "0 0 1rem", fontSize: "1.6rem", color: "#3ecf8e" }}>
        {isLocal ? "Local preview ready" : "Your app is live"}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              textAlign: "center",
              padding: "0.85rem 1rem",
              borderRadius: 8,
              background: "#0069ff",
              color: "#fff",
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            {isLocal ? "Open the preview →" : "Open your app →"}
          </a>
        ) : null}
        {repo && !isLocal ? (
          <a
            href={repo}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              textAlign: "center",
              padding: "0.65rem 1rem",
              borderRadius: 8,
              border: "1px solid #333",
              color: "#fff",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            {isGithub ? "View source on GitHub →" : "View image in Container Registry →"}
          </a>
        ) : null}
      </div>
      <p style={{ margin: "1.25rem 0 0", fontSize: "0.85rem", opacity: 0.65 }}>
        {isLocal
          ? "Served from this machine. The preview lives until you stop the tideAI server."
          : "Deployed on DigitalOcean App Platform"}
      </p>
    </div>
  );
}
