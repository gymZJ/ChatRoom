import { GitAccessToken } from "#app/git-access";
import { CommandRunner } from "#core/runtime/command-runner";
import type { InternalPlugin } from "#plugins/types";
import { GitService } from "./git-service.js";

export function createGitPlugin(): InternalPlugin {
  return {
    id: "git",
    activate(context) {
      const service = new GitService(new CommandRunner());
      context.services.provide(GitAccessToken, service);
    },
  };
}
