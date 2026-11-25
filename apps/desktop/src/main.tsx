import { ardiaHost } from "./host";
import { popoverBoot } from "./popoverSurface";

function showStartupFailure(error: unknown) {
  console.error("[ardia linux] startup failed", error);
  const root = document.getElementById("root");
  if (root) {
    root.setAttribute("role", "alert");
    root.textContent = `Ardia could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const popover = popoverBoot(ardiaHost, location.search);
void (popover
  ? import("./popoverEntry").then(({ startPopover }) => startPopover(ardiaHost!, popover))
  : import("./shellEntry").then(({ startShell }) => startShell())
).catch(showStartupFailure);
