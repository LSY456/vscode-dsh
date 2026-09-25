import * as vscode from 'vscode';
import { logger } from './logger';
import { TRUST_MANAGE_COMMAND } from './workspaceTrust';

/**
 * 打开 VS Code 的「工作区信任」管理界面。
 *
 * 唯一出口：扩展命令 `dsh.trustWorkspace`、状态栏受限项、面板横幅的「信任此工作区」按钮都走它，
 * 这样三处的行为与失败兜底文案不会各自漂移。
 */
export async function openTrustManagement(): Promise<void> {
  try {
    await vscode.commands.executeCommand(TRUST_MANAGE_COMMAND);
  } catch (err) {
    // 内建命令在极老版本 / 精简发行版上可能不存在：给出手动路径，不要静默失败
    logger.warn(`打开工作区信任管理失败: ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showInformationMessage(
      '未能自动打开工作区信任界面。请在命令面板中搜索「信任」并信任此工作区后重试。'
    );
  }
}
