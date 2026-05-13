export default function PromptForm({
  onSubmit,
  disabled,
  defaultDoTokenConfigured = false,
}) {
  function handleSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const deploy_mode = String(fd.get("deploy_mode") || "docr");
    onSubmit({
      prompt: String(fd.get("prompt") || "").trim(),
      do_token: String(fd.get("do_token") || "").trim(),
      deploy_mode,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        maxWidth: 520,
        margin: "0 auto",
        padding: "2rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700 }}>
        tideAI
      </h1>
      <p style={{ margin: 0, opacity: 0.85, fontSize: "0.95rem" }}>
        Describe your AI product in one line. We generate the code and either preview it
        on your machine or push a small container image to DigitalOcean Container Registry
        and deploy it on App Platform.
      </p>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
          What do you want to build?
        </span>
        <textarea
          name="prompt"
          required
          rows={4}
          disabled={disabled}
          placeholder="e.g. build me an image generation website"
          style={{
            width: "100%",
            padding: "0.75rem 0.85rem",
            borderRadius: 8,
            border: "1px solid #222",
            background: "#111",
            color: "#fff",
            resize: "vertical",
            minHeight: 120,
          }}
        />
      </label>

      <fieldset
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          border: "1px solid #222",
          borderRadius: 8,
          padding: "0.75rem 0.85rem",
          margin: 0,
        }}
      >
        <legend style={{ fontSize: "0.9rem", fontWeight: 600, padding: "0 0.25rem" }}>
          Where to run it
        </legend>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.9rem" }}>
          <input type="radio" name="deploy_mode" value="local" defaultChecked disabled={disabled} />
          Local preview (just builds and serves it on this machine)
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.9rem" }}>
          <input type="radio" name="deploy_mode" value="docr" disabled={disabled} />
          Deploy to DigitalOcean (Container Registry + App Platform)
        </label>
      </fieldset>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
          DigitalOcean API Token
          {defaultDoTokenConfigured ? (
            <span style={{ fontWeight: 400, opacity: 0.85 }}> (optional)</span>
          ) : null}
        </span>
        <input
          name="do_token"
          type="password"
          required={!defaultDoTokenConfigured}
          autoComplete="off"
          disabled={disabled}
          placeholder={
            defaultDoTokenConfigured
              ? "Leave blank to use TIDEAI_DEFAULT_DO_TOKEN on the server"
              : ""
          }
          style={{
            width: "100%",
            padding: "0.65rem 0.85rem",
            borderRadius: 8,
            border: "1px solid #222",
            background: "#111",
            color: "#fff",
          }}
        />
      </label>

      <button
        type="submit"
        disabled={disabled}
        style={{
          marginTop: "0.25rem",
          padding: "0.85rem 1rem",
          borderRadius: 8,
          border: "none",
          background: "#0069ff",
          color: "#fff",
          fontWeight: 700,
          fontSize: "1rem",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        Build it →
      </button>

      <p style={{ margin: 0, fontSize: "0.8rem", opacity: 0.7 }}>
        {defaultDoTokenConfigured
          ? "Server has a default token set for local testing. Paste another above to override."
          : "Token is used for code generation (Serverless Inference) — and, if you choose Deploy, for Container Registry and App Platform."}{" "}
        Local preview takes about a minute. Deploy takes two to four minutes.
      </p>
    </form>
  );
}
