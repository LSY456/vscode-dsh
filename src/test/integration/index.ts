/**
 * 集成测试 runner（在 VSCode Extension Development Host 内执行）。
 *
 * @vscode/test-electron 调用的 entry：必须导出 `run(): Promise<void>`，
 * 失败则抛错。用 mocha（bdd）加载 out/test/integration/*.integration.js。
 */
import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000 });
  const testsRoot = __dirname;

  return new Promise<void>((resolve, reject) => {
    const files = fs
      .readdirSync(testsRoot)
      .filter((f) => f.endsWith('.integration.js'))
      .sort();
    if (files.length === 0) {
      reject(new Error('未找到集成测试文件：请先 npm run build'));
      return;
    }
    files.forEach((f) => mocha.addFile(path.join(testsRoot, f)));
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} 个集成测试失败`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}