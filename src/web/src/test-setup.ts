class ResizeObserverMock implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export class EventSourceMock extends EventTarget {
  static instances: EventSourceMock[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    EventSourceMock.instances.push(this);
  }

  emit(type: string, data?: unknown): void {
    this.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close(): void {
    this.closed = true;
  }
}

Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock, configurable: true });
Object.defineProperty(globalThis, "EventSource", { value: EventSourceMock, configurable: true });
Object.defineProperty(HTMLElement.prototype, "scrollTo", { value() {}, configurable: true });
