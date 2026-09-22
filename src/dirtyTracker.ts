/**
 * 脏文档跟随（P0-1 客户端侧）。
 *
 * 把编辑器里「有未保存改动」的文档内容推给 daemon（`workspace.syncDirty`，全量快照），
 * 让 Agent 读到的是**用户此刻看到的内容**，而不是过期的磁盘版本；同时让 daemon 知道
 * 哪些文件处于未保存态，从而在「应用补丁」时避开磁盘、改走编辑器缓冲区。
 *
 * 触发时机：文档变更（去抖）、保存、关闭、打开，以及**每次发消息前**（`syncNow`）——
 * 最后这条是关键：用户打完字立刻提问，去抖窗口可能还没到点，必须显式冲刷。
 *
 * 体积控制：超大文件只上报「脏」不上报内容（`content` 缺省），既避免把几 MB 文本反复
 * 推过 WebSocket，又不牺牲写入安全——daemon 侧照样不会去覆盖它。
 */
import * as vscode from 'vscode';
import { METHODS } from '../shared/protocol';
import type { DshClient } from './wsClient';

/** 单文件内容上报上限：超过则只上报脏状态。 */
export const MAX_PUSH_FILE_BYTES = 512 * 1024;
/** 单次快照内容总量上限（超出部分只上报脏状态）。 */
export const MAX_PUSH_TOTAL_BYTES = 2 * 1024 * 1024;
/** 单次快照条目上限。 */
export const MAX_PUSH_FILES = 200;

export interface DirtyTrackerOptions {
  /** 取当前客户端（重连会换实例，故用 getter 而非直接持有） */
  getClient: () => DshClient | undefined;
  /** 去抖窗口（ms） */
  debounceMs?: number;
}

/** 一个待上报的脏文档。 */
interface DirtyDoc {
  path: string;
  bytes: number;
  text: string;
}

export class DirtyTracker implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 上次上报内容的指纹，未变化时跳过推送（避免用户在编辑器里只是移动光标也发一遍） */
  private lastSignature = '';
  private readonly disposables: vscode.Disposable[] = [];
  private readonly debounceMs: number;

  constructor(private readonly opts: DirtyTrackerOptions) {
    this.debounceMs = opts.debounceMs ?? 300;
    const onChange = (doc: vscode.TextDocument) => {
      if (this.isRelevant(doc)) this.schedule();
    };
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => onChange(e.document)),
      vscode.workspace.onDidOpenTextDocument(onChange),
      // 保存 / 关闭都会让文件离开脏集合，需要立刻把覆盖层里的旧内容撤掉
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.workspace.onDidCloseTextDocument(() => this.schedule())
    );
  }

  /** 去抖后上报。 */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync();
    }, this.debounceMs);
  }

  /**
   * 立即上报（发消息前调用）。
   * 失败不抛：脏文档同步只是"让结果更准"，不该阻断用户发消息。
   */
  async syncNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.sync();
  }

  private async sync(): Promise<void> {
    const client = this.opts.getClient();
    if (!client) return;
    const files = this.collect();
    const signature = files.map((f) => `${f.path}:${f.bytes}`).join('|');
    if (signature === this.lastSignature) return;

    const payload: Array<{ path: string; content?: string }> = [];
    let budget = MAX_PUSH_TOTAL_BYTES;
    for (const f of files) {
      if (payload.length >= MAX_PUSH_FILES) break;
      if (f.bytes <= MAX_PUSH_FILE_BYTES && f.bytes <= budget) {
        budget -= f.bytes;
        payload.push({ path: f.path, content: f.text });
      } else {
        payload.push({ path: f.path }); // 只报「脏」
      }
    }

    try {
      await client.request(METHODS.WorkspaceSyncDirty, { files: payload });
      this.lastSignature = signature;
    } catch {
      // 上报失败（daemon 正在重连等）：保留旧指纹，下次变更时会重试
    }
  }

  /** 收集当前工作区内所有脏文档（按路径排序，保证快照确定性）。 */
  private collect(): DirtyDoc[] {
    const out: DirtyDoc[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!this.isRelevant(doc)) continue;
      const text = doc.getText();
      out.push({ path: doc.uri.fsPath, bytes: Buffer.byteLength(text, 'utf8'), text });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** 只关心「工作区内的磁盘文件」：untitled / 输出面板 / diff 虚拟文档一律不算。 */
  private isRelevant(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file' || !doc.isDirty) return false;
    return vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
