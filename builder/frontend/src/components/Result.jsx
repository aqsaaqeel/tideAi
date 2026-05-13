import { useState } from "react";
import CostModal from "./CostModal.jsx";

export default function Result({
  buildState,
  onReset,
  onRedeploy,
  redeployBusy,
}) {
  const [showCost, setShowCost] = useState(false);
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

  async function handleDeployClick() {
    if (typeof onRedeploy === "function") {
      await onRedeploy();
    }
    setShowCost(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowCost(true)}
        title="Estimated DigitalOcean cost for this app"
        style={{
          position: "fixed",
          top: 14,
          right: 14,
          padding: "0.45rem 0.85rem",
          borderRadius: 999,
          border: "1px solid #2a2a2a",
          background: "#0d0d0d",
          color: "#fff",
          fontSize: "0.82rem",
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          zIndex: 40,
        }}
      >
        {isLocal ? "Cost & deploy" : "Cost"}
      </button>
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
      {showCost ? (
        <CostModal
          buildState={buildState}
          busy={Boolean(redeployBusy)}
          onClose={() => setShowCost(false)}
          onDeploy={handleDeployClick}
        />
      ) : null}
    </>
  );
}
