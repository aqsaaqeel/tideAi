import { useEffect, useRef, useState } from "react";
import {
  fetchConfig,
  postBuild,
  postRedeploy,
  subscribeBuild,
} from "./api.js";
import PromptForm from "./components/PromptForm.jsx";
import BuildProgress from "./components/BuildProgress.jsx";
import Result from "./components/Result.jsx";

export default function App() {
  const [phase, setPhase] = useState("form");
  const [buildId, setBuildId] = useState(null);
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

  async function handleSubmit({ prompt, do_token, knowledge_base_id, deploy_mode }) {
    setFormBusy(true);
    try {
      const { build_id, deploy_mode: server_deploy_mode } = await postBuild({
        prompt,
        do_token,
        knowledge_base_id,
        deploy_mode,
      });
      setBuildId(build_id);
      startSubscription(build_id, server_deploy_mode || deploy_mode || "docr");
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

  /**
   * Subscribe to a build's SSE stream and drive the phase machine. Used by both
   * the initial submission and the "Deploy now" CTA on the Result screen.
   * @param {string} id
   * @param {string} mode
   */
  function startSubscription(id, mode) {
    setPhase("building");
    setBuildState({
      status: "inferring",
      steps: [],
      url: null,
      repo: null,
      error: null,
      deploy_mode: mode,
      app_spec: null,
    });
    if (closeRef.current) closeRef.current();
    closeRef.current = subscribeBuild(id, (state) => {
      setBuildState(state);
      if (state.status === "live" || state.status === "failed") {
        setPhase("done");
        if (closeRef.current) {
          closeRef.current();
          closeRef.current = null;
        }
      }
    });
  }

  async function handleRedeploy() {
    if (!buildId) return;
    setFormBusy(true);
    try {
      const { build_id: newId, deploy_mode } = await postRedeploy(buildId);
      setBuildId(newId);
      startSubscription(newId, deploy_mode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuildState((prev) => ({
        ...(prev || {}),
        error: msg,
      }));
      // Surface a non-blocking notice; user can retry.
      window.alert(msg);
    } finally {
      setFormBusy(false);
    }
  }

  function handleReset() {
    if (closeRef.current) {
      closeRef.current();
      closeRef.current = null;
    }
    setBuildId(null);
    setBuildState(null);
    setPhase("form");
  }

  if (phase === "building") {
    return <BuildProgress buildState={buildState} />;
  }

  if (phase === "done") {
    return (
      <Result
        buildState={buildState}
        onReset={handleReset}
        onRedeploy={handleRedeploy}
        redeployBusy={formBusy}
      />
    );
  }

  return (
    <PromptForm
      onSubmit={handleSubmit}
      disabled={formBusy}
      defaultDoTokenConfigured={defaultDoTokenConfigured}
    />
  );
}
