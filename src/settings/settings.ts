export interface GiteeSyncSettings {
  firstSync: boolean;
  giteeToken: string;
  giteeOwner: string;
  giteeRepo: string;
  giteeBranch: string;
  syncStrategy: "manual" | "interval";
  syncInterval: number;
  syncOnStartup: boolean;
  syncConfigDir: boolean;
  conflictHandling: "overwriteLocal" | "ask" | "overwriteRemote";
  conflictViewMode: "default" | "unified" | "split";
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  showConflictsRibbonButton: boolean;
  enableLogging: boolean;
}

export const DEFAULT_SETTINGS: GiteeSyncSettings = {
  firstSync: true,
  giteeToken: "",
  giteeOwner: "",
  giteeRepo: "",
  giteeBranch: "main",
  syncStrategy: "manual",
  syncInterval: 1,
  syncOnStartup: false,
  syncConfigDir: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: false,
};
