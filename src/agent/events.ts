export interface RunEvent {
  id: string;
  issueId: string;
  kind: string;
  message: string;
  createdAt: string;
  transient?: boolean;
}

export type RunEventListener = (event: RunEvent) => void;
