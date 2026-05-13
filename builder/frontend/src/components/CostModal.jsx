/**
 * Estimates only — DigitalOcean publishes the source of truth at:
 *   https://www.digitalocean.com/pricing/app-platform
 *   https://www.digitalocean.com/pricing/container-registry
 *   https://docs.digitalocean.com/products/inference/details/pricing/
 *   https://www.digitalocean.com/pricing/genai-platform
 *
 * `monthlyUsd` per line is computed against a fixed "small hobby app" usage profile
 * (declared in `USAGE_PROFILE`) so the modal can show a single $/month total instead
 * of leaving the user to do the math on per-token pricing.
 */
const USAGE_PROFILE = {
  chats: 1000,
  tokensPerChat: 1500,
  images: 200,
  kbStorageGb: 0.1,
  kbRetrievals: 1000,
};

const RATE = {
  chatPerMillionTokens: 0.65,
  imagePerInvocation: 0.0035,
  kbStoragePerGbMonth: 0.1,
  kbRetrievalPer1k: 0.4,
  appPlatformBasicXxs: 5,
};

function chatMonthly() {
  const millions =
    (USAGE_PROFILE.chats * USAGE_PROFILE.tokensPerChat) / 1_000_000;
  return millions * RATE.chatPerMillionTokens;
}

function imageMonthly() {
  return USAGE_PROFILE.images * RATE.imagePerInvocation;
}

function kbMonthly() {
  return (
    USAGE_PROFILE.kbStorageGb * RATE.kbStoragePerGbMonth +
    (USAGE_PROFILE.kbRetrievals / 1000) * RATE.kbRetrievalPer1k
  );
}

const COST_LINES = {
  inference_chat: {
    label: "Serverless Inference — chat",
    detail: "llama3.3-70b-instruct, ~$0.65 per 1M tokens (input + output)",
    usage: `~${USAGE_PROFILE.chats.toLocaleString()} chats/mo × ~${USAGE_PROFILE.tokensPerChat.toLocaleString()} tokens each`,
    monthlyUsd: chatMonthly(),
  },
  inference_image: {
    label: "Serverless Inference — image",
    detail: "fal-ai/fast-sdxl via async-invoke, ~$0.0035 per image",
    usage: `~${USAGE_PROFILE.images.toLocaleString()} images / month`,
    monthlyUsd: imageMonthly(),
  },
  knowledge_base: {
    label: "Knowledge Bases + Gen-AI",
    detail: "~$0.10/GB-month storage + per-1k retrievals + embeddings per token",
    usage: `~${USAGE_PROFILE.kbStorageGb * 1024} MB stored, ~${USAGE_PROFILE.kbRetrievals.toLocaleString()} retrievals / month`,
    monthlyUsd: kbMonthly(),
  },
  app_platform_static: {
    label: "App Platform — static site",
    detail: "Static sites tier (build + global edge serving)",
    usage: "First 3 static sites + 1 GiB egress are free",
    monthlyUsd: 0,
  },
  app_platform_basic: {
    label: "App Platform — web service (basic-xxs)",
    detail: "1 instance × basic-xxs container, 24/7",
    usage: "Fixed monthly per instance",
    monthlyUsd: RATE.appPlatformBasicXxs,
  },
  container_registry_starter: {
    label: "Container Registry — Starter",
    detail: "1 repository, 500 MB storage, 5 GB monthly transfer",
    usage: "Within Starter free tier",
    monthlyUsd: 0,
  },
};

/**
 * Lines that apply for this build's mode + parsed services.
 * @param {{ deploy_mode?: string, app_spec?: { do_services?: string[], app_name?: string, description?: string } | null }} buildState
 */
function buildCostLines(buildState) {
  const mode = buildState?.deploy_mode || "docr";
  const services = (buildState?.app_spec?.do_services || []).map((s) =>
    String(s).toLowerCase()
  );
  const usesKb = services.some((s) => s.includes("knowledge"));
  const usesImage = /image|fal|sdxl|stable[-\s]?diffusion/.test(
    `${buildState?.app_spec?.app_name || ""} ${
      buildState?.app_spec?.description || ""
    }`.toLowerCase()
  );

  const lines = [COST_LINES.inference_chat];
  if (usesImage) lines.push(COST_LINES.inference_image);
  if (usesKb) lines.push(COST_LINES.knowledge_base);

  if (mode === "github") {
    lines.push(COST_LINES.app_platform_static);
  } else if (mode === "docr") {
    lines.push(COST_LINES.container_registry_starter);
    lines.push(COST_LINES.app_platform_basic);
  }
  return lines;
}

function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function sumMonthly(lines) {
  return lines.reduce(
    (acc, l) => acc + (Number.isFinite(l.monthlyUsd) ? l.monthlyUsd : 0),
    0
  );
}

