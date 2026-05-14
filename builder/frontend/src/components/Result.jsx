import { useEffect, useRef, useState } from "react";

/**
 * Two-column layout:
 *   - Left: iframe of the generated app. Starts on `preview_url`, swaps to `live_do_url`
 *     when the DigitalOcean App Platform deploy completes.
 *   - Right: app name, current URL with copy, services list, cost summary, reset.
 *
 * Terminal states surfaced here:
 *   - `live`          — DO deploy done, swap happens, "Now on DigitalOcean" banner.
 *   - `preview_only`  — DO deploy failed, preview still works, warning banner.
 *   - `failed`        — codegen/Vite build failed; iframe shows error instead.
 */
function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return "Free";
  if (n < 0.01) return "<$0.01/mo";
  return `$${n.toFixed(2)}/mo`;
}

export default function Result({ buildState, onReset }) {
  const status = buildState?.status;
  const previewUrl = buildState?.preview_url || null;
  const liveDoUrl = buildState?.live_do_url || null;
  const doError = buildState?.do_deploy_error || null;
  const spec = buildState?.app_spec || null;
  const services = spec?.do_services || [];
  const lines = spec?.cost_estimate?.lines || [];
  const total = Number(spec?.cost_estimate?.total_usd_monthly) || 0;

  const iframeSrc = liveDoUrl || previewUrl || null;
  const currentUrl = iframeSrc;
  const onLiveDo = Boolean(liveDoUrl);

  const [copied, setCopied] = useState(false);
  /**
   * Iframe-load retry. App Platform sometimes serves the live URL a few seconds
   * before DNS propagates to the user's browser. Even with backend reachability
   * verification, an iframe `src` change can race the user's local resolver
   * cache. We probe the URL via no-cors fetch; if the network fails (DNS /
   * connection) we re-key the iframe to force a fresh load every ~5s, up to
   * 2 minutes. A no-cors fetch resolves even for opaque responses — only
   * actual network failures reject, which is exactly what we want to detect.
   */
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeStatus, setIframeStatus] = useState("idle");
  const retryTimerRef = useRef(null);
  const retryCountRef = useRef(0);
  useEffect(() => {
    if (!iframeSrc) {
      setIframeStatus("idle");
      return;
    }
    setIframeStatus("checking");
    retryCountRef.current = 0;
    let cancelled = false;
    const MAX_RETRIES = 24;
    const probe = async () => {
      if (cancelled) return;
      try {
        await fetch(iframeSrc, { method: "GET", mode: "no-cors", cache: "no-store" });
        if (!cancelled) setIframeStatus("ready");
      } catch {
        if (cancelled) return;
        if (retryCountRef.current >= MAX_RETRIES) {
          setIframeStatus("unreachable");
          return;
        }
        retryCountRef.current += 1;
        setIframeStatus("retrying");
        setIframeKey((k) => k + 1);
        retryTimerRef.current = setTimeout(probe, 5000);
      }
    };
    probe();
    return () => {
      cancelled = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [iframeSrc]);

  async function handleCopy() {
    if (!currentUrl) return;
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable on http origins */
    }
  }

  if (status === "failed") {
    return (
      <div className="ta-progress">
        <div className="ta-progress-inner">
          <div className="ta-section-label" style={{ color: "var(--error)" }}>
            Build failed
          </div>
          <h2 className="ta-progress-title">Something went wrong</h2>
          <p className="ta-progress-subtitle">
            {buildState?.error || "An unknown error happened during the build."}
          </p>
          <button type="button" className="ta-button ta-button-primary" onClick={onReset}>
            Try a new prompt
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ta-result">
      <div className="ta-iframe-pane">
        <div
          className={"ta-iframe-overlay" + (onLiveDo ? " live-do" : "")}
          aria-live="polite"
        >
          {onLiveDo ? (
            <>
              <span aria-hidden>🌊</span> Now live on DigitalOcean
            </>
          ) : (
            <>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: "var(--success)",
                  boxShadow: "0 0 12px var(--success)",
                }}
              />
              Live preview · DigitalOcean deploy in progress
            </>
          )}
        </div>
        {iframeSrc ? (
          <>
            <iframe
              key={iframeKey}
              className="ta-iframe"
              src={iframeSrc}
              title="Live preview of the generated app"
            />
            {iframeStatus === "checking" || iframeStatus === "retrying" ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                  background: "rgba(255, 255, 255, 0.92)",
                  color: "#0c1322",
                  fontSize: "0.95rem",
                  pointerEvents: "none",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    border: "3px solid rgba(0, 105, 255, 0.18)",
                    borderTopColor: "var(--accent)",
                    animation: "ta-spin 0.9s linear infinite",
                  }}
                />
                {iframeStatus === "checking"
                  ? "Connecting to your app…"
                  : `Still connecting · retry ${retryCountRef.current}/24`}
              </div>
            ) : null}
            {iframeStatus === "unreachable" ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                  background: "rgba(255, 255, 255, 0.95)",
                  color: "#0c1322",
                  fontSize: "0.95rem",
                  padding: "1rem",
                  textAlign: "center",
                }}
              >
                <div style={{ fontWeight: 600 }}>App not reachable yet</div>
                <div style={{ fontSize: "0.85rem", maxWidth: 360, lineHeight: 1.45 }}>
                  DNS may still be propagating on your network. Try
                  {" "}
                  <a href={iframeSrc} target="_blank" rel="noreferrer" style={{ pointerEvents: "auto" }}>
                    opening the URL directly
                  </a>{" "}
                  in a new tab, or wait a minute and reload.
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--fg-faint)",
            }}
          >
            Preview is preparing…
          </div>
        )}
      </div>

      <aside className="ta-sidebar">
        <div className="ta-sidebar-section">
          <span className="ta-section-label">App</span>
          <div style={{ fontSize: "1.15rem", fontWeight: 700 }}>
            {spec?.app_name || "Your app"}
          </div>
          {spec?.description ? (
            <div style={{ color: "var(--fg-muted)", fontSize: "0.88rem" }}>
              {spec.description}
            </div>
          ) : null}
        </div>

        <div className="ta-sidebar-section">
          <span className="ta-section-label">
            {onLiveDo ? "Public URL" : "Preview URL"}
          </span>
          <div className="ta-url-row">
            <span className="ta-url-text" title={currentUrl || ""}>
              {currentUrl || "—"}
            </span>
            <button
              type="button"
              className="ta-icon-button"
              onClick={handleCopy}
              disabled={!currentUrl}
              title="Copy URL"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              href={currentUrl || "#"}
              target="_blank"
              rel="noreferrer"
              className="ta-icon-button"
              style={{ textDecoration: "none" }}
              aria-disabled={!currentUrl}
            >
              Open
            </a>
          </div>
          {!onLiveDo && status === "preview_only" ? (
            <div className="ta-warning-banner">
              <strong>DigitalOcean deploy failed.</strong> The local preview is
              still working — you can keep iterating.
              {doError ? (
                <div style={{ marginTop: 4, fontSize: "0.78rem", opacity: 0.85 }}>
                  {doError}
                </div>
              ) : null}
            </div>
          ) : null}
          {!onLiveDo && status !== "preview_only" ? (
            <div
              style={{
                fontSize: "0.78rem",
                color: "var(--fg-faint)",
              }}
            >
              tideAI is pushing this build to DigitalOcean App Platform in the
              background. The iframe will switch to the public URL when ready.
            </div>
          ) : null}
        </div>

        <div className="ta-sidebar-section">
          <span className="ta-section-label">DigitalOcean services</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {services.map((s) => (
              <span
                key={s}
                className="ta-chip"
                style={{ cursor: "default" }}
              >
                {s}
              </span>
            ))}
            {services.length === 0 ? (
              <span style={{ color: "var(--fg-faint)", fontSize: "0.85rem" }}>
                None requested
              </span>
            ) : null}
          </div>
        </div>

        <div className="ta-sidebar-section">
          <span className="ta-section-label">Cost summary</span>
          <div>
            {lines.map((line) => (
              <div
                key={line.key || line.label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.85rem",
                  padding: "0.3rem 0",
                }}
              >
                <span style={{ color: "var(--fg-muted)" }}>{line.label}</span>
                <span
                  style={{
                    color: line.monthlyUsd > 0 ? "var(--fg)" : "var(--success)",
                    fontWeight: 500,
                  }}
                >
                  {fmtUsd(line.monthlyUsd)}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: "0.5rem",
              paddingTop: "0.5rem",
              borderTop: "1px solid var(--border)",
              fontWeight: 600,
            }}
          >
            <span style={{ color: "var(--fg-muted)" }}>Estimated total</span>
            <span>${total.toFixed(2)}/mo</span>
          </div>
        </div>

        <div style={{ marginTop: "auto" }}>
          <button
            type="button"
            className="ta-button ta-button-ghost"
            onClick={onReset}
            style={{ width: "100%" }}
          >
            New app
          </button>
        </div>
      </aside>
    </div>
  );
}
