import { useRef, useState } from "react";
import { postKnowledgeBasesList, postKnowledgeBasesCreate } from "../api.js";

export default function PromptForm({
  onSubmit,
  disabled,
  defaultDoTokenConfigured = false,
}) {
  const tokenRef = useRef(null);
  const [kbId, setKbId] = useState("");
  const [kbList, setKbList] = useState([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbCreating, setKbCreating] = useState(false);
  const [kbLoadError, setKbLoadError] = useState("");
  const [newKbName, setNewKbName] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const deploy_mode = String(fd.get("deploy_mode") || "docr");
    onSubmit({
      prompt: String(fd.get("prompt") || "").trim(),
      do_token: String(fd.get("do_token") || "").trim(),
      knowledge_base_id: kbId.trim(),
      deploy_mode,
    });
  }

  async function handleLoadKnowledgeBases() {
    setKbLoadError("");
    setKbLoading(true);
    setKbList([]);
    try {
      const token = String(tokenRef.current?.value || "").trim();
      if (!token && !defaultDoTokenConfigured) {
        setKbLoadError("Paste your DigitalOcean API token first (or set a server default token).");
        return;
      }
      const { knowledge_bases } = await postKnowledgeBasesList(
        token || undefined
      );
      setKbList(knowledge_bases);
      if (knowledge_bases.length === 0) {
        setKbLoadError(
          "No knowledge bases returned. Create one under DigitalOcean → Data Services → Knowledge Bases, or check your token scopes (GenAI)."
        );
      }
    } catch (err) {
      setKbLoadError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setKbLoading(false);
    }
  }

  async function handleCreateKnowledgeBase() {
    setKbLoadError("");
    setKbCreating(true);
    try {
      const token = String(tokenRef.current?.value || "").trim();
      if (!token && !defaultDoTokenConfigured) {
        setKbLoadError("Paste your DigitalOcean API token first (or set a server default token).");
        return;
      }
      /** @type {Record<string, string>} */
      const payload = {};
      if (token) payload.do_token = token;
      const trimmedName = newKbName.trim();
      if (trimmedName) payload.name = trimmedName;
      const { knowledge_base } = await postKnowledgeBasesCreate(payload);
      setKbId(knowledge_base.uuid);
      setKbList((prev) => {
        const rest = prev.filter((k) => k.uuid !== knowledge_base.uuid);
        return [
          { uuid: knowledge_base.uuid, name: knowledge_base.name },
          ...rest,
        ];
      });
      setNewKbName("");
    } catch (err) {
      setKbLoadError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setKbCreating(false);
    }
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
          ref={tokenRef}
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

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          border: "1px solid #222",
          borderRadius: 8,
          padding: "0.75rem 0.85rem",
        }}
      >
        <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.88, lineHeight: 1.45 }}>
          For most document Q&A apps you can <strong>leave the section below closed</strong>.
          tideAI uses an in-browser flow for simple doc chat, and can create an empty DigitalOcean
          Knowledge Base at build time when the generated app needs one.
        </p>
        <details style={{ fontSize: "0.9rem" }}>
          <summary
            style={{
              cursor: disabled ? "not-allowed" : "pointer",
              fontWeight: 600,
              opacity: disabled ? 0.6 : 1,
            }}
          >
            Advanced: link an existing DigitalOcean Knowledge Base (optional)
          </summary>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.65rem",
              marginTop: "0.65rem",
              paddingTop: "0.65rem",
              borderTop: "1px solid #2a2a2a",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={disabled || kbLoading || kbCreating}
                onClick={() => void handleLoadKnowledgeBases()}
                style={{
                  padding: "0.4rem 0.65rem",
                  borderRadius: 6,
                  border: "1px solid #333",
                  background: "#1a1a1a",
                  color: "#fff",
                  fontSize: "0.8rem",
                  cursor: disabled || kbLoading || kbCreating ? "not-allowed" : "pointer",
                  opacity: disabled || kbLoading || kbCreating ? 0.6 : 1,
                }}
              >
                {kbLoading ? "Loading…" : "Load my Knowledge Bases"}
              </button>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.8rem", opacity: 0.85 }}>
                Create a new empty Knowledge Base on your account (for apps that index PDFs on
                DigitalOcean)
              </span>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <input
                  type="text"
                  autoComplete="off"
                  disabled={disabled || kbCreating}
                  value={newKbName}
                  onChange={(e) => setNewKbName(e.target.value)}
                  placeholder="Name (optional — auto if empty)"
                  style={{
                    flex: "1 1 180px",
                    minWidth: 140,
                    padding: "0.5rem 0.65rem",
                    borderRadius: 8,
                    border: "1px solid #222",
                    background: "#111",
                    color: "#fff",
                    fontSize: "0.85rem",
                  }}
                />
                <button
                  type="button"
                  disabled={disabled || kbLoading || kbCreating}
                  onClick={() => void handleCreateKnowledgeBase()}
                  style={{
                    padding: "0.45rem 0.75rem",
                    borderRadius: 6,
                    border: "1px solid #224a7a",
                    background: "#0d2847",
                    color: "#fff",
                    fontSize: "0.8rem",
                    whiteSpace: "nowrap",
                    cursor: disabled || kbLoading || kbCreating ? "not-allowed" : "pointer",
                    opacity: disabled || kbLoading || kbCreating ? 0.6 : 1,
                  }}
                >
                  {kbCreating ? "Creating…" : "Create new Knowledge Base"}
                </button>
              </div>
            </label>
            {kbList.length > 0 ? (
              <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                <span style={{ fontSize: "0.8rem", opacity: 0.85 }}>Pick one (fills the ID below)</span>
                <select
                  value={kbList.some((k) => k.uuid === kbId) ? kbId : ""}
                  disabled={disabled}
                  onChange={(e) => setKbId(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.55rem 0.75rem",
                    borderRadius: 8,
                    border: "1px solid #222",
                    background: "#111",
                    color: "#fff",
                    fontSize: "0.9rem",
                  }}
                >
                  <option value="">— Select a knowledge base —</option>
                  {kbList.map((k) => (
                    <option key={k.uuid} value={k.uuid}>
                      {k.name} ({k.uuid.slice(0, 8)}…)
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.8rem", opacity: 0.85 }}>
                Knowledge base ID (paste manually or choose from the list above)
              </span>
              <input
                type="text"
                autoComplete="off"
                disabled={disabled}
                value={kbId}
                onChange={(e) => setKbId(e.target.value)}
                placeholder="e.g. 20cd8434-6ea1-11f0-bf8f-4e013e2ddde4"
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
            {kbLoadError ? (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "#f66" }}>{kbLoadError}</p>
            ) : (
              <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.65 }}>
                Only needed when you already have a Knowledge Base in DigitalOcean and want this
                build wired to it. Otherwise leave blank.
              </p>
            )}
          </div>
        </details>
      </div>

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