export default function CostModal({
  buildState,
  onClose,
  onDeploy,
  busy,
}) {
  const mode = buildState?.deploy_mode || "docr";
  const isLocal = mode === "local";
  const isGithub = mode === "github";
  const lines = buildCostLines(buildState);
  const total = sumMonthly(lines);

  /** What the bill would look like if a local preview gets pushed to DOCR + App Platform. */
  const deployedLines = isLocal
    ? buildCostLines({ ...buildState, deploy_mode: "docr" })
    : null;
  const deployedTotal = deployedLines ? sumMonthly(deployedLines) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 600,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "#0d0d0d",
          border: "1px solid #2a2a2a",
          borderRadius: 12,
          padding: "1.25rem 1.25rem 1rem",
          color: "#fff",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            marginBottom: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "1.15rem" }}>
            Estimated DigitalOcean cost
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: "#aaa",
              fontSize: "1.25rem",
              cursor: "pointer",
              lineHeight: 1,
              padding: "0 0.25rem",
            }}
          >
            ×
          </button>
        </div>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", opacity: 0.85 }}>
          Numbers below assume <strong>small hobby usage</strong>:{" "}
          ~{USAGE_PROFILE.chats.toLocaleString()} chats/mo,{" "}
          ~{USAGE_PROFILE.images.toLocaleString()} images/mo,{" "}
          ~{USAGE_PROFILE.kbStorageGb * 1024} MB stored in any Knowledge Base.
        </p>
        <p style={{ margin: "0 0 1rem", fontSize: "0.78rem", opacity: 0.65 }}>
          Verify on{" "}
          <a
            href="https://www.digitalocean.com/pricing"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#5aa8ff" }}
          >
            DigitalOcean pricing
          </a>{" "}
          before going to production.
        </p>

        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {lines.map((line) => (
            <li
              key={line.label}
              style={{
                padding: "0.65rem 0.75rem",
                borderRadius: 8,
                border: "1px solid #1c1c1c",
                background: "#111",
                display: "flex",
                gap: "0.75rem",
                alignItems: "flex-start",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>
                  {line.label}
                </div>
                <div style={{ fontSize: "0.8rem", opacity: 0.8, marginTop: 2 }}>
                  {line.detail}
                </div>
                <div
                  style={{
                    fontSize: "0.78rem",
                    opacity: 0.7,
                    marginTop: 4,
                    fontStyle: "italic",
                  }}
                >
                  {line.usage}
                </div>
              </div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "0.95rem",
                  whiteSpace: "nowrap",
                  color: line.monthlyUsd > 0 ? "#fff" : "#3ecf8e",
                }}
              >
                {line.monthlyUsd > 0 ? `${fmtUsd(line.monthlyUsd)} /mo` : "Free"}
              </div>
            </li>
          ))}
        </ul>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginTop: "0.85rem",
            padding: "0.75rem 0.75rem",
            borderRadius: 8,
            background: "#0a1f12",
            border: "1px solid #1c4a2a",
          }}
        >
          <span style={{ fontWeight: 700, color: "#3ecf8e" }}>
            Estimated total
          </span>
          <span
            style={{ fontWeight: 800, color: "#3ecf8e", fontSize: "1.1rem" }}
          >
            ~{fmtUsd(total)} / month
          </span>
        </div>
        {isLocal && deployedTotal != null ? (
          <p
            style={{
              margin: "0.45rem 0 0",
              fontSize: "0.78rem",
              opacity: 0.75,
            }}
          >
            If you deploy this to DigitalOcean, the estimate becomes{" "}
            <strong>~{fmtUsd(deployedTotal)} / month</strong> (adds App Platform
            basic-xxs at $5/mo, DOCR Starter is free).
          </p>
        ) : null}

        <div
          style={{
            borderTop: "1px solid #1c1c1c",
            paddingTop: "0.85rem",
            marginTop: "1rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>
            Are you ready to deploy this app?
          </p>
          {isLocal ? (
            <p style={{ margin: 0, fontSize: "0.82rem", opacity: 0.8 }}>
              Click <strong>Deploy now</strong> to push the same prompt to
              DigitalOcean Container Registry + App Platform. tideAI reuses the
              token you used for this preview.
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: "0.82rem", opacity: 0.8 }}>
              This app is already live on DigitalOcean
              {isGithub
                ? " (GitHub → App Platform static)."
                : " (DOCR → App Platform)."}
            </p>
          )}
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "0.55rem 0.9rem",
                borderRadius: 8,
                border: "1px solid #333",
                background: "#161616",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Not yet
            </button>
            {isLocal ? (
              <button
                type="button"
                disabled={busy}
                onClick={onDeploy}
                style={{
                  padding: "0.55rem 1rem",
                  borderRadius: 8,
                  border: "none",
                  background: "#0069ff",
                  color: "#fff",
                  fontWeight: 700,
                  cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? "Starting…" : "Deploy now"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
