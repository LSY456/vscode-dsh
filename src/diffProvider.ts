/**
 * Native Diff 预览（方案流程四）。
 *
 * 当 daemon 发出 file.patch.pending：
 *  - 在内存中登记补丁，
 *  - 通过 vscode.diff 打开并排对比视图（左=旧内容，右=提议的新内容），
 *  - 开发者审查后在 **Diff 标题栏按钮** 或 Webview 卡片中选择应用/拒绝，
 *    扩展把决策回传 daemon（file.patch.respond），由 daemon 写盘并回执。
 *
 * 关键实现约束（P2 修正，集成测试 T6 守住）：
 *  scheme `dsh-patch` 必须由 **FileSystemProvider** 提供，而不是 TextDocumentContentProvider——
 *  后者在 VS Code 中被判定为只读文档，用户在 Diff 右侧根本敲不进字（输入通道被拦），
 *  "编辑后应用" 会退化成只能看。改用可写文件系统提供器后，右侧是可编辑的脏文档，
 *  applyEdited 直接读编辑器缓冲区即可（无需先保存）。
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { EventFilePatchPending, EventFilePatchResult, METHODS } from '../shared/protocol';
import { DshClient } from './wsClient';

const SCHEME = 'dsh-patch';
/** 已回执的补丁视图保留数量（可回看，不再可写） */
const MAX_RESOLVED_RECORDS = 20;

/** 路径比较（Windows 忽略大小写）。 */
function sameFile(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * P0-1：把补丁内容写进**编辑器缓冲区**（整文件替换），磁盘不动。
 * 改动保持未保存态，由用户复核后自行保存——这正是“不会静默覆盖未保存改动”的实现方式。
 */
async function applyToDocument(doc: vscode.TextDocument, content: string): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, full, content);
  return vscode.workspace.applyEdit(edit);
}

interface PatchRecord {
  patchId: string;
  sessionId: string;
  filePath: string;
  oldContent?: string;
  newContent: string;
  description?: string;
  /** daemon 已回执（应用/拒绝）：仍可查看，但不接受写入 */
  resolved?: boolean;
}

export class DshDiffManager implements vscode.FileSystemProvider {
  private readonly records = new Map<string, PatchRecord>();
  /** patchId -> 用户在新内容侧编辑后的缓冲区（仅内存，落盘由 daemon 执行） */
  private readonly edited = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly clientGetter: () => DshClient | null;

