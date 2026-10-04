import type { AgentConfig, Json } from "./types.js";
import { hash, positive, TEXT_LIMIT } from "./util.js";

/** A pinned requirement. Catalogue metadata does not prove native activation. */
export interface PluginReference {
  id: string;
  revision: string;
}

/** Portable intent. Installed adapters and private configuration remain local. */
export interface ProfileIntent {
  instructions?: string;
  instructionsChannel?: "prompt-prefix" | "native-system";
  model?: string;
  mode?: "read-only" | "write";
  tools?: string[];
  strict?: boolean;
  timeoutMs?: number;
  session?: "fresh" | "compatible";
  plugins?: readonly PluginReference[];
}

/** Trusted adapter metadata. An inventory alone does not enforce a restriction. */
export interface ProfileCapabilities {
  revision: string;
  modes: readonly ("read-only" | "write")[];
  tools?: readonly string[];
  strictTools: boolean;
  nativeSystem: boolean;
  fresh: boolean;
  /** Exact plugins activated by trusted local target configuration. */
  activePlugins?: readonly PluginReference[];
}

export interface ProfileBinding {
  agent: AgentConfig;
  capabilities: ProfileCapabilities;
  instructionChannel?: "prompt-prefix" | "native-system";
  /** Exact instructions already configured in the native harness. */
  nativeInstructions?: string;
}

export interface ProfileSelection {
  profiles: Record<string, ProfileIntent>;
  bindings: Record<string, ProfileBinding>;
  defaultProfile?: string;
  nodeProfile?: string;
  callerProfile?: string;
  defaults?: ProfileIntent;
  override?: ProfileIntent;
}

const fields = new Set([
  "instructions",
  "instructionsChannel",
  "model",
  "mode",
  "tools",
  "strict",
  "timeoutMs",
  "session",
  "plugins",
]);
const namePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const pluginIdPattern =
  /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/;
const pluginRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Validate and freeze exact references without reading or installing plugins. */
export function parsePluginReferences(
  value: unknown,
  label = "Plugins",
): readonly PluginReference[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error(`${label} must be an array of at most 256 references`);
  const result: PluginReference[] = [],
    ids = new Set<string>();
  for (const entry of value) {
    const input = record(entry, `${label} reference`);
    for (const key of Object.keys(input))
      if (key !== "id" && key !== "revision")
        throw new Error(`Unknown ${label} reference field: ${key}`);
    if (
      !Object.hasOwn(input, "id") ||
      typeof input.id !== "string" ||
      input.id.match(pluginIdPattern)?.[0] !== input.id
    )
      throw new Error(
        `${label} reference id must be marketplace/plugin with two lowercase 1-128 character slugs`,
      );
    if (
      !Object.hasOwn(input, "revision") ||
      typeof input.revision !== "string" ||
      input.revision.match(pluginRevisionPattern)?.[0] !== input.revision
    )
      throw new Error(
        `${label} reference revision must be an exact lowercase 40 or 64 character SHA`,
      );
    if (ids.has(input.id))
      throw new Error(`${label} contain duplicate plugin id ${input.id}`);
    ids.add(input.id);
    result.push(Object.freeze({ id: input.id, revision: input.revision }));
  }
  result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(result);
}

