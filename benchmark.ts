import * as fs from "fs";
import * as proxyquire from "proxyquire";
import * as obsidianMocks from "./mock-obsidian";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

const proxyquireNonStrict = proxyquire.noCallThru();

const LoggerModule = proxyquireNonStrict("./src/logger", {
  obsidian: obsidianMocks,
});

const MetadataStoreModule = proxyquireNonStrict("./src/metadata-store", {
  obsidian: obsidianMocks,
});

const EventsListenerModule = proxyquireNonStrict("./src/events-listener", {
  obsidian: obsidianMocks,
  "./metadata-store": MetadataStoreModule,
});

const UtilsModule = proxyquireNonStrict("./src/utils", {
  obsidian: obsidianMocks,
});

const GiteeClientModule = proxyquireNonStrict("./src/gitee/client", {
  obsidian: obsidianMocks,
  "src/utils": UtilsModule,
});

const SyncManagerModule = proxyquireNonStrict("./src/sync-manager", {
  obsidian: obsidianMocks,
  "./metadata-store": MetadataStoreModule,
  "./events-listener": EventsListenerModule,
  "./gitee/client": GiteeClientModule,
  "./utils": UtilsModule,
});

async function runBenchmark(vaultRootDir: string) {
  const vault = new obsidianMocks.Vault(vaultRootDir);

  // Create a real logger with our mock vault
  const logger = new LoggerModule.default(vault, false);

  // Settings for the sync manager
  const settings = {
    giteeToken: process.env.GITEE_TOKEN,
    giteeOwner: process.env.REPO_OWNER,
    giteeRepo: process.env.REPO_NAME,
    giteeBranch: process.env.REPO_BRANCH,
    syncConfigDir: false,
  };

  // We're not going to get any conflicts, this is useless
  const onConflicts = async () => {
    return [];
  };

  // Create the sync manager
  const SyncManager = SyncManagerModule.default;
  const syncManager = new SyncManager(vault, settings, onConflicts, logger);
  await syncManager.loadMetadata();

  const startTime = performance.now();
  await syncManager.firstSync();
  return performance.now() - startTime;
}

const generateRandomFiles = (
  rootPath: string,
  numFiles: number,
  maxDepth: number,
  fileSize: number,
) => {
  const metadata: { lastSync: number; files: { [key: string]: {} } } = {
    lastSync: 0,
    files: {},
  };

  // Create root directory if it doesn't exist
  if (!fs.existsSync(rootPath)) {
    fs.mkdirSync(rootPath, { recursive: true });
  }

  // Generate folder structure first
  const allFolderPaths = [rootPath];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const numFoldersAtThisDepth = Math.floor(Math.random() * 3) + 1; // 1-3 folders per level

    for (let i = 0; i < numFoldersAtThisDepth; i++) {
      const parentPath =
        allFolderPaths[Math.floor(Math.random() * allFolderPaths.length)];
      const currentDepthOfParent =
        parentPath.split(path.sep).length - rootPath.split(path.sep).length;

      // Only create subfolders if we haven't reached max depth for this path
      if (currentDepthOfParent < maxDepth) {
        const folderName = crypto.randomBytes(5).toString("hex");
        const newFolderPath = path.join(parentPath, folderName);

        fs.mkdirSync(newFolderPath, { recursive: true });
        allFolderPaths.push(newFolderPath);
      }
    }
  }

  // Now generate files
  const contentSize = fileSize / 2; // We divide by two as converting bytes to hex doubles the size

  for (let i = 0; i < numFiles; i++) {
    // Pick a random folder to place the file in
    const targetFolder =
      allFolderPaths[Math.floor(Math.random() * allFolderPaths.length)];

    // Generate random file name
    const fileName = crypto.randomBytes(8).toString("hex") + ".md";
    const filePath = path.join(targetFolder, fileName);

    // Generate random content
    const content = crypto.randomBytes(contentSize).toString("hex");

    // Write file
    fs.writeFileSync(filePath, content);

    const relativeFilePath = filePath.replace(`${rootPath}/`, "");
    metadata.files[relativeFilePath] = {
      path: relativeFilePath,
      sha: null,
      dirty: true,
      justDownloaded: false,
      lastModified: Date.now(),
    };
  }

  const metadataFilePath = path.join(
    rootPath,
    ".obsidian",
    "gitee-sync-metadata.json",
  );
  fs.mkdirSync(path.join(rootPath, ".obsidian"));
  fs.writeFileSync(metadataFilePath, JSON.stringify(metadata), { flag: "w" });
};

