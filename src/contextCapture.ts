/**
 * 主动上下文捕获。
 *
 * 使用 VSCode API 自动打包：
 *  - activeTextEditor：光标所在文件全文 + 高亮选区（含行区间）
 *  - vscode.languages.getDiagnostics：当前文件诊断 + 工作区诊断摘要
 *  - git status（可配置开关，失败静默跳过）
 * 组装为结构化 Attachment 列表发送给 daemon。
 */
import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Attachment, Diagnostic } from '../shared/protocol';
import { resolveWorkspaceRoot } from './workspaceRoot';

export interface CaptureOptions {
  maxFileBytes?: number;
  includeGitStatus?: boolean;
  maxDiagnostics?: number;
}

export async function captureContext(opts?: CaptureOptions): Promise<Attachment[]> {
  const cfg = vscode.workspace.getConfiguration('dsh');
  const maxFileBytes = opts?.maxFileBytes ?? cfg.get<number>('context.maxFileBytes', 200_000);
  const includeGitStatus = opts?.includeGitStatus ?? cfg.get<boolean>('context.gitStatus', true);
  const maxDiagnostics = opts?.maxDiagnostics ?? 50;

  const attachments: Attachment[] = [];

  // ---- 1. 活动编辑器：文件 + 选区 + 诊断
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const text = doc.getText();
    if (text.length > maxFileBytes) {
      // 大文件（P1.6）：省略内容，daemon 可按需 file.read
      attachments.push({
        kind: 'file',
        uri: doc.uri.toString(),
        path: doc.uri.fsPath,
        language: doc.languageId,
        name: fileName(doc.uri),
        contentOmitted: true,
      });
    } else {
      attachments.push({
        kind: 'file',
        uri: doc.uri.toString(),
        path: doc.uri.fsPath,
        language: doc.languageId,
        name: fileName(doc.uri),
        content: text,
      });
    }

    const sel = editor.selection;
    if (!sel.isEmpty) {
      attachments.push({
        kind: 'selection',
        uri: doc.uri.toString(),
        path: doc.uri.fsPath,
        language: doc.languageId,
        content: doc.getText(sel),
        range: { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
      });
    }

    const fileDiags = vscode.languages.getDiagnostics(doc.uri);
    if (fileDiags.length > 0) {
      attachments.push({
        kind: 'diagnostics',
        uri: doc.uri.toString(),
        name: `诊断（${fileName(doc.uri)}）`,
        diagnostics: fileDiags.slice(0, maxDiagnostics).map(mapDiagnostic),
      });
    }
  }

  // ---- 2. 工作区诊断摘要
  const wsDiags = summarizeWorkspaceDiagnostics();
  if (wsDiags.length > 0) {
    attachments.push({ kind: 'diagnostics', name: '工作区诊断摘要', diagnostics: wsDiags });
  }

  // ---- 3. git status
  if (includeGitStatus) {
    const git = await getGitStatus();
    if (git) {
      attachments.push({ kind: 'gitStatus', gitStatus: git });
    }
  }

  return attachments;
}

function mapDiagnostic(d: vscode.Diagnostic): Diagnostic {
  const severity =
    d.severity === vscode.DiagnosticSeverity.Error
      ? 'error'
      : d.severity === vscode.DiagnosticSeverity.Warning
        ? 'warning'
        : d.severity === vscode.DiagnosticSeverity.Information
          ? 'info'
          : 'hint';
  const r = d.range;
  return {
    severity,
    message: d.message,
    source: typeof d.source === 'string' ? d.source : undefined,
    range: {
      startLine: r.start.line + 1,
      startCol: r.start.character + 1,
      endLine: r.end.line + 1,
      endCol: r.end.character + 1,
    },
  };
}

function summarizeWorkspaceDiagnostics(): Diagnostic[] {
  const all = vscode.languages.getDiagnostics();
  const summary: Diagnostic[] = [];
  for (const [, diags] of all) {
    if (diags.length === 0) continue;
    const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
    // 工作区摘要取各文件前 3 条错误，避免 payload 过大
    const top = diags
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 3)
      .map(mapDiagnostic);
    summary.push({
      severity: 'error',
      message: `${diags.length} 条诊断（${errors} 错误 / ${warnings} 警告）`,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      source: 'workspace-summary',
    });
    summary.push(...top);
    if (summary.length >= 60) break;
  }
  return summary;
}

function getGitStatus(): Promise<string | null> {
  // 工作区根的解析收在 resolveWorkspaceRoot（P0-2）：没有文件夹就明确不做，不猜目录
  const ws = resolveWorkspaceRoot(vscode.workspace.workspaceFolders);
  if (!ws.ok) return Promise.resolve(null);
  const root = ws.root;
  return new Promise((resolve) => {
    let settled = false;
    const child = cp.execFile(
      'git',
      ['-C', root, 'status', '--short', '--branch'],
      { timeout: 3000, maxBuffer: 1024 * 256 },
      (err, stdout) => {
        if (settled) return;
        settled = true;
        if (err || !stdout) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      }
    );
    child.on('error', () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    // 保险：超时兜底
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(null);
      }
    }, 3500);
  });
}

function fileName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath || uri.path) || 'untitled';
}
