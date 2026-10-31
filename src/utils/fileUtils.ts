import fs from "fs/promises";
import { constants } from "fs";
// Attach constants to fs.promises for compatibility with tests
(fs as typeof fs & { constants: typeof constants }).constants = constants;
// import path from 'path';

export async function readFileContent(
  filePath: string,
  logger: { warn: (msg: string) => void; error: (msg: string, error?: Error) => void },
  maxSizeBytes: number,
): Promise<string | null> {
  try {
    await fs.access(filePath, fs.constants.R_OK);
    const stats = await fs.stat(filePath);

    if (stats.size === 0) {
      logger.warn(`File ${filePath} is empty, skipping`);
      return null;
    }

    if (stats.size > maxSizeBytes) {
      logger.warn(`File ${filePath} is too large (${stats.size} bytes), skipping`);
      return null;
    }

    const content = await fs.readFile(filePath, "utf-8");

    if (!content.trim()) {
      logger.warn(`File ${filePath} is empty or whitespace only, skipping`);
      return null;
    }

    return content;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof Error) {
      switch ((error as NodeJS.ErrnoException).code) {
      case "ENOENT":
        logger.error(`File not found: ${filePath}`);
        break;
      case "EACCES":
        logger.error(`Permission denied reading file: ${filePath}`);
        break;
      case "EMFILE":
      case "ENFILE":
        logger.error(`Too many open files, failed to read: ${filePath}`);
        break;
      default:
        logger.error(`Failed to read file ${filePath}: ${errorMessage}`, error);
      }
    } else {
      logger.error(`Failed to read file ${filePath}: ${errorMessage}`);
    }
    return null;
  }
}

export async function ensureDirectoryExists(
  directoryPath: string,
  logger: { error: (msg: string, error?: Error) => void },
): Promise<void> {
  try {
    await fs.mkdir(directoryPath, { recursive: true });
  } catch (error) {
    logger.error(
      `Failed to create directory ${directoryPath}:`,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error; // Re-throw to indicate failure
  }
}

export async function createBackup(
  filePath: string,
  logger: { debug: (msg: string) => void; warn: (msg: string, error?: Error) => void },
): Promise<void> {
  try {
    await fs.access(filePath);
    const backupPath = `${filePath}.backup`;
    await fs.copyFile(filePath, backupPath);
    logger.debug(`Created backup: ${backupPath}`);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Failed to create backup for ${filePath}:`, error);
    }
  }
}
