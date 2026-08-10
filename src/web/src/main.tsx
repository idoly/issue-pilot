import { render } from "@solidjs/web";

import { App } from "./app/App";
import "./app/styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");
render(() => <App />, rootElement);
