import * as gemini from "./geminiService";
import * as openrouter from "./openrouterService";

// AI_PROVIDER options:
// "gemini"      - Gemini for everything
// "openrouter"  - OpenRouter for everything
// "hybrid"      - Gemini for discovery (needs Google Search), OpenRouter for extraction
const provider = process.env.AI_PROVIDER || "gemini";

export const discoverProspects: typeof gemini.discoverProspects = (...args) => {
  if (provider === "openrouter") return openrouter.discoverProspects(...args);
  // hybrid and gemini both use Gemini for discovery (Google Search)
  return gemini.discoverProspects(...args);
};

export const extractFromText: typeof gemini.extractFromText = (...args) => {
  if (provider === "openrouter" || provider === "hybrid") return openrouter.extractFromText(...args);
  return gemini.extractFromText(...args);
};
