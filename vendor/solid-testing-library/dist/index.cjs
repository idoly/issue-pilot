"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  cleanup: () => cleanup,
  render: () => render,
  renderDirective: () => renderDirective,
  renderHook: () => renderHook,
  renderRef: () => renderRef,
  testEffect: () => testEffect
});
module.exports = __toCommonJS(index_exports);
var import_dom = require("@testing-library/dom");
var import_solid_js = require("solid-js");
var import_web = require("@solidjs/web");
__reExport(index_exports, require("@testing-library/dom"), module.exports);
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
  const wrappedUi = typeof wrapper === "function" ? () => (0, import_solid_js.createComponent)(wrapper, {
    get children() {
      return (0, import_solid_js.createComponent)(ui, {});
    }
  }) : ui;
  const dispose = hydrate ? (0, import_web.hydrate)(wrappedUi, container) : (0, import_web.render)(wrappedUi, container);
  mountedContainers.add({ container, dispose });
  const queryHelpers = (0, import_dom.getQueriesForElement)(container, queries);
  return {
    asFragment: () => container?.innerHTML,
    container,
    baseElement,
    debug: (el = baseElement, maxLength, options2) => Array.isArray(el) ? el.forEach((e) => console.log((0, import_dom.prettyDOM)(e, maxLength, options2))) : console.log((0, import_dom.prettyDOM)(el, maxLength, options2)),
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
    (0, import_solid_js.flush)();
    result = hook(...initialProps);
    owner = (0, import_solid_js.getOwner)();
    return null;
  };
  const wrapped = wrapper ? () => (0, import_solid_js.createComponent)(wrapper, { get children() {
    return (0, import_solid_js.createComponent)(Comp, {});
  } }) : () => (0, import_solid_js.createComponent)(Comp, {});
  const dispose = (0, import_web.render)(wrapped, container);
  mountedContainers.add({ container, dispose });
  (0, import_solid_js.flush)();
  return { result, cleanup: dispose, owner };
}
function renderRef(ref, options = {}) {
  return render(() => {
    const targetElement = options?.targetElement && (options.targetElement instanceof HTMLElement ? options.targetElement : typeof options.targetElement === "string" ? document.createElement(options.targetElement) : typeof options.targetElement === "function" ? options.targetElement() : void 0) || document.createElement("div");
    (0, import_solid_js.onSettled)(() => Array.isArray(ref) ? ref.forEach((r) => r(targetElement)) : ref(targetElement));
    return targetElement;
  });
}
var rootOrOwner = (owner, fn) => owner ? (0, import_solid_js.runWithOwner)(owner, fn) : (0, import_solid_js.createRoot)(fn);
function testEffect(testee, owner = null) {
  return new Promise((done, fail) => rootOrOwner(owner, (dispose) => (0, import_solid_js.createErrorBoundary)(
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cleanup,
  render,
  renderDirective,
  renderHook,
  renderRef,
  testEffect,
  ...require("@testing-library/dom")
});
