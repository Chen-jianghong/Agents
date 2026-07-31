import type { Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./contracts.js";
import {
  resolveProfileModel,
  type ModelAliases,
  type ResolvedPiModel,
} from "./model-runtime.js";

export interface CredentialResolver {
  resolve(providerId: string): Promise<string | undefined>;
}

/** Resolves provider credentials from host environment variables only. */
export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly prefix = "PI_PROVIDER_",
  ) {}

  async resolve(providerId: string): Promise<string | undefined> {
    const normalized = providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    return this.environment[`${this.prefix}${normalized}_API_KEY`];
  }
}

export interface ModelGatewayOptions {
  aliases?: ModelAliases;
  credentials?: CredentialResolver;
}

export interface ResolvedGatewayModel extends ResolvedPiModel {
  alias: string;
  providerId: string;
  modelId: string;
  credentialConfigured: boolean;
}

export class ModelGatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelGatewayConfigurationError";
  }
}

/**
 * Host-owned model routing boundary. It deliberately stores routes only;
 * credentials are resolved just before a Pi session is created.
 */
export class ModelGateway {
  readonly modelRuntime: ModelRuntime;
  readonly aliases: ModelAliases;

  constructor(
    modelRuntime: ModelRuntime,
    options: ModelGatewayOptions = {},
  ) {
    this.modelRuntime = modelRuntime;
    this.aliases = Object.freeze({ ...(options.aliases ?? {}) });
    for (const [alias, source] of Object.entries(this.aliases)) {
      validateAlias(alias);
      parseModelReference(source, alias);
    }
    this.credentialResolver = options.credentials;
  }

  private readonly credentialResolver: CredentialResolver | undefined;

  async resolve(
    alias: string,
    defaultThinkingLevel: ThinkingLevel,
  ): Promise<ResolvedGatewayModel> {
    const source = this.aliases[alias] ?? alias;
    const reference = parseModelReference(source, alias);
    const credential = await this.credentialResolver?.resolve(reference.providerId);
    if (credential !== undefined) {
      if (credential.length === 0) {
        throw new ModelGatewayConfigurationError(
          `Credential resolver returned an empty credential for provider ${reference.providerId}`,
        );
      }
      await this.modelRuntime.setRuntimeApiKey(reference.providerId, credential, {
        allowNetwork: false,
      });
    }

    const resolved = resolveProfileModel(
      alias,
      defaultThinkingLevel,
      this.modelRuntime,
      this.aliases,
    );
    return {
      ...resolved,
      alias,
      providerId: reference.providerId,
      modelId: reference.modelId,
      credentialConfigured: this.modelRuntime.hasConfiguredAuth(reference.providerId),
    };
  }

  async resolveModel(
    alias: string,
    defaultThinkingLevel: ThinkingLevel,
  ): Promise<Model<any>> {
    return (await this.resolve(alias, defaultThinkingLevel)).model;
  }
}

function validateAlias(alias: string): void {
  if (alias.trim().length === 0 || alias.includes("/")) {
    throw new ModelGatewayConfigurationError(`Invalid model alias: ${alias}`);
  }
}

function parseModelReference(source: string, alias: string): { providerId: string; modelId: string } {
  const separator = source.indexOf("/");
  const providerId = separator > 0 ? source.slice(0, separator) : "";
  const modelId = separator > 0 ? source.slice(separator + 1) : "";
  if (providerId.length === 0 || modelId.length === 0 || /\s/.test(source)) {
    throw new ModelGatewayConfigurationError(
      `Model alias ${alias} must resolve to a provider/model reference`,
    );
  }
  return { providerId, modelId };
}
