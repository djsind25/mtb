// Maps a `profiles` row (snake_case, as stored) to the camelCase session shape the UI uses —
// keeps the component code close to the original prototype's session object shape.
export function mapProfileToSession(profile) {
  return {
    id: profile.id,
    role: profile.role,
    email: profile.email,
    name: profile.name,
    businessName: profile.business_name,
    zip: profile.zip,
    avatar: profile.avatar || (profile.role === "hauler" ? "🚛" : profile.role === "admin" ? "🛡️" : "👤"),
    verified: profile.verified,
    licenseActive: !!profile.license_active,
    insuranceActive: !!profile.insurance_active,
    membershipTier: profile.membership_tier || "free",
    jobSearchPrefs: profile.job_search_prefs || null,
    rating: profile.rating,
    notificationPrefs: profile.notification_prefs,
    active: profile.active,
    adminReadOnly: !!profile.admin_read_only,
    superAdmin: !!profile.super_admin,
  };
}
