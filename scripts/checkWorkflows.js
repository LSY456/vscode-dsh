/**
 * 工作流守卫（零第三方依赖，本地与 CI 共用）。
 *
 * 为什么需要它：CI 里的 `uses: actions/checkout@v4` 看着像"锁在 v4"，其实不是 ——
 * tag 是**可以被移动**的。上游把 v4 指向新提交，我们下次跑的就是别人的新代码，
 * 没有 diff、没有提示、也没有任何一步会失败。同理 `@main` / `@master` 更糟。
 * 唯一稳定的锚是 40 位 commit SHA。
 *
 * 这不是假想风险：本仓库就真实踩过 `google/osv-scanner-action@v1` ——
 * 该仓库后来把 v1 这个 ref 整个删了（只剩 v1.7.x / v1.8.x / v1.9.x 与 v2.x），
 * 于是那一步在 ref 解析阶段直接失败。pin 到 SHA 的话，上游怎么改都与我们无关。
 *
 * 检查项：
 *  1. 每个 `uses:` 必须 pin 到 40 位十六进制 SHA（本地路径 `./` 与 `docker://` 除外）；
 *  2. 每个工作流文件必须有顶层 `permissions:` —— 不写就是把仓库默认权限原样发给所有 job；
 *  3. 禁止 `pull_request_target` / `workflow_run` 触发 —— 两者都会把带写权限的 token
 *     和 secrets 暴露给不可信代码（fork PR、上游工作流）；
 *  4. 缺少 `# vX.Y.Z` 版本注释只告警：SHA 本身不可读，注释是人和 Dependabot 的抓手。
 *
 * 用法：`node scripts/checkWorkflows.js`（`npm run check:workflows`）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

const SHA_RE = /^[0-9a-f]{40}$/;
/** 本地复合 action 与 docker action 没有"上游 tag"可浮动，单独放行。 */
const EXEMPT_PREFIXES = ['./', 'docker://'];
const FORBIDDEN_TRIGGERS = ['pull_request_target', 'workflow_run'];

/** `uses:` 可能写在 `- uses:` 同行，也可能单独一行（step 里 `- name:` 之后再 `uses:`）。 */
const USES_RE = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(?:#\s*(\S.*?))?\s*$/;

const errors = [];
const warnings = [];
const pinned = [];

function fail(file, lineNo, message) {
  errors.push(`${file}:${lineNo}  ${message}`);
}

function checkUsesRef(file, lineNo, rawValue, comment) {
  const value = rawValue.replace(/^['"]|['"]$/g, '');
  if (EXEMPT_PREFIXES.some((p) => value.startsWith(p))) return;

  const at = value.lastIndexOf('@');
  if (at < 0) {
    fail(file, lineNo, `uses 缺少 @<ref>：\`${value}\` —— 指向默认分支，必须 pin 到 commit SHA`);
    return;
  }
  const repo = value.slice(0, at);
  const ref = value.slice(at + 1);

  if (!SHA_RE.test(ref)) {
    fail(
      file,
      lineNo,
      `uses 未 pin 到 commit SHA：\`${value}\` —— \`${ref}\` 是可变引用（tag/分支都可能被移动）`,
    );
    return;
  }
  pinned.push({ file, line: lineNo, repo, sha: ref, comment });
  if (!comment) {
    warnings.push(`${file}:${lineNo}  ${repo} 已 pin 到 SHA 但没有 \`# vX.Y.Z\` 注释，日后无法判断该升到哪一版`);
  }
}

function checkWorkflow(fileName) {
  const filePath = path.join(WORKFLOW_DIR, fileName);
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (/^\s*#/.test(line)) return; // 注释行不参与判定

    const uses = USES_RE.exec(line);
    if (uses) checkUsesRef(fileName, lineNo, uses[1], uses[2]);

    for (const trigger of FORBIDDEN_TRIGGERS) {
      // 只在 on: 的键位置匹配（`  pull_request_target:`），避免把正文里的同名词也判进来。
      if (new RegExp(`^\\s{2}${trigger}\\s*:`).test(line)) {
        fail(
          fileName,
          lineNo,
          `使用了 ${trigger} 触发 —— 会把带写权限的 token 与 secrets 交给不可信代码（fork PR / 上游工作流）`,
        );
      }
    }
  });

  // 顶层 permissions 必须存在（缩进 0）。job 级的不能替代它：
  // 顶层缺失时，没有声明权限的 job 会拿到仓库默认权限。
  if (!lines.some((l) => /^permissions\s*:/.test(l))) {
    fail(fileName, 1, '缺少顶层 `permissions:` —— 未声明的 job 会继承仓库默认权限');
  }
}

function main() {
  if (!fs.existsSync(WORKFLOW_DIR)) {
    console.error(`✗ 找不到工作流目录：${WORKFLOW_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) {
    console.error(`✗ ${WORKFLOW_DIR} 下没有工作流文件`);
    process.exit(1);
  }

  for (const f of files) checkWorkflow(f);

  console.log(`检查工作流 ${files.length} 个：${files.join(', ')}`);
  console.log(`已 pin 的引用 ${pinned.length} 条：`);
  for (const p of pinned) {
    console.log(`  ${p.sha.slice(0, 12)}…  ${p.repo.padEnd(34)} ${p.comment || '(无版本注释)'}`);
  }
  for (const w of warnings) console.log(`  [warn] ${w}`);

  if (errors.length > 0) {
    console.error(`\n✗ 工作流守卫失败（${errors.length} 条）：`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('\n✓ 工作流守卫通过：全部 uses 均 pin 到 commit SHA，权限与触发方式合规');
}

main();