const cleanupRemote = () => {
  const url = `git@gitee.com:${process.env.REPO_OWNER}/${process.env.REPO_NAME}.git`;
  const clonedDir = path.join(os.tmpdir(), "temp-clone");

  // Remove the folder in case it already exists
  fs.rmSync(clonedDir, { recursive: true, force: true });
  console.log(`[cleanupRemote] Starting cleanup of remote repository: ${url}`);

  try {
    // Clone the repository
    console.log(`[cleanupRemote] Cloning repository to ${clonedDir}...`);
    execSync(`git clone ${url} ${clonedDir}`, { stdio: "inherit" });

    const repoExists = fs.existsSync(clonedDir);
    if (!repoExists) {
      throw Error("Failed to clone repo");
    }
    console.log(`[cleanupRemote] Repository cloned successfully`);

    // Check current branch - don't assume "master"
    console.log(`[cleanupRemote] Checking current branch...`);
    const branchResult = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: clonedDir,
      encoding: "utf-8",
    }).trim();
    console.log(`[cleanupRemote] Current branch: ${branchResult}`);

    // List commits to check if repo has any
    console.log(`[cleanupRemote] Checking repository history...`);
    try {
      const logResult = execSync("git log --oneline -5", {
        cwd: clonedDir,
        encoding: "utf-8",
      });
      console.log(`[cleanupRemote] Recent commits:\n${logResult}`);
    } catch (e) {
      console.log(`[cleanupRemote] No commits found in repository (empty repo)`);
    }

    // Remove all files except .git
    console.log(`[cleanupRemote] Removing all files from working directory...`);
    execSync('find . -type f -not -path "./.git*" -delete', {
      stdio: "inherit",
      cwd: clonedDir,
    });

    // Commit empty state
    console.log(`[cleanupRemote] Staging changes...`);
    execSync("git add -A", { stdio: "inherit", cwd: clonedDir });

    console.log(`[cleanupRemote] Creating cleanup commit...`);
    try {
      execSync('git commit -m "Cleanup"', {
        stdio: "inherit",
        cwd: clonedDir,
      });
      console.log(`[cleanupRemote] Commit created successfully`);
    } catch (e) {
      console.log(`[cleanupRemote] No changes to commit (already empty)`);
    }

    // Push changes - use the actual branch name we detected
    console.log(`[cleanupRemote] Pushing changes to remote branch '${branchResult}'...`);
    try {
      execSync(`git push origin ${branchResult}`, { stdio: "inherit", cwd: clonedDir });
      console.log(`[cleanupRemote] Push successful`);
    } catch (e) {
      console.error(`[cleanupRemote] Push failed: ${e.message}`);
      console.log(`[cleanupRemote] This may be expected if the repository is empty or branch doesn't exist remotely`);
      throw e;
    }
  } catch (error) {
    console.error(`[cleanupRemote] Error during cleanup: ${error.message}`);
    console.error(`[cleanupRemote] Stack trace: ${error.stack}`);
    throw error;
  }

  // Remove the folder when everything is done
  console.log(`[cleanupRemote] Cleaning up temporary directory...`);
  fs.rmSync(clonedDir, { recursive: true, force: true });
  console.log(`[cleanupRemote] Cleanup completed successfully`);
};

const BENCHMARK_DATA = [
  {
    files: 1,
    maxDepth: 0,
    // 15 Kb
    fileSize: 1024 * 15,
  },
  {
    files: 10,
    maxDepth: 0,
    // 15 Kb
    fileSize: 1024 * 15,
  },
  {
    files: 100,
    maxDepth: 0,
    // 15 Kb
    fileSize: 1024 * 15,
  },
  {
    files: 1000,
    maxDepth: 0,
    // 15 Kb
    fileSize: 1024 * 15,
  },
  {
    files: 10000,
    maxDepth: 0,
    // 15 Kb
    fileSize: 1024 * 15,
  },
  {
    files: 100000,
    maxDepth: 0,
    // 15 Kb
    fileSize: 1024 * 15,
  },
];

(async () => {
  const tmp = os.tmpdir();
  const benchmarkRootDir = path.join(tmp, "gitee-sync-benchmark");
  try {
    const results = [];
    for (const data of BENCHMARK_DATA) {
      console.log(
        `Running benchmark with ${data.files} files totaling ${data.fileSize} bytes`,
      );
      const vaultRootDir = path.join(
        benchmarkRootDir,
        `${data.files}-${data.maxDepth}-${data.fileSize}`,
      );
      // Generates random files
      generateRandomFiles(
        vaultRootDir,
        data.files,
        data.maxDepth,
        data.fileSize,
      );

      // Run first sync by uploading all local files
      console.log("First sync from local");
      const uploadTime = await runBenchmark(vaultRootDir);

      // Cleanup vault dir completely
      fs.rmSync(vaultRootDir, { recursive: true, force: true });

      // Run first sync again, this time we download the files we just uploaded
      console.log("Second sync from remote");
      const downloadTime = await runBenchmark(vaultRootDir);

      // Cleanup the remote repo so it's ready for another benchmark
      cleanupRemote();

      results.push({
        data,
        uploadTime,
        downloadTime,
      });

      // Cleanup vault dir again, it's not necessary to keep it around
      fs.rmSync(vaultRootDir, { recursive: true, force: true });

      // Wait 2 seconds between each run just to avoid annoying Gitee
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log("");
    }
    fs.writeFileSync("benchmark_result.json", JSON.stringify(results), {
      flag: "w",
    });
  } catch (error) {
    console.error("Benchmark failed:", error);
  }
  fs.rmSync(benchmarkRootDir, { recursive: true, force: true });
})();
