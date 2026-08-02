export interface PublicAgentEvent {
  id: string;
  issueId: string;
  kind: string;
  message: string;
  createdAt: string;
}

type Listener = (event: PublicAgentEvent) => void;

export class AgentEventBroker {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(event: PublicAgentEvent): void {
    for (const listener of this.listeners.get(event.issueId) ?? []) listener(event);
  }

  subscribe(issueId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(issueId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(issueId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(issueId);
    };
  }
}
