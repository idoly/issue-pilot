import { Component, Owner } from 'solid-js';
import { JSX } from '@solidjs/web';
import { Queries, queries, BoundFunctions, PrettyDOMOptions } from '@testing-library/dom';
export * from '@testing-library/dom';

type Ui = () => JSX.Element;
interface Options {
    container?: HTMLElement;
    baseElement?: HTMLElement;
    queries?: Queries & typeof queries;
    hydrate?: boolean;
    wrapper?: Component<{
        children: JSX.Element;
    }>;
    readonly location?: string;
}
type DebugFn = (baseElement?: HTMLElement | HTMLElement[], maxLength?: number, options?: PrettyDOMOptions) => void;
type Result = BoundFunctions<typeof queries> & {
    asFragment: () => string;
    container: HTMLElement;
    baseElement: HTMLElement;
    debug: DebugFn;
    unmount: () => void;
};
type RenderHookOptions<A> = {
    initialProps?: A;
    wrapper?: Component<{
        children: JSX.Element;
    }>;
};
type RenderHookResult<R> = {
    result: R;
    owner: Owner | null;
    cleanup: () => void;
};
type RenderRefOptions<A extends any, E extends HTMLElement = HTMLDivElement> = Options & {
    targetElement?: Lowercase<E['nodeName']> | E | (() => E);
};

declare global {
    var _$HY: object;
}
/**
 * Solid.js 2.0 no longer supports directives, so this function has been replaced with renderRef
 * @deprecated
 *
 * ```ts
 * // before
 * const directive = (ref, arg) => ...;
 * const { arg, setArg } = renderDirective(directive, { targetElement });
 *
 * // after
 * const [arg, setArg] = createSignal();
 * const refHandler = (arg) => (ref) => ...;
 * renderRef(ref(arg), { targetElement });
 * ```
 */
declare function renderDirective(_directive: (_ref: HTMLElement, _arg: Function) => void, _options?: {
    targetElement?: HTMLElement | string;
}): void;
/**
 * Renders a component to test it
 * @param ui {Ui} a function calling the component
 * @param options {Options} test options
 * @returns {Result} references and tools to test the component
 *
 * ```ts
 * const { getByText } = render(() => <App />, { wrapper: I18nProvider });
 * const button = getByText('Accept');
 * ```
 * ### Options
 * - `options.container` - the HTML element which the UI will be rendered into; otherwise a `<div>` will be created
 * - `options.baseElement` - the parent of the container, the default will be `<body>`
 * - `options.queries` - custom queries (see https://testing-library.com/docs/queries/about)
 * - `options.hydrate` - `true` if you want to test hydration
 * - `options.wrapper` - a component that applies a context provider and returns `props.children`
 * - `options.location` - wraps the component in a solid-router with memory integration pointing at the given path
 *
 * ### Result
 * - `result.asFragment()` - returns the HTML fragment as string
 * - `result.container` - the container in which the component is rendered
 * - `result.baseElement` - the parent of the component
 * - `result.debug()` - returns helpful debug output on the console
 * - `result.unmount()` - unmounts the component, usually automatically called in cleanup
 * - `result.`[queries] - testing library queries, see https://testing-library.com/docs/queries/about)
 */
declare function render(ui: Ui, options?: Options): Result;
/**
 * "Renders" a hook to test it
 * @param hook {() => unknown)} a hook or primitive
 * @param options {RenderHookOptions} test options
 * @returns {RenderHookResult} references and tools to test the hook/primitive
 *
 * ```ts
 * const { result } = render(useI18n, { wrapper: I18nProvider });
 * expect(result.t('test')).toBe('works');
 * ```
 * ### Options
 * - `options.initialProps` - an array with the props that the hook will be provided with.
 * - `options.wrapper` - a component that applies a context provider and **always** returns `props.children`
 *
 * ### Result
 * - `result.result` - the return value of the hook/primitive
 * - `result.owner` - the reactive owner in which the hook is run (in order to run other reactive code in the same context with [`runWithOwner`](https://www.solidjs.com/docs/latest/api#runwithowner))
 * - `result.cleanup()` - calls the cleanup function of the hook/primitive
 */
declare function renderHook<A extends [] | [any, ...any[]], R>(hook: (...args: A) => R, options?: A | RenderHookOptions<A>): RenderHookResult<R>;
/**
 * Applies ref(s) to a test container
 * @param directive {(ref, value: () => unknown)} a reusable custom directive
 * @param options {RenderRefOptions} test options
 * @returns {RenderDirectiveResult} references and tools to test the directive
 *
 * ```ts
 * const called = vi.fn()
 * const { getByText, baseContainer } = render(onClickOutside, { initialValue: called });
 * expect(called).not.toBeCalled();
 * fireEvent.click(baseContainer);
 * expect(called).toBeCalled();
 * ```
 * ### Options
 * - `options.targetElement` - the name of a HTML element as a string or a HTMLElement or a function returning a HTMLElement
 * - `options.container` - the HTML element which the UI will be rendered into; otherwise a `<div>` will be created
 * - `options.baseElement` - the parent of the container, the default will be `<body>`
 * - `options.queries` - custom queries (see https://testing-library.com/docs/queries/about)
 * - `options.hydrate` - `true` if you want to test hydration
 * - `options.wrapper` - a component that applies a context provider and returns `props.children`
 *
 * ### Result
 * - `result.arg()` - the accessor for the value that the directive receives
 * - `result.setArg()` - the setter for the value that the directive receives
 * - `result.asFragment()` - returns the HTML fragment as string
 * - `result.container` - the container in which the component is rendered
 * - `result.baseElement` - the parent of the component
 * - `result.debug()` - returns helpful debug output on the console
 * - `result.unmount()` - unmounts the component, usually automatically called in cleanup
 * - `result.`[queries] - testing library queries, see https://testing-library.com/docs/queries/about)
 */
declare function renderRef<A extends any, U extends A, E extends HTMLElement>(ref: ((ref: E) => void) | ((ref: E) => void)[], options?: RenderRefOptions<U, E>): Result;
/**
 * testEffect - provides an asynchronous scaffold to test effects in unit tests
 *
 * @param {(done: () => void) => void} testee - test function, calling done() ends the test
 * @param {Owner | null | undefined} owner - the reactive context that should own the test function
 *
 * ```ts
 * it("tests an effect", () => testEffect((done) => {
 *   const [item, setItem] = createSignal(0);
 *   createEffect(() => item(), (item) => {
 *     if (item === 0) { setItem(1); }
       else if (item === 1) { done(); }
       else { throw new Error('item is !== 0/1: ' + item); }
 *   });
 * });
 * ```
 */
declare function testEffect<T>(testee: (done: undefined extends T ? ((result?: T) => void) : ((result: T) => void)) => void, owner?: Owner | null): Promise<T>;
declare function cleanup(): void;

export { cleanup, render, renderDirective, renderHook, renderRef, testEffect };
