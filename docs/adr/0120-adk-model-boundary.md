# ADR 0120: Keep native ADK execution inside a Harness

## Context

ASF-TS already reserves native sends and stores receipts and accounting. ADK 2.2.0 has its own model loop, graph engine, session service, and cancellation protocol.

## Decision

Implement an optional `AdkHarness` with the pinned official SDK. Preconfigure instructions, concrete tools, model factory, prices, and finite model-call and event bounds. A reviewed fixed native root may use only the injected accounted model. A Runner plugin rejects other native LlmAgent models and AgentTool delegation. Keep existing Harness request types and native adapters. Continue only an owned, available in-memory ADK session. Reject unsupported sandbox, waiting, authentication, live transport, and configuration overrides.

## Why

ASF retains durable outer order and replay. ADK retains native inner execution. Shared files cannot configure credentials or import arbitrary native code. This boundary supports a real SDK proof without claiming portable native checkpoints or forced cancellation of hostile local code.
