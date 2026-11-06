// Wraps an AI function as a Vercel-style (req, res) handler.
export const handler = (fn) => async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    res.status(200).json(await fn(body));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "AI request failed" });
  }
};
