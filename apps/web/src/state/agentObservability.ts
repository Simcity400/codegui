import { useAtomValue } from "@effect/atom-react";
import { createAgentObservabilityAtoms } from "@t3tools/client-runtime/state/agent-observability";
import { deriveAgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ServerConfig, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";

export const agentObservability = createAgentObservabilityAtoms(connectionAtomRuntime);
const EMPTY_CONFIG = Atom.make<ServerConfig | null>(null);

export function useAgentStreamsCapability(environmentId: EnvironmentId | null) {
  const config = useAtomValue(
    environmentId === null ? EMPTY_CONFIG : serverEnvironment.configValueAtom(environmentId),
  );
  const sessionConfig = useAtomValue(
    environmentId === null
      ? EMPTY_CONFIG
      : environmentSession.initialConfigValueAtom(environmentId),
  );
  return {
    supported: (sessionConfig ?? config)?.separateAgentTranscripts === true,
    known: sessionConfig !== null,
  };
}

export function useAgentRoster(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const capability = useAgentStreamsCapability(environmentId);
  const query = useEnvironmentQuery(
    capability.supported && environmentId !== null && threadId !== null
      ? agentObservability.roster({ environmentId, input: { threadId } })
      : null,
  );
  const model = useMemo(
    () => (query.data === null ? null : deriveAgentPanelModel(query.data)),
    [query.data],
  );
  return { ...query, ...capability, model };
}
