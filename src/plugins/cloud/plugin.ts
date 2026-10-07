import type { InternalPlugin } from "#plugins/types";
import { createServiceToken } from "#app/service-registry";
import { CloudController } from "./controller.js";

export const CloudServiceToken = createServiceToken<CloudController>("cloud");

export function createCloudPlugin(): InternalPlugin {
  let controller: CloudController | null = null;

  return {
    id: "cloud",
    async activate(context) {
      controller = await CloudController.create(
        context.config,
        context.logs,
        context.externalAccess,
      );
      context.services.provide(CloudServiceToken, controller);
    },
    async deactivate() {
      await controller?.stop();
      controller = null;
    },
  };
}
