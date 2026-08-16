// src/index.ts
import { getQueriesForElement, prettyDOM } from "@testing-library/dom";
import {
  createComponent,
  createErrorBoundary,
  createRoot,
  flush,
  getOwner,
  onSettled,
  runWithOwner
} from "solid-js";
import { hydrate as solidHydrate, render as solidRender } from "@solidjs/web";
export * from "@testing-library/dom";
function renderDirective(_directive, _options = {}) {
  throw new Error("Solid-2.0 no longer supports directives. Use ref instead.");
}
if (typeof process === "undefined" || !process.env.STL_SKIP_AUTO_CLEANUP) {
  if (typeof afterEach === "function") {
    afterEach(cleanup);
  }
}
var mountedContainers = /* @__PURE__ */ new Set();
function render(ui, options = {}) {
  let { container, baseElement = container, queries, hydrate = false, wrapper } = options;
  if (!baseElement) {
    baseElement = document.body;
  }
  if (!container) {
    container = baseElement.appendChild(document.createElement("div"));
  }
  const wrappedUi = typeof wrapper === "function" ? () => createComponent(wrapper, {
    get children() {
      return createComponent(ui, {});
    }
  }) : ui;
  const dispose = hydrate ? solidHydrate(wrappedUi, container) : solidRender(wrappedUi, container);
  mountedContainers.add({ container, dispose });
  const queryHelpers = getQueriesForElement(container, queries);
  return {
    asFragment: () => container?.innerHTML,
    container,
    baseElement,
    debug: (el = baseElement, maxLength, options2) => Array.isArray(el) ? el.forEach((e) => console.log(prettyDOM(e, maxLength, options2))) : console.log(prettyDOM(el, maxLength, options2)),
    unmount: dispose,
    ...queryHelpers
  };
}
var hasInitialProps = (options) => Array.isArray(options?.initialProps);
function renderHook(hook, options = []) {
  const initialProps = Array.isArray(options) ? options : hasInitialProps(options) ? options.initialProps : [];
  const wrapper = Object.hasOwn(options, "wrapper") && options.wrapper;
  const container = document.createElement("div");
  document.body.appendChild(container);
  let result;
  let owner = null;
  const Comp = () => {
    flush();
    result = hook(...initialProps);
    owner = getOwner();
    return null;
  };
  const wrapped = wrapper ? () => createComponent(wrapper, { get children() {
    return createComponent(Comp, {});
  } }) : () => createComponent(Comp, {});
  const dispose = solidRender(wrapped, container);
  mountedContainers.add({ container, dispose });
  flush();
  return { result, cleanup: dispose, owner };
}
function renderRef(ref, options = {}) {
  return render(() => {
    const targetElement = options?.targetElement && (options.targetElement instanceof HTMLElement ? options.targetElement : typeof options.targetElement === "string" ? document.createElement(options.targetElement) : typeof options.targetElement === "function" ? options.targetElement() : void 0) || document.createElement("div");
    onSettled(() => Array.isArray(ref) ? ref.forEach((r) => r(targetElement)) : ref(targetElement));
    return targetElement;
  });
}
var rootOrOwner = (owner, fn) => owner ? runWithOwner(owner, fn) : createRoot(fn);
function testEffect(testee, owner = null) {
  return new Promise((done, fail) => rootOrOwner(owner, (dispose) => createErrorBoundary(
    () => testee((result) => (done(result), dispose?.())),
    (err) => (fail(err()), queueMicrotask(() => dispose?.()))
  )()));
}
function cleanupAtContainer(ref) {
  const { container, dispose } = ref;
  if (typeof dispose === "function") {
    dispose();
  } else {
    console.warn("solid-testing-library: dispose is not a function - maybe your tests include multiple solid versions!");
  }
  if (container?.parentNode === document.body) {
    document.body.removeChild(container);
  }
  mountedContainers.delete(ref);
}
function cleanup() {
  mountedContainers.forEach(cleanupAtContainer);
}
export {
  cleanup,
  render,
  renderDirective,
  renderHook,
  renderRef,
  testEffect
};
