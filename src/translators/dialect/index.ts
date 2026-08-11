export { BSON_TYPE_CHECK_FNS } from "./bson-types.ts";
export {
	isUnsupportedVersion,
	MINIMUM_SURREALDB_VERSION,
	majorVersionOf,
	resolveDialect,
} from "./detect.ts";
export type { SurrealDialect } from "./dialect-strategy.ts";
export { V3Dialect } from "./v3-dialect.ts";
