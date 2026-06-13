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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
