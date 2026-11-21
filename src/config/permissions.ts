/**
 * The permission matrix from the plan, in one place.
 * Changing who can do what is a one-line edit here.
 *
 * Rows marked "own family only" / "own" for residents are enforced inside the
 * route handler (the matrix only says whether the role may call the route at all).
 */
export const ROLES = ['chief', 'secretary', 'treasurer', 'resident'] as const;
export type Role = (typeof ROLES)[number];

export const ADMIN_ROLES: readonly Role[] = ['chief', 'secretary', 'treasurer'];

const ALL: readonly Role[] = ROLES;
const ADMINS = ADMIN_ROLES;
const MONEY_ADMINS: readonly Role[] = ['chief', 'treasurer'];
const CHIEF: readonly Role[] = ['chief'];

export const PERMISSIONS = {
  'families.view': ALL,
  'families.manage': ADMINS,
  'invites.send': ALL, // residents: own family only (checked in handler)
  'invites.manage': ADMINS,
  'members.approve': ADMINS,
  'members.view': ADMINS,
  'roles.assign': CHIEF,
  'society.edit': CHIEF,
  'complaints.raise': ALL,
  'complaints.updateStatus': ADMINS,
  'maintenance.setPlan': MONEY_ADMINS,
  'dues.viewOwn': ALL,
  'dues.viewAll': ADMINS,
  'payments.record': ADMINS,
  'payments.report': ALL,
  'dues.waive': MONEY_ADMINS,
  'expenses.manage': ADMINS,
  'statement.view': ALL,
  'finance.openingBalance': MONEY_ADMINS,
  'notices.manage': ADMINS,
  'notices.read': ALL,
  'documents.manage': ADMINS,
  'documents.viewResidents': ALL,
  'documents.viewAdmins': ADMINS,
  'contacts.manage': ADMINS,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function isAdminRole(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}
