/**
 * Renders the build pipeline step list during `provisioning → preview_live → deploying`.
 * The state machine in App.jsx leaves this screen as soon as `preview_url` is set —
 * after that the Result split-screen takes over. So this view's job is just to keep
 * the user informed during the ~30–90s while Vite is building.
 */

const STEP_ORDER = [
  "Understanding your prompt",
  "Generating code",
  "Awaiting your approval",
  "Knowledge base setup",
  "Spaces bucket setup",
  "Building static site",
  "Live preview ready",
  "Pushing to DOCR",
  "Deploying to DigitalOcean",
  "Going live on DigitalOcean",
  "Verifying public URL",
];

function statusClass(status) {
  if (status === "done") return "done";
  if (status === "in_progress") return "in_progress";
  if (status === "failed") return "failed";
  return "";
}

function markerSymbol(status) {
  if (status === "done") return "✓";
  if (status === "failed") return "✕";
  return "";
}

export default function BuildProgress({ buildState }) {
  const steps = buildState?.steps || [];
  const byName = new Map(steps.map((s) => [s.step, s]));

  const ordered = STEP_ORDER.map((name) => {
    const found = byName.get(name);
    return found || { step: name, status: "pending", detail: "" };
  });
  /** Include any unexpected steps the backend emitted that we didn't anticipate. */
  for (const s of steps) {
    if (!STEP_ORDER.includes(s.step)) ordered.push(s);
  }

  return (
    <div className="ta-progress">
      <div className="ta-progress-inner">
        <div className="ta-section-label">Deploying</div>
        <h2 className="ta-progress-title">
          {buildState?.app_spec?.app_name || "Your app"} is being built
        </h2>
        <p className="ta-progress-subtitle">
          You'll see a live preview the moment the build finishes — DigitalOcean
          deployment continues in the background.
        </p>

        <ul className="ta-steps">
          {ordered.map((s) => (
            <li
              key={s.step}
              className={"ta-step " + statusClass(s.status)}
            >
              <div className="ta-step-marker" aria-hidden>
                {markerSymbol(s.status)}
              </div>
              <div className="ta-step-body">
                <div className="ta-step-name">{s.step}</div>
                {s.detail ? <div className="ta-step-detail">{s.detail}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
