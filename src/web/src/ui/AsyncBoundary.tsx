import { Errored } from "solid-js";
import type { JSX } from "@solidjs/web";

import { Button } from "./controls";

/**
 * Keeps a failed lazy chunk or async read from halting the application's reactivity. Without a boundary
 * Solid 2.0 stops every effect after the first unhandled error, so an old cached generation or a failed
 * chunk request would freeze the whole page. Reset re-mounts the failed subtree, which retries a lazy import.
 */
export function AsyncBoundary(props: { label: string; children: JSX.Element }) {
  return (
    <Errored
      fallback={(error, reset) => (
        <div class="ui-async-error" role="alert">
          <p>
            {props.label}加载失败：{String((error() as { message?: string })?.message ?? error())}
          </p>
          <Button size="small" onClick={() => reset()}>
            重试
          </Button>
        </div>
      )}
    >
      {props.children}
    </Errored>
  );
}
