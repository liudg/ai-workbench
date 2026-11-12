import React from "react";
import ReactDOM from "react-dom/client";

import App from "./app/App";
import { bindNativeWindowTheme } from "./lib/native/window-theme";
import { initTheme } from "./shared/theme";
import "./styles/globals.css";

initTheme();
bindNativeWindowTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
