/**
 * Server-side cost estimation. Numbers are best-effort estimates against a
 * "small hobby app" usage profile so the Blueprint screen can show a single
 * $/month total before the user approves. Source of truth is DO pricing:
 *   https://www.digitalocean.com/pricing/app-platform
 *   https://www.digitalocean.com/pricing/container-registry
 *   https://docs.digitalocean.com/products/inference/details/pricing/
 *   https://www.digitalocean.com/pricing/genai-platform
 *   https://www.digitalocean.com/pricing/spaces
 */

const USAGE_PROFILE = {
  chats: 1000,
  tokensPerChat: 1500,
  images: 200,
  kbStorageGb: 0.1,
  kbRetrievals: 1000,
  spacesGb: 5,
};

const RATE = {
  chatPerMillionTokens: 0.65,
  imagePerInvocation: 0.0035,
  kbStoragePerGbMonth: 0.1,
  kbRetrievalPer1k: 0.4,
  appPlatformBasicXxs: 5,
  spacesBaseMonthly: 5,
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
    key: "inference_chat",
    label: "Serverless Inference — chat",
    detail: "llama3.3-70b-instruct, ~$0.65 per 1M tokens (input + output)",
    usage: `~${USAGE_PROFILE.chats.toLocaleString()} chats/mo × ~${USAGE_PROFILE.tokensPerChat.toLocaleString()} tokens each`,
    monthlyUsd: chatMonthly(),
  },
  inference_image: {
    key: "inference_image",
    label: "Serverless Inference — image",
    detail: "fal-ai/fast-sdxl via async-invoke, ~$0.0035 per image",
    usage: `~${USAGE_PROFILE.images.toLocaleString()} images / month`,
    monthlyUsd: imageMonthly(),
  },
  knowledge_base: {
    key: "knowledge_base",
    label: "Knowledge Bases + Gen-AI",
    detail: "~$0.10/GB-month storage + per-1k retrievals + embeddings per token",
    usage: `~${USAGE_PROFILE.kbStorageGb * 1024} MB stored, ~${USAGE_PROFILE.kbRetrievals.toLocaleString()} retrievals / month`,
    monthlyUsd: kbMonthly(),
  },
  spaces: {
    key: "spaces",
    label: "Spaces — object storage",
    detail: "250 GB included, $5/mo base; raw PDFs and user uploads live here",
    usage: `~${USAGE_PROFILE.spacesGb} GB stored, well under the 250 GB included`,
    monthlyUsd: RATE.spacesBaseMonthly,
  },
  app_platform_basic: {
    key: "app_platform_basic",
    label: "App Platform — web service (basic-xxs)",
    detail: "1 instance × basic-xxs container, 24/7",
    usage: "Fixed monthly per instance",
    monthlyUsd: RATE.appPlatformBasicXxs,
  },
  container_registry_starter: {
    key: "container_registry_starter",
    label: "Container Registry — Starter",
    detail: "1 repository, 500 MB storage, 5 GB monthly transfer",
    usage: "Within Starter free tier",
    monthlyUsd: 0,
  },
};

/**
 * @param {string[]} services
 * @returns {boolean}
 */
function servicesIncludeKb(services) {
  return services.some((s) => s.includes("knowledge"));
}

/**
 * @param {string[]} services
 * @returns {boolean}
 */
function servicesIncludeSpaces(services) {
  return services.some((s) => s.includes("space"));
}

/**
 * Heuristic match for "this app generates images" so we add the image-inference line.
 * @param {string} appName
 * @param {string} description
 */
function looksLikeImageApp(appName, description) {
  const text = `${appName || ""} ${description || ""}`.toLowerCase();
  return /image|fal|sdxl|stable[-\s]?diffusion/.test(text);
}

/**
 * @param {{
 *   deploy_mode?: string;
 *   do_services?: string[];
 *   app_name?: string;
 *   description?: string;
 * }} spec
 * @returns {{
 *   lines: Array<{ key: string, label: string, detail: string, usage: string, monthlyUsd: number }>,
 *   total_usd_monthly: number,
 *   usage_profile: typeof USAGE_PROFILE,
 * }}
 */
export function buildCostEstimate(spec = {}) {
  const services = Array.isArray(spec.do_services)
    ? spec.do_services.map((s) => String(s).toLowerCase())
    : [];

  const usesKb = servicesIncludeKb(services);
  const usesSpaces = servicesIncludeSpaces(services);
  const usesImage = looksLikeImageApp(spec.app_name || "", spec.description || "");

  const lines = [COST_LINES.inference_chat];
  if (usesImage) lines.push(COST_LINES.inference_image);
  if (usesKb) lines.push(COST_LINES.knowledge_base);
  if (usesSpaces) lines.push(COST_LINES.spaces);
  /**
   * For the hybrid deploy default, we always end on App Platform + DOCR even though the
   * very first thing the user sees is a free local preview. Blueprint screen needs to
   * show the steady-state cost, not the preview-only cost.
   */
  lines.push(COST_LINES.container_registry_starter);
  lines.push(COST_LINES.app_platform_basic);

  const total_usd_monthly = lines.reduce(
    (acc, l) => acc + (Number.isFinite(l.monthlyUsd) ? l.monthlyUsd : 0),
    0
  );

  return {
    lines,
    total_usd_monthly,
    usage_profile: USAGE_PROFILE,
  };
}

export { USAGE_PROFILE, RATE, COST_LINES };
