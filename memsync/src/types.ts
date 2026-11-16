export type Tool = "claude-code" | "codex";

export type NoteKind = "progress" | "decision" | "blocker" | "todo" | "handoff";

export interface Identity {
  name: string;
  email: string;
}

export interface GlobalConfig {
  version: number;
  repoPath: string;
  remoteUrl: string;
  identity: Identity;
  defaultBudgetChars: number;
}
