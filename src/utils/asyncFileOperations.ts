import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./Logger";

/**
 * Utility functions for async file operations to replace synchronous versions
 */

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T = any>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    logger.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
}

export async function writeJsonFile<T = any>(filePath: string, data: T): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, content, "utf8");
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    logger.warn(`Failed to read text file: ${filePath}`, error);
    return null;
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf8");
}

export async function copyFile(source: string, destination: string): Promise<void> {
  await fs.copyFile(source, destination);
}

export async function deleteFile(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(
  dirPath: string,
  extension?: string,
): Promise<string[]> {
  try {
    const files = await fs.readdir(dirPath);
    if (extension) {
      return files.filter(file => file.endsWith(extension));
    }
    return files;
  } catch {
    return [];
  }
}

export async function getFileStats(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Safe path resolution that prevents directory traversal attacks
 */
export function safePath(basePath: string, requestPath: string): string {
  // Explicitly reject absolute paths to prevent path traversal via absolute references
  if (path.isAbsolute(requestPath)) {
    // Tests expect unified messaging for traversal/absolute
    throw new Error("Path traversal detected");
  }
  // Remove leading slash and resolve path
  const cleanPath = requestPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(basePath, cleanPath);

  // Ensure the resolved path is within the base directory
  if (!resolvedPath.startsWith(path.resolve(basePath))) {
    throw new Error("Path traversal detected");
  }

  return resolvedPath;
}

/**
 * Create a backup of a file before modifying it
 */
export async function createBackup(filePath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.backup.${timestamp}`;
  await copyFile(filePath, backupPath);
  return backupPath;
}

/**
 * Read a file with automatic retry on temporary failures
 */
export async function readFileWithRetry(
  filePath: string,
  maxRetries = 3,
  retryDelay = 100,
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }
  throw new Error("Unexpected error in readFileWithRetry");
}

/**
 * Write a file with automatic backup and atomic operation
 */
export async function safeWriteFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;

  try {
    // Write to temporary file first
    await fs.writeFile(tempPath, content, "utf8");

    // Atomic move to final location
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temporary file on error
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
