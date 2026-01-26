import {
  Vault,
  Notice,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "obsidian";
import GiteeClient, {
  GetTreeResponseItem,
  RepoContent,
  FileChange,
} from "./gitee/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GiteeSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { decodeBase64String, hasTextExtension } from "./utils";
import GiteeSyncPlugin from "./main";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import GitignoreParser from "./gitignore-parser";

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

type NewTreeRequestItem = {
  path: string;
  mode: string;
  type: string;
  sha?: string | null;
  content?: string;
};

export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GiteeClient;
  private eventsListener: EventsListener;
  private syncIntervalId: number | null = null;
  private gitignoreParser: GitignoreParser;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;

  constructor(
    private vault: Vault,
    private settings: GiteeSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GiteeClient(this.settings, this.logger);
    this.gitignoreParser = new GitignoreParser(this.vault);
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
      this.gitignoreParser,
    );
  }

  /**
   * Returns true if the local vault root is empty.
   */
  private async vaultIsEmpty(): Promise<boolean> {
    const { files, folders } = await this.vault.adapter.list(
      this.vault.getRoot().path,
    );
    // There are files or folders in the vault dir
    return (
      files.length === 0 ||
      // We filter out the config dir since is always present so it's fine if we find it.
      folders.filter((f) => f !== this.vault.configDir).length === 0
    );
  }

  /**
   * Handles first sync with remote and local.
   * This fails if neither remote nor local folders are empty.
   */
  async firstSync() {
    if (this.syncing) {
      this.logger.info("First sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    this.syncing = true;
    try {
      await this.firstSyncImpl();
    } catch (err) {
      this.syncing = false;
      throw err;
    }
    this.syncing = false;
  }

  private async firstSyncImpl() {
    await this.logger.info("Starting first sync");
    await this.logger.info("First sync settings", {
      giteeOwner: this.settings.giteeOwner,
      giteeRepo: this.settings.giteeRepo,
      giteeBranch: this.settings.giteeBranch,
    });

    let repositoryIsEmpty = false;
    let res: RepoContent;
    let files: {
      [key: string]: GetTreeResponseItem;
    } = {};
    let treeSha: string = "";

    await this.logger.info("Fetching remote repo content for first sync...");
    try {
      res = await this.client.getRepoContent();
      files = res.files;
      treeSha = res.sha;
      await this.logger.info("Remote repo content fetched successfully", {
        filesCount: Object.keys(files).length,
        treeSha,
      });
    } catch (err) {
      await this.logger.error("Failed to fetch remote repo content", {
        message: err.message,
        status: err.status,
        stack: err.stack,
      });
      // 409 is returned in case the remote repo has been just created
      // and contains no files.
      // 404 instead is returned in case there are no files.
      // Either way we can handle both by commiting a new empty manifest.
      if (err.status !== 409 && err.status !== 404) {
        this.syncing = false;
        throw err;
      }
      // The repository is bare, meaning it has no tree, no commits and no branches
      repositoryIsEmpty = true;
      await this.logger.info("Remote repository is empty (409 or 404)", {
        repositoryIsEmpty,
      });
    }

    if (repositoryIsEmpty) {
      await this.logger.info("Remote repository is empty");
      // Since the repository is completely empty we need to create a first commit.
      // We can't create that by going throught the normal sync process since the
      // API doesn't let us create a new tree when the repo is empty.
      // So we create a the manifest file as the first commit, since we're going
      // to create that in any case right after this.
      const buffer = await this.vault.adapter.readBinary(
        normalizePath(`${this.vault.configDir}/${MANIFEST_FILE_NAME}`),
      );
      await this.client.createFile({
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        content: arrayBufferToBase64(buffer),
        message: "First sync",
        retry: true,
      });
      // Now get the repo content again cause we know for sure it will return a
      // valid sha that we can use to create the first sync commit.
      res = await this.client.getRepoContent({ retry: true });
      files = res.files;
      treeSha = res.sha;
    }

    const vaultIsEmpty = await this.vaultIsEmpty();

    if (!repositoryIsEmpty && !vaultIsEmpty) {
      // Both have files, we can't sync, show error
      await this.logger.error("Both remote and local have files, can't sync");
      throw new Error("Both remote and local have files, can't sync");
    } else if (repositoryIsEmpty) {
      // Remote has no files and no manifest, let's just upload whatever we have locally.
      // This is fine even if the vault is empty.
      // The most important thing at this point is that the remote manifest is created.
      await this.firstSyncFromLocal(files, treeSha);
    } else {
      // Local has no files and there's no manifest in the remote repo.
      // Let's download whatever we have in the remote repo.
      // This is fine even if the remote repo is empty.
      // In this case too the important step is that the remote manifest is created.
      await this.firstSyncFromRemote(files, treeSha);
    }
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the local content dir while
   * remote has files in the repo content dir but no manifest file.
   *
   * @param files All files in the remote repository, including those not in its content dir.
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from remote files");

    // We want to avoid getting throttled by Gitee, so instead of making a request for each
    // file we download the whole repository as a ZIP file and extract it in the vault.
    // We exclude config dir files if the user doesn't want to sync those.
    const zipBuffer = await this.client.downloadRepositoryArchive();
    const zipBlob = new Blob([zipBuffer]);
    const reader = new ZipReader(new BlobReader(zipBlob));
    const entries = await reader.getEntries();

    await this.logger.info("Extracting files from ZIP", {
      length: entries.length,
    });

    await Promise.all(
      entries.map(async (entry: Entry) => {
        // All repo ZIPs contain a root directory that contains all the content
        // of that repo, we need to ignore that directory so we strip the first
        // folder segment from the path
        const pathParts = entry.filename.split("/");
        const targetPath =
          pathParts.length > 1 ? pathParts.slice(1).join("/") : entry.filename;

        if (targetPath === "") {
          // Must be the root folder, skip it.
          // This is really important as that would lead us to try and
          // create the folder "/" and crash Obsidian
          return;
        }

        if (
          this.settings.syncConfigDir &&
          targetPath.startsWith(this.vault.configDir) &&
          targetPath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
        ) {
          await this.logger.info("Skipped config", { targetPath });
          return;
        }

        if (entry.directory) {
          const normalizedPath = normalizePath(targetPath);
          await this.vault.adapter.mkdir(normalizedPath);
          await this.logger.info("Created directory", {
            normalizedPath,
          });
          return;
        }

        if (targetPath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
          // We don't want to download the log file if the user synced it in the past.
          // This is necessary because in the past we forgot to ignore the log file
          // from syncing if the user enabled configs sync.
          // To avoid downloading it we ignore it if still present in the remote repo.
          return;
        }

        // Check if file is ignored by .gitignore rules
        if (this.gitignoreParser.isIgnored(targetPath)) {
          await this.logger.info("Skipping ignored file (from .gitignore)", targetPath);
          return;
        }

        const writer = new Uint8ArrayWriter();
        await entry.getData!(writer);
        const data = await writer.getData();
        const dir = targetPath.split("/").splice(0, -1).join("/");
        if (dir !== "") {
          const normalizedDir = normalizePath(dir);
          await this.vault.adapter.mkdir(normalizedDir);
          await this.logger.info("Created directory", {
            normalizedDir,
          });
        }

        const normalizedPath = normalizePath(targetPath);
        await this.vault.adapter.writeBinary(
          normalizedPath,
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
        await this.logger.info("Written file", {
          normalizedPath,
        });

        // Only add to metadata if the file exists in the remote files list
        if (files[normalizedPath]) {
          this.metadataStore.data.files[normalizedPath] = {
            path: normalizedPath,
            sha: files[normalizedPath].sha,
            dirty: false,
            justDownloaded: true,
            lastModified: Date.now(),
          };
          await this.metadataStore.save();
        } else {
          await this.logger.warn("File not in remote tree, skipping metadata", {
            normalizedPath,
          });
        }
      }),
    );

    await this.logger.info("Extracted zip");

    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {} as { [key: string]: NewTreeRequestItem },
      );
    // Add files that are in the manifest but not in the tree.
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          return !Object.keys(files).contains(filePath);
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the remote repo and no manifest while
   * local vault has files and a manifest.
   *
   * @param files All files in the remote repository
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromLocal(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    await this.logger.info("Starting first sync from local files");
    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {} as { [key: string]: NewTreeRequestItem },
      );
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          // We should not try to sync deleted files, this can happen when
          // the user renames or deletes files after enabling the plugin but
          // before syncing for the first time
          return !this.metadataStore.data.files[filePath].deleted;
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Syncs local and remote folders.
   * @returns
   */
  async sync() {
    if (this.syncing) {
      this.logger.info("Sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    const notice = new Notice("Syncing...");
    this.syncing = true;
    try {
      await this.syncImpl();
      // Shown only if sync doesn't fail
      new Notice("Sync successful", 5000);
    } catch (err) {
      // Log the error with full details
      await this.logger.error("Sync failed", {
        message: err.message,
        stack: err.stack,
        status: err.status,
        name: err.name,
      });
      // Also log to console for debugging
      console.error("[SyncManager] Sync failed:", err);
      console.error("[SyncManager] Error details:", {
        message: err.message,
        stack: err.stack,
        status: err.status,
      });
      // Show the error to the user, it's not automatically dismissed to make sure
      // the user sees it.
      new Notice(`Error syncing. ${err}`);
    } finally {
      this.syncing = false;
      notice.hide();
    }
  }

  private async syncImpl() {
    let files: { [key: string]: GetTreeResponseItem };
    let treeSha: string;
    let manifest: GetTreeResponseItem | undefined;

    await this.logger.info("Starting sync");
    const repoContent = await this.client.getRepoContent({
      retry: true,
    });
    files = repoContent.files;
    treeSha = repoContent.sha;
    manifest = files[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`];

    if (manifest === undefined) {
      await this.logger.error("Remote manifest is missing", { files, treeSha });
      throw new Error("Remote manifest is missing");
    }

    if (
      Object.keys(files).contains(`${this.vault.configDir}/${LOG_FILE_NAME}`)
    ) {
      // We don't want to download the log file if the user synced it in the past.
      // This is necessary because in the past we forgot to ignore the log file
      // from syncing if the user enabled configs sync.
      // To avoid downloading it we delete it if still around.
      delete files[`${this.vault.configDir}/${LOG_FILE_NAME}`];
    }

    const fileContent = await this.client.getFileContent({
      path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
      retry: true,
    });

    await this.logger.info("Retrieved manifest file content", {
      path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
      contentLength: fileContent.content?.length,
      contentType: fileContent.type,
      encoding: fileContent.encoding,
      contentPreview: fileContent.content?.substring(0, 100),
    });

    // Gitee API returns content in different formats depending on the endpoint
    // For the /contents/{path} endpoint, text files may return content as:
    // 1. base64 encoded string (with encoding: "base64")
    // 2. plain text string (with encoding: "text" or undefined)
    // We need to handle both cases by trying multiple approaches
    const manifestContentRaw = fileContent.content;

    await this.logger.info("Attempting to parse manifest content...");

    // Try different parsing strategies
    const strategies = [
      {
        name: "Direct JSON parse (no encoding)",
        parse: (content: string) => JSON.parse(content),
      },
      {
        name: "Base64 decode then JSON parse",
        parse: (content: string) => JSON.parse(decodeBase64String(content)),
      },
      {
        name: "Double base64 decode then JSON parse",
        parse: (content: string) => JSON.parse(decodeBase64String(decodeBase64String(content))),
      },
    ];

    let remoteMetadata: Metadata | undefined;
    for (const strategy of strategies) {
      try {
        await this.logger.info(`Trying strategy: ${strategy.name}`);
        const result = strategy.parse(manifestContentRaw);
        remoteMetadata = result;
        await this.logger.info(`Successfully parsed manifest using: ${strategy.name}`, {
          preview: JSON.stringify(remoteMetadata).substring(0, 200),
        });
        break;
      } catch (err) {
        await this.logger.info(`Strategy "${strategy.name}" failed`, {
          error: err.message,
        });
      }
    }

    if (!remoteMetadata) {
      await this.logger.error("All parsing strategies failed", {
        originalContent: manifestContentRaw,
      });
      throw new Error(
        `Failed to parse manifest after trying all strategies (direct, single base64, double base64)`
      );
    }

    const conflicts = await this.findConflicts(remoteMetadata.files);

    // We treat every resolved conflict as an upload SyncAction, mainly cause
    // the user has complete freedom on the edits they can apply to the conflicting files.
    // So when a conflict is resolved we change the file locally and upload it.
    // That solves the conflict.
    let conflictActions: SyncAction[] = [];
    // We keep track of the conflict resolutions cause we want to update the file
    // locally only when we're sure the sync was successul. That happens after we
    // commit the sync.
    let conflictResolutions: ConflictResolution[] = [];

    if (conflicts.length > 0) {
      await this.logger.warn("Found conflicts", conflicts);
      if (this.settings.conflictHandling === "ask") {
        // Here we block the sync process until the user has resolved all the conflicts
        conflictResolutions = await this.onConflicts(conflicts);
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        // The user explicitly wants to always overwrite the local file
        // in case of conflicts so we just download the remote file to solve it

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the remote file with no changes.
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "download", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        // The user explicitly wants to always overwrite the remote file
        // in case of conflicts so we just upload the remote file to solve it.

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the local file with no changes.
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      }
    }

    const actions: SyncAction[] = [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        this.metadataStore.data.files,
        conflictActions.map((action) => action.filePath),
      )),
      ...conflictActions,
    ];

    if (actions.length === 0) {
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      return;
    }
    await this.logger.info("Actions to sync", actions);

    const newTreeFiles: { [key: string]: NewTreeRequestItem } = Object.keys(
      files,
    )
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {} as { [key: string]: NewTreeRequestItem },
      );

    await Promise.all(
      actions.map(async (action) => {
        switch (action.type) {
          case "upload": {
            const normalizedPath = normalizePath(action.filePath);
            const resolution = conflictResolutions.find(
              (c: ConflictResolution) => c.filePath === action.filePath,
            );
            // If the file was conflicting we need to read the content from the
            // conflict resolution instead of reading it from file since at this point
            // we still have not updated the local file.
            const content =
              resolution?.content ||
              (await this.vault.adapter.read(normalizedPath));
            newTreeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              content: content,
            };
            break;
          }
          case "delete_remote": {
            newTreeFiles[action.filePath].sha = null;
            break;
          }
          case "download":
            break;
          case "delete_local":
            break;
        }
      }),
    );

    // Download files and delete local files
    await Promise.all([
      ...actions
        .filter((action) => action.type === "download")
        .map(async (action: SyncAction) => {
          await this.downloadFile(
            files[action.filePath],
            remoteMetadata.files[action.filePath].lastModified,
          );
        }),
      ...actions
        .filter((action) => action.type === "delete_local")
        .map(async (action: SyncAction) => {
          await this.deleteLocalFile(action.filePath);
        }),
    ]);

    await this.commitSync(newTreeFiles, treeSha, conflictResolutions);
  }

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<ConflictFile[]> {
    const commonFiles = Object.keys(filesMetadata).filter(
      (key) => key in this.metadataStore.data.files,
    );
    if (commonFiles.length === 0) {
      return [];
    }

    const conflicts = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file is only internal, the user must not
          // handle conflicts for this
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }
        const actualLocalSHA = await this.calculateSHA(filePath);
        const remoteFileHasBeenModifiedSinceLastSync =
          remoteFile.sha !== localFile.sha;
        const localFileHasBeenModifiedSinceLastSync =
          actualLocalSHA !== localFile.sha;
        // This is an unlikely case. If the user manually edits
        // the local file so that's identical to the remote one,
        // but the local metadata SHA is different we don't want
        // to show a conflict.
        // Since that would show two identical files.
        // Checking for this prevents showing a non conflict to the user.
        const actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA;
        if (
          remoteFileHasBeenModifiedSinceLastSync &&
          localFileHasBeenModifiedSinceLastSync &&
          actualFilesAreDifferent
        ) {
          return filePath;
        }
        return null;
      }),
    );

    return await Promise.all(
      conflicts
        .filter((filePath): filePath is string => filePath !== null)
        .map(async (filePath: string) => {
          // Load contents in parallel
          const [remoteContent, localContent] = await Promise.all([
            await (async () => {
              const res = await this.client.getFileContent({
                path: filePath,
                retry: true,
                maxRetries: 1,
              });
              return decodeBase64String(res.content);
            })(),
            await this.vault.adapter.read(normalizePath(filePath)),
          ]);
          return {
            filePath,
            remoteContent,
            localContent,
          };
        }),
    );
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
  ) {
    let actions: SyncAction[] = [];

    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localSHA = await this.calculateSHA(filePath);
        if (remoteFile.sha === localSHA) {
          // If the remote file sha is identical to the actual sha of the local file
          // there are no actions to take.
          // We calculate the SHA at the moment instead of using the one stored in the
          // metadata file cause we update that only when the file is uploaded or downloaded.
          return;
        }

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({
              type: "delete_local",
              filePath: filePath,
            });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({
              type: "delete_remote",
              filePath: filePath,
            });
            return;
          }
        }

        // For non-deletion cases, if SHAs differ, we just need to check if local changed.
        // Conflicts are already filtered out so we can make this decision easily
        if (localSHA !== localFile.sha) {
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
        // TODO: Maybe we need to remove remote reference too?
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    Object.keys(localFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (remoteFile) {
        // Remote file exists, we already handled it.
        // Skip it.
        return;
      }
      if (localFile.deleted) {
        // Local is deleted and remote doesn't exist.
        // Just remove the local reference.
      } else {
        actions.push({ type: "upload", filePath: filePath });
      }
    });

    if (!this.settings.syncConfigDir) {
      // Remove all actions that involve the config directory if the user doesn't want to sync it.
      // The manifest file is always synced.
      return actions.filter((action: SyncAction) => {
        return (
          !action.filePath.startsWith(this.vault.configDir) ||
          action.filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
        );
      });
    }

    return actions;
  }

  /**
   * Calculates the SHA1 of a file given its content.
   * This is the same identical algoritm used by git to calculate
   * a blob's SHA.
   * @param filePath normalized path to file
   * @returns String containing the file SHA1 or null in case the file doesn't exist
   */
  async calculateSHA(filePath: string): Promise<string | null> {
    if (!(await this.vault.adapter.exists(filePath))) {
      // The file doesn't exist, can't calculate any SHA
      return null;
    }
    const contentBuffer = await this.vault.adapter.readBinary(filePath);
    const contentBytes = new Uint8Array(contentBuffer);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  /**
   * Creates a new sync commit in the remote repository.
   *
   * @param treeFiles Updated list of files in the remote tree
   * @param baseTreeSha sha of the tree to use as base for the new tree (not used in Gitee)
   * @param conflictResolutions list of conflicts between remote and local files
   */
  async commitSync(
    treeFiles: { [key: string]: any },
    baseTreeSha: string,
    conflictResolutions: ConflictResolution[] = [],
  ) {
    await this.logger.info("Starting commitSync", {
      treeFilesCount: Object.keys(treeFiles).length,
      baseTreeSha,
      conflictResolutionsCount: conflictResolutions.length,
    });

    // Update local sync time
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    await this.logger.info("Updated sync time", { syncTime });
    await this.metadataStore.save();

    // We update the last modified timestamp for all files that had resolved conflicts
    conflictResolutions.forEach((resolution) => {
      this.metadataStore.data.files[resolution.filePath].lastModified =
        syncTime;
    });

    // Collect all file changes that need to be committed
    const changes: FileChange[] = [];

    // Process files that need to be uploaded or updated
    for (const filePath of Object.keys(treeFiles)) {
      try {
        const treeFile = treeFiles[filePath];
        await this.logger.info("Processing file for commit", {
          filePath,
          hasContent: treeFile.content !== undefined,
          shaIsNull: treeFile.sha === null,
        });

        if (treeFile.sha === null) {
          // File needs to be deleted
          await this.logger.info("Marking file for deletion", { filePath });
          changes.push({
            action: "delete",
            path: filePath,
          });
          // Mark as deleted in metadata
          if (this.metadataStore.data.files[filePath]) {
            this.metadataStore.data.files[filePath].deleted = true;
            this.metadataStore.data.files[filePath].deletedAt = syncTime;
          }
        } else if (treeFile.content !== undefined) {
          // File needs to be uploaded or updated
          let content: string;

          // For binary files or files already with content, use the content directly
          if (treeFile.content === "binaryfile" || !hasTextExtension(filePath)) {
            await this.logger.info("Reading binary file", { filePath });
            const buffer = await this.vault.adapter.readBinary(
              normalizePath(filePath),
            );
            content = arrayBufferToBase64(buffer);
            await this.logger.info("Binary file encoded", {
              filePath,
              contentLength: content.length,
            });
          } else {
            // For text files, use the content directly - Gitee API doesn't need base64 encoding
            content = treeFile.content;
            await this.logger.info("Using text content directly", {
              filePath,
              contentLength: content.length,
            });
          }

          // Calculate SHA for metadata tracking
          await this.logger.info("Calculating SHA for file", { filePath });
          const sha = await this.calculateSHA(filePath);
          if (!this.metadataStore.data.files[filePath]) {
            this.metadataStore.data.files[filePath] = {
              path: filePath,
              sha: sha,
              dirty: false,
              justDownloaded: false,
              lastModified: Date.now(),
            };
            await this.logger.info("Created new metadata entry for file", {
              filePath,
              sha,
            });
          }
          this.metadataStore.data.files[filePath].sha = sha;

          // Determine if this is a create or update action
          // If file already exists in remote (treeFile has a sha that's not from current state), use update
          // Otherwise use create
          const fileExistsInRemote = treeFile.sha && treeFile.sha !== this.metadataStore.data.files[filePath]?.sha;
          const actionType = fileExistsInRemote ? "update" : "create";

          await this.logger.info("Adding file change", {
            filePath,
            actionType,
            fileExistsInRemote,
            treeFileSha: treeFile.sha,
            metadataSha: this.metadataStore.data.files[filePath]?.sha,
          });

          changes.push({
            action: actionType,
            path: filePath,
            content: content,
          });
        }
      } catch (err) {
        await this.logger.error("Error processing file for commit", {
          filePath,
          error: err.message,
          stack: err.stack,
        });
        throw err;
      }
    }

    // Add manifest file to changes
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const manifestFile = this.metadataStore.data.files[manifestPath];
    const manifestExists = manifestFile && manifestFile.sha !== null && manifestFile.sha !== undefined;

    await this.logger.info("Preparing manifest file for commit", {
      manifestPath,
      manifestExists,
      manifestFileSha: manifestFile?.sha,
    });

    const manifestJson = JSON.stringify(this.metadataStore.data);
    // Gitee API doesn't need base64 encoding for text content
    const manifestContent = manifestJson;

    await this.logger.info("Manifest file prepared", {
      manifestContentLength: manifestContent.length,
      action: manifestExists ? "update" : "create",
    });

    changes.push({
      action: manifestExists ? "update" : "create",
      path: manifestPath,
      content: manifestContent,
    });

    // Update manifest SHA
    await this.logger.info("Calculating manifest SHA");
    const manifestSha = await this.calculateSHA(
      `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
    );
    if (!this.metadataStore.data.files[manifestPath]) {
      this.metadataStore.data.files[manifestPath] = {
        path: manifestPath,
        sha: manifestSha,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    }
    this.metadataStore.data.files[manifestPath].sha = manifestSha;
    await this.logger.info("Manifest SHA updated", { manifestSha });

    // Commit all changes in one request
    if (changes.length > 0) {
      await this.logger.info("Committing changes to remote", {
        count: changes.length,
        changes: changes.map(c => ({ action: c.action, path: c.path })),
      });

      try {
        const commitSha = await this.client.commitChanges({
          changes: changes,
          message: "Sync",
          retry: true,
        });
        await this.logger.info("Changes committed successfully", { commitSha });
      } catch (err) {
        await this.logger.error("Failed to commit changes to remote", {
          error: err.message,
          status: err.status,
          stack: err.stack,
          changesCount: changes.length,
        });
        throw err;
      }
    } else {
      await this.logger.info("No changes to commit");
    }

    // Update the local content of all files that had conflicts we resolved
    await Promise.all(
      conflictResolutions.map(async (resolution) => {
        await this.vault.adapter.write(resolution.filePath, resolution.content);
        this.metadataStore.data.files[resolution.filePath].lastModified =
          syncTime;
      }),
    );

    // Save the latest metadata to disk
    this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  async downloadFile(file: GetTreeResponseItem, lastModified: number) {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (fileMetadata && fileMetadata.sha === file.sha) {
      // File already exists and has the same SHA, no need to download it again.
      return;
    }
    const fileContent = await this.client.getFileContent({
      path: file.path,
      retry: true,
    });
    const normalizedPath = normalizePath(file.path);
    const fileFolder = normalizePath(
      normalizedPath.split("/").slice(0, -1).join("/"),
    );
    if (!(await this.vault.adapter.exists(fileFolder))) {
      await this.vault.adapter.mkdir(fileFolder);
    }
    await this.vault.adapter.writeBinary(
      normalizedPath,
      base64ToArrayBuffer(fileContent.content),
    );
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified: lastModified,
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    await this.vault.adapter.remove(normalizedPath);
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    this.metadataStore.save();
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.gitignoreParser.load();
    await this.metadataStore.load();
    if (Object.keys(this.metadataStore.data.files).length === 0) {
      await this.logger.info("Metadata was empty, loading all files");
      let files = [];
      let folders = [this.vault.getRoot().path];
      while (folders.length > 0) {
        const folder = folders.pop();
        if (folder === undefined) {
          continue;
        }
        if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
          await this.logger.info("Skipping config dir");
          // Skip the config dir if the user doesn't want to sync it
          continue;
        }
        const res = await this.vault.adapter.list(folder);
        files.push(...res.files);
        folders.push(...res.folders);
      }
      for (const filePath of files) {
        if (filePath === `${this.vault.configDir}/workspace.json`) {
          // Obsidian recommends not syncing the workspace file
          continue;
        }

        // Skip files ignored by .gitignore
        if (this.gitignoreParser.isIgnored(filePath)) {
          await this.logger.info("Skipping ignored file (from .gitignore)", filePath);
          continue;
        }

        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      }

      // Must be the first time we run, initialize the metadata store
      // with itself and all files in the vault.
      this.metadataStore.data.files[
        `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
      ] = {
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
      this.metadataStore.save();
    }
    await this.logger.info("Loaded metadata");
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }
    // Add them to the metadata store
    files.forEach((filePath: string) => {
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    });
    this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    files.forEach((filePath: string) => {
      if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      delete this.metadataStore.data.files[filePath];
    });
    this.metadataStore.save();
  }

  getFileMetadata(filePath: string): FileMetadata {
    return this.metadataStore.data.files[filePath];
  }

  startEventsListener(plugin: GiteeSyncPlugin) {
    this.eventsListener.start(plugin);
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
