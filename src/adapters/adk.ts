import {
  BaseLlm,
  BasePlugin,
  InMemorySessionService,
  LlmAgent,
  Runner,
  StreamingMode,
  isBaseTool,
  isAgentTool,
  isFinalResponse,
  isLlmAgent,
  isWorkflow,
  type BaseAgent,
  type BaseTool,
  type Context,
  type LlmRequest,
  type LlmResponse,
  type Workflow,
} from "@google/adk";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type {
  Accounting,
  Harness,
  HarnessRequest,
  HarnessSink,
  Json,
  Pricing,
  Receipt,
  Tokens,
} from "../types.js";
import {
  estimate,
  incomplete,
  validTokens,
  validatePricing,
  zeroTokens,
} from "../accounting.js";
import { boundedJson, clip, errorText, hash, json, positive } from "../util.js";

export const ADK_VERSION = "2.2.0";
export interface AdkCapabilities {
  revision: string;
  modes: readonly ["write"];
  tools?: readonly string[];
  strictTools: boolean;
  nativeSystem: boolean;
  fresh: true;
}
export interface AdkOptions {
  /** Identifies the reviewed local model/tool/factory code. */
  revision: string;
  /** False only for an account-free local model implementation. */
  live: boolean;
  model: { create: () => BaseLlm; pricing: Pricing };
  instruction?: string;
  tools?: readonly BaseTool[];
  maxLlmCalls?: number;
  maxEvents?: number;
  /** Trusted fixed native code. It must use only the injected model. */
  root?: {
    revision: string;
    modelUsage: "injected-only";
    create: (model: BaseLlm) => BaseAgent | Workflow;
  };
}

/** Text-token projection for the pinned GenAI usage protocol. */
function tokens(response: LlmResponse): Tokens {
  const usage = response.usageMetadata;
  if (!usage) throw new Error("ADK model response has no usage metadata");
  const prompt = usage.promptTokenCount;
  const candidate = usage.candidatesTokenCount;
  if (prompt === undefined || candidate === undefined)
    throw new Error("ADK model response has incomplete token counts");
  if ((usage.toolUsePromptTokenCount ?? 0) > 0)
    throw new Error("ADK auxiliary tool-prompt pricing is unsupported");
  for (const detail of [
    ...(usage.promptTokensDetails ?? []),
    ...(usage.candidatesTokensDetails ?? []),
    ...(usage.cacheTokensDetails ?? []),
  ]) {
    if (detail.modality && detail.modality !== "TEXT")
      throw new Error("ADK non-text token pricing is unsupported");
  }
  const cached = usage.cachedContentTokenCount ?? 0;
  const reasoning = usage.thoughtsTokenCount ?? 0;
  const result = {
    input: prompt - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: candidate + reasoning,
    reasoning,
  };
  validTokens(result);
  return result;
}

class Usage {
  calls = 0;
  settled = 0;
  total = zeroTokens();
  reason?: string;
  constructor(
    readonly pricing: Pricing,
    readonly bound: number,
    readonly sink: HarnessSink,
  ) {}
  accounting(): Accounting {
    const known = this.settled > 0 || (this.calls === 0 && !this.reason);
    const result: Accounting = {
      status: this.reason ? "incomplete" : "complete",
      usd: known ? estimate(this.total, this.pricing) : null,
      kind: "asf-calculated",
      model: this.pricing.model,
      modelSource: "requested",
      scope: "all injected ADK model calls: reported text tokens",
      excluded: [
        "unreported cache creation",
        "tool/service charges",
        "provider internal retries and invoice adjustments",
      ],
      source: "ADK BaseLlm responses and explicit local rate card",
      version: ADK_VERSION,
      tokens: known ? { ...this.total } : null,
      pricing: this.pricing,
      raw: { modelCalls: this.calls, settledModelCalls: this.settled },
    };
    return this.reason
      ? incomplete(this.pricing.model, this.reason, result)
      : result;
  }
  report(key: string): void {
    this.sink.report(key, this.accounting());
  }
}

/** Capture usage at the official model seam, before cancellation drops events. */
class AccountedModel extends BaseLlm {
  constructor(
    private readonly underlying: BaseLlm,
    private readonly usage: Usage,
  ) {
    super({ model: underlying.model });
  }
  override connect(): never {
    throw new Error("ADK live/bidirectional execution is unsupported");
  }
  override async *generateContentAsync(
    request: LlmRequest,
    stream?: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    signal?.throwIfAborted();
    if (this.usage.calls >= this.usage.bound)
      throw new Error("ASF ADK model-call bound reached");
    const call = ++this.usage.calls;
    let last: LlmResponse | undefined;
    let finished = false;
    try {
      for await (const response of this.underlying.generateContentAsync(
        request,
        stream,
        signal,
      )) {
        if (response.usageMetadata) last = response;
        yield response;
      }
      finished = true;
    } finally {
      try {
        if (!last) throw new Error("ADK model call ended without usage");
        if (last.modelVersion && last.modelVersion !== this.model)
          throw new Error("ADK observed model does not match the priced model");
        const measured = tokens(last);
        for (const key of Object.keys(measured) as (keyof Tokens)[])
          this.usage.total[key] += measured[key];
        validTokens(this.usage.total);
        this.usage.settled++;
        if (
          !finished ||
          signal?.aborted ||
          last.partial ||
          last.interrupted ||
          last.errorCode
        )
          throw new Error("ADK model call was interrupted or failed");
      } catch (error) {
        this.usage.reason = errorText(error);
      }
      this.usage.report(`model-${call}`);
    }
  }
}

