// Google Gemini provider (free tier key from https://aistudio.google.com/apikey).
// Uses the REST API directly so the project needs no extra dependency.
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Gemini's responseSchema is an OpenAPI subset: convert the JSON Schema Zod gives us.
export function toGeminiSchema(s) {
  if (s.anyOf) {
    const real = s.anyOf.filter((x) => x.type !== "null");
    return { ...toGeminiSchema({ ...real[0], description: s.description ?? real[0].description }), nullable: real.length < s.anyOf.length };
  }
  if (Array.isArray(s.type)) {
    const real = s.type.filter((t) => t !== "null");
    return { ...toGeminiSchema({ ...s, type: real[0] }), nullable: real.length < s.type.length };
  }
  const out = { type: s.type };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.required = s.required || Object.keys(s.properties);
    out.propertyOrdering = Object.keys(s.properties);
  }
  return out;
}

// If the main model is overloaded or retired, fall back to this one.
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash";

// Gemini 2.5 takes a token budget; Gemini 3+ takes a level.
const thinking = (model, level) => (model.startsWith("gemini-2.5") ? { thinkingBudget: level === "low" ? 0 : 1024 } : { thinkingLevel: level });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate({ system, user, generationConfig, thinkingLevel, strong }) {
  const key = process.env.GEMINI_API_KEY;
  // strong=true tries the bigger fallback model first (used for retries).
  const models = [...new Set(strong ? [FALLBACK, MODEL] : [MODEL, FALLBACK])];
  let m = 0;
  for (let attempt = 0; ; attempt++) {
    const model = models[m];
    let res, data;
    try {
      res = await fetch(URL(model), {
        method: "POST",
        signal: AbortSignal.timeout(25000),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { ...generationConfig, thinkingConfig: thinking(model, thinkingLevel) },
        }),
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      if (err.name !== "TimeoutError") throw err;
      res = { ok: false, status: 504 };
      data = { error: { message: "timed out" } };
    }
    if (attempt < 5) {
      const hint = data.error?.details?.find((d) => d.retryDelay)?.retryDelay;
      const waitMs = hint ? parseFloat(hint) * 1000 + 500 : 2000 * 2 ** attempt;
      // Overloaded, slow or retired model, or its daily quota is used up: switch to the other model.
      const dailyQuota = res.status === 429 && waitMs > 60000;
      if (([404, 503, 504].includes(res.status) || dailyQuota) && m < models.length - 1) { m++; continue; }
      // Per-minute rate limit: wait and retry.
      if ([429, 503, 504].includes(res.status) && waitMs <= 60000) {
        await sleep(Math.min(waitMs, 20000));
        continue;
      }
    }
    if (res.status === 429) throw new Error("The free Gemini quota is used up for now. Try again later or add another key.");
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${data.error?.message || "request failed"}`);
    const cand = data.candidates?.[0];
    if (!cand) throw new Error(`Gemini returned no answer${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ""}`);
    if (cand.finishReason === "MAX_TOKENS") throw new Error("Gemini's answer was cut off.");
    return (cand.content?.parts || []).map((p) => p.text || "").join("");
  }
}

export async function generateJSON({ system, user, schema, strong }) {
  const text = await generate({
    system, user, strong,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(schema),
      maxOutputTokens: 4000,
    },
    thinkingLevel: "low",
  });
  try { return JSON.parse(text); } catch { throw new Error("Could not read the AI response."); }
}

export async function generateText({ system, user }) {
  return generate({ system, user, generationConfig: { maxOutputTokens: 8000 }, thinkingLevel: "medium" });
}
