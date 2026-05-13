import { buildSystemPrompt } from "./systemPrompt.js";

const INFERENCE_URL = "https://inference.do-ai.run/v1/chat/completions";
/** See https://docs.digitalocean.com/products/inference/details/models/ — IDs are not HuggingFace paths. */
const DEFAULT_MODEL =
  process.env.INFERENCE_MODEL?.trim() || "llama3.3-70b-instruct";

/**
 * @param {string} doToken
 * @param {string} prompt
 * @returns {Promise<string>} Raw LLM message content
 */
export async function runInference(doToken, prompt) {
  const systemPrompt = buildSystemPrompt(prompt);

  const response = await fetch(INFERENCE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${doToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 8000,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Inference API error ${response.status}: ${text.slice(0, 500)}`
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Inference API returned no message content");
  }
  return content;
}
