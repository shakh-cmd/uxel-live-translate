import { createApp } from "./app";
import { loadConfig } from "./config";
import { log } from "./log";

const config = loadConfig();
const { server } = await createApp({ config });
server.listen(config.port, config.host, () => {
  log("listen", {
    url: `http://${config.host}:${config.port}`,
    provider: config.provider,
    maxGuests: config.maxGuests,
    storeAudio: config.storeAudio,
  });
  if (config.guidePin === "2468") {
    log("pin-warning", { message: "GUIDE_PIN is still the pilot default 2468. Change it before a real tour." });
  }
});