/** Reject native SDK agents that bypass the bound, accounted model. */
class ModelBoundary extends BasePlugin {
  constructor(private readonly model: BaseLlm) {
    super("asf_model_boundary");
  }
  override async beforeModelCallback({
    callbackContext,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const agent = callbackContext.invocationContext.agent;
    if (!agent || !isLlmAgent(agent) || agent.canonicalModel !== this.model)
      throw new Error("ADK native agent bypasses the injected model boundary");
    return undefined;
  }
  override async beforeToolCallback({
    tool,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    if (isAgentTool(tool))
      throw new Error("ADK AgentTool model ownership is unsupported");
    return undefined;
  }
}

/** Optional native SDK adapter. Its tool boundary is not an OS sandbox. */
export class AdkHarness implements Harness {
  readonly name = "adk";
  readonly live: boolean;
  readonly identity: Json;
  readonly maxLlmCalls: number;
  readonly capabilities: Readonly<AdkCapabilities>;
  readonly nativeInstructions: string;
  private readonly options: AdkOptions;
  private readonly sessions = new InMemorySessionService();
  private readonly baselines = new Map<string, Json>();
  private readonly active = new Set<string>();
  private closed = false;
  private readonly appName = "asf_adk";
  private readonly userId = randomUUID();
  constructor(options: AdkOptions) {
    if (!options.revision.trim())
      throw new Error("ADK binding revision required");
    validatePricing(options.model.pricing, options.model.pricing.model);
    if (options.root && (options.instruction || options.tools?.length))
      throw new Error(
        "Fixed ADK root cannot receive agent configuration overrides",
      );
    if (
      options.root &&
      (!options.root.revision.trim() ||
        options.root.modelUsage !== "injected-only")
    )
      throw new Error("Fixed ADK root needs a reviewed injected-model policy");
    const tools = [...(options.tools ?? [])];
    if (
      tools.some((tool) => !isBaseTool(tool) || isAgentTool(tool)) ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length
    )
      throw new Error("ADK requires distinct concrete named tools");
    this.maxLlmCalls = positive(options.maxLlmCalls ?? 16, 1000);
    positive(options.maxEvents ?? 1000, 10000);
    this.live = options.live;
    this.options = {
      ...options,
      model: {
        ...options.model,
        pricing: structuredClone(options.model.pricing),
      },
      tools,
      root: options.root ? { ...options.root } : undefined,
    };
    this.identity = json({
      adapter: "adk",
      sdk: ADK_VERSION,
      policy: 1,
      revision: options.revision,
      live: options.live,
      instruction: options.instruction ?? "",
      tools: tools.map((tool) => tool.name),
      pricing: this.options.model.pricing,
      maxLlmCalls: this.maxLlmCalls,
      maxEvents: options.maxEvents ?? 1000,
      nativeRoot: options.root
        ? {
            revision: options.root.revision,
            modelUsage: options.root.modelUsage,
          }
        : null,
      continuation: "owned in-memory ADK session only",
      mode: "write",
    });
    this.nativeInstructions = options.instruction ?? "";
    this.capabilities = Object.freeze({
      revision: hash(this.identity),
      modes: Object.freeze(["write"] as const),
      ...(options.root
        ? {}
        : { tools: Object.freeze(tools.map((tool) => tool.name).sort()) }),
      strictTools: !options.root,
      nativeSystem: !options.root,
      fresh: true,
    });
  }
  async preflight(request: Omit<HarnessRequest, "signal">): Promise<void> {
    if (this.closed) throw new Error("ADK harness is closed");
    const installed = createRequire(import.meta.url)(
      "@google/adk/package.json",
    ) as { version: string };
    if (installed.version !== ADK_VERSION)
      throw new Error("ADK SDK version mismatch");
    validatePricing(this.options.model.pricing, request.model);
    if (request.mode !== "write")
      throw new Error("ADK has no read-only OS sandbox");
    if (request.session) {
      const baseline = this.baselines.get(request.session.nativeId);
      if (!baseline || hash(baseline) !== hash(request.session.baseline))
        throw new Error("ADK native session unavailable or baseline changed");
      if (this.active.has(request.session.nativeId))
        throw new Error("ADK native session is busy");
    }
  }
  async invoke(request: HarnessRequest, sink: HarnessSink): Promise<Receipt> {
    await this.preflight(request);
    const usage = new Usage(this.options.model.pricing, this.maxLlmCalls, sink);
    let nativeId = request.session?.nativeId;
    let text = "";
    let truncated = false;
    let error: string | undefined;
    let iterator:
      | AsyncGenerator<import("@google/adk").Event, void, undefined>
      | undefined;
    let final = false;
    let ownsSession = false;
    try {
      request.signal.throwIfAborted();
      if (!nativeId) {
        const session = await this.sessions.createSession({
          appName: this.appName,
          userId: this.userId,
        });
        nativeId = session.id;
      }
      if (this.active.has(nativeId))
        throw new Error("ADK native session is busy");
      this.active.add(nativeId);
      ownsSession = true;
      const underlying = this.options.model.create();
      if (underlying.model !== request.model)
        throw new Error("ADK factory model does not match price binding");
      const model = new AccountedModel(underlying, usage);
      const root =
        this.options.root?.create(model) ??
        new LlmAgent({
          name: "asf_agent",
          model,
          instruction: this.options.instruction ?? "",
          tools: [...(this.options.tools ?? [])],
          disallowTransferToParent: true,
          disallowTransferToPeers: true,
        });
      const runner = new Runner({
        appName: this.appName,
        agent: root,
        sessionService: this.sessions,
        plugins: [new ModelBoundary(model)],
      });
      iterator = runner.runAsync({
        userId: this.userId,
        sessionId: nativeId,
        newMessage: { role: "user", parts: [{ text: request.prompt }] },
        runConfig: {
          maxLlmCalls: this.maxLlmCalls,
          streamingMode: StreamingMode.NONE,
        },
        abortSignal: request.signal,
      });
      let count = 0;
      for await (const event of iterator) {
        if (++count > (this.options.maxEvents ?? 1000))
          throw new Error("ASF ADK event bound reached");
        if (event.errorCode || event.errorMessage)
          throw new Error(event.errorMessage ?? event.errorCode);
        if (
          (event.longRunningToolIds?.length ?? 0) > 0 ||
          Object.keys(event.actions.requestedToolConfirmations ?? {}).length ||
          Object.keys(event.actions.requestedAuthConfigs ?? {}).length
        )
          throw new Error(
            "ADK waiting/authentication lifecycle is unsupported",
          );
        sink.event({
          type: "lifecycle",
          sourceId: event.id,
          data: boundedJson({
            author: event.author,
            nodeInfo: event.nodeInfo,
            actions: event.actions,
          }),
        });
        const selected = isWorkflow(root)
          ? event.nodeInfo
            ? event.nodeInfo.outputFor?.includes(root.name)
            : event.author === root.name && event.output !== undefined
          : event.author === root.name && isFinalResponse(event);
        if (selected && !event.partial && !event.interrupted) {
          const output =
            event.output !== undefined
              ? JSON.stringify(event.output)
              : (event.content?.parts
                  ?.map((part) => part.text ?? "")
                  .join("") ?? "");
          if (output) {
            text = clip(output);
            truncated = text !== output;
            final = true;
            sink.event({
              type: "message",
              sourceId: event.id,
              data: { text },
              content: true,
            });
          }
        }
      }
      request.signal.throwIfAborted();
      if (!final) throw new Error("ADK ended without a final root result");
    } catch (failure) {
      error = errorText(failure);
      if (!usage.calls && !final)
        usage.reason =
          "ADK operation failed before model usage was established";
    } finally {
      try {
        await iterator?.return();
      } catch (failure) {
        error = errorText(failure);
        usage.reason = "ADK iterator cleanup failed";
      }
    }
    try {
      if (request.signal.aborted) error ??= "ADK operation was cancelled";
      const accounting = usage.accounting();
      sink.report("terminal", accounting);
      let session: Receipt["session"];
      if (nativeId && ownsSession) {
        const saved = await this.sessions.getSession({
          appName: this.appName,
          userId: this.userId,
          sessionId: nativeId,
        });
        if (saved) {
          const baseline = json({
            history: hash(saved),
            revision: hash(this.identity),
          });
          this.baselines.set(nativeId, baseline);
          session = { nativeId, baseline };
        }
      }
      return {
        status: request.signal.aborted
          ? "cancelled"
          : error
            ? "failed"
            : "succeeded",
        text,
        nativeId,
        session,
        accounting,
        error,
        truncated,
      };
    } finally {
      if (nativeId && ownsSession) this.active.delete(nativeId);
    }
  }
  async close(): Promise<void> {
    if (this.active.size) throw new Error("Cannot close an active ADK harness");
    this.closed = true;
    for (const sessionId of this.baselines.keys())
      await this.sessions.deleteSession({
        appName: this.appName,
        userId: this.userId,
        sessionId,
      });
    this.baselines.clear();
  }
}
