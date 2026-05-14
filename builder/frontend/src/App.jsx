import { useEffect, useRef, useState } from "react";
import {
  postBuild,
  postApprove,
  postCancel,
  subscribeBuild,
} from "./api.js";
import PromptForm from "./components/PromptForm.jsx";
import Blueprint from "./components/Blueprint.jsx";
import BuildProgress from "./components/BuildProgress.jsx";
import Result from "./components/Result.jsx";

/**
 * V1 phase machine:
 *   form       — single hero prompt
 *   approving  — Blueprint screen (architecture + cost + Yes/No)
 *   building   — progress (provisioning → Vite build) until preview_url is set
 *   live       — split-screen Result; iframe swaps preview → public DO URL
 *
 * `live` is also used for `preview_only` (DOCR failed) and `failed` (catastrophic),
 * the Result screen branches on `buildState.status` internally.
 */
export default function App() {
  const [phase, setPhase] = useState("form");
  const [, setBuildId] = useState(null);
  const buildIdRef = useRef(null);
  const [buildState, setBuildState] = useState(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    return () => {
      if (closeRef.current) closeRef.current();
    };
  }, []);

  function startSubscription(id) {
    setBuildId(id);
    buildIdRef.current = id;
    if (closeRef.current) closeRef.current();
    closeRef.current = subscribeBuild(id, (state) => {
      setBuildState(state);
      /**
       * Phase is derived purely from `state.status` + `state.preview_url`, never from
       * the previous `phase` value. The SSE callback closure was registered once at
       * subscription time and would otherwise see a stale `phase` from that render.
       */
      const s = state.status;
      if (s === "cancelled") {
        handleReset();
        return;
      }
      /**
       * Phase transitions are driven by `status` only. We deliberately do NOT
       * jump to the Result screen as soon as `preview_url` arrives — that would
       * skip the user past the provisioning step list. Let the BuildProgress
       * screen show every step until the pipeline terminates (`live`,
       * `preview_only`, or `failed`).
       */
      if (s === "live" || s === "preview_only" || s === "failed") {
        setPhase("live");
      } else if (s === "awaiting_approval" || s === "inferring" || s === "generating") {
        /**
         * `approving` covers the codegen skeleton too — Blueprint.jsx shows a spinner
         * until `app_spec.cost_estimate` arrives, then renders the gate.
         */
        setPhase("approving");
      } else if (
        s === "provisioning" ||
        s === "publishing" ||
        s === "deploying" ||
        s === "preview_live"
      ) {
        setPhase("building");
      }
    });
  }

  async function handleSubmit({ prompt }) {
    setBusy(true);
    try {
      const { build_id } = await postBuild({ prompt });
      setPhase("approving");
      setBuildState({
        status: "inferring",
        steps: [],
        url: null,
        repo: null,
        error: null,
        deploy_mode: "docr",
        app_spec: null,
        preview_url: null,
        live_do_url: null,
      });
      startSubscription(build_id);
    } catch (e) {
      setPhase("live");
      setBuildState({
        status: "failed",
        steps: [],
        url: null,
        repo: null,
        error: e instanceof Error ? e.message : String(e),
        deploy_mode: "docr",
        app_spec: null,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    const id = buildIdRef.current;
    if (!id) return;
    setBusy(true);
    try {
      await postApprove(id);
      setPhase("building");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    const id = buildIdRef.current;
    if (!id) {
      handleReset();
      return;
    }
    setBusy(true);
    try {
      await postCancel(id);
    } catch {
      /* if cancel fails (e.g. past the cancellable phase) we still reset locally */
    } finally {
      setBusy(false);
      handleReset();
    }
  }

  function handleReset() {
    if (closeRef.current) {
      closeRef.current();
      closeRef.current = null;
    }
    buildIdRef.current = null;
    setBuildId(null);
    setBuildState(null);
    setPhase("form");
  }

  return (
    <div className="ta-shell">
      <header className="ta-nav">
        <div className="ta-brand">
          <span className="ta-brand-dot" aria-hidden />
          tideAI
        </div>
        {phase !== "form" ? (
          <button
            type="button"
            className="ta-button ta-button-ghost"
            onClick={handleReset}
          >
            Start over
          </button>
        ) : null}
      </header>

      {phase === "form" ? (
        <PromptForm onSubmit={handleSubmit} disabled={busy} />
      ) : null}

      {phase === "approving" ? (
        <Blueprint
          buildState={buildState}
          onApprove={handleApprove}
          onCancel={handleCancel}
          busy={busy}
        />
      ) : null}

      {phase === "building" ? <BuildProgress buildState={buildState} /> : null}

      {phase === "live" ? (
        <Result buildState={buildState} onReset={handleReset} />
      ) : null}
    </div>
  );
}
