import { setLogger } from "@google/adk";
import { localAdkProof } from "../adk-proof.js";
import type { ProfileBinding } from "../../src/profiles.js";

// Application choice: preserve JSON stdout while retaining SDK diagnostics.
setLogger({
  log: (_level, ...args) => console.error(...args),
  debug: (...args) => console.error(...args),
  info: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  error: (...args) => console.error(...args),
  setLogLevel: () => {},
});
const harness = localAdkProof();
export const bindings: Record<string, ProfileBinding> = {
  worker: {
    agent: { harness, model: "asf-local-proof", mode: "write" },
    capabilities: harness.capabilities,
    instructionChannel: "native-system",
    nativeInstructions: harness.nativeInstructions,
  },
};
