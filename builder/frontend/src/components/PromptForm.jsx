import { useEffect, useState } from "react";

const PLACEHOLDER_ROTATION = [
  "A clean SaaS UI to generate AI images from text prompts…",
  "An InfoBot that lets me upload PDFs and ask questions about them…",
  "A meme generator with caption editing…",
  "A color palette explorer with named swatches…",
];

const SUGGESTIONS = [
  "Generate AI images from text",
  "Chat with PDFs and Word docs (InfoBot)",
  "Build a meme generator",
  "Color palette tool",
];

export default function PromptForm({ onSubmit, disabled }) {
  const [prompt, setPrompt] = useState("");
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setInterval(
      () => setPlaceholderIdx((i) => (i + 1) % PLACEHOLDER_ROTATION.length),
      4500
    );
    return () => clearInterval(t);
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Type what you'd like to build first.");
      return;
    }
    setError("");
    onSubmit({ prompt: trimmed });
  }

  return (
    <div className="ta-landing">
      <div className="ta-landing-inner">
        <span className="ta-eyebrow">
          <span className="ta-brand-dot" aria-hidden /> Built natively on
          DigitalOcean
        </span>
        <h1 className="ta-headline">What will you ship today?</h1>
        <p className="ta-subhead">
          Describe your app in a single sentence. tideAI maps it to DigitalOcean
          artifacts, shows you the cost, and deploys when you approve.
        </p>

        <form className="ta-prompt-shell" onSubmit={handleSubmit}>
          <textarea
            className="ta-prompt-textarea"
            placeholder={PLACEHOLDER_ROTATION[placeholderIdx]}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={disabled}
            aria-label="Describe the app you want to build"
            rows={3}
          />
          <div className="ta-prompt-actions">
            <span className="ta-prompt-hint">
              You'll see the architecture & monthly cost before anything deploys.
            </span>
            <button
              type="submit"
              className="ta-button ta-button-primary"
              disabled={disabled || !prompt.trim()}
            >
              {disabled ? "Starting…" : "Build with DigitalOcean →"}
            </button>
          </div>
        </form>

        {error ? <div className="ta-error">{error}</div> : null}

        <div className="ta-suggestions" aria-label="Suggested prompts">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="ta-chip"
              onClick={() => setPrompt(s)}
              disabled={disabled}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
