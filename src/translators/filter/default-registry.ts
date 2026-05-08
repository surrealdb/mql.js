/**
 * The set of MongoDB filter operators that ship with mql.js.
 *
 * `translateFilter` reuses one shared default registry; downstream users
 * could in principle build their own registry to extend or override
 * operators without touching the translator core.
 */

import { FilterOperatorRegistry } from "./operator-registry.ts";
import { arrayOperators } from "./operators/array.ts";
import { comparisonOperators } from "./operators/comparison.ts";
import { elementOperators } from "./operators/element.ts";
import { evaluationOperators } from "./operators/evaluation.ts";
import { geospatialOperators } from "./operators/geospatial.ts";
import { logicalOperators } from "./operators/logical.ts";
import { membershipOperators } from "./operators/membership.ts";

export const DEFAULT_FILTER_REGISTRY: FilterOperatorRegistry =
	new FilterOperatorRegistry().registerAll([
		...comparisonOperators,
		...membershipOperators,
		...elementOperators,
		...evaluationOperators,
		...arrayOperators,
		...geospatialOperators,
		...logicalOperators,
	]);
