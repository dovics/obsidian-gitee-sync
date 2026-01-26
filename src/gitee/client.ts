import { requestUrl } from "obsidian";
import Logger from "src/logger";
import { GiteeSyncSettings } from "src/settings/settings";
import { retryUntil } from "src/utils";

export type RepoContent = {
  files: { [key: string]: GetTreeResponseItem };
  sha: string;
};

/**
 * Represents a single item in a tree response from the Gitee API.
 */
export type GetTreeResponseItem = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
  url: string;
};

/**
 * Response when getting file content from Gitee
 */
export type FileContent = {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: string;
  content: string;
  encoding: string;
};

/**
 * Change item for batch commit
 * action: create/create_dir/update/delete/delete_dir/move/move_dir/chmod
 */
export type FileChange = {
  action: "create" | "update" | "delete" | "create_dir" | "delete_dir" | "move" | "move_dir" | "chmod";
  path: string;
  content?: string;
  from_path?: string; // For move/move_dir actions
  mode?: string; // For chmod action
};

/**
 * Response from commit API
 */
export type CommitResponse = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
  };
};

/**
 * Custom error to make some stuff easier
 */
class GiteeAPIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export default class GiteeClient {
  constructor(
    private settings: GiteeSyncSettings,
    private logger: Logger,
  ) {}

  headers() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  /**
   * Gets the content of the repo.
   *
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns Array of files in the directory in the remote repo
   */
  async getRepoContent({
    retry = false,
    maxRetries = 5,
  } = {}): Promise<RepoContent> {
    const response = await retryUntil(
      async () => {
        return requestUrl({
          url: `https://gitee.com/api/v5/repos/${this.settings.giteeOwner}/${this.settings.giteeRepo}/git/trees/${this.settings.giteeBranch}?recursive=1&access_token=${this.settings.giteeToken}`,
          headers: this.headers(),
          throw: false,
        });
      },
      (res) => res.status !== 422, // Retry condition: only retry on 422 status
      retry ? maxRetries : 0, // Use 0 retries if retry is false
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to get repo content", response);
      throw new GiteeAPIError(
        response.status,
        `Failed to get repo content, status ${response.status}`,
      );
    }

    const files = response.json.tree
      .filter((file: GetTreeResponseItem) => file.type === "blob")
      .reduce(
        (
          acc: { [key: string]: GetTreeResponseItem },
          file: GetTreeResponseItem,
        ) => ({ ...acc, [file.path]: file }),
        {},
      );
    return { files, sha: response.json.sha };
  }

  /**
   * Gets a file content from its path
   *
   * @param path The path to the file
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The file content with base64 encoding
   */
  async getFileContent({
    path,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<FileContent> {
    const response = await retryUntil(
      async () => {
        return requestUrl({
          url: `https://gitee.com/api/v5/repos/${this.settings.giteeOwner}/${this.settings.giteeRepo}/contents/${path}?access_token=${this.settings.giteeToken}&ref=${this.settings.giteeBranch}`,
          headers: this.headers(),
          throw: false,
        });
      },
      (res) => res.status !== 422,
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to get file content", response);
      throw new GiteeAPIError(
        response.status,
        `Failed to get file content, status ${response.status}`,
      );
    }
    return response.json;
  }

  /**
   * Create a new file in the repo, the content must be base64 encoded.
   *
   * @param path Path to create in the repo
   * @param content Base64 encoded content of the file
   * @param message Commit message
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   */
  async createFile({
    path,
    content,
    message,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    content: string;
    message: string;
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await retryUntil(
      async () => {
        return requestUrl({
          url: `https://gitee.com/api/v5/repos/${this.settings.giteeOwner}/${this.settings.giteeRepo}/contents/${path}`,
          headers: this.headers(),
          method: "POST",
          body: JSON.stringify({
            access_token: this.settings.giteeToken,
            content: content,
            message: message,
            branch: this.settings.giteeBranch,
          }),
          throw: false,
        });
      },
      (res) => res.status !== 422,
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to create file", response);
      throw new GiteeAPIError(
        response.status,
        `Failed to create file, status ${response.status}`,
      );
    }
  }

  /**
   * Commit multiple file changes in one request.
   * This is the main method for syncing files to Gitee.
   *
   * @param changes Array of file changes (create/update/delete)
   * @param message Commit message
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The commit SHA
   */
  async commitChanges({
    changes,
    message,
    retry = false,
    maxRetries = 5,
  }: {
    changes: FileChange[];
    message: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string> {
    const response = await retryUntil(
      async () => {
        return requestUrl({
          url: `https://gitee.com/api/v5/repos/${this.settings.giteeOwner}/${this.settings.giteeRepo}/commits`,
          headers: this.headers(),
          method: "POST",
          body: JSON.stringify({
            access_token: this.settings.giteeToken,
            message: message,
            branch: this.settings.giteeBranch,
            actions: changes,
          }),
          throw: false,
        });
      },
      (res) => res.status !== 422,
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to commit changes", response);
      throw new GiteeAPIError(
        response.status,
        `Failed to commit changes, status ${response.status}`,
      );
    }

    return response.json.sha;
  }

  /**
   * Downloads the repository as a ZIP archive from Gitee.
   *
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The archive contents as an ArrayBuffer
   */
  async downloadRepositoryArchive({
    retry = false,
    maxRetries = 5,
  } = {}): Promise<ArrayBuffer> {
    const response = await retryUntil(
      async () => {
        return requestUrl({
          url: `https://gitee.com/api/v5/repos/${this.settings.giteeOwner}/${this.settings.giteeRepo}/zipball?access_token=${this.settings.giteeToken}&ref=${this.settings.giteeBranch}`,
          headers: this.headers(),
          method: "GET",
          throw: false,
        });
      },
      (res) => res.status !== 422,
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to download zip archive", response);
      throw new GiteeAPIError(
        response.status,
        `Failed to download zip archive, status ${response.status}`,
      );
    }
    return response.arrayBuffer;
  }
}
