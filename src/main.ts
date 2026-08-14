import { resolve } from "node:path";

import { config as loadDotEnv } from "dotenv";
import pino from "pino";

import { startApplication } from "./application.ts";

loadDotEnv({ quiet: true });

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "WECOM_BOT_SECRET",
    "COS_SECRET_ID",
    "COS_SECRET_KEY",
    "secret",
    "secretId",
    "secretKey",
  ],
});

async function main(): Promise<void> {
  const configPath = resolve(process.env.BOT_CONFIG_PATH ?? "config/local.json");
  const application = await startApplication({
    configPath,
    environment: process.env,
    logger,
  });

  const stop = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "正在停止企微 Codex 机器人");
    application.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  logger.error({ error }, "企微 Codex 机器人启动失败");
  process.exitCode = 1;
});
