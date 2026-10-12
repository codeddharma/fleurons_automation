import { env } from "./config/env";
import { app } from "./app";
import { logger } from "./lib/logger";

app.listen(env.PORT, () => {
  logger.info(`Fleurons automation middleware listening on port ${env.PORT}`);
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});
