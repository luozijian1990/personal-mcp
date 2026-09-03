import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@primer/react";

import { App } from "./App.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider colorMode="auto" dayScheme="light" nightScheme="dark_dimmed">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
