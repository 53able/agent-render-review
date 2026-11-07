// The agent API (/api/agent/*): the response bodies Director sends and mcp.mts reads. Types only (erased at runtime).
import type { Profile, Scene, Config, Exposure, RenderObject, DiffEntry, PolicyFlag, VersionStatus, Version, AgentEvent } from './policy.mts';

/** What the agent learns about a render. file is the PNG's absolute path (mcp.mts reads it to return the image). */
export interface RenderSummary { profile: Profile; seconds: number; width: number; height: number; file: string; exposure: Exposure; objects: RenderObject[]; warnings: string[] }
export interface AgentStatusResponse {
  mode: 'ade' | 'standalone'; project: string | null; head: string | null; vork: string;
  versions: Pick<Version, 'id' | 'parent' | 'status' | 'origin' | 'instruction'>[]; config: Config;
}
export interface AgentSceneResponse { version: string; status: VersionStatus; scene: Scene }
export interface AgentProposeResponse {
  version: string; status: VersionStatus; head: string | null; render: RenderSummary | null | undefined; renderError: string | null | undefined; diff: DiffEntry[]; flags: PolicyFlag[];
}
export interface AgentRenderResponse { version: string; status: VersionStatus; render: RenderSummary | undefined }
export type AgentFeedbackResponse = { timeout: true; waitedSec: number; events: [] } | { timeout: false; events: AgentEvent[] };
export interface AdoptionRequestResponse { request: string; status: 'pending_human_approval'; note: string }
export interface OpenTabResponse { opened: boolean; note: string }
/** Any refused request. blockers and log come with a rejected proposal, request with a duplicate adoption request. */
export interface AgentErrorResponse { error: string; blockers?: string[]; log?: string | null; version?: null; request?: string }
