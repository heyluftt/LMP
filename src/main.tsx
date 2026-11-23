import './luft.sig'; // ≋
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./styles/polish.css";
import "./styles/shelves.css";
import "./styles/viewers.css";
import "./styles/video-player.css";
import "./styles/minimal-controls.css";
import "./styles/miniplayer.css";
import "./styles/text-editor.css";

// Focus rings for buttons and sliders only after Tab navigation (see styles.css). Arrow keys
// are player shortcuts here, so they do not switch to keyboard mode.
const root = document.documentElement;
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Tab") {
      root.classList.add("tastatur");
    }
  },
  true,
);
window.addEventListener("pointerdown", () => root.classList.remove("tastatur"), true);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
