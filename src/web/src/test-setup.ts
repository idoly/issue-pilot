import { beforeEach, vi } from "vitest";
import { resetMonacoTestState } from "./test-monaco";
vi.mock("./app/monaco", async () => (await import("./test-monaco")).monacoMock);
beforeEach(() => {
  resetMonacoTestState();
  // jsdom resolves relative URLs against http://localhost:3000, where a real service may be listening.
  // Unmocked requests must fail immediately instead of reaching it; tests that need fetch stub it themselves.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      throw new TypeError(`unmocked_fetch:${input instanceof Request ? input.url : String(input)}`);
    }),
  );
});

class ResizeObserverMock implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export class EventSourceMock extends EventTarget {
  static instances: EventSourceMock[] = [];
  readonly url: string;
  closed = false;
  closeCalls = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    EventSourceMock.instances.push(this);
  }

  emit(type: string, data?: unknown): void {
    this.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
  }
}

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value(query: string): MediaQueryList {
    return Object.assign(new EventTarget(), {
      media: query,
      matches: false,
      onchange: null,
      addListener() {},
      removeListener() {},
    }) as MediaQueryList;
  },
});
Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock, configurable: true });
Object.defineProperty(globalThis, "EventSource", { value: EventSourceMock, configurable: true });
Object.defineProperty(HTMLElement.prototype, "scrollTo", { value() {}, configurable: true });
// jsdom does not implement modal dialogs. Native focus, inertness and Escape are tested in Chromium.
Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.open = true;
  },
  close(this: HTMLDialogElement) {
    this.open = false;
  },
});
