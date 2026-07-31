import {
  ModelRuntime,
  resolveCliModel,
  type ResolveCliModelResult,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "./contracts.js";

export type ModelAliases = Readonly<Record<string, string>>;

export interface ResolvedPiModel {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  source: string;
}

export function resolveProfileModel(
  modelName: string,
  defaultThinkingLevel: ThinkingLevel,
  modelRuntime: ModelRuntime,
  aliases: ModelAliases = {},
): ResolvedPiModel {
  const source = aliases[modelName] ?? modelName;
  const result = resolveCliModel({
    cliModel: source,
    modelRuntime,
  });

  if (!result.model) {
    throw new ModelResolutionError(modelName, source, result);
  }

  return {
    model: result.model,
    thinkingLevel: result.thinkingLevel ?? defaultThinkingLevel,
    source,
  };
}

export class ModelResolutionError extends Error {
  readonly modelName: string;
  readonly source: string;

  constructor(modelName: string, source: string, result: ResolveCliModelResult) {
    super(result.error ?? `Unable to resolve model ${modelName} from ${source}`);
    this.name = "ModelResolutionError";
    this.modelName = modelName;
    this.source = source;
  }
}
