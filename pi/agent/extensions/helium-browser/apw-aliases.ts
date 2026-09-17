/**
 * Trusted saved-login hostname groups. Add one row per site, then run /reload.
 *
 * Each hostname in a row may use credentials saved under any other hostname
 * in that row. Use exact lowercase hostnames only (no URLs, paths or wildcards).
 * Only group hosts you trust to receive the same credentials. Sharing a suffix
 * does not establish trust. Overlapping rows do not create transitive aliases.
 * Browser destination/origin confirmation remains exact.
 */
export const APW_HOSTNAME_ALIAS_GROUPS: readonly (readonly string[])[] = [
	["gradescope.com", "www.gradescope.com"],
	// ["example.com", "www.example.com"],
];

export function matchesSavedHostname(value: unknown, destination: string): value is string {
	if (typeof value !== "string") return false;
	if (value === destination) return true;
	return APW_HOSTNAME_ALIAS_GROUPS.some((group) => group.includes(destination) && group.includes(value));
}
