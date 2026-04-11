import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { parseWorkflowFile } from "@/importer/scanner.ts";
import {
  findExistingSubfilesDirs,
  generateFilePath,
  generateYamlFilePath,
  writeWorkflowJSON,
  writeWorkflowYAML,
} from "@/importer/writer.ts";

/** Supported target formats for conversion. */
export type TargetFormat = "json" | "yaml";

/** Options for converting a workflow file. */
export interface ConvertOptions {
  targetFormat: TargetFormat;
  directory: string;
  externalizeThreshold: number;
  dryRun: boolean;
  keepOriginal: boolean;
}

/** Result of converting a single workflow file. */
export interface ConvertResult {
  sourcePath: string;
  outputPath: string;
  sourceFormat: TargetFormat;
  targetFormat: TargetFormat;
  writtenFiles: string[];
  removedFiles: string[];
  skipped: boolean;
  skipReason?: string;
  error?: Error;
}

/** Detects the format of a file based on its extension. */
export function detectFormat(filePath: string): TargetFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return null;
}

/** Converts a single workflow file to the target format. */
export function convertWorkflowFile(filePath: string, options: ConvertOptions): ConvertResult {
  const sourceFormat = detectFormat(filePath);
  const result: ConvertResult = {
    sourcePath: filePath,
    outputPath: "",
    sourceFormat: sourceFormat ?? "json",
    targetFormat: options.targetFormat,
    writtenFiles: [],
    removedFiles: [],
    skipped: false,
  };

  if (!sourceFormat) {
    result.skipped = true;
    result.skipReason = "unsupported file extension";
    return result;
  }

  if (sourceFormat === options.targetFormat) {
    result.skipped = true;
    result.skipReason = `already in ${options.targetFormat} format`;
    return result;
  }

  let workflow: Workflow;
  try {
    workflow = parseWorkflowFile(filePath);
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
    return result;
  }

  const workflowID = workflow.id ?? "";
  if (!workflowID) {
    result.error = new Error("workflow has no ID");
    return result;
  }

  try {
    if (options.targetFormat === "yaml") {
      result.outputPath = generateYamlFilePath(options.directory, workflowID, workflow.name);

      if (!options.dryRun) {
        const written = writeWorkflowYAML(
          options.directory,
          null,
          workflow,
          options.externalizeThreshold,
        );
        result.writtenFiles = written;
        if (written.length > 0) {
          result.outputPath = written[0]!;
        }
      }
    } else {
      result.outputPath = generateFilePath(options.directory, workflowID, workflow.name);

      if (!options.dryRun) {
        writeWorkflowJSON(result.outputPath, workflow);
        result.writtenFiles = [result.outputPath];
      }
    }

    // Remove original file and associated _subfiles (for YAML→JSON)
    if (!options.dryRun && !options.keepOriginal) {
      // Delete source file (unless output overwrote it — same path)
      if (path.resolve(filePath) !== path.resolve(result.outputPath)) {
        fs.unlinkSync(filePath);
        result.removedFiles.push(filePath);
      }

      // When converting YAML→JSON, clean up _subfiles directories
      if (sourceFormat === "yaml") {
        const subfilesDirs = findExistingSubfilesDirs(options.directory, workflowID);
        for (const dir of subfilesDirs) {
          fs.rmSync(dir, { recursive: true, force: true });
          result.removedFiles.push(dir);
        }
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
  }

  return result;
}