/** Reject unknown fields and ambiguous values before rendering or dispatch. */
function parseIntent(
  value: unknown,
  complete: boolean,
): Readonly<ProfileIntent> {
  const input = record(value, "Profile");
  const result: ProfileIntent = {};
  for (const key of Object.keys(input))
    if (!fields.has(key)) throw new Error(`Unknown profile field: ${key}`);
  for (const key of ["instructions", "model"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (typeof value !== "string" || (key === "model" && !value.trim()))
        throw new Error(
          `Profile ${key} must be a ${key === "model" ? "nonempty " : ""}string`,
        );
      if (Buffer.byteLength(value) > TEXT_LIMIT)
        throw new Error(`Profile ${key} exceeds 64 KiB`);
      result[key] = value;
    }
  }
  if (input.mode !== undefined) {
    if (input.mode !== "read-only" && input.mode !== "write")
      throw new Error("Profile mode must be read-only or write");
    result.mode = input.mode;
  }
  if (input.instructionsChannel !== undefined) {
    if (
      input.instructionsChannel !== "prompt-prefix" &&
      input.instructionsChannel !== "native-system"
    )
      throw new Error(
        "Profile instructionsChannel must be prompt-prefix or native-system",
      );
    result.instructionsChannel = input.instructionsChannel;
  }
  if (input.session !== undefined) {
    if (input.session !== "fresh" && input.session !== "compatible")
      throw new Error("Profile session must be fresh or compatible");
    result.session = input.session;
  }
  if (input.strict !== undefined) {
    if (typeof input.strict !== "boolean")
      throw new Error("Profile strict must be boolean");
    result.strict = input.strict;
  }
  if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== "number")
      throw new Error("Profile timeoutMs must be a number");
    result.timeoutMs = positive(input.timeoutMs);
  }
  if (input.tools !== undefined) {
    if (
      !Array.isArray(input.tools) ||
      input.tools.length > 256 ||
      input.tools.some(
        (tool) => typeof tool !== "string" || !tool.trim() || tool.length > 256,
      )
    )
      throw new Error(
        "Profile tools must be an array of at most 256 nonempty names",
      );
    if (new Set(input.tools).size !== input.tools.length)
      throw new Error("Profile tools contain duplicates");
    result.tools = Object.freeze(
      [...input.tools].sort(),
    ) as unknown as string[];
  }
  if (input.plugins !== undefined)
    result.plugins = parsePluginReferences(input.plugins, "Profile plugins");
  if (complete && result.strict && result.tools === undefined)
    throw new Error(
      "Strict profile requires an explicit tools array; [] means no tools",
    );
  return Object.freeze(result);
}

export function parseProfile(value: unknown): Readonly<ProfileIntent> {
  return parseIntent(value, true);
}

export function parseProfiles(
  value: unknown,
): Readonly<Record<string, Readonly<ProfileIntent>>> {
  const input = record(value, "Profiles"),
    result: Record<string, Readonly<ProfileIntent>> = Object.create(null);
  if (Object.keys(input).length > 256)
    throw new Error("Profiles exceed 256 entries");
  for (const [name, intent] of Object.entries(input)) {
    if (!namePattern.test(name))
      throw new Error(`Invalid profile name: ${name}`);
    result[name] = parseProfile(intent);
  }
  return Object.freeze(result);
}

/** A frozen execution receipt; it holds a local harness, never credential values. */
export class ResolvedProfile {
  readonly identity: string;
  readonly agentConfig: Readonly<AgentConfig>;
  readonly intent: Readonly<ProfileIntent>;
  readonly capabilities: Readonly<ProfileCapabilities>;
  readonly instructionChannel: "prompt-prefix" | "native-system";
  readonly sessionPolicy: "fresh" | "compatible";

