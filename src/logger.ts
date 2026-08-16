/**
 * 扩展侧分级日志（P0.3）：OutputChannel 输出，支持 dsh.log.level 控制。
 */
import * as vscode from 'vscode';

export type LogLevel = 'info' | 'debug';

class DshLogger {
  private channel: vscode.OutputChannel | undefined;
  private level: LogLevel = 'info';

  init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('dsh');
    this.level = vscode.workspace.getConfiguration('dsh').get<LogLevel>('log.level', 'info');
    context.subscriptions.push(this.channel);
    this.info('logger 初始化完成（level=' + this.level + '）');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  info(msg: string): void {
    this.write('INFO', msg);
  }

  debug(msg: string): void {
    if (this.level === 'debug') {
      this.write('DEBUG', msg);
    }
  }

  warn(msg: string): void {
    this.write('WARN', msg);
  }

  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? ` — ${err.message}` : '';
    this.write('ERROR', msg + detail);
  }

  show(): void {
    this.channel?.show(true);
  }

  private write(level: string, msg: string): void {
    if (!this.channel) return;
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] [${level}] ${msg}`);
  }
}

export const logger = new DshLogger();
