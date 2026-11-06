import { engineName, hasAI } from "../lib/ai.js";
export default (req, res) => res.status(200).json({ engine: engineName(), ai: hasAI() });
