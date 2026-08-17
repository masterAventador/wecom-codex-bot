export type TaskActions = {
  packageArtifact: boolean;
  deploy: boolean;
  codeChange: boolean;
};

const NEGATED_PREFIX = /(?:不要|不用|无需|不必|别|禁止|不需要)(?:再|主动|自动|重新|帮我|给我)?[\s，,、。；;]*$/u;
const IMPERATIVE_PREFIX = /(?:请|帮我|麻烦|顺便|然后|接着|再|并且|直接|给我|改完(?:后)?|修好(?:后)?|完成(?:后)?|需要|要)[\s，,、。；;]*$/u;
const BACKGROUND_SUFFIX = /^(?:后|之后|时|的时候|过程中|过程|失败|报错|异常|问题|日志|脚本|配置|流程|功能|工具|命令|产物|版本|接口|生成的|出来的)/u;
const PACKAGE_ACTION = /打(?:个|一个|一下|份|一份)?(?:安装)?包(?:一下)?|出(?:个|一个|一下|份|一份)?包(?:一下)?|(?:生成|构建)(?:个|一个|一下|份|一份)?安装包(?:一下)?/gu;
const DEPLOY_ACTION = /部署(?:一下)?|上线(?:一下)?|发布(?:一下)?/gu;

function containsRequestedAction(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const action = match[0];
    const prefix = text.slice(Math.max(0, index - 24), index);
    const suffix = text.slice(index + action.length).trimStart();
    if (NEGATED_PREFIX.test(prefix)) {
      continue;
    }
    const explicitlyImperative = IMPERATIVE_PREFIX.test(prefix)
      || /(?:一下|个|一个|份|一份)/u.test(action);
    if (BACKGROUND_SUFFIX.test(suffix) && !explicitlyImperative) {
      continue;
    }
    return true;
  }
  return false;
}

export function detectTaskActions(prompt: string): TaskActions {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  const packageArtifact = containsRequestedAction(normalized, PACKAGE_ACTION);
  const deploy = containsRequestedAction(normalized, DEPLOY_ACTION);
  const remainder = normalized
    .replace(PACKAGE_ACTION, " ")
    .replace(DEPLOY_ACTION, " ")
    .replace(/到(?:测试环境|生产环境|预发环境|开发环境|线上|线上环境|正式环境|本地环境)/gu, " ")
    .replace(/(?:请|帮我|麻烦|顺便|然后|接着|再|并且|并|直接|给我|改完(?:后)?|修好(?:后)?|完成(?:后)?|也)/gu, " ")
    .replace(/[\s，,、。；;！!：:]+/gu, "");
  return {
    packageArtifact,
    deploy,
    codeChange: remainder.length > 0,
  };
}
