import { render } from "@solidjs/web";
import "github-markdown-css/github-markdown.css";

import { App } from "./app/App";
import "./app/styles.css";
import "./app/settings.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");
render(() => <App />, rootElement);
