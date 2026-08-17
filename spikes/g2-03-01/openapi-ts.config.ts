import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "spikes/g2-03-01/openapi/runtime-read.candidate.json",
  output: {
    path: "spikes/g2-03-01/web/src/generated",
    clean: true,
  },
});
