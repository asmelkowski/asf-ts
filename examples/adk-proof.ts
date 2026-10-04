import {
  BaseLlm,
  FunctionTool,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { AdkHarness } from "../src/adapters/adk.js";
import type { Pricing } from "../src/types.js";

/** Actual SDK model seam. This class performs no network or credential access. */
export class LocalProofModel extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  constructor() {
    super({ model: "asf-local-proof" });
  }
  override connect(): never {
    throw new Error("No live transport in the local proof");
  }
  override async *generateContentAsync(
    request: LlmRequest,
    _stream?: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    signal?.throwIfAborted();
    this.requests.push(request);
    const hasResult = request.contents.some((content) =>
      content.parts?.some((part) => part.functionResponse?.name === "marker"),
    );
    yield {
      content: {
        role: "model",
        parts: hasResult
          ? [{ text: '{"ok":true,"marker":"local-adk"}' }]
          : [{ functionCall: { name: "marker", args: {} } }],
      },
      modelVersion: this.model,
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
      },
    };
  }
}
export const localPricing: Pricing = {
  model: "asf-local-proof",
  source: "account-free deterministic fixture rate card",
  version: "1",
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
};
export function localAdkProof(): AdkHarness {
  return new AdkHarness({
    revision: "local-model-marker-tool-v1",
    live: false,
    model: { create: () => new LocalProofModel(), pricing: localPricing },
    instruction: "Call marker, then return the marker as JSON.",
    tools: [
      new FunctionTool({
        name: "marker",
        description: "Return a deterministic local proof marker.",
        execute: () => ({ marker: "local-adk" }),
      }),
    ],
    maxLlmCalls: 3,
  });
}
