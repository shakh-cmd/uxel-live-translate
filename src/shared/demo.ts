export const DEMO_LINE =
  "Welcome to Hagia Sophia in Istanbul. This great church was built in the sixth century. Please watch your step near the ramp.";

export const SAMPLE_STOP = {
  name: "Basilica Cistern",
  script:
    "This is the Basilica Cistern in Istanbul. Emperor Justinian built it in the sixth century to store water for the palace. Mind the wet floor.",
};

export function normPhrase(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
