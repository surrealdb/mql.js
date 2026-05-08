/**
 * Backwards-compatibility re-export. The implementation lives at
 * `src/client/connection-string.ts`; existing imports such as
 * `from "./connection.ts"` continue to work via this shim.
 */
export {
	type ParsedConnection,
	parseConnectionString,
} from "./client/connection-string.ts";
