import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import { createRoot } from "react-dom/client";
import { GuidePage } from "./guide";
import { GuestPage } from "./guest";
import { HomePage } from "./home";
import "./styles.css";

const path = window.location.pathname.replace(/\/$/, "") || "/";
const guest = path.match(/^\/g\/([A-Za-z0-9]+)$/);

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

const page = guest ? <GuestPage code={guest[1].toUpperCase()} /> : path === "/guide" ? <GuidePage /> : <HomePage />;

createRoot(document.getElementById("root")!).render(page);
