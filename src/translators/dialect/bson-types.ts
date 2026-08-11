/**
 * BSON type identifier → SurrealQL type-check function name.
 *
 * Keyed by both the BSON type alias (`"string"`) and its numeric code (`2`),
 * because `$type` accepts either form. Names use the SurrealDB 3.x
 * `type::is_*` spelling (2.x used a `type::is::*` namespace, which this
 * driver no longer targets — see `resolveDialect`).
 */
export const BSON_TYPE_CHECK_FNS: Record<string | number, string> = {
	double: "type::is_float",
	string: "type::is_string",
	object: "type::is_object",
	array: "type::is_array",
	bool: "type::is_bool",
	date: "type::is_datetime",
	null: "type::is_null",
	int: "type::is_int",
	long: "type::is_int",
	decimal: "type::is_decimal",
	number: "type::is_number",
	1: "type::is_float",
	2: "type::is_string",
	3: "type::is_object",
	4: "type::is_array",
	8: "type::is_bool",
	9: "type::is_datetime",
	10: "type::is_null",
	16: "type::is_int",
	18: "type::is_int",
	19: "type::is_decimal",
};