  constructor(
    readonly name: string,
    intent: ProfileIntent,
    binding: ProfileBinding,
  ) {
    this.intent = parseProfile(intent);
    intent = this.intent;
    if (!namePattern.test(name))
      throw new Error(`Invalid profile name: ${name}`);
    const caps = binding.capabilities;
    if (
      !caps.revision ||
      !Array.isArray(caps.modes) ||
      caps.modes.some((mode) => mode !== "read-only" && mode !== "write") ||
      typeof caps.strictTools !== "boolean" ||
      typeof caps.nativeSystem !== "boolean" ||
      typeof caps.fresh !== "boolean"
    )
      throw new Error(
        "Binding requires trusted, revisioned capability metadata",
      );
    this.capabilities = Object.freeze({
      ...caps,
      modes: Object.freeze([...caps.modes]),
      ...(caps.tools === undefined
        ? {}
        : { tools: Object.freeze([...caps.tools].sort()) }),
      ...(caps.activePlugins === undefined
        ? {}
        : {
            activePlugins: parsePluginReferences(
              caps.activePlugins,
              "Target active plugins",
            ),
          }),
    });
    if (intent.plugins !== undefined) {
      if (this.capabilities.activePlugins === undefined)
        throw new Error("Target active plugin inventory is unknown");
      if (hash(intent.plugins) !== hash(this.capabilities.activePlugins))
        throw new Error(
          "Target active plugins do not match the exact profile selection; use a preconfigured binding",
        );
    }
    this.instructionChannel = intent.instructionsChannel ?? "prompt-prefix";
    if (
      this.instructionChannel === "native-system" &&
      (!caps.nativeSystem ||
        binding.instructionChannel !== "native-system" ||
        binding.nativeInstructions !== (intent.instructions ?? ""))
    )
      throw new Error(
        "Target must configure these exact native system instructions before resolution",
      );
    const mode = intent.mode ?? binding.agent.mode ?? "read-only";
    if (!caps.modes.includes(mode))
      throw new Error(`Target does not support mode ${mode}`);
    this.sessionPolicy = intent.session ?? "fresh";
    if (this.sessionPolicy === "fresh" && !caps.fresh)
      throw new Error("Target does not support fresh sessions");
    if (intent.tools !== undefined) {
      if (caps.tools === undefined)
        throw new Error("Target tool inventory is unknown");
      for (const tool of intent.tools)
        if (!caps.tools.includes(tool))
          throw new Error(`Target does not provide tool ${tool}`);
      if (
        intent.strict &&
        (!caps.strictTools ||
          hash([...caps.tools].sort()) !== hash(intent.tools))
      )
        throw new Error(
          "Target cannot enforce the exact strict tool selection; use a preconfigured binding",
        );
    }
    const model = intent.model ?? binding.agent.model;
    if (!model.trim()) throw new Error("Resolved model must be explicit");
    // Adapter identity includes local protocol and pricing. A different model needs a binding
    // whose price provenance matches; existing harness preflight checks that before reservation.
    let instructions =
      this.instructionChannel === "native-system"
        ? undefined
        : (intent.instructions ?? binding.agent.instructions);
    if (
      this.instructionChannel === "native-system" &&
      intent.tools !== undefined &&
      !intent.strict
    )
      throw new Error(
        "Native advisory tool guidance requires a preconfigured instruction; use strict tools or a prompt prefix",
      );
    if (intent.tools !== undefined && !intent.strict)
      instructions = [
        instructions,
        `Advisory tool guidance: use only ${intent.tools.length ? intent.tools.join(", ") : "no tools"}. This target does not enforce this profile-specific restriction.`,
      ]
        .filter(Boolean)
        .join("\n\n");
    this.agentConfig = Object.freeze({
      harness: binding.agent.harness,
      model,
      mode,
      instructions,
      timeoutMs: intent.timeoutMs ?? binding.agent.timeoutMs ?? 300_000,
    });
    positive(this.agentConfig.timeoutMs!);
    this.identity = hash({
      profile: this.intent,
      name,
      capabilities: this.capabilities,
      instructionChannel: this.instructionChannel,
      adapter: binding.agent.harness.identity,
      model,
      mode,
      instructions: instructions ?? "",
      timeoutMs: this.agentConfig.timeoutMs,
      session: this.sessionPolicy,
    });
    Object.freeze(this);
  }

  preview(): Json {
    return {
      name: this.name,
      identity: this.identity,
      intent: this.intent as Json,
      model: this.agentConfig.model,
      mode: this.agentConfig.mode!,
      timeoutMs: this.agentConfig.timeoutMs!,
      session: this.sessionPolicy,
      instructions:
        this.intent.instructions ?? this.agentConfig.instructions ?? "",
      instructionChannel: this.instructionChannel,
      instructionSupport:
        this.instructionChannel === "native-system" ? "enforced" : "advisory",
      toolSupport: this.intent.strict
        ? "enforced"
        : this.intent.tools
          ? "advisory"
          : "unspecified",
      capabilityRevision: this.capabilities.revision,
    };
  }

  checkContinuation(priorIdentity: string): void {
    if (this.sessionPolicy === "fresh")
      throw new Error("Fresh profile cannot continue a previous session");
    if (priorIdentity !== this.identity)
      throw new Error(
        "Resolved profile identity changed; continuation rejected",
      );
  }
}

/** Selection order is workflow default, node profile, then an explicit caller override. */
export function resolveProfile(selection: ProfileSelection): ResolvedProfile {
  const profiles = parseProfiles(selection.profiles);
  const name =
    selection.callerProfile ??
    selection.nodeProfile ??
    selection.defaultProfile;
  if (!name || !Object.hasOwn(profiles, name))
    throw new Error(`Unknown selected profile: ${name ?? "none"}`);
  if (!Object.hasOwn(selection.bindings, name))
    throw new Error(`Missing local binding for profile ${name}`);
  const intent = parseProfile({
    ...parseIntent(selection.defaults ?? {}, false),
    ...profiles[name],
    ...parseIntent(selection.override ?? {}, false),
  });
  return new ResolvedProfile(name, intent, selection.bindings[name]!);
}