  constructor(clientGetter: () => DshClient | null) {
    this.clientGetter = clientGetter;
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      // isReadonly: false —— 这是"编辑后应用"能用的前提
      vscode.workspace.registerFileSystemProvider(SCHEME, this, {
        isCaseSensitive: true,
        isReadonly: false,
      }),
      vscode.commands.registerCommand('dsh.diff.open', (arg?: unknown) => {
        const patchId = this.resolvePatchId(arg);
        if (patchId) void this.openDiff(patchId);
      }),
      vscode.commands.registerCommand('dsh.diff.accept', (arg?: unknown) => {
        const patchId = this.resolvePatchId(arg);
        if (patchId) void this.respond(patchId, true);
      }),
      vscode.commands.registerCommand('dsh.diff.reject', (arg?: unknown) => {
        const patchId = this.resolvePatchId(arg);
        if (patchId) void this.respond(patchId, false);
      }),
      // P2 编辑后应用：读取用户在 diff 新内容侧编辑后的文本，作为最终内容回传写盘
      vscode.commands.registerCommand('dsh.diff.applyEdited', (arg?: unknown) => {
        const patchId = this.resolvePatchId(arg);
        if (patchId) void this.applyEdited(patchId);
      })
    );
  }

  // ------------------------------------------------------------------ 事件入口

  /** daemon 发出补丁：登记 + 触发变更通知 + （可选）自动打开 Diff。 */
  handlePatchPending(p: EventFilePatchPending): void {
    this.pruneResolved();
    this.records.set(p.patchId, {
      patchId: p.patchId,
      sessionId: p.sessionId,
      filePath: p.path,
      oldContent: p.oldContent,
      newContent: p.newContent,
      description: p.description,
    });
    this.edited.delete(p.patchId);
    this.fire(this.makeUri(p.patchId, 'new'));
    this.fire(this.makeUri(p.patchId, 'old'));

    const autoOpen = vscode.workspace.getConfiguration('dsh').get<boolean>('diff.autoOpen', true);
    if (autoOpen) {
      void this.openDiff(p.patchId);
    }
  }

  handlePatchResult(p: EventFilePatchResult): void {
    const record = this.records.get(p.patchId);
    if (record) record.resolved = true;
    this.edited.delete(p.patchId);
    this.fire(this.makeUri(p.patchId, 'new'));
  }

  async openDiff(patchId: string): Promise<void> {
    const record = this.records.get(patchId);
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

  async respond(patchId: string, accept: boolean, content?: string): Promise<void> {
    const record = this.records.get(patchId);
    if (!record) {
      void vscode.window.showWarningMessage(`补丁不存在或已处理：${patchId}`);
      return;
    }
    const client = this.clientGetter();
    if (!client) {
      void vscode.window.showErrorMessage('daemon 未连接，无法回传补丁决策');
      return;
    }

    // P0-1 脏文档一致性：目标文件在编辑器里有未保存改动时，**不能让 daemon 写盘**——
    // 磁盘与缓冲区会就此分叉，用户下一次 Ctrl+S 就会用旧缓冲区覆盖掉 Agent 的结果。
    // 改走编辑器缓冲区：两边重新对齐，且改动保持"未保存"态，用户可自行复核后再保存。
    let applyInEditor = false;
    if (accept) {
      const doc = vscode.workspace.textDocuments.find((d) => sameFile(d.uri.fsPath, record.filePath));
      if (doc && doc.isDirty) {
        const finalContent = content ?? record.newContent;
        if (doc.getText() !== (record.oldContent ?? '')) {
          // 客户端侧乐观锁：审阅期间缓冲区又被改过，不静默覆盖（P0-2 在脏文档通路上的对应物）。
          // 仍照常回执：applyInEditor 为 false，daemon 会因"目标是脏文档"而拒绝落盘并给出原因，
          // Agent 因此不会一直挂着等 TTL 超时。
          void vscode.window.showWarningMessage(
            `dsh: ${path.basename(record.filePath)} 在审阅期间已被修改，未自动应用，请重新发起修改。`
          );
        } else if (await applyToDocument(doc, finalContent)) {
          applyInEditor = true;
        } else {
          void vscode.window.showErrorMessage(`dsh: 无法写入编辑器缓冲区 ${path.basename(record.filePath)}`);
          return;
        }
      }
    }

    try {
      await client.request(METHODS.FilePatchRespond, {
        sessionId: record.sessionId,
        patchId,
        accept,
        content,
        applyInEditor,
      });
      void vscode.window.setStatusBarMessage(
        `dsh: 已${accept ? (applyInEditor ? '应用到编辑器（未保存）' : '应用') : '拒绝'}补丁 ${path.basename(record.filePath)}`,
        4000
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`回传补丁决策失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** P2 编辑后应用：优先读 Diff 编辑器里的当前文本（含未保存的编辑），其次用 FS 写入缓冲。 */
  async applyEdited(patchId: string): Promise<void> {
    const record = this.records.get(patchId);
    if (!record) {
      void vscode.window.showWarningMessage(`补丁不存在或已处理：${patchId}`);
      return;
    }
    const newUri = this.makeUri(patchId, 'new');
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === newUri.toString()
    );
    const content = editor ? editor.document.getText() : this.edited.get(patchId);
    if (typeof content !== 'string') {
      void vscode.window.showWarningMessage('未找到补丁的编辑视图，请先打开 Diff');
      return;
    }
    await this.respond(patchId, true, content);
  }

  // ------------------------------------------------------------------ FileSystemProvider
  // 只实现"可读可写的内存文件"，其余操作（删除/重命名/建目录）对补丁视图无意义

  readFile(uri: vscode.Uri): Uint8Array {
    return Buffer.from(this.contentOf(uri), 'utf8');
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const { patchId, side } = parsePatchUri(uri);
    const record = this.records.get(patchId);
    if (!record || side !== 'new') {
      throw vscode.FileSystemError.NoPermissions('dsh 补丁视图不可写');
    }
    if (record.resolved) {
      throw vscode.FileSystemError.NoPermissions('补丁已处理，无法再编辑');
    }
    this.edited.set(patchId, Buffer.from(content).toString('utf8'));
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (isRoot(uri)) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const text = this.contentOf(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: Buffer.byteLength(text, 'utf8'),
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (!isRoot(uri)) return [];
    return [...this.records.keys()].map((id) => [`${id}.patch`, vscode.FileType.File]);
  }

  watch(): vscode.Disposable {
    // 内容变更由本类内部驱动（writeFile / 补丁回执），无需监听外部文件系统
    return new vscode.Disposable(() => undefined);
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('dsh 补丁视图为只读目录');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('dsh 补丁视图不支持删除');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('dsh 补丁视图不支持重命名');
  }

  // ------------------------------------------------------------------ 内部

  /** 命令参数解析：Diff 标题栏传入的是当前编辑器 URI；命令面板调用时取唯一的挂起补丁。 */
  private resolvePatchId(arg?: unknown): string | undefined {
    if (arg && typeof arg === 'object' && 'scheme' in (arg as vscode.Uri)) {
      const parsed = tryParsePatchUri(arg as vscode.Uri);
      if (parsed?.patchId) return parsed.patchId;
    }
    if (typeof arg === 'string' && arg) return arg;
    const open = [...this.records.values()].filter((r) => !r.resolved);
    if (open.length === 1) return open[0].patchId;
    if (open.length === 0) {
      void vscode.window.showInformationMessage('当前没有待审查的补丁');
      return undefined;
    }
    void vscode.window.showInformationMessage('存在多个待审查补丁，请在面板或 Diff 标题栏中选择');
    return undefined;
  }

  private contentOf(uri: vscode.Uri): string {
    const { patchId, side } = parsePatchUri(uri);
    const record = this.records.get(patchId);
    if (!record) throw vscode.FileSystemError.FileNotFound(uri);
    if (side === 'old') return record.oldContent ?? '';
    return this.edited.get(patchId) ?? record.newContent;
  }

  private fire(uri: vscode.Uri): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  private pruneResolved(): void {
    const resolved = [...this.records.values()].filter((r) => r.resolved);
    if (resolved.length <= MAX_RESOLVED_RECORDS) return;
    for (const r of resolved.slice(0, resolved.length - MAX_RESOLVED_RECORDS)) {
      this.records.delete(r.patchId);
      this.edited.delete(r.patchId);
    }
  }

  private makeUri(patchId: string, side: 'old' | 'new'): vscode.Uri {
    return vscode.Uri.parse(
      `${SCHEME}://pending/${encodeURIComponent(patchId)}?side=${side}&patchId=${encodeURIComponent(patchId)}`
    );
  }
}

function isRoot(uri: vscode.Uri): boolean {
  return uri.path === '' || uri.path === '/';
}

function parsePatchUri(uri: vscode.Uri): { patchId: string; side: 'old' | 'new' } {
  const query = new URLSearchParams(uri.query);
  return {
    patchId: query.get('patchId') ?? '',
    side: query.get('side') === 'old' ? 'old' : 'new',
  };
}

function tryParsePatchUri(uri: vscode.Uri): { patchId: string; side: 'old' | 'new' } | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const parsed = parsePatchUri(uri);
  return parsed.patchId ? parsed : undefined;
}
