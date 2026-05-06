/**
 * The set of MongoDB update operators that ship with mql.js.
 */

import { UpdateOperatorRegistry } from "./operator-registry.ts";
import { arrayUpdateOperators } from "./operators/array.ts";
import { fieldOperators } from "./operators/field.ts";

export const DEFAULT_UPDATE_REGISTRY: UpdateOperatorRegistry =
	new UpdateOperatorRegistry().registerAll([
		...fieldOperators,
		...arrayUpdateOperators,
	]);
