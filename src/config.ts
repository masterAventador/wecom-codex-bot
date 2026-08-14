import { isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";

import { z } from "zod";

const commandSchema = z.array(z.string().min(1)).min(1);
const artifactGlobSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."), {
    message: "artifactGlobs 不能使用绝对路径或 ..",
  });
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, "项目仓库路径必须是绝对路径");
const projectIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, "项目 ID 只能包含字母、数字、点、下划线和连字符");

const projectSchema = z.object({
  path: absolutePathSchema,
  baseBranch: z.string().min(1),
  remote: z.string().min(1),
  fetchBeforeTask: z.boolean(),
  installCommand: commandSchema,
  testCommand: commandSchema,
  buildCommand: commandSchema,
  artifactGlobs: z.array(artifactGlobSchema).min(1),
});

const permissionGroupSchema = z.object({
  name: z.string().min(1),
  allowedUserIds: z.array(z.string().min(1)).min(1),
  allowedChatIds: z.array(z.string().min(1)).min(1),
  allowedProjectIds: z.array(projectIdSchema).min(1),
});

const filesystemArtifactSchema = z.object({
  provider: z.literal("filesystem"),
  filesystem: z.object({
    directory: z.string().min(1).refine(isAbsolute, "artifact.filesystem.directory 必须是绝对路径"),
    downloadBaseUrl: z.url(),
  }),
});

const cosArtifactSchema = z.object({
  provider: z.literal("cos"),
  cos: z.object({
    bucket: z.string().min(1),
    region: z.string().min(1),
    keyPrefix: z.string().min(1),
    urlExpiresSeconds: z.number().int().min(60).max(604_800),
  }),
});

const botConfigSchema = z.object({
  projects: z
    .record(projectIdSchema, projectSchema)
    .refine((projects) => Object.keys(projects).length > 0, {
      message: "projects 至少要登记一个项目",
    }),
  permissionGroups: z.array(permissionGroupSchema).min(1),
  codex: z.object({
    binary: z.string().min(1),
    timeoutMinutes: z.number().int().min(1).max(180),
  }),
  git: z
    .object({
      commitChanges: z.boolean(),
      pushBranches: z.boolean(),
      branchPrefix: z.string().regex(/^[a-zA-Z0-9._-]+$/),
      authorName: z.string().min(1),
      authorEmail: z.string().regex(/^[^@\s]+@[^@\s]+$/, "git.authorEmail 格式不正确"),
    })
    .refine((value) => !value.pushBranches || value.commitChanges, {
      path: ["pushBranches"],
      message: "git.pushBranches=true 时必须同时启用 git.commitChanges",
    }),
  runtime: z.object({
    directory: z.string().min(1).refine(isAbsolute, "runtime.directory 必须是绝对路径"),
  }),
  artifact: z.discriminatedUnion("provider", [filesystemArtifactSchema, cosArtifactSchema]),
}).superRefine((config, context) => {
  const groupNames = new Set<string>();
  for (const [groupIndex, group] of config.permissionGroups.entries()) {
    if (groupNames.has(group.name)) {
      context.addIssue({
        code: "custom",
        path: ["permissionGroups", groupIndex, "name"],
        message: `权限组名称不能重复：${group.name}`,
      });
    }
    groupNames.add(group.name);
    for (const [projectIndex, projectId] of group.allowedProjectIds.entries()) {
      if (config.projects[projectId] === undefined) {
        context.addIssue({
          code: "custom",
          path: ["permissionGroups", groupIndex, "allowedProjectIds", projectIndex],
          message: `${projectId} 未在 projects 中登记`,
        });
      }
    }
  }
});

export type BotConfig = z.infer<typeof botConfigSchema>;
export type ProjectConfig = BotConfig["projects"][string];
export type PermissionGroupConfig = BotConfig["permissionGroups"][number];
export type RuntimeSecrets = {
  wecom: { botId: string; secret: string };
  cos?: { secretId: string; secretKey: string };
};

export function parseBotConfig(value: unknown): BotConfig {
  return botConfigSchema.parse(value);
}

export async function loadBotConfigFile(configPath: string): Promise<BotConfig> {
  const content = await readFile(configPath, "utf8");
  return parseBotConfig(JSON.parse(content) as unknown);
}

export function parseRuntimeSecrets(
  config: BotConfig,
  environment: NodeJS.ProcessEnv,
): RuntimeSecrets {
  const wecom = z
    .object({
      WECOM_BOT_ID: z.string().min(1),
      WECOM_BOT_SECRET: z.string().min(1),
    })
    .parse(environment);
  const result: RuntimeSecrets = {
    wecom: { botId: wecom.WECOM_BOT_ID, secret: wecom.WECOM_BOT_SECRET },
  };
  if (config.artifact.provider === "cos") {
    const cos = z
      .object({
        COS_SECRET_ID: z.string().min(1),
        COS_SECRET_KEY: z.string().min(1),
      })
      .parse(environment);
    result.cos = { secretId: cos.COS_SECRET_ID, secretKey: cos.COS_SECRET_KEY };
  }
  return result;
}
