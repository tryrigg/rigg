import packageMetadata from "../package.json" with { type: "json" }

// Bun inlines this access during `bun build --env=RIGG_*`.
// @ts-expect-error Bun build-time env injection relies on dot access here.
export const RIGG_VERSION = process.env.RIGG_VERSION ?? packageMetadata.version
