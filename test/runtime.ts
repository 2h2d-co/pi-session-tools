import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export const SYSTEM_INSTRUCTIONS = "Base test instructions: Never deploy without approval.";
export const PROJECT_INSTRUCTIONS = "Project test instructions: Preserve all existing data.";

/** A real Pi runtime with an offline scripted provider and a private temporary agent home. */
export async function testRuntime(
  extra?: ExtensionFactory,
  mode: "tui" | "rpc" | "print" | "json" = "print",
  persisted = true,
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-tools-runtime-"));
  const agentDir = join(cwd, "agent");
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const errors: string[] = [];
  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 100 },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: {
        systemPromptOverride: () => SYSTEM_INSTRUCTIONS,
        agentsFilesOverride: () => ({
          agentsFiles: [{ path: join(cwd, "AGENTS.md"), content: PROJECT_INSTRUCTIONS }],
        }),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [
          fileURLToPath(new URL("../extensions/index.ts", import.meta.url)),
        ],
        extensionFactories: [
          {
            name: "offline-provider",
            factory: (pi) => {
              pi.registerProvider(faux.provider);
            },
          },
          ...(extra ? [{ name: "test-events", factory: extra }] : []),
        ],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
        model: faux.getModel(),
        noTools: "builtin",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: persisted
      ? SessionManager.create(cwd, join(cwd, "sessions"))
      : SessionManager.inMemory(cwd),
  });
  const bind = async (session: AgentSession) => {
    await session.bindExtensions({
      mode,
      onError: (error) => {
        errors.push(error.error);
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        navigateTree: (id, options) => session.navigateTree(id, options),
        newSession: (options) => runtime.newSession(options),
        fork: (id, options) => runtime.fork(id, options),
        switchSession: (file, options) => runtime.switchSession(file, options),
        reload: async () => {
          throw new Error("Test does not implement reload.");
        },
      },
    });
  };
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  assert.equal(errors.length, 0, errors.join("\n"));
  return { runtime, faux, errors, cwd };
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await setTimeout(10);
  }
  throw new Error("Timed out waiting for session operation.");
}
