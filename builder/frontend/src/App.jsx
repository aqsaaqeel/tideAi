import { useEffect, useRef, useState } from "react";
import { fetchConfig, postBuild, subscribeBuild } from "./api.js";
import PromptForm from "./components/PromptForm.jsx";
import BuildProgress from "./components/BuildProgress.jsx";
import Result from "./components/Result.jsx";

export default function App() {
  const [phase, setPhase] = useState("form");
  const [buildState, setBuildState] = useState(null);
  const [formBusy, setFormBusy] = useState(false);
  const [defaultDoTokenConfigured, setDefaultDoTokenConfigured] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    fetchConfig()
      .then((c) => setDefaultDoTokenConfigured(c.default_do_token_configured))
      .catch(() => setDefaultDoTokenConfigured(false));
    return () => {
      if (closeRef.current) closeRef.current();
    };
  }, []);

  async function handleSubmit({ prompt, do_token, deploy_mode }) {
    setFormBusy(true);
    try {
      const { build_id, deploy_mode: server_deploy_mode } = await postBuild({
        prompt,
        do_token,
        deploy_mode,
      });
      setPhase("building");
      setBuildState({
        status: "inferring",
        steps: [],
        url: null,
        repo: null,
        error: null,
        deploy_mode: server_deploy_mode || deploy_mode || "docr",
      });

      if (closeRef.current) closeRef.current();
      closeRef.current = subscribeBuild(build_id, (state) => {
        setBuildState(state);
        if (state.status === "live") {
          setPhase("done");
          if (closeRef.current) {
            closeRef.current();
            closeRef.current = null;
          }
        }
        if (state.status === "failed") {
          setPhase("done");
          if (closeRef.current) {
            closeRef.current();
            closeRef.current = null;
          }
        }
      });
    } catch (e) {
      setPhase("done");
      setBuildState({
        status: "failed",
        steps: [],
        url: null,
        repo: null,
        error: e instanceof Error ? e.message : String(e),
        deploy_mode: "docr",
      });
    } finally {
      setFormBusy(false);
    }
  }

  function handleReset() {
    if (closeRef.current) {
      closeRef.current();
      closeRef.current = null;
    }
    setBuildState(null);
    setPhase("form");
  }

  if (phase === "building") {
    return <BuildProgress buildState={buildState} />;
  }

  if (phase === "done") {
    return <Result buildState={buildState} onReset={handleReset} />;
  }

  return (
    <PromptForm
      onSubmit={handleSubmit}
      disabled={formBusy}
      defaultDoTokenConfigured={defaultDoTokenConfigured}
    />
  );
}
