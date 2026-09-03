// Organization application entitlements (two-fixes plan §1): the entitlement
// belongs to the organization that OWNS a resource. These helpers are the one
// place that logic lives — routes must not duplicate it, and a user's
// entitlement in one org must never authorize resources in another.
//
// A missing organization_apps row means DISABLED (recommended default).

/** Does this organization have the application enabled? */
export function organizationHasApp(db, organizationId, appCode) {
  if (!organizationId) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM organization_apps
       WHERE organization_id = ? AND app_code = ? AND status = 'enabled' AND disabled_at IS NULL`
    )
    .get(organizationId, appCode);
}

/** All organization ids with the application enabled — for intersecting into
 *  list/search/query scopes ("visible = accessible ∩ entitled"). */
export function entitledOrgIds(db, appCode) {
  return db
    .prepare(
      `SELECT organization_id FROM organization_apps
       WHERE app_code = ? AND status = 'enabled' AND disabled_at IS NULL`
    )
    .all(appCode)
    .map((r) => r.organization_id);
}
