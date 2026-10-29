// State shared by the adapters of all analysis contexts, and the caller's convention file (config.yml).
import type { EnvRegistry, AppEnvironment } from './environments.ts';
import type { Extractor } from '../extract/core.ts';

/** An HTTP client wrapper declared by the caller (decision A10), matched by resolved symbol. */
export interface HttpClientConvention {
  /** npm package that declares the method, for example `@abp/ng.core`. */
  package: string;
  /** Qualified method name, for example `RestService.request`. */
  method: string;
  request: { argument: number; method?: string; url: string };
  base?: { argument: number; property: string; environmentKey: string; default?: string };
}

export interface EngineConfig {
  http?: { clients?: HttpClientConvention[] };
}

export interface InterceptorInfo {
  observation: string;
  project: string;
  /** Prefix parts before the request URL (literal or environment). */
  prefix: import('./fold.ts').Part[];
  registered: boolean;
  entity: string;
}

export interface AnalysisState {
  env: EnvRegistry;
  config: EngineConfig;
  /** Every extractor, in context order. */
  extractors: Extractor[];
  /** Applications whose program includes a repository file. */
  appsIncluding(path: string): AppEnvironment[];
  /** Route tables (file:position) reached from a root router configuration. */
  routeTablesReached: Set<string>;
  interceptors: InterceptorInfo[];
  /** Interceptor classes and functions registered through HTTP_INTERCEPTORS or withInterceptors(). */
  registeredInterceptors: Set<string>;
}
