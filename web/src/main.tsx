import React from "react";
import ReactDOM from "react-dom/client";
import { initTheme } from "../../src/axe/theme";
import { App } from "./App";
import "./styles.css";

initTheme();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
