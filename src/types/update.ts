import type { Document } from "./documents.ts";

/** Update operators – mirrors MongoDB's `UpdateFilter`. */
export interface UpdateFilter<TSchema extends Document = Document> {
	$set?: Partial<TSchema> & Document;
	$setOnInsert?: Partial<TSchema> & Document;
	$unset?: { [key: string]: "" | true | 1 };
	$inc?: { [key: string]: number };
	$mul?: { [key: string]: number };
	$min?: { [key: string]: unknown };
	$max?: { [key: string]: unknown };
	$push?: { [key: string]: unknown };
	$pull?: { [key: string]: unknown };
	$addToSet?: { [key: string]: unknown };
	$rename?: { [key: string]: string };
	$currentDate?: { [key: string]: true | { $type: "date" | "timestamp" } };
	$pop?: { [key: string]: 1 | -1 };
	$pullAll?: { [key: string]: unknown[] };
}
