export const pinnedPostgresTestImage =
  "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";

const immutableImageReference = /^(?:sha256:[0-9a-f]{64}|[^\s@]+@sha256:[0-9a-f]{64})$/u;

export function resolvePostgresTestImage(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = environment.ONTOS_TEST_POSTGRES_IMAGE;
  if (override === undefined || override === "") return pinnedPostgresTestImage;
  if (!immutableImageReference.test(override)) {
    throw new Error(
      "ONTOS_TEST_POSTGRES_IMAGE must be an immutable sha256 image ID or digest reference",
    );
  }
  return override;
}
