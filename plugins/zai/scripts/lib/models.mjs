export const MODELS = Object.freeze({
  GLM_5_1: "glm-5.1",
  GLM_5: "glm-5",
  GLM_4_7: "glm-4.7",
  GLM_4_7_FLASH: "glm-4.7-flash",
  GLM_4_5_FLASH: "glm-4.5-flash",
});

export const DEFAULT_MODEL = MODELS.GLM_5_1;
export const DEFAULT_REVIEW_MODEL = MODELS.GLM_4_7;
export const DEFAULT_GATE_MODEL = MODELS.GLM_4_7_FLASH;

export const MODEL_ALIASES = new Map([
  ["flagship", MODELS.GLM_5_1],
  ["thinking", MODELS.GLM_4_7],
  ["flash", MODELS.GLM_4_7_FLASH],
  ["free", MODELS.GLM_4_5_FLASH],
]);

export function resolveModel(input, fallback = DEFAULT_MODEL) {
  if (input == null) return fallback;
  const normalized = String(input).trim();
  if (!normalized) return fallback;
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function suggestAlternatives(failedModelId) {
  const alternatives = [];
  for (const [alias, modelId] of MODEL_ALIASES) {
    if (modelId !== failedModelId) {
      alternatives.push(alias);
    }
  }
  if (alternatives.length === 0) {
    return [...MODEL_ALIASES.keys()];
  }
  return alternatives;
}
