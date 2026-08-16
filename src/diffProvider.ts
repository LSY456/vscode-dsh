/**
 * Native Diff 预览（方案流程四）。
 *
 * 当 daemon 发出 file.patch.pending：
 *  - 在内存中登记补丁（虚拟文档，scheme: dsh-patch），
 *  - 通过 vscode.diff(oldUri, newUri) 打开并排对比视图，
 *  - 开发者审查后在原生 Diff 视图或 Webview 卡片中选择应用/拒绝，
 *    扩展将决策回传 daemon（file.patch.respond），由 daemon 写盘并回执。
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { EventFilePatchPending, EventFilePatchResult, METHODS } from '../shared/protocol';
import { DshClient } from './wsClient';

const SCHEME = 'dsh-patch';

interface PatchRecord {
  patchId: string;
  sessionId: string;
  filePath: string;
  oldContent?: string;
  newContent: string;
  description?: string;
}

export class DshDiffManager implements vscode.TextDocumentContentProvider {
  private records = new Map<string, PatchRecord>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly clientGetter: () => DshClient | null;

  constructor(clientGetter: () => DshClient | null) {
    this.clientGetter = clientGetter;
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, this));
    context.subscriptions.push(
      vscode.commands.registerCommand('dsh.diff.open', (patchId?: string) => {
        if (patchId) void this.openDiff(patchId);
      }),
      vscode.commands.registerCommand('dsh.diff.accept', (patchId?: string) => {
        if (patchId) void this.respond(patchId, true);
      }),
      vscode.commands.registerCommand('dsh.diff.reject', (patchId?: string) => {
        if (patchId) void this.respond(patchId, false);
      })
    );
  }

  /** daemon 发出补丁：登记 + 触发变更通知 + （可选）自动打开 Diff。 */
  handlePatchPending(p: EventFilePatchPending): void {
    const record: PatchRecord = {
      patchId: p.patchId,
      sessionId: p.sessionId,
      filePath: p.path,
      oldContent: p.oldContent,
      newContent: p.newContent,
      description: p.description,
    };
    const uri = this.makeUri(p.patchId, 'new');
    this.records.set(uri.toString(), record);
    this.emitter.fire(uri);

    const autoOpen = vscode.workspace.getConfiguration('dsh').get<boolean>('diff.autoOpen', true);
    if (autoOpen) {
      void this.openDiff(p.patchId);
    }
  }

  handlePatchResult(p: EventFilePatchResult): void {
    const uri = this.makeUri(p.patchId, 'new');
    this.records.delete(uri.toString());
    this.emitter.fire(uri);
  }

  /** TextDocumentContentProvider：按 side 提供旧/新内容。 */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const query = new URLSearchParams(uri.query);
    const patchId = query.get('patchId') ?? '';
    const side = query.get('side') ?? 'new';
    const record = this.findRecord(patchId);
    if (!record) {
      return `// 补丁不存在或已处理：${patchId}`;
    }
    if (side === 'old') {
      return record.oldContent ?? '// 新文件（无旧内容）';
    }
    return record.newContent;
  }

  async openDiff(patchId: string): Promise<void> {
    const record = this.findRecord(patchId);
    if (!record) {
      void vscode.window.showWarningMessage(`补丁不存在或已处理：${patchId}`);
      return;
    }
    const oldUri = this.makeUri(patchId, 'old');
    const newUri = this.makeUri(patchId, 'new');
    const title = `dsh 补丁: ${path.basename(record.filePath)}`;
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri,
        newUri,
        title,
        { preview: true, viewColumn: vscode.ViewColumn.Beside }
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`打开 Diff 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async respond(patchId: string, accept: boolean): Promise<void> {
    const record = this.findRecord(patchId);
    if (!record) {
      void vscode.window.showWarningMessage(`补丁不存在或已处理：${patchId}`);
      return;
    }
    const client = this.clientGetter();
    if (!client) {
      void vscode.window.showErrorMessage('daemon 未连接，无法回传补丁决策');
      return;
    }
    try {
      await client.request(METHODS.FilePatchRespond, {
        sessionId: record.sessionId,
        patchId,
        accept,
      });
      void vscode.window.setStatusBarMessage(`dsh: 已${accept ? '接受' : '拒绝'}补丁 ${path.basename(record.filePath)}`, 4000);
    } catch (err) {
      void vscode.window.showErrorMessage(`回传补丁决策失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private findRecord(patchId: string): PatchRecord | undefined {
    for (const r of this.records.values()) {
      if (r.patchId === patchId) return r;
    }
    return undefined;
  }

  private makeUri(patchId: string, side: 'old' | 'new'): vscode.Uri {
    return vscode.Uri.parse(
      `${SCHEME}://pending/${encodeURIComponent(patchId)}?side=${side}&patchId=${encodeURIComponent(patchId)}`
    );
  }
}
