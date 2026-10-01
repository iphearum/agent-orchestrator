"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { hasDesktopBridge, getDesktopBridge } from "../../lib/desktopBridge";

const AgentContext = createContext(null);

/** Owns agent profiles and agent-run events for React feature components. */
export function AgentProvider({ children }) {
  const [agents, setAgents] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshAgents = useCallback(async () => {
    if (!hasDesktopBridge()) return [];
    setLoading(true);
    try {
      const nextAgents = await getDesktopBridge().listAgents();
      setAgents(nextAgents || []);
      setError(null);
      return nextAgents || [];
    } catch (cause) {
      setError(cause);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = hasDesktopBridge() ? getDesktopBridge().onAgentEvent(event => {
      if (mounted) setEvents(current => [...current, event]);
    }) : undefined;
    refreshAgents().catch(() => {});
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [refreshAgents]);

  const saveAgent = useCallback(async agent => {
    const saved = await getDesktopBridge().saveAgent(agent);
    await refreshAgents();
    return saved;
  }, [refreshAgents]);

  const deleteAgent = useCallback(async agentId => {
    await getDesktopBridge().deleteAgent(agentId);
    await refreshAgents();
  }, [refreshAgents]);

  const value = useMemo(() => ({ agents, events, loading, error, refreshAgents, saveAgent, deleteAgent }), [agents, events, loading, error, refreshAgents, saveAgent, deleteAgent]);
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgents() {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgents must be used inside AgentProvider");
  return context;
}
