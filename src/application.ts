import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";

import type { ArtifactPublisher } from "./artifact-publisher.ts";
import { findNewestArtifact } from "./artifact-locator.ts";
import { BotController } from "./bot-controller.ts";
import { runCodex } from "./codex-runner.ts";
import {
  loadBotConfigFile,
  parseRuntimeOptions,
  parseRuntimeSecrets,
  type BotConfig,
  type RuntimeSecrets,
} from "./config.ts";
import { mergeGitWorkspace, prepareGitWorkspace } from "./git-workspace.ts";
import { triageIssue } from "./issue-triage.ts";
import { runPreflight } from "./preflight.ts";
import { runCommand } from "./process-runner.ts";
import { createArtifactPublisher } from "./publisher-factory.ts";
import { routeConversation } from "./conversation-router.ts";
import { createTaskId } from "./task-id.ts";
import { generateTaskTitle } from "./task-title.ts";
import { TaskWorkflow } from "./task-workflow.ts";
import { startWeComGateway, type EventedWeComClient } from "./wecom-gateway.ts";

type ApplicationLogger = {
  info(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

type ApplicationDependencies = {
  preflight(config: BotConfig): Promise<void>;
  createPublisher(config: BotConfig, secrets: RuntimeSecrets): ArtifactPublisher;
  createWeComClient(secrets: RuntimeSecrets, logger: ApplicationLogger): EventedWeComClient;
  createStreamId(): string;
};

type StartApplicationOptions = {
  configPath: string;
  environment: NodeJS.ProcessEnv;
  logger: ApplicationLogger;
  dependencies?: Partial<ApplicationDependencies>;
};

function defaultCreateWeComClient(
  secrets: RuntimeSecrets,
  logger: ApplicationLogger,
): EventedWeComClient {
  const client = new WSClient({
    botId: secrets.wecom.botId,
    secret: secrets.wecom.secret,
    maxReconnectAttempts: -1,
    logger: logger as never,
  });
  return client as unknown as EventedWeComClient;
}

const defaultDependencies: ApplicationDependencies = {
  preflight: runPreflight,
  createPublisher: createArtifactPublisher,
  createWeComClient: defaultCreateWeComClient,
  createStreamId: () => generateReqId("stream"),
};

export async function startApplication(options: StartApplicationOptions): Promise<{ stop(): void }> {
  const dependencies: ApplicationDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  const initialConfig = await loadBotConfigFile(options.configPath);
  const secrets = parseRuntimeSecrets(initialConfig, options.environment);
  const runtimeOptions = parseRuntimeOptions(options.environment);
  await dependencies.preflight(initialConfig);
  const publisher = dependencies.createPublisher(initialConfig, secrets);
  const workflow = new TaskWorkflow({
    prepareWorkspace: prepareGitWorkspace,
    mergeWorkspace: mergeGitWorkspace,
    triageIssue,
    runCommand,
    runCodex,
    findArtifact: findNewestArtifact,
    publisher,
  });
  const controller = new BotController({
    loadConfig: () => loadBotConfigFile(options.configPath),
    createTaskId: (messageId) => createTaskId(messageId),
    routeConversation: (prompt) => routeConversation({
      binary: initialConfig.codex.binary,
      cwd: process.cwd(),
      message: prompt,
      timeoutMs: 60_000,
    }),
    summarizeTaskTitle: (prompt) => generateTaskTitle({
      binary: initialConfig.codex.binary,
      cwd: process.cwd(),
      issueDescription: prompt,
      timeoutMs: 60_000,
    }),
    verboseProgress: runtimeOptions.verboseProgress,
    workflow,
  });
  const client = dependencies.createWeComClient(secrets, options.logger);
  const gateway = startWeComGateway({
    client,
    controller,
    runtimeDirectory: initialConfig.runtime.directory,
    createStreamId: dependencies.createStreamId,
    logger: options.logger,
  });
  options.logger.info(
    {
      configPath: options.configPath,
      projects: Object.fromEntries(
        Object.entries(initialConfig.projects).map(([projectId, project]) => [
          projectId,
          project.path,
        ]),
      ),
      artifactProvider: initialConfig.artifact.provider,
      verboseProgress: runtimeOptions.verboseProgress,
    },
    "企微 Codex 机器人已启动",
  );
  return gateway;
}
