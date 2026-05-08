/**
 * BSON type identifier → SurrealQL v2 type-check function name.
 *
 * v3 dialect derives its names from these via simple renaming
 * (`type::is::X` → `type::is_X`).
 */
export const BSON_TYPE_NAMES_V2: Record<string | number, string> = {
	double: "type::is::float",
	string: "type::is::string",
	object: "type::is::object",
	array: "type::is::array",
	bool: "type::is::bool",
	date: "type::is::datetime",
	null: "type::is::null",
	int: "type::is::int",
	long: "type::is::int",
	decimal: "type::is::decimal",
	number: "type::is::number",
	1: "type::is::float",
	2: "type::is::string",
	3: "type::is::object",
	4: "type::is::array",
	8: "type::is::bool",
	9: "type::is::datetime",
	10: "type::is::null",
	16: "type::is::int",
	18: "type::is::int",
	19: "type::is::decimal",
};
