# GYM MANAGEMENT PROJECT MASTER

**Technical handover and continuation reference**
**Last updated:** 21 November 2026 (Payments & Collections active-branch implementation, Flutter integration and static validation checkpoint; authenticated runtime tests and GitHub release remain pending in Section 38)
**Project owner / development context:** Innovex Fitness Center / Innovex Web Solutions
**Primary development environment:** Windows, PowerShell, Flutter, Node.js and MySQL 8. The active PowerShell project paths explicitly confirmed during the 20 November continuation are `D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_api` and `D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_app`. Earlier office-laptop paths and GitHub release checkpoints in Sections 31, 33 and 35 are historical records; verify the current machine, branch and working-tree state before any Git operation.

> **Purpose.** This document is the durable technical handover for continuing the Gym Management project in a new ChatGPT conversation. It records decisions, source paths, database facts, endpoints, implementation state, debugging history and pending work. It deliberately distinguishes verified implementation from requirements that have only been discussed. Unknown schema details are identified as unknown rather than guessed.

---

## 1. Project Overview and Objectives

The project is an Innovex Gym Management solution with a platform-level Super Admin application, a Node.js/MySQL backend and a separate Flutter application used by gym staff and members as that app is developed.

The intended product scope includes:

- Platform administration of gym organizations, branches, registered devices, licenses and platform audit activity.
- A gym operational application for branch-wise gym operations.
- Member registration and member profiles.
- Membership products and plans, including monthly, yearly and daily payment arrangements.
- Membership billing, payment recording and an approval workflow for actions that require administrator approval.
- Gym programs, program enrollment and program-specific member progress.
- Fitness progress history with member photographs and measurements.
- Role-based access control, with configurable roles and dynamic permissions.
- Auditing of important administrative and operational actions.

### Current product boundary

The platform-management foundation and the first operational Gym App modules are implemented in the project working copies. The Super Admin app/API include organization, device, license, initial Gym Owner provisioning, Gym Owner account editing and Platform Admin password reset. The Gym App/API include device activation/validation, Gym Staff authentication and session handling, branch switching, a global active-branch selector, Staff Management, branch/device/audit modules, Membership Plan and Fitness Program modules, Trainer Management, Member Management/search/registration foundations, and the Member Fitness API. The Member Fitness API branch-scope correction was included in the 18 November checkpoint; see Sections 35–36 for qualification and outstanding profile-scope/UI work. A billing ledger foundation for membership invoices, payments, refunds and waivers is now implemented at the API level, and the Flutter app has a standalone Payments navigation screen that is visible in the running app. However, the requested Payments & Collections dashboard redesign, global financial summary cards, automatic member type-ahead search, plan-based member collections report and its secure aggregate API are still pending as of 20 November; see Section 37. The removal of the old Billing & Payments entry from inside Membership has not yet been re-verified against the current source. The Flutter Role & Permission management UI and the Member Detail/Fitness UI follow-ups recorded in Section 36 must not be considered complete without fresh source and runtime evidence. A module being present must not be treated as proof that every business rule or error path is production-tested.

The original design considered an organization/tenant with multiple branches. The user later said full multi-tenant complexity could be deferred initially while branch-wise operations remained necessary. The implemented platform layer nevertheless has an `organizations` boundary, organization-owned branches, licenses and devices. The current state is therefore organization-scoped at the platform/device/license level; do not assume all future operational data APIs are already tenant-isolated.

---

## 2. Technology Stack and Development Environment

### Backend

- Node.js **v24.20.0**.
- npm **v11.19.0**.
- Express.js.
- MySQL **8.0.x** (office environment reported 8.0.39 in earlier setup notes).
- `mysql2` promise API for database access (`db.query`, `db.getConnection`).
- `dotenv` for environment configuration.
- `cors` and `express.json()` in the Express server.
- `bcrypt` for password hashing in platform admin authentication.
- `jsonwebtoken` for platform-admin JWTs.
- Node `crypto` for organization code generation, SHA-256 hashes and secure random tokens.

### Flutter

- Flutter **3.47.7 stable**.
- Dart **3.13.5**.
- Windows development environment; Android SDK **36.0.0** and Android Studio were installed.
- Pixel Tablet Android emulator used during development.
- `dio` for HTTP requests.
- `flutter_secure_storage` for platform-admin token storage.
- Flutter Material 3 UI.

### Office laptop project paths

```text
%USERPROFILE%\Documents\INNOVEX WEB\Flutter Projects\
    gym_management_api\
    gym_management_super_admin\
    gym_management_app\
```

The same logical projects previously existed on the original development laptop under:

```text
D:\Personal\INNOVEX WEB\Flutter Projects\
    gym_management_api\
    gym_management_super_admin\
    gym_management_app\
```

The user explicitly said work was continuing on the office laptop and did not want to switch back to or pull to the original laptop during this development session. Do not assume the original laptop has the newest changes.

### API runtime

The API server uses `process.env.PORT || 5000` and was accessed locally at:

```text
http://localhost:5000
```

The health endpoint returned the following successful response on the office laptop:

```json
{
  "success": true,
  "api": "connected",
  "database": "connected"
}
```

The exact current Flutter API base URL is configured in `lib/core/constants/api_constants.dart`; its literal value was not included in the source excerpts available for this handover. Do not guess it. The API `.env` contains local secrets and must not be committed or pasted into chat.

---

## 3. Final Project Architecture

There are three separately versioned repositories:

| Layer | Project folder | GitHub repository |
|---|---|---|
| Backend API | `gym_management_api` | `https://github.com/arafath65/gym-management-api.git` |
| Platform Super Admin app | `gym_management_super_admin` | `https://github.com/arafath65/gym-management-super-admin.git` |
| Gym operational app | `gym_management_app` | `https://github.com/arafath65/gym-management-apps.git` |

The repositories are separate; do not assume one Git commit pushes all three.

### Logical architecture

```text
Platform Administrator
        |
        v
Flutter Super Admin App
  - Login / JWT storage
  - Dashboard
  - Organizations and branches
  - Device management
  - License management
  - Audit log viewer
        |
        | HTTPS/HTTP JSON + Bearer JWT
        v
Node.js / Express API
  - Platform-admin authentication
  - Organization and branch controllers
  - Device registration and activation
  - License lifecycle
  - Platform audit read/write
        |
        v
MySQL 8
  - organizations / branches
  - platform_admins / platform_audit_logs
  - licenses / devices
  - gym users / roles / permissions (schema exists or is planned in current design;
    operational implementation still needs verification)

Separate Flutter Gym App
  - Intended staff-side membership, payments, programs and member operations
  - Backend integration and completed feature coverage are not established
    by the latest verified source excerpts.
```

### Current tenant / branch model

- `organizations` is the platform-level gym/customer boundary.
- `branches` belongs to an organization (`organization_id` is used by the branch controller).
- Devices belong to an organization and may be assigned to a branch.
- Licenses belong to an organization and determine the allowed active-device count.
- The future operational app must consistently scope gym data to the authenticated organization and branch. That full set of operational query scopes has not yet been verified.

---

## 4. Flutter App Structure and Screens

### 4.1 Super Admin Flutter app

Project root:

```text
gym_management_super_admin/
```

Known source structure and classes:

```text
lib/
  main.dart
  core/
    constants/
      api_constants.dart
    services/
      auth_service.dart
  features/
    auth/
      login_screen.dart
    dashboard/
      dashboard_screen.dart
    organizations/
      organizations_screen.dart
      organization_edit_screen.dart
    devices/
      device_management_screen.dart
    licenses/
      license_management_screen.dart
    audit_logs/
      audit_logs_screen.dart
```

The folder and source filenames above were confirmed by actual file listings and terminal output after the patches were installed, except that the precise internals of `api_constants.dart` were not included in the excerpts.

#### `main.dart`

- Runs `GymSuperAdminApp`.
- Material 3 theme.
- Seed/primary red: `0xFFE50914`.
- Secondary/dark: `0xFF111111`.
- Home screen: `LoginScreen`.

#### Authentication

- `LoginScreen` handles platform-admin login and navigates to the dashboard after a successful login (the navigation implementation exists in the app, although only its import and dashboard integration were in the latest source excerpt).
- `AuthService` is the shared API client and token-store owner.

#### Dashboard

Class: `DashboardScreen` in `lib/features/dashboard/dashboard_screen.dart`.

Displayed counters:

- Organizations.
- Active Devices.
- Active Licenses.
- Pending Devices.

Management tiles:

- Organizations.
- Device Management.
- License Management.
- Audit Logs.

The License Management and Audit Logs tiles were initially placeholders. The License patch wired License Management, and the Audit Logs patch wired the Audit Logs screen. The dashboard refreshes organization/device/license statistics after returning from the related screens where implemented.

#### Organizations

Classes:

- `OrganizationsScreen` â€” list/search/status filter, organization cards and creation dialog.
- `OrganizationEditScreen` â€” organization details, existing organization-level license configuration, editable initial Gym Owner name/login username, and a password-reset action (see Section 30).

Organization creation collects name, slug, optional email/phone/address and initial license settings. License choices are `trial`, `monthly`, `yearly`, and `lifetime`; maximum devices is validated in the UI between 1 and 1000. Trial duration is configurable from 1 to 365 days. Lifetime uses no expiry date.

Important architectural note: the older organization edit flow can update the latest existing license in place through `PUT /api/organizations/:organizationId`. The dedicated License Management module is the separate workflow for new license records, renewals and history. Prefer the dedicated license module for renewals/history rather than treating organization-edit as a renewal operation.

#### Device Management

Class: `DeviceManagementScreen` in `lib/features/devices/device_management_screen.dart`.

Implemented UI behavior:

- Server-side search and pagination.
- Filters for device status, organization and branch.
- Page sizes 25, 50 and 100.
- Search debounce of approximately 450 ms.
- Request sequence IDs suppress stale search/filter responses.
- Organization and branch dropdowns; branch choices can include inactive branches for filtering.
- Responsive device card grid: two cards across at wide tablet/desktop widths (threshold 720 px); one column at narrower widths.
- Compact card header expands to show organization, branch, device UUID, last seen and activation expiry.
- Device action menu includes revoke, reactivate/regenerate activation code or cancel pending registration, depending on state.
- Activation code is displayed once to the administrator after registration/regeneration and can be copied.

#### License Management

Class: `LicenseManagementScreen` in `lib/features/licenses/license_management_screen.dart`.

Implemented and reported working by the user:

- License list and paging.
- Search.
- Filters for license type, organization and status.
- Summary counts.
- License detail view and organization license history.
- Issue a license.
- Renew the latest license by creating a new historical record.
- Change license status among active, suspended and expired.
- Responsive two-column cards on wide layouts.

Latest user-requested UI adjustment:

- Default list status is `active`.
- Status choices are `all`, `active`, `suspended`, and `expired`.
- Status dropdown is positioned beside the organization dropdown, while license type remains a separate filter.
- Selecting `All` exposes historical rows, including old expired records. Historical licenses must not be deleted just because a renewed license exists.

The user explicitly reported that License Management was working after testing a renewal and seeing both old and new records. That is intended history behavior.

#### Audit Logs

Class: `AuditLogsScreen` in `lib/features/audit_logs/audit_logs_screen.dart`.

Patch installed and formatted. Its intended features are:

- Read-only platform audit list.
- Search across action/entity/description/IP/admin/organization/entity ID.
- Action and entity-type filters.
- Organization/admin/date filtering supported by the API method.
- Date range selection.
- Pagination (25/50/100).
- Expandable audit records showing admin, organization, action/entity metadata, IP, user-agent and old/new JSON values.
- No edit/delete controls.

**Runtime status:** Flutter source exists and formatting was run. The latest shared `flutter analyze` output showed two informational lint warnings in `audit_logs_screen.dart` at lines 798 and 826 (`curly_braces_in_flow_control_structures`); no Flutter errors were reported. The user has not yet shared the post-fix analyzer result or a runtime screenshot confirming the audit list loads records.

### 4.2 Main Gym Management Flutter app

Project root:

```text
gym_management_app/
```

This is a separate repository from Super Admin.

The gym operational app is intended for organization/branch users and will eventually cover members, memberships, payments, programs, enrollments and fitness history. The project has been set up as a Flutter app. An earlier source excerpt showed a generic `GymManagementApp` and a `LoginScreen` prototype. That prototype had a local 500 ms delayed mock login and an explicit comment that backend authentication would be connected in a later phase. Therefore, that earlier login source is not evidence of a completed production authentication flow.

UI direction discussed for the gym app included a gym-themed splash screen with Innovex branding, progress indicator, tablet-friendly 2560x1600 design target, and a motivated green/black palette with a small red accent. Treat the design direction as a preference unless the current app source confirms the final implementation.

---

## 5. Backend Node.js API Architecture

### Project structure (known modules)

```text
gym_management_api/
  src/
    server.js
    config/
      db.js
    routes/
      platformAdminRoutes.js
      organizationRoutes.js
      branchRoutes.js
      deviceRoutes.js
      licenseRoutes.js
    controllers/
      platformAdminController.js
      platformDashboardController.js
      organizationController.js
      branchController.js
      deviceController.js
      deviceManagementController.js
      licenseManagementController.js
      platformAuditController.js
    middleware/
      platformAdminMiddleware.js
      licenseMiddleware.js
    services/
      platformAuditService.js
  .env                 # local secrets; do not commit
  package.json
```

Some file names and directories were directly inspected; the `licenseManagementController.js`, `licenseRoutes.js`, `platformAuditController.js` and audit screen were introduced by patches in this conversation.

### `src/server.js`

Known middleware and mounts:

```js
app.use(cors());
app.use(express.json());
app.use("/api/organizations", organizationRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/platform-admin", platformAdminRoutes);
app.use("/api/licenses", licenseRoutes);
```

Also exposes:

- `GET /` â€” API-running response.
- `GET /api/health` â€” checks MySQL with `SELECT 1 AS database_connected`.

### Database connection

`src/config/db.js` supplies the shared `mysql2` connection/pool used by controllers. Mutating controller workflows use `db.getConnection()`, `beginTransaction`, `commit`, `rollback` and `release` when transaction safety is required.

### Controller style

- Express request/response handlers.
- Parameterized SQL queries.
- JSON responses with `success` and `message` fields.
- Validation before database writes.
- Transactions for sensitive multi-step actions, especially organization/license/device operations.
- `console.error` server-side logging and stable user-facing error messages.

---

## 6. MySQL Database Structure

### 6.1 Known table inventory

The platform database has these table names in the current project design/inspection history:

1. `organizations`
2. `branches`
3. `licenses`
4. `devices`
5. `platform_admins`
6. `platform_audit_logs`
7. `users`
8. `roles`
9. `permissions`
10. `role_permissions`
11. `user_roles`
12. `user_branch_access`
13. `audit_logs`

The first six support the platform-management/device/license/audit features documented here. The remaining tables are present in the database design inventory, but their complete DDL and column-level definitions were not available in the conversation excerpts. Membership/program-specific table names were not confirmed and must not be invented.

### 6.2 `organizations` â€” full DDL facts confirmed

| Column | Type / definition | Constraints / meaning |
|---|---|---|
| `id` | `bigint unsigned` | Primary key, auto increment |
| `name` | `varchar(150)` | Not null |
| `slug` | `varchar(100)` | Not null, unique |
| `organization_code` | `varchar(30)` | Nullable, unique |
| `email` | `varchar(150)` | Nullable |
| `phone` | `varchar(30)` | Nullable |
| `address` | `text` | Nullable |
| `status` | `enum('active','suspended','inactive')` | Not null, default `active` |
| `created_at` | `timestamp` | Nullable, default current timestamp |
| `updated_at` | `timestamp` | Nullable, current timestamp on update |

`organizations` is the parent for branch, device and license ownership in the implemented platform design. A separate full DDL excerpt for the organization table was shared.

### 6.3 `licenses` â€” full DDL facts confirmed

| Column | Type / definition | Constraints / meaning |
|---|---|---|
| `id` | `bigint unsigned` | Primary key, auto increment |
| `organization_id` | `bigint unsigned` | Not null; FK to `organizations.id`, `ON DELETE RESTRICT` |
| `license_type` | `enum('trial','monthly','yearly','lifetime')` | Not null, default `trial` |
| `license_status` | `enum('active','expired','suspended')` | Not null, default `active` |
| `max_devices` | `int unsigned` | Not null, default 2 |
| `starts_at` | `datetime` | Not null |
| `expires_at` | `datetime` | Nullable; `NULL` for lifetime license |
| `created_by_platform_admin_id` | `bigint unsigned` | Nullable; FK to `platform_admins.id`, `ON DELETE SET NULL` |
| `notes` | `varchar(500)` | Nullable |
| `created_at` | `timestamp` | Nullable, default current timestamp |
| `updated_at` | `timestamp` | Nullable, current timestamp on update |

Indexes confirmed:

- Primary key on `id`.
- `idx_licenses_org_status` on (`organization_id`, `license_status`).
- `idx_licenses_expiry` on (`expires_at`).
- `fk_license_platform_admin` index on (`created_by_platform_admin_id`).

Important rules:

- `lifetime` licenses cannot have an expiry date.
- A license is valid only when status is active, its start time has arrived, and its expiry is null or in the future.
- `max_devices` is validated by the License API between 1 and 1000.
- Renewals create a new row; history is preserved.

### 6.4 `platform_admins` â€” full DDL facts confirmed

| Column | Type / definition | Constraints / meaning |
|---|---|---|
| `id` | `bigint unsigned` | Primary key, auto increment |
| `full_name` | `varchar(150)` | Not null |
| `email` | `varchar(150)` | Not null, unique |
| `password_hash` | `varchar(255)` | Not null |
| `status` | `enum('active','inactive','locked')` | Not null, default `active` |
| `last_login_at` | `datetime` | Nullable |
| `created_at` | `timestamp` | Nullable, default current timestamp |
| `updated_at` | `timestamp` | Nullable, current timestamp on update |

### 6.5 `platform_audit_logs` â€” all columns confirmed; constraints partly unknown

| Column | Type / definition | Nullability / meaning |
|---|---|---|
| `id` | `bigint unsigned` | Not null; primary key |
| `platform_admin_id` | `bigint unsigned` | Not null; indexed |
| `organization_id` | `bigint unsigned` | Nullable; indexed |
| `action` | `varchar(100)` | Not null |
| `entity_type` | `varchar(100)` | Nullable; indexed |
| `entity_id` | `bigint unsigned` | Nullable |
| `description` | `text` | Nullable |
| `old_values` | `json` | Nullable |
| `new_values` | `json` | Nullable |
| `ip_address` | `varchar(45)` | Nullable |
| `user_agent` | `varchar(500)` | Nullable |
| `created_at` | `timestamp` | Nullable; default current timestamp |

Only the `INFORMATION_SCHEMA.COLUMNS` output was used for the complete column list. The full FK/index/engine DDL was truncated in the user-provided output, so do not infer unshown FK delete rules.

### 6.6 `branches` â€” columns observed in controller SQL; full DDL not provided

Observed branch fields:

- `id`
- `organization_id`
- `name`
- `branch_code`
- `phone`
- `address`
- `status`
- `created_at`

The controller uses `organization_id` as the organization association. Branch creation requires name and branch code; the code is uppercased and duplicate branch codes are rejected within the same organization. It returns new branches with status `active`. Full types, indexes and formal FK constraints were not verified with `SHOW CREATE TABLE`.

### 6.7 `devices` â€” columns observed through controllers; full DDL not provided

Fields used in API/controller queries and updates include:

- `id`
- `organization_id`
- `registered_branch_id`
- `device_uuid`
- `device_name`
- `device_type`
- `status`
- `activation_code_hash`
- `activation_expires_at`
- `device_token_hash`
- `last_seen_at`

The exact complete table definition, unique keys, FK constraints, and any additional timestamp fields were not supplied. Device states used in code are `pending`, `active`, and `revoked`.

### 6.8 User, role and permission tables â€” names known, full DDL not supplied

The design inventory includes:

- `users`
- `roles`
- `permissions`
- `role_permissions`
- `user_roles`
- `user_branch_access`
- `audit_logs`

Likely logical associations from their names and the user's decisions are user-to-role, role-to-permission and user-to-branch access. **This logical description is not a substitute for verified foreign keys.** Column names, unique constraints, indexes and exact relationship cardinality remain to be confirmed by retrieving each table's `SHOW CREATE TABLE` output.

### 6.9 Sample license records observed on 10 November 2026 (before later renewal test)

The user initially shared these three rows:

| License ID | Organization ID | Type | Status | Device limit | Start | Expiry |
|---:|---:|---|---|---:|---|---|
| 3 | 1 | yearly | active | 2 | 2026-11-09 20:23:39 | 2027-12-09 23:59:59 |
| 2 | 3 | lifetime | active | 1 | 2026-11-09 18:15:22 | `NULL` |
| 1 | 2 | trial | active | 5 | 2026-11-09 16:12:04 | 2026-11-23 16:12:04 |

Later the user intentionally marked a license expired and renewed it to verify history behavior. Therefore, the table above is a historical snapshot, **not a statement of the current live rows**.

### 6.10 Organization/branch data observed

An organization was created:

- Name: `Innovex Fitness Center`
- Slug: `innovex-fitness`

A branch was created:

- Name: `Colombo Main Branch`
- Branch code: `COL-001`
- Address: `Colombo 06, Sri Lanka`

The current database's numeric IDs should be read from MySQL rather than assumed in future scripts.

---

## 7. Authentication and Authorization

### Platform administrator authentication (implemented; Platform Admin RBAC tables and initial assignment created; enforcement pending)

- Login endpoint: `POST /api/platform-admin/login`.
- Password hashes are stored in `platform_admins.password_hash` and checked with bcrypt.
- Successful login returns a JWT with `platform_admin_id`, email and `role: "platform_admin"`; token expiry is 12 hours.
- `authenticatePlatformAdmin` requires a Bearer token, verifies the JWT, checks the role and re-queries `platform_admins` to ensure the account remains active.
- Middleware sets `req.platformAdmin = { id, email }`.
- Flutter `AuthService` stores the token in `FlutterSecureStorage` with key `platform_admin_token`; authenticated Dio requests send the Bearer token.

**Important verified gap:** Platform Admin RBAC database tables and the initial Super Admin assignment now exist (details in Section 26), but the current Platform Admin middleware still authenticates identity and active status only. It does not load the assigned role's permissions or check a permission key for each route/action. Platform Admin login also updates `last_login_at`, but the inspected `loginPlatformAdmin` controller does not write a platform audit event for successful or failed login attempts.

### Gym staff authorization (schema exists; runtime enforcement not yet verified)

The current `roles`, `permissions`, `role_permissions` and `user_roles` structures are organization-scoped to Gym Staff users. See Section 9 for their confirmed DDL relationships. Do not use this organization-scoped role assignment as if it were a Platform Admin permission system.

For both applications, the backend must be the security boundary: every protected API operation must check the acting user's effective permission and organization/branch scope. Flutter should hide or disable unavailable actions for usability, but UI checks must never replace backend checks.

### Platform Admin RBAC (database structure created; middleware enforcement pending)

Platform Admins use a dedicated role/permission model separate from organization-scoped Gym Staff RBAC. Tables created in MySQL: `platform_permissions`, `platform_roles`, `platform_admin_roles` and `platform_role_permissions`. The initial `Super Admin` role has been assigned to active Platform Admin ID `1` (MMM Arafath) with 19 permissions. The API middleware must still load and enforce these permissions per route/action. Never grant a request access solely because its JWT contains `role: "platform_admin"`.

---

## 8. Organization, Branch and User Management

### Organization management (implemented)

Controller: `organizationController.js`. Routes in `organizationRoutes.js` apply `router.use(authenticatePlatformAdmin)` to all organization routes.

Endpoints:

- `GET /api/organizations/` â€” list organizations and the latest license information.
- `POST /api/organizations/` â€” create organization and its initial license.
- `PUT /api/organizations/:organizationId` â€” update organization and, when license fields are supplied, update the latest license row in place.
- `PATCH /api/organizations/:organizationId/status` â€” set organization status (`active` or `inactive` in this controller's accepted workflow); action is audited.

Organization creation details:

- `name` and `slug` required.
- Slug normalized lowercase and constrained to letters, numbers and hyphens.
- Organization code generated as `GYM-` plus six uppercase hexadecimal characters from `crypto.randomBytes(3)`.
- Initial license can be trial/monthly/yearly/lifetime.
- Device limit 1â€“1000.
- Trial duration 1â€“365 days (default 14).
- Lifetime has no expiry.
- Creation and initial license are handled in a transaction and audit logging is used.

Organization status and license status are separate concepts. An organization can be active while its license is expired/suspended; device activation is still gated by the license check.

### Branch management (basic API exists; incomplete and currently unauthenticated)

Controller: `branchController.js`. Current routes:

- `GET /api/branches/:organizationId` â€” list branches.
- `POST /api/branches/:organizationId` â€” create a branch.

The latest source inspection confirmed that `branchRoutes.js` applies **no authentication or permission middleware**. The controller performs direct queries/inserts, has no transaction-backed platform audit write, and exposes no update/status-change/delete API. Route mounting is `app.use("/api/branches", branchRoutes)` in `server.js`. These routes must be secured before the Super Admin branch screen is connected. Platform Admin calls need `authenticatePlatformAdmin` plus permission checks; later Gym Staff branch management must use Gym authentication, permission checks and organization/branch scoping rather than reusing a Platform Admin identity.

Branch creation requires `name` and `branch_code`; branch code is uppercased and uniqueness is scoped to `organization_id`. Phone/address are optional. For normal lifecycle management, prefer marking a branch inactive rather than hard-deleting it: registered devices reference branches with `ON DELETE RESTRICT`, and user branch assignments have their own FK/cascade semantics.

### Gym Staff user management and first Gym Owner provisioning (not implemented)

The `users` table and role/branch association tables exist, but the latest source inspection found no user/role/auth route or controller files and no matching user-creation, invitation or role-assignment endpoints. The Super Admin Flutter feature list contains no Gym Users or Roles screens. First-time Gym Owner provisioning is therefore still missing. Design a secure invitation flow so the owner sets their own password; do not use a shared/default password. The owner is a Gym Staff user in the tenant, not a Platform Admin.

---

## 9. Roles and Dynamic Permissions

### Confirmed Gym Staff role/permission schema (10 November 2026)

The user supplied these `SHOW CREATE TABLE` definitions from the current MySQL database:

- `roles`: `id`, required `organization_id`, `name`, optional description, `is_system_role`, `created_at`. Role names are unique per organization; a composite unique key supports organization-scoped references. It has an FK to `organizations`.
- `permissions`: global catalog with `id`, unique `permission_key`, `module_name`, optional description.
- `role_permissions`: composite primary key (`role_id`, `permission_id`); FKs to `roles` and `permissions`.
- `user_roles`: `organization_id`, `user_id`, `role_id`; composite FKs ensure both the user and role belong to the same organization.
- `platform_admins` has no role/permission assignment columns or related table in the supplied table inventory.

These relationships confirm that the existing role tables are designed for organization-scoped Gym Staff users, not Platform Admins. The current Gym Staff permission-checking middleware and complete API enforcement coverage have not yet been demonstrated. Platform Admin RBAC has now been separately created; see Section 26.

### Permission catalog observed in MySQL

The user supplied the current rows from `permissions` (IDs 1â€“21):

| ID | Permission key | Module |
|---:|---|---|
| 1 | `organizations.view` | Organizations |
| 2 | `organizations.create` | Organizations |
| 3 | `organizations.update` | Organizations |
| 4 | `organizations.suspend` | Organizations |
| 5 | `branches.view` | Branches |
| 6 | `branches.create` | Branches |
| 7 | `branches.update` | Branches |
| 8 | `branches.delete` | Branches |
| 9 | `users.view` | Users |
| 10 | `users.create` | Users |
| 11 | `users.update` | Users |
| 12 | `users.deactivate` | Users |
| 13 | `roles.view` | Roles & Permissions |
| 14 | `roles.create` | Roles & Permissions |
| 15 | `roles.update` | Roles & Permissions |
| 16 | `roles.delete` | Roles & Permissions |
| 17 | `roles.assign` | Roles & Permissions |
| 18 | `audit_logs.view` | Audit Logs |
| 19 | `licenses.view` | Licenses |
| 20 | `licenses.activate` | Licenses |
| 21 | `licenses.suspend` | Licenses |

The observed 21-row catalog belongs to the Gym Staff permission system. It does not include device-specific keys and must not be treated as the Platform Admin catalog. A separate `platform_permissions` catalog has been seeded with 19 initial Platform Admin permissions, including device permissions; see Section 26.

### Mandatory authorization rule for the whole product

- Every meaningful mutation and protected read must be authorized by the backend against the actor's assigned role/permissions and organization/branch scope.
- Super Admin routes must enforce the newly created Platform Admin RBAC tables using permission middleware (distinct view/create/update/suspend/activate/revoke actions); the schema and initial 19 permissions are created, but middleware/route enforcement remains to be implemented.
- Gym Staff routes must use the organization-scoped role assignment (`user_roles`) and enforce branch access as well as permission keys.
- Flutter permission-aware visibility/disablement is required for good UX, but is never the security boundary.
- Permission changes, role assignment/removal and denied security-sensitive operations must have appropriate audit/security history.

---

## 10. Device Registration, Activation and Server Validation

### 10.1 Device registration

Platform Admin registration endpoint:

- `POST /api/devices/register`
- Required body fields: `organization_id`, `device_uuid`, `device_name`, `device_type`.
- `registered_branch_id` is optional.
- Known device types: `android_tablet`, `android_mobile`, `other`.

The registration controller validates organization and branch ownership, checks organization/license state and active-device quota, inserts a pending device, and returns a one-time activation code. The code is stored as a SHA-256 hash; plaintext is returned only in the registration response for the Super Admin to share.

**Current expiry policy (12 November 2026 source update):** newly registered device activation codes expire after **15 minutes**. Regenerated activation codes also expire after **15 minutes**. Both SQL write paths use `DATE_ADD(NOW(), INTERVAL 15 MINUTE)`.

Important rollout detail: pending codes created before this change retain the `activation_expires_at` value already stored in MySQL. To bring an older pending device onto the 15-minute policy and invalidate its previous code, regenerate its activation code through Super Admin. A database table/schema change is not required because `devices.activation_expires_at` already exists.

The code generator remains `crypto.randomBytes(5).toString("hex").toUpperCase()` (10 hexadecimal characters). The hash, UUID binding and expiry are checked by the API. Rate limiting for repeated activation attempts remains a security-hardening item.

### 10.2 Gym App activation — code only, no Organization ID

Endpoint:

- `POST /api/devices/activate`

The route is intentionally separate from Platform Admin management routes. The prior `checkOrganizationLicense` route middleware has been removed because it required an Organization ID before the controller could identify the organization. The `activateDevice` controller performs the organization and license checks itself.

Request body is now:

```json
{
  "device_uuid": "device-unique-id",
  "activation_code": "one-time-code"
}
```

The Gym Owner does **not** need to know or enter an internal Organization ID. The Gym App automatically reads its stable installation UUID from Flutter Secure Storage and sends it with the code.

Current activation sequence:

1. Require non-empty `device_uuid` and `activation_code`.
2. Hash the submitted code and find a matching `pending` device by both UUID and activation-code hash.
3. Derive `organization_id` from the matched device row; do not trust an organization ID supplied by the Gym App.
4. Begin/continue a DB transaction and lock the organization and latest license (`FOR UPDATE`).
5. Require active organization, an existing active license, license start reached, and license not expired.
6. Count active devices and enforce the latest license's `max_devices`.
7. Re-select/lock the matching device using organization, UUID and activation hash; reject invalid, expired or non-pending activation.
8. Generate a 32-byte cryptographically random device token; store only its SHA-256 hash in `devices.device_token_hash`.
9. Set device status to `active`; clear activation code hash and expiry; update `last_seen_at`.
10. Commit and return the plaintext device token once, along with organization and device identity.

The device token is saved in Flutter Secure Storage. It must never be logged or stored plaintext in MySQL.

### 10.3 Super Admin activation-code popup

The Super Admin device screen now displays the following when a device is registered or a new code is generated:

- Gym/organization name.
- Registered device name.
- One-time activation code with Copy Code action.
- A message stating that the code is valid for 15 minutes from generation.

The registration popup obtains the organization name from the selected organization and the device name from the registration response. Regeneration/reactivation uses organization and device names returned with the device data. The popup continues to disclose the plaintext code once; the API stores only the hash.

The popup currently displays a 15-minute validity message; a live countdown timer is not implemented.

### 10.4 Device token validation at Gym App startup

New API endpoint:

- `GET /api/devices/validate`
- Authentication: `Authorization: Bearer <device-token>` (the device token returned once by successful activation).

New reusable API middleware:

- `src/middleware/deviceAuthMiddleware.js`
- Export: `authenticateDevice`

The middleware hashes the supplied token and looks it up against `devices.device_token_hash`. It joins the device to its organization and latest license, and validates:

- Device record exists and `devices.status = 'active'`.
- Organization status is `active`.
- A latest license exists and its status is `active`.
- License start time has arrived.
- License expiry is null or is in the future.

On success it populates `req.device` with device ID, organization ID/name, UUID, device name and status. `GET /api/devices/validate` uses this middleware and returns the verified organization/device identity. The validation route is placed before `router.use(authenticatePlatformAdmin)` so it accepts a Gym App device token, not a Platform Admin JWT.

The Gym App `DeviceActivationService.validateSavedActivation()` calls this endpoint before `AppEntryScreen` displays the login screen. It checks that returned organization ID, device ID and UUID match the identity saved during activation.

Behavior implemented in the Gym App:

- Missing saved activation: show activation screen.
- Valid active device and valid organization/license: allow the login screen.
- Deleted device, invalid device token, pending device or revoked device: clear the saved activation record and return to activation screen.
- Clearing a rejected activation deletes only the saved activation/token record. The stable device UUID (`gym_device_uuid_v1`) is deliberately preserved for re-registration/reactivation.
- Inactive organization, missing/inactive/not-yet-started/expired license: block login and show the retry/error screen while retaining the saved activation record, so the same device can recover when the account/license is restored.
- Network/server validation failure: block login and show retry/error UI, retaining the saved activation record; no offline bypass is allowed.

**Lifecycle scope:** the current implementation performs the server check when `AppEntryScreen` is initialized (app startup/restart). It does not yet add a separate `WidgetsBindingObserver` revalidation on every foreground resume. After changing Dart source, the running emulator app must be hot-restarted or rebuilt/reinstalled before testing the updated code. A hot restart is not the same as merely switching back to an already-running stale app process.

### 10.5 Reusable device middleware — route coverage limitation

`authenticateDevice` is implemented and currently protects `GET /api/devices/validate`. It is intended to be applied to each protected Gym Staff/operational API route when those routes are built. The current Gym Staff authentication/session and operational API surface is not yet implemented, so do not claim every future business endpoint is already protected.

Platform Admin device-management endpoints remain separately protected by `authenticatePlatformAdmin` and Platform Admin permissions. Do not use a Gym device token as a Platform Admin credential or vice versa.

### 10.6 Device management endpoints

- `GET /api/devices/` — list with server-side pagination and filters (Platform Admin).
- `POST /api/devices/register` — register pending device and return a one-time activation code (Platform Admin).
- `POST /api/devices/:deviceId/activation-code` — regenerate activation code / reactivate a revoked device (Platform Admin).
- `PATCH /api/devices/:deviceId/revoke` — revoke a device and clear its device-token hash (Platform Admin).
- `POST /api/devices/activate` — activate Gym App device using UUID + code only.
- `GET /api/devices/validate` — verify an activated Gym App device token and organization/license state.

Prefer the Super Admin **Revoke Device** action over physically deleting a row from `devices`. Revocation preserves device identity and audit history while clearing authorization. A deleted row is also rejected at startup because its token hash can no longer be found, but direct database deletion bypasses the intended audit trail.

### 10.7 Latest device-validation test observations (12 November 2026)

- The user deleted a previously registered device row directly from `gym_management_db.devices`.
- After the API and Gym App validation updates were applied and the Gym App was restarted, the app showed the Activation screen instead of the login screen. This is a positive observation for deleted-device startup validation.
- The user then re-registered and activated the device with the code-only flow.
- The user revoked the device through Super Admin and initially observed the Gym App still on the login screen. The user clarified that the latest Gym App code had not been hot-restarted in the emulator. Therefore this was a stale-running-app test, not a confirmed failure of the updated startup validation.
- **Revoked-device startup validation still needs a repeat test after hot restart/rebuild of the Gym App.** Expected: on next startup the API returns `DEVICE_NOT_ACTIVE`, the app clears the saved activation record but keeps the UUID, and shows Activation.
- The current database's final device row/status was not supplied after the test; query MySQL before assuming whether the test device is pending, active, revoked or deleted.

### 10.8 Device audit and security follow-ups

- `registerDevice`, activation-code regeneration/reactivation and `revokeDevice` write `platform_audit_logs` in the mutation transaction.
- `activateDevice` still lacks a device-originated operational audit event. Do not falsely attribute activation to a Platform Admin; design the correct actor representation and write the audit in the activation transaction.
- `authenticateDevice` currently authenticates a bearer device token and checks device/org/license status. Attach it to every protected Gym Staff endpoint when implemented.
- Add rate limiting or attempt throttling for public activation attempts; do not log activation codes or plaintext device tokens.
- The existing one-active-device/two-pending-device quota test remains distinct and is not yet recorded as passed.

### Device list query behavior

Known filters: `status`, `organizationId`, `branchId`, `search`, `page`, `limit`.

Page size values: 25, 50, 100. The response includes `devices`, `pagination`, `statusCounts` (`all`, `pending`, `active`, `revoked`) and `filters`. Status counts intentionally ignore the currently selected status while respecting other filters.

---

## 11. Activation Code and License Management

### License types and states

Allowed types from the actual MySQL enum and API validation:

- `trial`
- `monthly`
- `yearly`
- `lifetime`

Allowed states:

- `active`
- `expired`
- `suspended`

A lifetime license has `expires_at = NULL`.

### License middleware

`src/middleware/licenseMiddleware.js` checks the latest license for an organization and blocks activation when:

- No license exists.
- License status is not active.
- Current time is before `starts_at`.
- `expires_at` has passed.

It sets the validated license context on the request (`req.organizationLicense`) for downstream use.

### Dedicated License API (implemented by patch)

Mounted at `/api/licenses` in `src/server.js`; `licenseRoutes.js` applies `router.use(authenticatePlatformAdmin)` to all routes.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/licenses/` | Paginated/searchable/filterable license list |
| GET | `/api/licenses/:licenseId` | License detail and organization license history |
| POST | `/api/licenses/` | Issue a license |
| POST | `/api/licenses/:licenseId/renew` | Renew latest license by inserting a new row |
| PATCH | `/api/licenses/:licenseId/status` | Change status to active/suspended/expired |

List filters include `search`, `status`, `licenseType`, `organizationId`, `page`, and `limit`. Returned license rows include organization fields, `effective_status` and `is_latest`; response also includes status counts and pagination.

Important logic in `licenseManagementController.js`:

- `validateMaxDevices`: integer 1â€“1000.
- Trial duration: 1â€“365 days; default 14 days.
- Monthly: 30 days.
- Yearly: 365 days.
- Lifetime: no expiry.
- Optional explicit expiry format: `YYYY-MM-DD`.
- `getLicenses` calculates `effective_status = expired` for an active row whose expiry has passed, even before a manual status update.
- `getLicenseById` returns the selected license and all licenses for that organization, newest first.
- `createLicense` prevents issuing another current active license; if the latest active license is no longer valid, it marks that old row expired, then inserts the new license.
- `renewLicense` only allows the latest license to be renewed, inserts a new license row and keeps previous rows as history. When no custom expiry is specified, the new expiry extends from `GREATEST(NOW(), previous expires_at)` by the selected plan duration. It starts the new license immediately so latest-license middleware recognizes it as valid.
- Status changes are audited. The API supports `active`, `suspended`, `expired`; UI should avoid offering reactivation as a way to bypass an expired date when renewal is the intended path.

### License audit actions

Known action names used in license controller:

- `LICENSE_CREATED`
- `LICENSE_RENEWED`
- `LICENSE_SUSPENDED`
- `LICENSE_EXPIRED`
- `LICENSE_REACTIVATED`

License changes write `platform_audit_logs` in the same transaction as the license mutation.
### Older organization-edit license behavior

`updateOrganization` has an optional license configuration path which updates the existing latest license row in place if one exists (or inserts one if none exists). That path is primarily part of organization editing; it is not the dedicated historical renewal workflow. Preserve this distinction.

---

## 12. Audit Logs

### Platform audit writer (implemented)

File: `src/services/platformAuditService.js`. Export: `writePlatformAuditLog(connection, data)`.

It requires a DB transaction connection, a valid `platformAdminId` and an action. It writes `platform_admin_id`, optional `organization_id`, action/entity, description, JSON `old_values`/`new_values`, IP address and user agent to `platform_audit_logs`. The established pattern is to write the audit event using the same connection and transaction as the mutation, so audit failure rolls back the associated change.

Device registration, activation-code regeneration/reactivation, device revocation, and the inspected organization/license mutation paths invoke this writer. The platform audit list endpoint is `GET /api/platform-admin/audit-logs`; the Super Admin app has a read-only Audit Logs screen. The current endpoint is protected by authentication, but a specific `audit_logs.view` permission check is not yet in place.

### Operational audit table (DDL confirmed; actor/before-after structure incomplete)

The user supplied the current `audit_logs` table definition. Confirmed columns:

- `id` (auto-increment primary key)
- `organization_id` (required)
- `branch_id` (nullable)
- `user_id` (nullable)
- `action` (required)
- `entity_type`, `entity_id`, `description`
- `ip_address`, `user_agent`
- `created_at`

The table has organization, branch and user indexes/FKs. The current DDL does **not** include explicit `actor_type`, `actor_identifier`, `old_values` or `new_values` columns. It therefore needs a considered schema extension or equivalent actor/event design before it can fully represent device-originated activation with actor identity and before/after state.

### Confirmed audit gaps and rules

- `activateDevice` currently has no audit write. Add a committed operational audit record in the same transaction as activation; represent the device/app actor accurately (not as a Platform Admin or Gym Staff user). Include organization and registered branch context, device entity identity, action/time and before/after status. Never log activation codes or plaintext device tokens.
- `loginPlatformAdmin` updates `last_login_at` but the inspected controller does not write successful/failed login audit/security events.
- Audit authorization itself must be permission-checked on the backend.
- The user's mandatory project requirement is audit coverage for all meaningful business/admin operations, including device registration/activation/revocation, organization/license changes, user/role/permission changes, member/membership changes, approvals, payments/refunds, program/progress changes and login/security events.
- Use a transactionally consistent audit write for mutation events. Do not silently skip a required audit if the business mutation succeeds.

### Audit UI verification status

The Super Admin Audit Logs screen and read API were added in the earlier work. User later confirmed the Super Admin repository received the license/audit update in commit `a1fe13f`; however, a fresh live-data verification result for every filter and pagination behavior has not been provided in this latest home-laptop session. Keep that distinction in future handovers.

---

## 13. Membership Plans and Membership Management

### Confirmed product requirements

The user described these membership options:

- Monthly payment plan.
- Yearly plan, with Gold and Silver variants.
- Daily payment plan.
- Couple package, available monthly or yearly: one person pays and the second person is included free.
- Membership records need to associate the member/person, plan and validity/payment period.

These are requirements discussed for the Gym Management product. The current conversation does not establish a completed MySQL schema, Node API, or Flutter membership-management module for them.

### Important modeling points for future implementation

The couple package must not be modeled as an ordinary two-paid-member package: one paid membership should cover the primary member and one linked complimentary participant. The exact schema and business rules have not yet been designed/approved in this conversation; implement only after deciding how the primary and included member are linked and how renewal/cancellation works.

Gold/Silver yearly plan pricing, tax/discount rules, trial/concession rules and daily plan validity semantics have not been supplied and must be collected before hard-coding them.

---

## 14. Membership Payment and Approval Workflow

### Requirements / discussions

- Support daily, monthly and yearly membership payment models.
- Preserve the difference between plan price, amount due, amount paid, balance and payment status in future billing logic.
- Some membership creation or actions require an admin approval dialog/workflow; the exact final approval rules have not been verified.

### Earlier code/debugging note

A previous conversation contained Java/Android code using `CreateMembershipActivity`, with a `btnCreateMembership.setOnClickListener(v -> createMembership())` flow and an unresolved compile-time call:

```text
Cannot resolve method 'showAdminApprovalDialog' in 'CreateMembershipActivity'
```

This was an earlier Java activity-level implementation/prototype. It is not evidence that the current Flutter Gym App has a completed approval workflow. The available handover context does not prove the final resolution of that Java method error. Do not carry that method name into the Flutter app without first inspecting the current implementation.

### Pending design decisions

- Which operations require approval (membership creation, discount, backdated start, complimentary person, refund, waiver, manual payment correction, etc.).
- Who can approve and whether creator and approver must be different users.
- Approval statuses and rejection/rework behavior.
- Whether payment must be collected before or after approval.
- How approvals are audited.

---

## 15. Gym Programs and Enrollments

Confirmed requirement examples:

- Time-bound fitness programs such as a **60-day weight-loss program**.
- Members should be enrolled in programs.
- Program duration, enrollment dates, program status, and member results should be managed.

No final program tables, APIs, Flutter screens or complete enrollment workflows were confirmed in the current conversation. Do not claim these are implemented.

Future design should clarify whether a program is organization-wide or branch-specific, capacity limits, enrollment eligibility, program-specific fees, trainer assignment, start/end dates, attendance/checkpoints and completion status.

---

## 16. Member Profiles and Fitness Progress History

Confirmed requirements:

- Member profile with profile image.
- Fitness/growth history over time.
- Three side/progress images per recorded checkpoint were discussed.
- Measurement examples: waist, arms and chest.

No confirmed final member table schema, photo-storage design, progress-measurement schema, upload API, or UI was supplied. These remain pending.

Future implementation should distinguish immutable historical measurement snapshots from current profile values. Image storage strategy (local filesystem/object storage/database references), maximum sizes, access control and retention have not yet been decided.

---

## 17. API Endpoints and Request/Response Structures

The following are the endpoints confirmed by inspected routes and installed patches. All platform-admin protected endpoints require:

```http
Authorization: Bearer <platform-admin-jwt>
Content-Type: application/json
```

### Platform admin

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/platform-admin/login` | Public | Admin login; returns JWT |
| GET | `/api/platform-admin/dashboard-stats` | Platform admin | Dashboard counts |
| GET | `/api/platform-admin/audit-logs` | Platform admin | Read audit history |

Dashboard stats response fields observed by Flutter:

```json
{
  "success": true,
  "stats": {
    "active_devices": 0,
    "active_licenses": 0,
    "pending_devices": 0
  }
}
```

Numbers above are illustrative response shape only, not current data.

### Organizations

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/organizations/` | Platform admin | List organizations |
| POST | `/api/organizations/` | Platform admin | Create organization and initial license |
| PUT | `/api/organizations/:organizationId` | Platform admin | Update organization and optional existing license config |
| PATCH | `/api/organizations/:organizationId/status` | Platform admin | Change organization active/inactive status |

Create body fields observed:

```json
{
  "name": "Innovex Fitness Center",
  "slug": "innovex-fitness",
  "email": null,
  "phone": null,
  "address": null,
  "licenseType": "trial",
  "trialDays": 14,
  "maxDevices": 2,
  "expiresAt": null,
  "notes": null
}
```

This is a shape based on controller/UI fields; use real organization data, and for lifetime use no expiry date.

### Branches

| Method | Path | Auth confirmed in route | Purpose |
|---|---|---|---|
| GET | `/api/branches/:organizationId` | No auth middleware visible in inspected route | List organization branches |
| POST | `/api/branches/:organizationId` | No auth middleware visible in inspected route | Create branch |

The missing route-level auth is a security follow-up, as discussed in section 8.

### Devices

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/devices/activate` | Gym device UUID + one-time activation code; no Platform Admin JWT | Activate Gym App device; organization derived from matching device record |
| GET | `/api/devices/validate` | Bearer device token | Validate current device, organization and latest license |
| GET | `/api/devices/` | Platform Admin JWT + `devices.view` | Search/filter/paginate devices |
| POST | `/api/devices/register` | Platform Admin JWT + `devices.register` | Register pending device and return one-time activation code |
| POST | `/api/devices/:deviceId/activation-code` | Platform Admin JWT + `devices.activation_code.regenerate` | Regenerate code/reactivate revoked device flow |
| PATCH | `/api/devices/:deviceId/revoke` | Platform Admin JWT + `devices.revoke` | Revoke device and invalidate device token |

Register body observed from Flutter:

```json
{
  "organization_id": 1,
  "registered_branch_id": null,
  "device_uuid": "device-unique-id",
  "device_name": "Front Desk Tablet",
  "device_type": "android_tablet"
}
```

Activation body (current, 12 November 2026):

```json
{
  "device_uuid": "device-unique-id",
  "activation_code": "one-time-code"
}
```

Activation code validity: 15 minutes for newly registered or regenerated codes. Existing pending codes created before the 15-minute change retain their previously stored expiry until regenerated or expired.

Successful activation returns a `device_token` once. The Gym App stores it in Flutter Secure Storage; MySQL stores only its SHA-256 hash. The Gym App calls `GET /api/devices/validate` at startup before showing login.

### Licenses

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/licenses/` | Platform admin | List/search/filter licenses |
| GET | `/api/licenses/:licenseId` | Platform admin | Detail + organization history |
| POST | `/api/licenses/` | Platform admin | Issue new license |
| POST | `/api/licenses/:licenseId/renew` | Platform admin | Renew latest license, append history row |
| PATCH | `/api/licenses/:licenseId/status` | Platform admin | Set active/suspended/expired |

Create request shape used by Flutter:

```json
{
  "organizationId": 1,
  "licenseType": "yearly",
  "maxDevices": 2,
  "trialDays": null,
  "expiresAt": null,
  "notes": "Optional note"
}
```

Renew body can specify `licenseType`, `maxDevices`, `trialDays`, `expiresAt` and `notes`; controller defaults missing plan/device fields from the previous license, except trial duration defaults per validation. Status body:

```json
{ "status": "suspended" }
```

License list response includes:

```json
{
  "success": true,
  "licenses": [],
  "pagination": {},
  "statusCounts": {
    "all": 0,
    "active": 0,
    "suspended": 0,
    "expired": 0
  },
  "filters": {}
}
```

### Audit logs

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/platform-admin/audit-logs` | Platform admin | Read-only audit query |

Query keys: `search`, `action`, `entityType`, `organizationId`, `platformAdminId`, `fromDate`, `toDate`, `page`, `limit`.

Response keys: `success`, `auditLogs`, `pagination`, `actions`, `entityTypes`, `filters`.

### Health / root

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | Public | API running message |
| GET | `/api/health` | Public | API + MySQL connectivity check |

---

## 18. Completed Development Tasks

### Platform/API

- Node/Express API initialized and connected to local MySQL 8.
- Platform-admin table and login controller/authentication flow implemented.
- JWT middleware validates platform-admin identity and active account status.
- Organization create/list/update/status flow implemented.
- Organization code generation and initial license creation implemented.
- Branch list/create API implemented.
- Device registration and activation flow implemented, including license/device limit checks.
- Activation code hashing and expiry, device token hashing and one-time return behavior implemented.
- Device management list filtering and server-side pagination implemented.
- Dedicated license management controller/routes added.
- License history, renewals, state changes and audit integration implemented in the patch.
- Platform audit writer existed; read/list endpoint added.
- API health endpoint returned API and database connected on office laptop.

### Super Admin Flutter

- Login and dashboard screens.
- Organization listing, searching, create and edit screens.
- Device management screen with server filters, pagination, responsive cards and actions.
- License management screen with list, filters, detail/history, issue, renewal and status actions; user reported it works.
- Audit Logs screen and dashboard navigation added; formatted and analyzed, pending final analyzer/runtime confirmation.

### Environment / repository setup

- Office laptop repositories cloned into `Documents\INNOVEX WEB\Flutter Projects`.
- Flutter dependencies resolved (`flutter pub get`).
- Earlier Super Admin Flutter analyze completed with no issues before later module additions.
- Super Admin UI changes pushed previously in commit `6d7a5ca`, message `Improve device management cards and search`.

---

## 19. Errors Encountered and Their Confirmed Solutions

### 19.1 MySQL and API

- Office API health endpoint ultimately returned `success: true`, API connected and database connected. This confirms the current API process was able to query MySQL at that time.
- Do not confuse this with the separate Client Workflow System MySQL Workbench issue from another project; that was not confirmed as a Gym Management API issue.

### 19.2 npm bcrypt install-script approval

- npm 11 prompted for dependency lifecycle script approval for `bcrypt@6.0.0`.
- The office API package configuration was updated with:

```json
{
  "allowScripts": {
    "bcrypt@6.0.0": true
  }
}
```

- This change was intentional. Preserve it; do not remove it as cleanup without checking current npm behavior.

### 19.3 Device management UI/search

- Initial device listing was improved to server-side filtering and pagination rather than loading/filtering all records in Flutter.
- Search debounce and request-sequence checks were added to avoid outdated requests overwriting newer results.
- Responsive card layout was changed to show two cards across at wide widths and one card at narrow widths. Card header click expands only the selected card's details.
- The user subsequently said the device screen was okay and pushed the Super Admin repo change in commit `6d7a5ca`.

### 19.4 License Management installation

- First PowerShell installer invocation failed because the ZIP extracted into a nested `license-management-flutter-patch` folder. Resolved by recursively locating `install_license_management.ps1` and invoking its full path.
- Flutter patch installed successfully and created timestamped backups for `auth_service.dart` and `dashboard_screen.dart`.
- Initial `flutter analyze` reported three info-level curly-brace lints, not compilation errors. `dart fix --apply` was recommended.
- License filter patch attempt 1 stopped before save because its regex did not match the actual installed widget structure.
- After inspecting the real code, a targeted move script was supplied. That script left a standalone comma in the search-row child list; a targeted cleanup removed that comma. The user later reported License Management was working.
- The design requirement is to preserve old expired rows and make active the initial filter, not to delete historical rows.

### 19.5 Audit Logs module

- The API audit table schema output was initially truncated; this was resolved by querying `INFORMATION_SCHEMA.COLUMNS` to obtain all column names/types.
- Audit patch added a new read controller and route, and Flutter screen/service/dashboard integration.
- Latest user-shared `flutter analyze` output reports only two informational `curly_braces_in_flow_control_structures` warnings at lines 798 and 826 of `audit_logs_screen.dart`; no errors. No clean final analysis or runtime test result has yet been shared.

### 19.6 Earlier membership Java activity issue

- `CreateMembershipActivity` produced `Cannot resolve method 'showAdminApprovalDialog'`. This relates to earlier Android/Java activity code and has no confirmed resolution in the available project history. Verify the code before claiming it was fixed or porting it to Flutter.

---

## 20. Important Source Code Changes

### API

- `src/middleware/platformAdminMiddleware.js`: Bearer JWT validation, role check, DB check for active platform admin, sets `req.platformAdmin`.
- `src/services/platformAuditService.js`: `writePlatformAuditLog(connection, data)`, inserts audit rows with JSON snapshots in same transaction.
- `src/controllers/organizationController.js`: organization CRUD/status; creates initial license; updates latest license in organization-edit pathway; audit logging.
- `src/controllers/branchController.js`: branch listing and creation scoped by `organization_id`.
- `src/controllers/deviceManagementController.js`: list/search/filter/pagination; registration; activation-code regeneration; revoke. The device list was specifically changed to server-side pagination/search and status counts.
- `src/controllers/deviceController.js`: `activateDevice` with transaction, latest-license lock, active-device quota check, one-time activation code check and token hash storage.
- `src/middleware/licenseMiddleware.js`: validates the current/latest organization license before device activation.
- `src/controllers/licenseManagementController.js`: dedicated license list/details/create/renew/status behavior.
- `src/routes/licenseRoutes.js`: all routes protected with platform-admin auth.
- `src/controllers/platformAuditController.js`: `getPlatformAuditLogs` read endpoint.
- `src/routes/platformAdminRoutes.js`: mounts protected dashboard stats and audit logs alongside public login.
- `src/server.js`: mounts `/api/organizations`, `/api/branches`, `/api/devices`, `/api/platform-admin`, `/api/licenses` and health route.

### Super Admin Flutter

- `lib/core/services/auth_service.dart`: shared Dio client; token storage; organization/dashboard/device/branch/license/audit API methods.
- `lib/features/devices/device_management_screen.dart`: server-side filtering/pagination, search debounce, race suppression, organization/branch filters, expandable responsive cards and device actions.
- `lib/features/licenses/license_management_screen.dart`: dedicated license lifecycle UI and filter layout.
- `lib/features/audit_logs/audit_logs_screen.dart`: read-only audit viewer.
- `lib/features/dashboard/dashboard_screen.dart`: management tile navigation for Organizations, Device Management, License Management and Audit Logs; dashboard statistics.

### Git-sensitive changes to preserve

- The API `package.json` bcrypt allowScripts setting is intentional.
- `src/controllers/deviceManagementController.js` has intentional office-laptop device list pagination/search changes.
- The API changes were reported as uncommitted at the point of earlier inspection; current Git status must be checked before committing.
- The Super Admin repository had a prior pushed commit `6d7a5ca`, but later License and Audit patches were added afterward. Their current commit status must be checked locally.
- Do not run `git reset --hard`, `git checkout -- .`, `git clean -fd`, or broad restore commands to resolve future Git conflicts.

---

## 21. Current Development Status (10 November 2026 â€” latest home-laptop update)

| Area | Status | Evidence / qualification |
|---|---|---|
| API repository | **Pushed and clean in latest home-laptop check** | API commits `908d5af` and `78de952`; pull was already up to date and no working-tree changes were reported |
| Super Admin Flutter repository | **Pushed and clean in latest reported check** | Latest commit `4e50ec3` (`Update gym management project master handover`), pushed successfully after `a1fe13f` |
| Gym App Flutter repository | **Initial scaffold pushed and clean** | Commit `8981e1e`; pull already up to date |
| Platform Admin login/JWT | **Implemented** | Login controller and active-account middleware inspected |
| Platform Admin RBAC database | **Created and seeded** | `platform_permissions`, `platform_roles`, `platform_admin_roles`, `platform_role_permissions`; Super Admin assigned to admin ID 1 with 19 permissions |
| Platform Admin permission enforcement | **Missing / required** | Middleware still authenticates only; no per-action permission checks are wired to routes |
| Gym Staff roles/permission schema | **DDL confirmed; enforcement unverified** | `roles`, `permissions`, `role_permissions`, `user_roles`, `user_branch_access` are organization-scoped to Gym users |
| Organization management | **Implemented and used** | User created a new organization in the Super Admin app during current quota-test setup |
| Super Admin branch screen | **Missing** | Branch API exists only for GET/create; no branch feature screen or create method in `AuthService` |
| Gym User / Role screens and APIs | **Missing** | No user/role route/controller files or matching endpoints found in source inspection |
| Initial Gym Owner provisioning | **Missing** | No secure invitation, password setup, user creation or initial role/branch assignment flow verified |
| License management | **Working per user** | Previous license issue/renewal/status flow and history tested; current test organization was created with device limit 1 |
| Device registration screen/API | **Working for current test setup** | User registered two tablets for the one-device organization; both are pending |
| Maximum-device activation test | **Pending â€” exact next test** | Need activate first pending tablet and verify second is rejected with `DEVICE_LIMIT_REACHED` |
| Device activation API | **Implemented; activation audit gap** | Activation controller enforces current active-device quota but does not write an audit record |
| Device registration/regenerate/revoke audit | **Platform audit integrated** | Management controller writes platform audit events in the mutation transaction |
| Operational `audit_logs` schema | **DDL confirmed; needs extension/design** | Existing table has org/branch/user/action/entity/description/network metadata; no actor type/identifier or old/new JSON columns |
| Platform audit read UI/API | **Implemented and pushed** | Super Admin feature baseline was `a1fe13f`; master handover update subsequently pushed in `4e50ec3`; live behavior should be retested as needed |
| Gym App login/device onboarding | **Not implemented yet** | Current Gym App has splash and a mock login placeholder; no real backend login or activation UI was verified |
| Member/membership/payment/program/progress modules | **Not started / requirements captured** | Do not begin until current device activation/quota workflow is completed |

### Latest home-laptop paths

```text
API:
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_api

Super Admin:
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_super_admin

Gym App:
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_app
```

### Latest repository references

```text
API remote:         https://github.com/arafath65/gym-management-api.git
Super Admin remote: https://github.com/arafath65/gym-management-super-admin.git
Gym App remote:     https://github.com/arafath65/gym-management-apps.git

API commits:         908d5af, 78de952
Super Admin commit:  a1fe13f
Gym App commit:      8981e1e
```

## 22. Pending Development Tasks â€” reprioritized

### Immediate platform/device work

1. Design and add a dedicated Platform Admin role/permission model. The existing organization-scoped Gym Staff `roles`/`user_roles` cannot safely assign permissions to `platform_admins`.
2. Add backend permission checks to all Super Admin APIs, including device list/register/regenerate/revoke, organization operations, license operations, dashboard access and audit-log viewing. Define device permission keys because the current 21-key catalog has no device-specific entries.
3. Extend or otherwise correctly model operational audit events so device-originated actions can carry an accurate actor type/identifier and before/after values.
4. Add transactional audit logging to `activateDevice`; add successful/failed Platform Admin login/security audit events. Never log secrets or plaintext tokens/codes.
5. Implement real Gym App device onboarding/activation against `POST /api/devices/activate`, including stable device UUID, organization ID, activation code input, secure storage of returned device token and meaningful error handling.
6. Run the live quota test with the user's two currently pending tablets and one-device license: first activation succeeds; second is rejected with `DEVICE_LIMIT_REACHED`; revoke first and verify whether second can activate while its code remains valid.
7. Verify behavior for registration when an organization is already at its active-device limit, activation-code regeneration, revoked-device reactivation, expired codes, inactive/expired licenses and concurrent activation attempts.
8. Retest Super Admin Audit Logs and confirm all current platform actions show up with actor, organization, action, timestamp and old/new values where relevant.

### Gym Staff and operational app work (after device activation test)

9. Implement Gym Staff authentication/session handling, organization/branch context and device-token validation.
10. Implement backend permission enforcement using Gym Staff roles, permissions, role assignments and branch access; make the Flutter UI permission-aware.
11. Complete user/role/permission management and audit its changes.
12. Implement member CRUD and profile image handling.
13. Finalize membership plans (monthly, yearly Gold/Silver, daily and couple plan with one complimentary participant).
14. Implement membership lifecycle, renewals, freeze/cancel rules and approval workflow.
15. Implement payments, balances, receipts, refunds and reconciliation.
16. Implement programs/enrollments, including the 60-day weight-loss example.
17. Implement fitness progress history with measurement snapshots and photos, access controls and secure storage.
18. Enforce audit logging for every meaningful action across member, membership, approval, payment/refund, program/progress and security flows.

### Production readiness

- Keep secrets out of Git; verify `.env` is ignored.
- Protect every organization-bound API with authentication, permission checks and tenant/branch scope.
- Add rate limiting and suitable login protection.
- Define production HTTPS, CORS, backups, migrations, monitoring and audit retention.
- Validate transaction isolation and concurrency with real MySQL tests.

## 23. Exact Next Development Step

**Do not start membership modules. Resume the device registration / maximum licensed-device test from the two pending tablets already registered in the Super Admin app.** The Super Admin screen and API setup has been completed far enough to create the organization and register both pending devices. The activation test cannot yet be performed end-to-end from the current Gym App scaffold because the Gym App's login is still a placeholder and no activation screen/API integration was verified.

The next implementation sequence is:

1. Inspect the current API and Super Admin source again before edits (home-laptop repositories are pulled and clean in the latest reported status).
2. Implement Platform Admin permission middleware using the created `platform_permissions`/`platform_roles`/assignment tables, then apply explicit permission checks to every protected Super Admin route.
3. Secure and complete the Branch API: Platform Admin authentication + `branches.view`/`branches.create` checks, input validation, transaction-backed audit writes, and branch status management. Avoid hard deletion where device/user relationships should be preserved.
4. Build the Super Admin Branch Management screen and add the missing branch API methods to `AuthService`.
5. Design Gym Staff authentication and secure Gym Owner invitation/password setup. Provision the initial owner under the correct organization, assign the system Gym Admin role and initial branch access, and audit the entire provisioning process.
6. Add Gym User Management and Role & Permission Management APIs/screens. Use organization-scoped `roles`, `permissions`, `role_permissions`, `user_roles` and `user_branch_access`; backend checks must enforce both permissions and branch scope.
7. Extend or otherwise correctly model operational audit events so device-originated actions can carry an accurate actor type/identifier and before/after values. Add transactional audit logging to `activateDevice` and platform login/security events.
8. Build the Gym App device activation/onboarding screen and API service using the existing Flutter packages. Use organization identity, stable device UUID and one-time activation code; securely persist the returned device token. Never log activation codes or plaintext device tokens.
9. Complete the live one-device/two-pending-tablet quota test: activate Tablet A, verify Tablet B is blocked with `403 DEVICE_LIMIT_REACHED`, revoke Tablet A, regenerate Tablet B's code if needed, then retry and verify success.
10. Verify platform and operational audit history for each relevant action before proceeding to member/membership features.

### Current test facts â€” do not lose these

- The user created a new organization from the Super Admin Flutter app.
- The license/device limit for that organization is **1**.
- Two tablet devices have been registered under that organization.
- Both currently show `pending` status.
- No activation success, `DEVICE_LIMIT_REACHED` response, revocation/retry result or end-to-end quota pass has yet been reported.
- The two pending devices are expected because the current quota code counts only `active` devices; registration does not consume a slot until activation.

---

# CURRENT DEVELOPMENT HANDOVER â€” AUTHORITATIVE (10 November 2026)

## Current position

Continue on the **home laptop**. The three repositories were pulled/checked on the home laptop. Latest reported status was clean for all three:

- API: `908d5af` and `78de952`; `git pull --ff-only origin main` reported already up to date.
- Super Admin: initially pulled through `a1fe13f`; master document update was subsequently committed and pushed as `4e50ec3`. The latest source inspection showed an otherwise clean working tree before this new document update.
- Gym App: `8981e1e`; pull reported already up to date and local status was clean.

The Super Admin app is now being used to create an organization and register its tablets. One new test organization has a device limit of 1, and two tablets are currently pending. Continue from that exact state.

## Do not repeat or change these decisions

- Do not switch back to the office laptop context; current local paths are under `D:\Personal\INNOVEX WEB\Flutter Projects`.
- Do not jump into membership or payment modules before finishing the device quota test.
- Backend permission checks and audit history are mandatory for every meaningful action in both apps.
- Keep Gym Staff RBAC (`roles` scoped to `organization_id`, assigned through `user_roles`) separate from Platform Admin RBAC (`platform_roles`/`platform_admin_roles`); Platform Admin tables and the initial 19-permission Super Admin assignment exist, but API enforcement is still pending.
- Activation must be audited as a device/app-originated action, not attributed to a Platform Admin.
- Preserve one-time activation code and device token secrecy; store the device token securely in the app and store only its hash in MySQL.
- Use the DB transaction for both the mutation and its required audit write.
- Inspect exact source and current Git status before patching. Avoid broad regex replacements, `git add .`, destructive Git commands and committing backup files unintentionally.
- Update this master document at every meaningful milestone and keep the exact next task current.

## Paths

```text
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_api
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_super_admin
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_app
```

## Repositories

```text
https://github.com/arafath65/gym-management-api.git
https://github.com/arafath65/gym-management-super-admin.git
https://github.com/arafath65/gym-management-apps.git
```

## 24. GitHub Repository State â€” latest verified home-laptop sync (10 November 2026)

The three projects are separate Git repositories; each must be committed and pushed independently.

| Project | GitHub remote | Latest confirmed commit | Latest home-laptop status |
|---|---|---|---|
| API | `https://github.com/arafath65/gym-management-api.git` | `78de952` â€” Add API source backup snapshots; preceding `908d5af` â€” Add license and audit management APIs | Pulled; `git pull --ff-only origin main` reported already up to date; working tree clean in latest reported check |
| Super Admin Flutter | `https://github.com/arafath65/gym-management-super-admin.git` | `4e50ec3` â€” Update gym management project master handover (previous feature commit `a1fe13f`) | `4e50ec3` was pushed successfully; latest source inspection reported clean before this new documentation revision |
| Gym App Flutter | `https://github.com/arafath65/gym-management-apps.git` | `8981e1e` â€” Initial commit: Gym Management Flutter App | Pull reported already up to date; working tree clean in latest reported check |

The previous master document revision was committed and pushed to the Super Admin repository in `4e50ec3`. This newer onboarding/source-inspection revision must now be copied into that repository, reviewed, committed as a single file and pushed. Stage only `GYM_MANAGEMENT_PROJECT_MASTER.md`; do not stage unrelated files or backups.

## 26. Latest Home-Laptop Update and Live Device Test State â€” 10 November 2026

This section supersedes the earlier â€œExact Next Development Stepâ€ and historical handoff statements wherever they conflict.

### What was verified in this update

**Database structure and permissions**

- `platform_admins` contains identity, email, password hash, status and last-login fields, but no role/permission columns.
- `roles` is organization-scoped and has a required `organization_id` FK to `organizations`.
- `user_roles` links organization-scoped role IDs to organization-scoped rows in `users`.
- `permissions` contains the 21 permission keys listed in Section 9.
- `role_permissions` maps the existing organization roles to global permission catalog rows.
- Therefore, the existing `roles`/`user_roles` system is for Gym Staff. A separate Platform Admin RBAC model has been created and seeded; backend permission enforcement remains pending.
- The full `platform_audit_logs` DDL pasted during this update was truncated in the chat output. Do not assume columns beyond those used by `writePlatformAuditLog` (`platform_admin_id`, `organization_id`, `action`, `entity_type`, `entity_id`, `description`, `old_values`, `new_values`, `ip_address`, `user_agent`, plus the table's timestamp as used by the read controller). Re-run `SHOW CREATE TABLE platform_audit_logs` if exact indexes/FKs/constraints are needed.

**API behavior/source inspection**

- `POST /api/devices/activate` is mounted with `checkOrganizationLicense` and calls `activateDevice`.
- `GET /api/devices/`, `POST /api/devices/register`, `POST /api/devices/:deviceId/activation-code`, and `PATCH /api/devices/:deviceId/revoke` are protected by `authenticatePlatformAdmin`.
- `authenticatePlatformAdmin` validates the JWT and active Platform Admin account, but does not check action-specific permissions.
- `registerDevice` uses `lockOrganizationAndCheckLicense`, which locks the organization/latest license and counts only devices with `status = 'active'`.
- `activateDevice` locks the organization and latest license inside a transaction, checks active device count and returns `403` with `code: "DEVICE_LIMIT_REACHED"` when `active_devices >= max_devices`.
- Registration, activation-code regeneration/reactivation and revocation write platform audit events within their DB transaction.
- `activateDevice` currently does not insert an operational `audit_logs` event.

**Database audit DDL**

- `devices` has organization and optional branch, UUID/name/type, `pending|active|revoked` status, activation-code hash/expiry, device-token hash, registered-by user, last seen and timestamps.
- `audit_logs` has required `organization_id`, optional `branch_id` and `user_id`, action/entity/description, IP/user-agent and created timestamp. It does not have explicit actor type/identifier or old/new JSON columns in the supplied DDL.
- `platform_audit_logs` is the Platform Admin audit stream; device activation cannot be attributed to a Platform Admin because it is called by the Gym App/device.

**Live Super Admin app progress**

- The user launched the Super Admin app on the home laptop.
- Created a new organization with a device limit of **1**.
- Registered **two tablet devices** for that organization.
- Both devices are currently `pending`.
- This is expected with the current implementation because pending devices do not count toward the active-device quota.

### Exact next action

1. Add Platform Admin role/permission authorization (separate from Gym Staff roles) and enforce it on Super Admin protected actions.
2. Add a correctly modeled operational audit event for `DEVICE_ACTIVATED`, with device actor identity, organization/branch, entity and before/after status; write inside the activation transaction. Also add Platform Admin login/security audit coverage.
3. Implement the Gym App activation/onboarding UI and API integration; current Gym App source remains a splash screen plus a mock login placeholder.
4. Run the two-pending-tablet, one-device-license test: activate the first; confirm second is blocked with `DEVICE_LIMIT_REACHED`; revoke first; regenerate the second code if needed; retry and confirm activation.
5. Verify audit history for each mutation before moving to other gym modules.

### Expected quota-test outcomes

| Test | Expected result |
|---|---|
| Register two pending devices when active count is 0 and max is 1 | Both registrations can be pending |
| Activate first pending device | Success; active device count becomes 1 |
| Activate second pending device while first is active | HTTP 403, `DEVICE_LIMIT_REACHED`, limit 1, active count 1 |
| Revoke first active device | Device status becomes revoked; active count returns to 0 |
| Activate second with unexpired code after revocation | Expected to succeed; must be verified with the real app/API |

### Important: this is not yet a completed quota test

The user has reported only the organization creation and two pending registrations. Do not state that the maximum-device limit has passed until the activation rejection and post-revocation retry have actually been observed.

---

**End of updated master handover document.**


## 27. Customer Onboarding, Branch/Staff Provisioning and Latest Source Inspection â€” 10 November 2026

This section is the latest verified update and supersedes older statements about the branch/user/role implementation status and Platform Admin RBAC schema. It records the actual code and database state supplied from the home laptop.

### 27.1 Platform Admin RBAC database state

The user executed the initial Platform Admin RBAC SQL and verified the following query result:

| Platform Admin ID | Name | Email | Status | Role ID | Role | Permission count |
|---:|---|---|---|---:|---|---:|
| 1 | MMM Arafath | arafath65@gmail.com | active | 1 | Super Admin | 19 |

Created tables:

- `platform_permissions` â€” platform-specific permission catalog.
- `platform_roles` â€” platform role definitions.
- `platform_admin_roles` â€” Platform Admin-to-role assignment.
- `platform_role_permissions` â€” role-to-platform-permission assignment.

The initial `Super Admin` role is a system role and is assigned to Platform Admin ID `1`. It has all 19 currently seeded platform permissions. The initial catalog covers dashboard view; organization view/create/update/suspend; branch view/create/update/delete; device view/register/activation-code regeneration/revoke; license view/create/renew/activate/suspend; and audit-log view.

**Important:** these tables and the initial assignment are database-ready, but the latest inspected `platformAdminMiddleware.js` still only verifies JWT identity and active account status. It does not query `platform_admin_roles` or `platform_role_permissions` or enforce permission keys. Do not describe Platform Admin RBAC as fully implemented until middleware and every route have been updated and tested.

### 27.2 Confirmed `user_branch_access` structure

The user supplied the `SHOW CREATE TABLE user_branch_access` result:

- Columns: `organization_id` (required), `user_id` (required), `branch_id` (required).
- Primary key: (`user_id`, `branch_id`) â€” a user cannot have a duplicate assignment to the same branch, but can be assigned to multiple branches.
- Composite foreign key (`organization_id`, `branch_id`) references `branches` (`organization_id`, `id`) with `ON DELETE CASCADE`.
- Composite foreign key (`organization_id`, `user_id`) references `users` (`organization_id`, `id`) with `ON DELETE CASCADE`.

This is the database mechanism for assigning a Gym Staff user to one or multiple branches inside the same organization. It prevents a user from being linked to a branch belonging to another organization. Backend authorization must still check the current user's allowed branches on every branch-scoped request; the FK alone is not runtime authorization.

### 27.3 Confirmed branch and user table details

`branches` table (DDL supplied):

- `id`, `organization_id`, `name`, `branch_code`, optional `phone` and `address`, `status` (`active`/`inactive`), `created_at`, `updated_at`.
- Branch code unique within an organization (`organization_id`, `branch_code`).
- Composite unique key (`organization_id`, `id`) supports organization-safe foreign keys.
- Organization FK uses `ON DELETE RESTRICT`.

`users` table (DDL supplied):

- `id`, `organization_id`, `full_name`, `email`, optional `phone`, required `password_hash`, `status` (`active`/`inactive`/`locked`), `last_login_at`, `created_at`, `updated_at`.
- Email is unique within an organization (`organization_id`, `email`).
- Composite unique key (`organization_id`, `id`) supports organization-safe references.
- Organization FK uses `ON DELETE RESTRICT`.

The required `password_hash` means a first-owner invitation must be designed carefully. Do not create a usable account with a shared/default password. Use a one-time, expiring invitation token stored as a hash, and let the invited owner set their own password before the account becomes active (exact invitation table/API flow remains to be designed).

### 27.4 Latest API source inspection

Home laptop API path:

`D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_api`

Confirmed from the actual command output:

- `src/middleware/platformAdminMiddleware.js` authenticates a Platform Admin JWT and checks that the account is active, but has no permission-check middleware.
- `src/routes/branchRoutes.js` declares only `GET /:organizationId` and `POST /:organizationId`; neither route has authentication or permission middleware.
- `src/controllers/branchController.js` implements only `getBranches` and `createBranch`.
- `getBranches` queries branches by the supplied organization ID.
- `createBranch` validates organization ID, name and branch code; checks organization existence and duplicate code; inserts a branch with a direct DB query.
- Branch creation currently has no DB transaction, no `writePlatformAuditLog` call, no before/after audit values, and no update/status/deactivate endpoint.
- `server.js` mounts the branch router at `/api/branches`.
- No user, role, permission or auth route/controller files were found in `src/routes` and `src/controllers` by the supplied filename search. The source search for user creation/invitation/role assignment patterns returned no results.
- API `git status --short` produced no entries at inspection time (working tree clean).

### 27.5 Latest Super Admin Flutter source inspection

Home laptop Super Admin path:

`D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_super_admin`

Confirmed feature screens:

- `lib/features/auth/login_screen.dart`
- `lib/features/dashboard/dashboard_screen.dart`
- `lib/features/organizations/organizations_screen.dart`
- `lib/features/organizations/organization_edit_screen.dart`
- `lib/features/devices/device_management_screen.dart`
- `lib/features/licenses/license_management_screen.dart`
- `lib/features/audit_logs/audit_logs_screen.dart`

There are no Branches, Gym Users or Roles feature screens yet. The dashboard menu contains only Organizations, Device Management, License Management and Audit Logs.

`AuthService` already includes `getBranches(organizationId, activeOnly)` which sends a Bearer token and reads the branch list. It does not yet include a branch creation/update API method or Gym User/Role management methods. The branch list helper is useful for selecting a branch in the existing device-registration UI, but it is not a Branch Management feature.

The organization creation dialog currently provisions an organization and initial license together. It does not create the first branch or initial Gym Owner.

Super Admin `git status --short` produced no entries at inspection time (working tree clean). Local backup files exist in the feature folders; do not stage or commit those backups.

### 27.6 Agreed commercial onboarding model â€” Power World Gym example

The product is intended to work as a multi-organization SaaS platform:

1. Innovex Platform Admin creates a customer organization (tenant).
2. Innovex issues/configures its license and maximum active-device count.
3. Innovex creates the tenant's first branch.
4. Innovex provisions/invites the initial Gym Owner as an organization-scoped `users` row, assigns the initial Gym Admin role and grants access to the first branch.
5. The owner receives a secure invitation and sets their own password. No shared/default password is sent.
6. Innovex registers the customer's physical tablets; each tablet receives a unique one-time activation code.
7. The Gym App activates each tablet using its stable device UUID and activation code; the backend returns a one-time device token, which the app stores securely.
8. The Gym Owner signs in with their own staff credentials, then creates Cashier/Receptionist users, assigns roles and branch access, and manages day-to-day gym operations.

A device and a staff user are separate entities. A license's `max_devices` controls concurrent active physical devices, not the number of human staff accounts. Multiple authorized staff users can log in from a licensed tablet, subject to the session/concurrency policy that will be designed. Both tablets use the same Gym App and access the same organization/branch data; UI restrictions are not the security boundary.

The backend must validate both device authorization and the authenticated staff user, then derive/check organization and branch scope from trusted server-side identity. It must not trust a client-supplied organization ID as proof of tenant access.

### 27.7 Updated implementation sequence

The immediate onboarding foundation is now ordered as follows:

1. Implement `requirePlatformPermission(permissionKey)` using the newly created Platform Admin RBAC tables; add explicit permissions to all existing protected Super Admin routes. The existing admin ID `1` has the Super Admin role with 19 permission rows, but route enforcement remains absent.
2. Secure branch routes with Platform Admin authentication and `branches.view` / `branches.create` checks. Add transactional Platform Admin audit writes for branch creation and later updates/status changes. Validate organization existence and branch ownership. Add branch status/deactivation API rather than relying on hard deletion.
3. Build the Super Admin Branch Management screen and add create/list methods to `AuthService`; reuse existing `getBranches` where suitable after the route is secured.
4. Design Gym Staff authentication plus first Gym Owner invitation/password setup. Add user creation, invitation token hashing/expiry/acceptance, initial system role assignment and `user_branch_access` assignment. Audit owner provisioning.
5. Build Super Admin Gym User and Role management screens/APIs if Innovex needs support-side administration; the normal post-onboarding operation should allow the Gym Owner to manage their own staff within their organization/branch authority.
6. Implement Gym Staff RBAC enforcement using `roles`, `permissions`, `role_permissions`, `user_roles` and `user_branch_access`; add branch-scope enforcement in every branch-bound API. Flutter UI should reflect permissions, but backend checks are mandatory.
7. Complete device activation audit and the Gym App activation/onboarding screen. Device activation must be attributed to the device/app actor accurately, not to a Platform Admin. Never log activation codes or plaintext device tokens.
8. Complete the existing one-device/two-pending-tablet quota test: first tablet activates, second is rejected with `DEVICE_LIMIT_REACHED`; revoke first; regenerate second's activation code if needed; activate the second; verify audit history.
9. Only after onboarding/auth/device foundations are secure, continue with membership, payment, approvals, programs and progress modules.

### 27.8 Latest repository state and document update

- API repo latest confirmed commit remains `78de952`; source inspection showed a clean working tree.
- Super Admin repo latest confirmed commit is `4e50ec3` (`Update gym management project master handover`), pushed successfully from `a1fe13f`.
- Gym App repo latest confirmed commit remains `8981e1e`.
- No application source code was changed during this inspection/documentation update.
- This updated master document must now be copied into the Super Admin repo, reviewed, committed as a single file and pushed. Do not stage backups or unrelated files.

---

## 28. Platform Admin Permission Enforcement and Branch API Milestone â€” 11 November 2026

This section records the latest implemented and tested API changes on the home laptop. It supersedes earlier statements in Sections 27.1, 27.4, 27.7 and 27.8 wherever they said Platform Admin permission enforcement was still absent or the Branch API only supported listing/creation. The historical inspection findings remain useful as a record of what was true before this milestone.

### 28.1 Platform Admin permission assignment verified

The user created and verified the dedicated Platform Admin RBAC tables:

- `platform_permissions`
- `platform_roles`
- `platform_admin_roles`
- `platform_role_permissions`

The existing active Platform Admin account was confirmed as ID `1`, MMM Arafath (`arafath65@gmail.com`). The database verification query returned the `Super Admin` role (role ID `1`) with **19 permissions** assigned.

The 19 permission keys seeded and assigned are:

- `dashboard.view`
- `organizations.view`, `organizations.create`, `organizations.update`, `organizations.suspend`
- `branches.view`, `branches.create`, `branches.update`, `branches.delete`
- `devices.view`, `devices.register`, `devices.activation_code.regenerate`, `devices.revoke`
- `licenses.view`, `licenses.create`, `licenses.renew`, `licenses.activate`, `licenses.suspend`
- `audit_logs.view`

The device-activation route remains a Gym App/device endpoint and is not guarded by a Platform Admin permission.

### 28.2 Platform Admin middleware and protected routes updated

The following API files were modified locally:

- `src/middleware/platformAdminMiddleware.js`
- `src/routes/branchRoutes.js`
- `src/controllers/branchController.js`
- `src/routes/organizationRoutes.js`
- `src/routes/deviceRoutes.js`
- `src/routes/licenseRoutes.js`
- `src/routes/platformAdminRoutes.js`

The middleware now loads current permission keys from the four Platform Admin RBAC tables for the authenticated active Platform Admin and attaches them to `req.platformAdmin.permissions`. It exports `requirePlatformPermission(...)` for route-level authorization. Permission assignments are read from the database on each authenticated request rather than trusted from JWT claims.

Permission mappings applied to the existing Super Admin API routes:

| Route/action | Required permission |
|---|---|
| GET organizations | `organizations.view` |
| POST organizations | `organizations.create` |
| PUT organization | `organizations.update` |
| Set organization status | `organizations.suspend` |
| GET branches | `branches.view` |
| POST branch | `branches.create` |
| PATCH branch details | `branches.update` |
| PATCH branch status | `branches.update` |
| GET devices | `devices.view` |
| POST device registration | `devices.register` |
| Regenerate activation code | `devices.activation_code.regenerate` |
| Revoke device | `devices.revoke` |
| GET licenses / license detail | `licenses.view` |
| POST license | `licenses.create` |
| Renew license | `licenses.renew` |
| Activate license status | `licenses.activate` |
| Other license status change (including suspend) | `licenses.suspend` |
| Dashboard statistics | `dashboard.view` |
| Platform audit logs | `audit_logs.view` |

The dynamic license-status route maps `status === 'active'` to `licenses.activate`; other supplied states are routed through `licenses.suspend`. The license controller remains responsible for validating the allowed status values.

### 28.3 Branch API expanded and hardened

`src/routes/branchRoutes.js` now requires `authenticatePlatformAdmin` for every branch route and applies permission middleware. Implemented endpoints:

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/branches/:organizationId` | `branches.view` | List organization branches |
| POST | `/api/branches/:organizationId` | `branches.create` | Create branch |
| PATCH | `/api/branches/:organizationId/:branchId` | `branches.update` | Edit branch fields |
| PATCH | `/api/branches/:organizationId/:branchId/status` | `branches.update` | Activate/deactivate branch |

Branch status changes are soft deactivation/reactivation (`active` / `inactive`). Physical branch deletion is deliberately not implemented, to preserve records and avoid breaking references. Branch creation, updates and status changes use a DB transaction and write `platform_audit_logs` using the same transaction connection. An audit write failure prevents the mutation from committing.

Branch update supports the fields `name`, `branch_code`, `phone` and `address`, checks organization/branch ownership, validates inputs and enforces branch-code uniqueness per organization. Editing an inactive branch is rejected until it is reactivated.

### 28.4 API syntax and authentication tests completed

The user ran `node --check` for all seven modified API files. No syntax errors were printed. `git diff --check` returned no whitespace errors; Git only printed normal LF-to-CRLF working-copy warnings on Windows.

Anonymous GET tests were run against:

- `/api/branches/1`
- `/api/organizations`
- `/api/devices`
- `/api/licenses`
- `/api/platform-admin/dashboard-stats`
- `/api/platform-admin/audit-logs`

All six returned **HTTP 401**, as expected without a Bearer token.

The user then authenticated as the active Platform Admin account (credentials were entered privately in PowerShell; never record passwords or JWTs in this document). Authenticated access returned **HTTP 200** for:

- Organization list (`/api/organizations`)
- Branch list for organization ID `3`
- Device list
- License list
- Dashboard statistics
- Platform audit logs

This verifies the positive Super Admin path. A negative test using a second/no-branch-create permission role has **not yet been run**; do not claim per-permission denial is fully tested until that test is complete.

### 28.5 Power World branch tests completed

The authenticated Super Admin created Power World's first branch:

| Field | Verified value |
|---|---|
| Organization | Power World |
| Organization ID | `3` |
| Branch ID | `3` |
| Branch name | Wellampitiya |
| Branch code | `PWG-MAIN-001` |
| Phone | `+94753369680` |
| Address | `38, Awissavella Road, Wellampitiya, Colombo 10` |
| Final status | `active` |

Audit verification found:

| Audit ID | Action | Entity | Entity ID | Description |
|---:|---|---|---:|---|
| 10 | `BRANCH_CREATED` | branch | 3 | Created branch Wellampitiya for Power World |
| 11 | `BRANCH_UPDATED` | branch | 3 | Updated branch Wellampitiya |
| 12 | `BRANCH_DEACTIVATED` | branch | 3 | Deactivated branch Wellampitiya |
| 13 | `BRANCH_REACTIVATED` | branch | 3 | Reactivated branch Wellampitiya |

The user also confirmed successful branch update, deactivation and reactivation API responses. The final branch state is `active`. All three corresponding audit records (IDs 11â€“13) were found; the branch-created audit record (ID 10) was separately verified.

### 28.6 Current API working-tree state

The seven files listed in Section 28.2 are modified locally and have passed syntax/diff checks. The user has **not yet committed or pushed these API changes**. Keep this separate from the Super Admin master-document repository. Do not use `git add .`; stage only intended API source files after further verification.

### 28.7 Remaining verification and immediate next work

1. Run a negative authorization test using a temporary Platform Admin role that lacks a selected permission (for example, lacks `branches.create`) and verify HTTP 403 with `PLATFORM_PERMISSION_DENIED`. Ensure the test role/account is removed or restored safely afterward; do not weaken the existing Super Admin account.
2. Inspect the latest actual API files and verify middleware/route mappings for every endpoint, including validation of invalid license status values and permission coverage for all mutations.
3. Build the Flutter Super Admin Branch Management screen. Add authenticated `AuthService` methods for branch create, update and status change; the existing `getBranches` method already exists. Add organization selection, branch listing, search/status filters, create/edit forms and soft activate/deactivate controls.
4. Add permission-aware UI only after the API returns the authenticated admin's effective permissions; backend middleware remains authoritative.
5. Test Branch Management UI against the real Power World branch ID `3` and verify audit history remains visible.
6. Update this master document and push the API and Super Admin repositories independently after their respective milestones are validated.
7. Continue Gym Owner invitation/user/role provisioning, Gym App device activation audit and the one-device/two-pending-tablet quota test after the branch-management milestone. Do not start membership modules before the current onboarding/device-security foundations are complete.

### 28.8 Exact continuation point

**The next task is to build the Flutter Super Admin Branch Management feature**, after completing a negative per-permission authorization test. The API Branch endpoints for listing, creation, editing and soft activation/deactivation have been implemented and positively tested against Power World. Power World organization ID `3` has branch ID `3` (`Wellampitiya`, `PWG-MAIN-001`), currently active. Its branch audit trail contains IDs `10` through `13` as listed above.

The existing one-device/two-pending-tablet test organization remains a separate outstanding device-quota test. Do not confuse it with Power World's branch test or claim that device activation quota behavior has passed.

---

**End of updated master handover document.**


---

## 29. Release Checkpoint — Platform RBAC, Branch API and Branch Management UI (11 November 2026)

This section is the latest release checkpoint and supersedes earlier statements in this document that Platform Admin permission enforcement is pending, that the Branch API is unauthenticated/basic, or that the Super Admin Branch Management screen does not exist. Historical sections are retained to preserve the development record.

### 29.1 API repository — local changes ready for release

Repository: `gym_management_api`
Remote: `https://github.com/arafath65/gym-management-api.git`
Branch at release check: `main`, tracking `origin/main` with no reported ahead/behind commits. Seven files are modified locally and remain uncommitted/unpushed:

- `src/controllers/branchController.js`
- `src/middleware/platformAdminMiddleware.js`
- `src/routes/branchRoutes.js`
- `src/routes/deviceRoutes.js`
- `src/routes/licenseRoutes.js`
- `src/routes/organizationRoutes.js`
- `src/routes/platformAdminRoutes.js`

Validation on 11 November 2026:

- `node --check` passed for all seven modified JavaScript files.
- `git diff --check` passed. Git emitted only normal Windows LF-to-CRLF working-copy notices.
- Anonymous requests to protected organization, branch, device, license, dashboard and platform audit endpoints returned HTTP 401.
- Authenticated Super Admin requests to organization list, Power World branch list, device list, license list, dashboard stats and platform audit list returned HTTP 200.
- A negative permission test using an account without a required permission has not yet been performed. Do not claim denied-permission behavior is independently verified until that test is complete.

### 29.2 Platform Admin permission enforcement

`platformAdminMiddleware.js` now verifies the Platform Admin JWT and active account, retrieves current permission keys through `platform_admin_roles`, `platform_role_permissions` and `platform_permissions`, and exposes those permissions to route middleware. Permission assignments are queried from MySQL rather than trusted from JWT claims.

The active Platform Admin ID `1` has the `Super Admin` role and the 19 permissions listed in Section 28.1. Protected route mappings are implemented for dashboard, organizations, branches, devices, licenses and platform audit viewing. Gym Staff RBAC remains separate and organization-scoped; do not mix its `roles`/`user_roles` model with Platform Admin RBAC.

### 29.3 Branch API — secured branch lifecycle

The Branch API now requires Platform Admin authentication and action-specific permission checks:

| Method | Endpoint | Permission | Behavior |
|---|---|---|---|
| GET | `/api/branches/:organizationId` | `branches.view` | List organization branches |
| POST | `/api/branches/:organizationId` | `branches.create` | Create branch |
| PATCH | `/api/branches/:organizationId/:branchId` | `branches.update` | Update branch details |
| PATCH | `/api/branches/:organizationId/:branchId/status` | `branches.update` | Activate/deactivate branch |

Create, update and status changes use a DB transaction and write `platform_audit_logs` in the same transaction. An audit-write failure prevents the mutation from committing. Branch code uniqueness is organization-scoped. Inactive branches cannot be edited until reactivated. Deactivation is soft (`status = inactive`); physical deletion is not implemented, preserving references and history.

### 29.4 Verified Power World branch and audit history

| Field | Verified value |
|---|---|
| Organization | Power World (ID `3`) |
| Branch | Wellampitiya (ID `3`) |
| Branch code | `PWG-MAIN-001` |
| Phone | `+94753369680` |
| Address | `38, Awissavella Road, Wellampitiya, Colombo 10` |
| Final recorded status | `active` |

Verified platform audit entries:

| Audit ID | Action | Entity ID |
|---:|---|---:|
| 10 | `BRANCH_CREATED` | 3 |
| 11 | `BRANCH_UPDATED` | 3 |
| 12 | `BRANCH_DEACTIVATED` | 3 |
| 13 | `BRANCH_REACTIVATED` | 3 |

### 29.5 Super Admin Flutter — Branch Management UI

Repository: `gym_management_super_admin`
Remote: `https://github.com/arafath65/gym-management-super-admin.git`
Branch at release check: `main`, tracking `origin/main` with no reported ahead/behind commits.

Local uncommitted/unpushed changes:

- `lib/core/services/auth_service.dart` — authenticated branch create, update and status API methods, alongside the existing list method.
- `lib/features/dashboard/dashboard_screen.dart` — Branch Management dashboard navigation added; existing Audit Logs navigation preserved.
- `lib/features/branches/branch_management_screen.dart` — new Branch Management screen.

Current UI behavior:

- Organization selection and branch listing.
- Search by branch name, code, phone or address.
- Active is the default filter; All, Active and Inactive are in a dropdown beside search.
- Responsive two-column cards on wide layouts.
- Three-dot card menu instead of visible action buttons.
- Active branch menu: Edit and Deactivate. Inactive branch menu: Reactivate only.
- An additional dialog-entry guard blocks editing an inactive branch until it is reactivated.
- Create/edit forms and status confirmation dialogs call the Branch API.
- After deactivation, the branch disappears from the default Active view; it remains available in Inactive or All.

The user reported Branch Management as functionally acceptable for this release checkpoint. The release-check report shows `flutter analyze` completed with **No issues found** and `git diff --check` passed. `git diff -- lib/features/audit_logs/audit_logs_screen.dart` returned no changes, so the existing Audit Logs screen was preserved. A Flutter framework assertion had occurred earlier during an attempted edit/cancel flow on an inactive branch; the follow-up patch removed Edit from inactive-branch actions and added a dialog-entry guard. The latest release-check report shows analyzer success after these UI changes. Do not claim the framework assertion has been independently reproduced and root-caused without a full runtime stack trace.

### 29.6 Gym App repository — no release changes

Repository: `gym_management_app`
Remote: `https://github.com/arafath65/gym-management-apps.git`
Branch at release check: `main`, tracking `origin/main`, working tree clean. No modified or untracked files were found. `flutter analyze` completed with **No issues found**. No new commit is required because there are no Gym App changes to publish.

### 29.7 Release validation summary

| Repository | Pending files | Validation | Release action |
|---|---:|---|---|
| API | 7 modified | Seven `node --check` checks passed; `git diff --check` passed; anonymous-auth and positive-auth API tests passed | Commit and push the seven named files |
| Super Admin | 2 modified + 1 new | `flutter analyze` passed; `git diff --check` passed; Audit Logs screen unchanged | Commit/push the two named existing files, new Branch Management screen and this master document |
| Gym App | 0 | `flutter analyze` passed; working tree clean | No commit; verify synchronization with `origin/main` |

Do not use `git add .`. Do not include `.env`, local secrets, generated build output, temporary backups or unrelated files. Each repository has a separate Git history and must be handled independently.

### 29.8 Outstanding work after this release checkpoint

1. Run a negative Platform Admin permission test (for example, a temporary role without `branches.create` must receive HTTP 403 `PLATFORM_PERMISSION_DENIED`); restore/remove test assignments safely afterward.
2. Consider tightening license-status permission routing so invalid status values are rejected before permission mapping; the controller validates allowed status values.
3. Implement first Gym Owner provisioning with secure invitation token hashing/expiry, owner password setup, initial Gym Staff role and branch assignment, and transactional audit history.
4. Complete Gym Staff authentication and backend permission/branch-scope enforcement.
5. Add accurate device-originated activation audit events and Platform Admin login/security audit events.
6. Implement the Gym App device activation screen and secure device-token storage.
7. Complete the existing one-device/two-pending-tablet quota test. The organization with max devices `1` and its two pending devices remain an outstanding test, separate from Power World's branch verification.
8. After onboarding/auth/device-security foundations are complete, continue membership, payment/approval, program and fitness-progress modules.

### 29.9 Exact continuation point

After publishing this checkpoint, continue with a controlled negative Platform Admin permission test, followed by first Gym Owner invitation and Gym Staff authentication/authorization design. The API and Super Admin changes are release candidates based on syntax, analyzer, positive-auth and branch audit checks recorded above. The Gym App repository had no changes at this checkpoint.

---

## 30. Release Checkpoint — Gym Owner Onboarding, Editable Account and Password Reset (11 November 2026)

This is the current Gym Owner onboarding milestone. It supersedes earlier statements in this document that initial Gym Owner provisioning is entirely unimplemented. Earlier sections remain as historical records of the state at the time they were written. This milestone does **not** mean that the complete Gym Staff authentication, session, role-management or Gym App workflows are finished.

### 30.1 Organization creation now provisions the initial Gym Admin account

The existing Super Admin organization-creation flow now collects:

- Organization name and slug, plus the existing optional contact details.
- Initial Gym Admin / Gym Owner display name.
- Initial Gym Admin login username (email).
- Initial password and confirmation (confirmation is validated in Flutter and is not sent as a separate API value).
- The existing initial license configuration.

`POST /api/organizations/` now performs organization, initial license and initial Gym Admin provisioning in one database transaction. The Gym Admin account is inserted into the organization-scoped `users` table with active status. A system role named `Gym Admin` is created for that organization, the initial Gym Staff permission set is attached, and the user is assigned that role.

The initial Gym Admin role currently receives these 13 organization-scoped Gym Staff permissions:

- `branches.view`, `branches.create`, `branches.update`
- `users.view`, `users.create`, `users.update`, `users.deactivate`
- `roles.view`, `roles.create`, `roles.update`, `roles.assign`
- `audit_logs.view`, `licenses.view`

Platform-level organization administration permissions are not granted to the Gym Owner. Branch deletion and license activation/suspension permissions are also excluded from this initial role. The Gym Owner's future ability to change Gym Staff roles and permissions must be implemented in the tenant-side user/role management workflow; this Super Admin screen does not expose or edit the permission list.

The initial password is validated to be at least 8 characters and no more than 72 UTF-8 bytes, then hashed using bcrypt (cost 12). The plaintext password and password hash are not included in API responses or audit values. Creation audit actions include `GYM_ADMIN_CREATED` and `GYM_ADMIN_ROLE_ASSIGNED`; these writes participate in the organization-creation transaction.

### 30.2 First-branch access behavior

`src/controllers/branchController.js` now grants a newly created branch to active users assigned the organization-scoped system `Gym Admin` role by inserting `user_branch_access` in the same branch-creation transaction. It also writes the `GYM_ADMIN_BRANCH_ACCESS_GRANTED` platform audit event in that transaction.

The Fitness Mania organization shown during the UI verification had no branches yet, so its Gym Owner correctly showed **Branch Access (0)**. The branch-access automation is installed, but its first live end-to-end verification after creating a branch for this newly provisioned Gym Owner remains outstanding. Do not claim that branch assignment was verified until that test is completed.

### 30.3 Gym Owner account lookup API

The broad onboarding-report endpoint and its UI (permissions, branches, branch access and onboarding history) were removed from the Edit Organization workflow. The focused read endpoint is:

| Method | Endpoint | Required Platform Admin permission | Response data |
|---|---|---|---|
| GET | `/api/organizations/:organizationId/gym-owner` | `organizations.view` | Gym Owner ID, name and login email; no password fields |

The route is behind `authenticatePlatformAdmin`. The controller selects the organization-scoped user assigned to the system `Gym Admin` role. It does not select or return `password_hash`.

### 30.4 Gym Owner name and login username can be edited

The existing Edit Organization screen remains the same screen and retains its existing Organization Information and License Configuration forms. A focused **Gym Owner Account** card is included between those sections. It has editable fields:

- Gym Owner Name (`users.full_name`)
- Login Username (Email) (`users.email`)

The existing **Save Changes** action submits these values along with the ordinary organization/license form. The API extends `PUT /api/organizations/:organizationId` to update the organization-scoped Gym Admin account in the same transaction as the organization/license update. It checks for a duplicate username/email within that organization and returns HTTP 409 when already used by another user. The account update is recorded as `GYM_ADMIN_ACCOUNT_UPDATED`, with old/new name and email only; no password data is logged.

### 30.5 Password reset by Platform Admin

The Gym Owner Account card has a **Reset Password** action. The dedicated API is:

| Method | Endpoint | Required Platform Admin permission | Purpose |
|---|---|---|---|
| PATCH | `/api/organizations/:organizationId/gym-owner/reset-password` | `organizations.update` | Set a new password for the organization's system Gym Admin account |

The request contains `newPassword` only. No current/old password is required. Flutter collects **New Password** and **Confirm New Password** and validates that they match; confirmation is not sent to the server. The API validates a minimum of 8 characters and a maximum of 72 UTF-8 bytes, hashes the new password with bcrypt cost 12, and updates `users.password_hash` inside a transaction. The successful reset is audited with action `GYM_ADMIN_PASSWORD_RESET`. Neither the plaintext password nor its hash is included in audit values or response data.

### 30.6 Flutter reset-dialog lifecycle correction

The first password-reset dialog implementation triggered a Flutter framework assertion involving an inherited widget being deactivated while it still had dependents. The available screenshot did not include a complete stack trace, so the exact framework widget/root cause was not established.

The follow-up patch replaced the old `GlobalKey<FormState>` / `StatefulBuilder` dialog with a dedicated `_GymOwnerPasswordResetDialog` `StatefulWidget` that owns and disposes its two password text controllers. The isolated dialog performs inline validation without a nested `Form`, `GlobalKey` or `StatefulBuilder`.

The user confirmed completion of the Super Admin organization-edit and Gym Owner account/password-reset work after installing the correction. Static validation output after the final patch:

- `node --check` for the organization controller and routes completed without syntax errors.
- `dart format` completed for `auth_service.dart` and `organization_edit_screen.dart`.
- `flutter analyze` reported **No issues found**.
- Git emitted only Windows LF-to-CRLF working-copy notices; `git diff --check` had been used in the patch workflow.
- No database records were created by the patch scripts; the user separately created and viewed the Fitness Mania organization/Gym Admin through the application.

Treat the user's confirmation as the functional acceptance of the Super Admin editing/reset workflow. Gym Staff login must still be tested after a separate Gym Staff authentication endpoint and app flow are implemented.

### 30.7 Exact application files changed in this milestone

API repository (`gym_management_api`):

- `src/controllers/branchController.js` — automatic initial Gym Admin branch access grant and audit.
- `src/controllers/organizationController.js` — transactional initial Gym Admin provisioning; Gym Owner lookup, profile update and password reset handlers.
- `src/routes/organizationRoutes.js` — protected Gym Owner lookup and reset routes.

Super Admin repository (`gym_management_super_admin`):

- `lib/core/services/auth_service.dart` — initial Gym Admin request fields, owner lookup, profile update and password-reset API calls.
- `lib/features/organizations/organizations_screen.dart` — initial Gym Admin name, username, password and confirmation in organization creation.
- `lib/features/organizations/organization_edit_screen.dart` — existing organization editor extended with editable Gym Owner fields and isolated reset dialog.
- `GYM_MANAGEMENT_PROJECT_MASTER.md` — this project handover document.

No Gym App (`gym_management_app`) source change is part of this milestone. The last recorded release checkpoint showed its working tree clean and `flutter analyze` passing; recheck the current local tree before any push rather than assuming it has pending work.

### 30.8 Repository release preparation

The user's latest local status output after the final patch reported exactly three modified API files (the files in Section 30.7) and three modified Super Admin source files (the files in Section 30.7). No commit or push had yet been performed. The master document is to be copied into the Super Admin repository root and included in that repository's separate commit.

GitHub repositories are independent:

| Project | Remote | Current milestone action |
|---|---|---|
| API | `https://github.com/arafath65/gym-management-api.git` | Commit/push the three named API files after preflight |
| Super Admin | `https://github.com/arafath65/gym-management-super-admin.git` | Commit/push the three named source files plus `GYM_MANAGEMENT_PROJECT_MASTER.md` |
| Gym App | `https://github.com/arafath65/gym-management-apps.git` | No changes from this milestone; verify branch/status and push only if local commits are ahead of origin |

Do not use `git add .`. Do not stage `.env`, passwords, JWTs, generated output, backup folders or unrelated modifications. Verify each repository's branch, remote, fetch status and staged filenames independently before committing. Do not create an empty commit for the Gym App when there are no changes.

### 30.9 Remaining work after Gym Owner onboarding

1. Create the first branch for a newly provisioned Gym Owner organization and verify the user receives a `user_branch_access` row and `GYM_ADMIN_BRANCH_ACCESS_GRANTED` audit event.
2. Design and implement Gym Staff authentication/session handling separately from Platform Admin authentication. The Super Admin Platform Admin JWT must never be reused as a Gym Staff credential.
3. Build tenant-side Gym Staff user, role and permission management so the Gym Owner can manage Cashier/Receptionist accounts and customize permissions within their organization/branch authority. Backend permission checks and branch scope remain mandatory.
4. Run the controlled negative Platform Admin permission test (for example, an admin without `branches.create` must be denied with `PLATFORM_PERMISSION_DENIED`).
5. Complete device-originated activation audit and Gym App device activation/token storage; repeat the one-active-device/two-pending-tablet quota test.
6. After onboarding, authentication and device-security foundations are complete, continue membership, payment/approval, program and fitness-progress modules.

### 30.10 Exact continuation point

The current Super Admin onboarding milestone is complete according to the user's confirmation and has passed the reported static validation. The next practical verification is the first branch creation for Fitness Mania (or another fresh test organization) to verify automatic Gym Owner branch assignment and audit. In parallel, continue the separate Gym Staff authentication design; do not start membership modules before the onboarding/auth/device foundations are secure.

---

**End of updated master handover document.**

---

## 31. Current Office-Laptop Checkpoint — Code-Only Activation, 15-Minute Codes and Device Validation (12 November 2026)

This is the latest authoritative checkpoint for the office laptop. It supersedes older statements in Sections 10, 17, 18, 21, 23, 24, 26, 29 and 30 wherever activation, device validation, current workstation, repository status or next steps differ. The preceding sections remain as historical milestones unless explicitly updated above.

### 31.1 Current workstation and project paths

The active workstation is the **office laptop**. Use these complete paths in PowerShell commands; the user requested that every command include the full project path so they do not have to change directories manually.

```text
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\gym_management_api
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\gym_management_super_admin
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\gym_management_app
```

Repositories (separate Git histories; push each independently):

| Project | Remote |
|---|---|
| API | `https://github.com/arafath65/gym-management-api.git` |
| Super Admin | `https://github.com/arafath65/gym-management-super-admin.git` |
| Gym App | `https://github.com/arafath65/gym-management-apps.git` |

Current office-laptop environment: Node.js `v24.20.0`, npm `11.19.0`, Flutter `3.47.7`, Dart `3.13.5`, MySQL 8.

### 31.2 Product decisions confirmed on 12 November

- Gym Owner must enter **only the one-time activation code**; no Organization ID is required or expected to be known by the customer.
- Gym App automatically reads its stable Device UUID and submits `device_uuid` + `activation_code`.
- API identifies the organization from the registered device/activation record; the client does not choose or assert the tenant organization.
- Initial registration and code regeneration both set activation expiry to **15 minutes**.
- Codes are single-use; the DB stores only the SHA-256 code hash.
- Super Admin popup shows organization/gym name, device name, activation code, Copy Code action and a 15-minute validity message.
- Successful activation returns organization/device identity and a random device token once. The app stores the token in Flutter Secure Storage; DB stores only the token hash.
- A deleted, pending, revoked or otherwise invalid device must not reach the Gym App login screen after startup validation.
- A device with an inactive organization/license is blocked from login. The local activation record is retained for recovery when the license/organization becomes valid again.
- Prefer Super Admin's Revoke Device action over direct row deletion so audit history is preserved.

### 31.3 API changes currently applied locally (not yet committed/pushed)

API files changed:

- `src/controllers/deviceController.js`
  - `/activate` body no longer requires `organization_id`.
  - Requires non-empty `device_uuid` and `activation_code`.
  - Hashes the code, looks up a matching pending device by UUID + code hash, and derives `organization_id` from that row.
  - Retains organization status, latest license, start/expiry and active-device-quota checks in the controller.
  - Locks/rechecks the matching device during the transaction.
  - Successful response includes organization id/name, device identity and plaintext device token once.
- `src/controllers/deviceManagementController.js`
  - New registration expiry changed from 24 hours to 15 minutes.
  - Regenerated/reactivated code expiry changed from 24 hours to 15 minutes.
  - The device schema already had `activation_expires_at`; no DDL change was needed.
- `src/routes/deviceRoutes.js`
  - Removed `checkOrganizationLicense` from `/activate` because it required an Organization ID before device lookup; `activateDevice` contains its own organization/license validation.
  - Added `GET /validate` before Platform Admin route middleware, using device-token authentication.
- `src/middleware/deviceAuthMiddleware.js` (new)
  - Exports `authenticateDevice`.
  - Requires a Bearer token in the generated 64-character hex format, hashes it, and matches `devices.device_token_hash`.
  - Joins device, organization and latest license, and verifies active device, active organization, active/current license, start time reached and expiry not passed.
  - Populates `req.device` after successful validation.
  - It currently protects the new validation endpoint. Apply it to each future protected Gym Staff API route; do not claim future business routes are already secured.

API validation reported successful:
- `node --check` passed for `deviceController.js`, `deviceManagementController.js` and `deviceRoutes.js` after activation changes.
- `node --check` passed for the new middleware and updated device routes after device validation was added.
- `git diff --check` passed after both API patches.

API backup folders created during this session:

```text
%TEMP%\gym_api_activation_15min_20261112_145722
%TEMP%\gym_api_device_validation_20261112_163013
```

Current API Git status last reported:

```text
 M src/controllers/deviceController.js
 M src/controllers/deviceManagementController.js
 M src/routes/deviceRoutes.js
?? src/middleware/deviceAuthMiddleware.js
```

The API branch was `main`, tracking `origin/main`, at commit `7db9e1f` (`Add Gym Owner onboarding and account management`) during the office-laptop inspection. Recheck branch, remote and ahead/behind before pushing.

### 31.4 Gym App changes currently applied locally (not yet committed/pushed)

Files/areas changed:

- `lib/features/device_activation/presentation/device_activation_screen.dart`
  - Device UUID remains visible and selectable with Copy action.
  - Organization ID input has been removed.
  - Only Activation Code is entered by the Gym Owner.
- `lib/core/services/device_activation_service.dart`
  - `activate()` accepts only `activationCode`.
  - `POST /api/devices/activate` sends only `device_uuid` and `activation_code`.
  - UUID is read/generated and retained in Flutter Secure Storage.
  - Added `clearSavedActivation()` to delete only the activation/session record, preserving the stable UUID.
  - Added `validateSavedActivation()` to call `GET /api/devices/validate` with the saved Bearer device token.
  - Compares server-returned organization ID, device ID and UUID with the saved values and requires device status `active`.
  - Deleted/invalid/revoked/pending device-token cases clear the activation record and return to Activation.
  - Organization/license failures block login while retaining the activation for recovery.
  - Network/validation service failures block login and surface a retry/error state without deleting the saved activation.
- `lib/features/auth/presentation/app_entry_screen.dart`
  - Startup restore now calls `validateSavedActivation()` instead of trusting local activation data alone.
  - The login screen is rendered only after successful server validation.
- Earlier Gym App project setup remains locally changed:
  - `lib/main.dart`
  - `lib/features/splash/presentation/splash_screen.dart`
  - `lib/features/auth/presentation/login_screen.dart` and other auth files under the untracked `lib/features/auth/`
  - `lib/core/constants/api_constants.dart` and `lib/core/services/device_activation_service.dart` under untracked `lib/core/`
  - activation screen/service under untracked `lib/features/device_activation/`.

Gym App analysis/validation:
- Full-project `flutter analyze` passed for Gym App and Super Admin after the activation-code-only and popup changes, before the final device-validation additions.
- The final corrected device-validation patch passed targeted `flutter analyze` for `device_activation_service.dart` and `app_entry_screen.dart` with `No issues found`.
- An earlier attempt at the validation patch failed with nullable-int and duplicate-catch diagnostics, but the script restored both files; the corrected patch was subsequently installed and passed.
- No `WidgetsBindingObserver`/foreground-resume revalidation patch was applied. Current validation happens when `AppEntryScreen` is initialized (startup/restart). For testing updated Dart source, hot restart or rebuild/reinstall the emulator app before judging behavior. Immediate revalidation when returning from another app without restarting is not part of the current implementation.

Gym App backup folders:

```text
%TEMP%\gym_app_activation_code_only_20261112_151247
%TEMP%\gym_app_device_validation_final_20261112_171416
```

Current Gym App Git status last reported:

```text
 M lib/features/splash/presentation/splash_screen.dart
 M lib/main.dart
?? lib/core/
?? lib/features/auth/
?? lib/features/device_activation/
```

Last known Gym App baseline in prior handover was commit `8981e1e` (`Initial commit: Gym Management Flutter App`); recheck actual local `git log` and remote sync before pushing.

### 31.5 Super Admin popup changes currently applied locally (not yet committed/pushed)

File changed:

- `lib/features/devices/device_management_screen.dart`
  - `_showActivationCode` now receives required `organizationName` and `deviceName`.
  - Popup displays gym name and device name above the activation code.
  - Popup states: `Valid for 15 minutes from generation. Use it before it expires.`
  - Copy Code and one-time display behavior are retained.
  - Initial registration passes the selected organization name plus device name from the registration response.
  - Regeneration/reactivation passes organization/device names from the device record.
  - No Organization ID is requested from the Gym Owner; organization selection remains a Super Admin registration concern.

The targeted `flutter analyze` for `device_management_screen.dart` passed as part of the guarded patch. Backup folder:

```text
%TEMP%\gym_super_admin_activation_popup_20261112_154558
```

Current Super Admin Git status last reported:

```text
 M lib/features/devices/device_management_screen.dart
```

The master document must be copied to the root as `GYM_MANAGEMENT_PROJECT_MASTER.md` and included in the Super Admin commit. Recheck the current branch, latest local commit, remote and any unrelated changes before staging.

### 31.6 Device validation test observations and accurate status

Observed by the user:

1. A previously registered device row was deleted directly from `gym_management_db.devices` for a test.
2. After the API/Gym App device-validation changes were installed and the app was restarted, the Gym App showed the Activation screen instead of the old login screen. This is a positive observation that the deleted device token was rejected at startup.
3. The user then re-registered and activated the device using the code-only process.
4. The user revoked the device through Super Admin and at first saw login when returning/restarting the Gym App. The user clarified that the updated app had not been hot-restarted after the Dart source changes. Treat this as an outdated running-app test, not a confirmed failure of the new validation code.
5. Repeat the revoked-device startup test after hot restart/rebuild/reinstall of the Gym App. Expected API response from validation middleware for revoked status is HTTP 403 `DEVICE_NOT_ACTIVE`; the Gym App should clear activation only, preserve UUID and show Activation.

The final current state of the specific test device row was not supplied. Query by UUID before assuming it is still revoked/active/deleted.

### 31.7 Current validation evidence

- API activation-code changes: successful guarded patch; JavaScript syntax checks and `git diff --check` passed.
- API device validation endpoint/middleware: successful guarded patch; syntax checks and diff check passed.
- Gym App activation-code-only changes: successful guarded patch; targeted formatting/analyzer passed.
- Super Admin popup changes: successful guarded patch; targeted formatting/analyzer passed.
- Full-project Flutter analysis for both Flutter repositories passed after code-only activation and popup changes.
- Final Gym App device-validation files were separately analyzed afterward and passed with `No issues found`.
- Do not state that all three repositories are committed or pushed. At this checkpoint the changes remain local/uncommitted.

### 31.8 Release preparation — current explicit Git staging plan

All repositories are independent. Verify `git status`, `git branch --show-current`, `git remote -v` and `git fetch origin` for each before staging. Do not use `git add .`, destructive resets, broad restores or `git clean`. Never stage `.env`, secrets, build directories, local backup files or unrelated changes.

API staging paths (only these four):

```text
src/controllers/deviceController.js
src/controllers/deviceManagementController.js
src/routes/deviceRoutes.js
src/middleware/deviceAuthMiddleware.js
```

Gym App staging paths (only these paths):

```text
lib/main.dart
lib/features/splash/presentation/splash_screen.dart
lib/core/
lib/features/auth/
lib/features/device_activation/
```

Super Admin staging paths (only these two):

```text
lib/features/devices/device_management_screen.dart
GYM_MANAGEMENT_PROJECT_MASTER.md
```

Suggested separate commit messages:

- API: `Add 15-minute activation and device validation`
- Gym App: `Require server validation for device startup`
- Super Admin: `Show organization and device in activation code dialog`

Push each repository separately to `origin main` only after confirming the current branch is `main`, the working tree contains only expected changes, and the local branch is not unexpectedly behind/diverged. The master file is part of the Super Admin repository commit.

### 31.9 Outstanding work after this checkpoint

1. Copy this updated master document into the Super Admin repository root and commit/push it with the Super Admin popup change.
2. Commit and push the four named API files.
3. Commit and push the listed Gym App files/directories.
4. Re-run full-project `flutter analyze` for Gym App and Super Admin after the latest changes; API `node --check` and `git diff --check` as part of pre-push.
5. Hot restart/rebuild the Gym App, then test: valid active device -> login; revoked device -> Activation; deleted device -> Activation; pending device -> Activation; invalid token -> Activation; license expired/inactive -> blocked error/retry; server unavailable -> blocked retry while retaining activation.
6. Confirm the 15-minute expiry with a real newly generated code; verify an expired code is rejected and a single-use code cannot be reused.
7. Regenerate any pending codes that were created before the 15-minute policy change; old DB expiry timestamps remain until those codes are replaced or expire.
8. Add rate limiting/attempt throttling for public activation attempts and assess whether the 10-hex-character code format should be strengthened.
9. Add device-originated `DEVICE_ACTIVATED` operational audit history inside the activation transaction. Do not record activation code or plaintext device token.
10. Apply `authenticateDevice` to all protected Gym Staff routes when those API routes are created; the current new validation route is protected, but future operational endpoints are not yet present.
11. Consider revalidation on foreground resume if immediate revocation while the Gym App process remains alive is required. That lifecycle observer change has not been implemented.
12. Complete the separate one-active-device/two-pending-device quota test; it is not yet proven by the current activation flow.
13. Continue Gym Staff authentication/session handling, tenant-side user/role/permission management, audit hardening and only then membership/payment/program/progress modules.

### 31.10 Exact continuation point

The activation/onboarding flow has now been changed to code-only entry with a 15-minute code lifetime; the API can validate an activated device token against device, organization and latest-license state; and the Gym App validates the saved token at startup before displaying login. Static validation passed for the changed files. The next immediate task is to put the updated master file in the Super Admin repo, perform careful full-project/pre-push validation, and push all three repositories independently. After push, hot restart/rebuild the emulator app and repeat the revoked-device and expiry tests before considering device security complete.

---

**End of updated master handover document.**


---

## 32. Current Office-Laptop Checkpoint — Branch Switching and Membership Plans (13 November 2026)

This is the latest authoritative checkpoint as of 13 November 2026. It supersedes earlier statements in Sections 21–31 wherever current workstation state, Gym Staff authentication, branch behavior, membership-plan development, or next tasks differ. Older sections remain historical records.

### 32.1 Current workstation, projects and repositories

The active workstation is the **office Windows laptop**. Use these exact paths in PowerShell commands:

```text
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\gym_management_api
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\gym_management_super_admin
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\gym_management_app
```

The three Git repositories are independent and must be committed/pushed separately:

| Project | GitHub remote |
|---|---|
| API | `https://github.com/arafath65/gym-management-api.git` |
| Super Admin | `https://github.com/arafath65/gym-management-super-admin.git` |
| Gym App | `https://github.com/arafath65/gym-management-apps.git` |

Do not assume the local Windows project folders are accessible from ChatGPT. Before each release, inspect actual local `git status`, branch, remote and fetched `origin/main`. Never use `git add .`; stage only reviewed project files. Do not stage `.env`, credentials, device activation codes, plaintext device tokens, build output, `node_modules`, `.dart_tool`, or backup files.

### 32.2 Final branch and device behavior decisions

These are product-wide rules and must be applied consistently to all future APIs, database tables, Flutter screens, reports and dashboards.

**Devices are organization-bound, not branch-bound.**

- A device is registered to one `organization_id`.
- `devices.registered_branch_id` is retained as the original/default registration branch for reference only.
- A device may be used at any branch belonging to its own organization. `registered_branch_id` must never be used to reject a request solely because the device is being used at a different branch.
- Device authentication must continue to validate the device token, device status, organization ownership/status, and applicable license validity.
- A device registered to Organization A must never be accepted for Organization B.
- Using the device at another branch must not rewrite `registered_branch_id`.

**Members are organization-wide for attendance.**

- A member's registration/home branch is reference information, not an attendance restriction.
- A member may attend any branch belonging to the same organization.
- Attendance must record the actual branch where check-in occurred, separately from the member's home branch.
- Recommended attendance history fields include `branch_id` and `branch_name_snapshot`, so old attendance continues to display the branch name that applied at check-in if the branch is renamed later.
- Do not reject member attendance because the actual attendance branch differs from the member's registered/home branch.
- Member/attendance tables and APIs have not yet been implemented; these are mandatory design rules for their future implementation.

**Gym Staff active-branch access remains separately secured.**

- `devices.registered_branch_id` and Gym Staff's active working `branch_id` are distinct values.
- The active branch comes from the Gym Staff session and must be checked against the user's active `user_branch_access` records.
- Gym Admin/authorized staff can switch to another branch to which they have access, subject to `branches.switch` permission.
- A normal staff user remains constrained by their assigned branches and permissions.
- Every operational API must use the authenticated `req.gymStaff.branchId` as the active branch context when a module is branch-scoped; never trust an arbitrary client-supplied organization or branch identifier.
- Switching active branch does not modify the device's registered branch.

### 32.3 Branch-switch permission migration — completed

The permission migration `scripts/migrateGymAdminBranchSwitchPermission.js` was executed successfully on 13 November.

- Added `branches.switch` to `permissions` with `gym_admin_default = 1`.
- The permission received ID `22` in the current database.
- All three existing organization-scoped system Gym Admin roles were synchronized successfully.
- Organizations 1, 2 and 3 each have 14 default Gym Admin permissions and `branches.switch` assigned.
- Custom staff roles were not modified.

The existing `src/services/gymAdminPermissionService.js` uses `gym_admin_default` metadata to synchronize only system Gym Admin roles. Future Gym Admin-default permission migrations should use this service rather than maintaining hard-coded permission lists.

### 32.4 Gym Staff authentication and branch-switch API — implemented locally, not end-to-end tested

The Gym Staff API has been added to the API project:

- `src/controllers/gymAuthController.js`
- `src/middleware/gymStaffAuthMiddleware.js`
- `src/routes/gymAuthRoutes.js`
- `src/services/gymAdminPermissionService.js`
- `scripts/syncGymAdminPermissions.js`

`src/server.js` mounts `/api/gym-auth`.

The route `POST /api/gym-auth/switch-branch` uses device authentication, Gym Staff JWT authentication and `requireGymPermission("branches.switch")` before calling the branch-switch controller.

The branch-switch implementation issues a new Gym Staff session token with the selected active branch, checks the user's branch access through the session creation flow, does not change device registration, and writes a `GYM_STAFF_BRANCH_SWITCH` audit action. The `/api/gym-auth/me` response includes accessible branch information for restoring the selector.

The branch-switch code was validated using:

- `node --check` for `gymAuthController.js`, `gymStaffAuthMiddleware.js` and `gymAuthRoutes.js` — passed.
- Runtime `require()` probe for the controller, middleware and router — passed.
- `git diff --check` — passed.

**Qualification:** a real HTTP integration test of branch switching, token replacement and audit-log persistence has not yet been reported. The Flutter branch selector and Flutter call to `/switch-branch` are also not yet implemented. Do not describe branch switching as fully user-tested until these are completed.

### 32.5 Membership Plan module — database foundation completed

The user chose this implementation order:

1. Membership Plan Management.
2. Fitness Program Management.
3. Trainer Management.
4. Member Management, using the earlier master records during member registration.
5. Attendance Management.
6. Payments and reports.

The `membership_plans` table was created successfully on 13 November by `scripts/migrateMembershipPlans.js`.

Current schema fields:

| Column | Current definition / purpose |
|---|---|
| `id` | Auto-increment primary key |
| `organization_id` | Owning gym organization |
| `plan_code` | Unique within the organization; API should generate it |
| `name` | Plan display name |
| `description` | Optional description |
| `package_type` | `individual` or `couple` |
| `tier` | Configurable tier label such as Gold, Silver or Platinum |
| `duration_value` | Positive duration count |
| `duration_unit` | `day`, `week`, `month` or `year` |
| `price` | Total package price (`DECIMAL(12,2)`) |
| `currency_code` | Three-character currency code; defaults to `LKR` |
| `included_members` | Number of people covered by the package |
| `paying_members` | Number of people charged by the package |
| `status` | `active` or `inactive` |
| `created_by_user_id` | Authenticated Gym Staff creator |
| `updated_by_user_id` | Last authenticated Gym Staff updater |
| `created_at`, `updated_at` | Creation/update timestamps |

The schema enforces:

- Organization-scoped unique plan code and ID keys.
- Organization foreign key.
- Creator/updater foreign keys scoped to the same organization.
- Non-negative price and positive duration.
- `included_members >= paying_members >= 1`.
- Individual packages have exactly one included and one paying member.
- Couple packages have exactly two included members and one paying member.

**Benefits were explicitly removed.** The user does not want a benefits field in membership plans. The `benefits` column was removed successfully after the migration, and `scripts/migrateMembershipPlans.js` was updated so fresh installations do not create it. The removal script is `scripts/migrateRemoveMembershipPlanBenefits.js`. Verification showed no `benefits` column in the table. There were no membership-plan rows when the safe removal migration ran; the script would stop rather than drop the column if plans already existed.

Examples:

- Individual Gold Monthly: one included member, one paying member.
- Couple Gold Monthly: two included members, one paying member; the price is the total couple-package price, not a per-person amount.

Plans are organization-wide in the initial design. Do not add a branch restriction to plan availability unless a later explicit product decision introduces optional branch availability.

### 32.6 Membership Plan permission catalogue — completed

The migration added four permissions with `gym_admin_default = 1`:

| Permission | Current database ID |
|---|---:|
| `membership_plans.view` | 23 |
| `membership_plans.create` | 24 |
| `membership_plans.update` | 25 |
| `membership_plans.deactivate` | 26 |

The migration synchronized the existing system Gym Admin roles for organizations 1, 2 and 3. Each role received all four permissions. Custom staff roles were not modified. The permission sync mechanism will also grant these defaults to future organizations when their Gym Admin role is provisioned.

### 32.7 Services are a separate future module

The user explicitly decided that membership plans should not contain service/benefit definitions. Facilities such as swimming pool, sauna and similar services will be managed through a separate Services module.

Future integration may associate services with a membership plan through a separate relationship table (for example, a plan-to-service entitlement table). A service may also be sold separately with its own price and validity. Do not add a `benefits` JSON/text field back to `membership_plans` and do not hardcode swimming pool/sauna properties into membership plan records.

The Services module itself has not been implemented or fully specified yet.

### 32.8 Membership Plan API and Flutter UI — not yet implemented

The current milestone is database schema and permission foundation only. No Membership Plan CRUD API, repository/service layer, Flutter model, plan list, create/edit form or dashboard navigation screen has been confirmed as implemented.

Next Membership Plan implementation should include:

- `GET` list with pagination/search/status filtering, organization scope from authenticated Gym Staff context, and view permission.
- `GET` one plan scoped by organization and plan ID.
- `POST` create with `membership_plans.create`, validated input, generated organization-unique plan code, creator ID from `req.gymStaff.userId`, and a transaction-backed audit record.
- `PUT` or `PATCH` update with `membership_plans.update`, immutable organization/creator data, and updater ID from authenticated context.
- Deactivate action with `membership_plans.deactivate`; do not hard-delete plan records because future member subscriptions may reference them.
- Consistent error handling, validation and organization scoping. Never accept `organization_id` or creator IDs as trusted client input.
- Flutter API service/model and responsive Membership Plans list, create/edit form, view details and deactivate confirmation.
- Add navigation visibility/actions based on the four permission keys.
- Verify all mutations through API/database tests and audit logs before considering the module complete.

The plan-code column is mandatory and unique per organization, but the automatic code-generation logic belongs in the API and has not yet been implemented. Example display code only: `GOLD-MON-001`; do not rely on a hard-coded prefix convention until the generator is designed.

### 32.9 Current project change inventory — recheck before Git staging

The last displayed API Git status after the branch-switch permission migration included:

```text
 M src/controllers/organizationController.js
 M src/middleware/deviceAuthMiddleware.js
 M src/routes/organizationRoutes.js
 M src/server.js
?? scripts/migrateGymAdminBranchSwitchPermission.js
?? scripts/syncGymAdminPermissions.js
?? src/controllers/gymAuthController.js
?? src/middleware/gymStaffAuthMiddleware.js
?? src/routes/gymAuthRoutes.js
?? src/services/gymAdminPermissionService.js
```

Since then the Membership Plan migration scripts were created/updated:

```text
scripts/migrateMembershipPlans.js
scripts/migrateRemoveMembershipPlanBenefits.js
```

The latest complete API Git status after those migration changes has **not** been captured. Recheck before staging.

The last reported Gym App Git status was:

```text
 M lib/features/auth/presentation/app_entry_screen.dart
 M lib/features/auth/presentation/login_screen.dart
 M pubspec.yaml
?? assets/images/gym_hero_athlete.png
?? lib/core/services/gym_auth_service.dart
?? lib/features/auth/presentation/gym_authenticated_screen.dart
```

Recheck the current Gym App status and run full `flutter analyze` before staging. The Gym App includes device activation/login/session and a dark green/black dashboard foundation. A Flutter active-branch selector, branch-switch API integration, and Membership Plan UI have not yet been implemented.

No current Git status was captured for the Super Admin repository during this 13 November work. Do not assume it is clean or dirty; inspect it. The Super Admin app was not intentionally changed as part of the Gym Staff branch-switch or Membership Plan database work. It may still contain the earlier activation dialog change described in Section 31.

### 32.10 GitHub release preparation — three separate projects

The user requested a release/push of the updated project state and this master document to all three GitHub repositories. No `git commit` or `git push` was executed during the 13 November branch-switch/Membership Plan work in this ChatGPT session.

Before pushing:

1. Confirm `main` is the current branch in all three repositories.
2. Confirm the exact expected `origin` URL for each repository.
3. Fetch `origin` and stop if local `main` is behind/diverged; do not force push.
4. Run API JavaScript syntax checks and `git diff --check`.
5. Run full `flutter analyze` in both Flutter projects.
6. Stage only reviewed changed source/migration/documentation files. Never `git add .`.
7. Copy this document into the Super Admin repository root as `GYM_MANAGEMENT_PROJECT_MASTER.md`; back up any existing copy before replacing it.
8. Commit/push each repository independently. Report commit hashes and push results separately.

The exact current staged file list must be derived from fresh Git status. Earlier change inventory is a guide, not proof of current local state.

### 32.11 Exact continuation point

The branch-switch permission migration and Membership Plan table/permissions are applied and verified in the office-laptop database. The API branch-switch code passed syntax/module-load/diff checks, but has not yet received an end-to-end HTTP test. The member/device cross-branch rules are settled product requirements. Benefits were removed from membership plans; swimming pool, sauna and similar facilities will be a separate Services module later.

**Immediate next tasks:**

1. Recheck and safely commit/push the API, Gym App and Super Admin repositories; include this updated master document in the Super Admin repository root.
2. After release, test branch switching end-to-end (permissions, branch access, new JWT, `/me`, audit row) and build the Flutter active-branch selector.
3. Implement Membership Plan CRUD API with validation, generated plan codes, organization isolation and audit logging.
4. Build Membership Plan Flutter screens and test all four permissions.
5. Continue with Fitness Program Management, Trainer Management, Member Management, Attendance, Services integration, Payments and reports in that order.

---

**End of the 13 November 2026 checkpoint. The authoritative 14 November 2026 continuation update follows.**
---

## 33. Current Authoritative Checkpoint — Role API, Operational Modules and GitHub Release (14 November 2026)

This section is the newest verified continuation checkpoint. It supersedes earlier statements wherever they conflict with the 14 November source inventory, database audit, validation output or GitHub commit state. Sections 1–32 are retained as historical design and implementation records; do not delete them merely because later work changes the status of a feature.

### 33.1 Office workstation and repository state

The active workstation for the work summarized here is the office Windows laptop. The project root and exact repository paths are:

```text
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects\
    gym_management_api\
    gym_management_app\
    gym_management_super_admin\
```

All three repositories are on branch `main`. Each repository was fetched from `origin/main` and checked after the push attempt. The final verification showed:

- `git rev-list --left-right --count origin/main...main` returned `0 0` for every repository.
- `git status --short --branch` showed `## main...origin/main` with no modified or untracked files in each repository.
- Local `HEAD`, `origin/main` and `origin/HEAD` pointed at the same latest commit in each repository.

The first push script printed `FAILED` for the API and Gym App because its PowerShell/native-command output handling did not capture the push result reliably. **Do not interpret that first summary as the final GitHub state.** A subsequent `git fetch origin main`, commit comparison and clean-status verification proved that both commits were present on GitHub. No force push, reset, rebase or merge was needed.

### 33.2 Verified GitHub release checkpoint

These are the exact repositories and latest commits verified on 14 November 2026:

| Project | Repository | Latest verified commit | Commit message | Verification |
|---|---|---|---|---|
| Gym Management API | `https://github.com/arafath65/gym-management-api` | `b4aaaf9` | `Update gym API and role permission management` | Local and `origin/main` synchronized; clean tree |
| Gym Management App | `https://github.com/arafath65/gym-management-apps` | `909b777` | `Update gym app device management and permissions foundation` | Local and `origin/main` synchronized; clean tree |
| Gym Management Super Admin | `https://github.com/arafath65/gym-management-super-admin` | `5039251` | `Update Gym Management project master handover` | Local and `origin/main` synchronized; clean tree |

The Super Admin repository had no pending source changes during this release check. Its latest commit already contained the then-current master handover file. The updated 14 November version of this document is a subsequent documentation change and must be copied into that repository and committed separately after reviewing the diff.

The old repository named `Gym-Management-App` is not the current Flutter Gym App repository. The active Flutter operational application is `gym-management-apps` (folder `gym_management_app`). Do not confuse the older Android project/repository with the Flutter repository listed above.

### 33.3 API source modules now present in the 14 November release

The API repository's 14 November commit included the following additional/current source modules:

```text
src/controllers/
    fitnessProgramController.js
    gymAuditLogController.js
    gymBranchController.js
    gymDeviceController.js
    gymRoleController.js
    membershipPlanController.js

src/routes/
    fitnessProgramRoutes.js
    gymAuditLogRoutes.js
    gymBranchRoutes.js
    gymDeviceRoutes.js
    gymRoleRoutes.js
    membershipPlanRoutes.js

src/services/
    gymAdminPermissionService.js

scripts/
    migrateFitnessPrograms.js
    migrateGymDeviceTransfers.js
    migrateGymPermissionScope.js
    migrateMembershipPlans.js
    migrateOngoingMembershipPlans.js
```

The release also updated existing `gymAuthController.js`, `deviceAuthMiddleware.js`, `server.js`, `gymAdminPermissionService.js` and `migrateMembershipPlans.js`. The API commit summary reported 26 changed files, approximately 7,106 insertions and 61 deletions. This is the Git change summary, not a count of independently completed or end-to-end tested features.

The route files and controllers exist in the committed source. Before extending a controller or writing a Flutter service against it, inspect the current route and controller code to confirm exact paths, HTTP methods, request fields, response shapes, middleware order and permission keys. Do not infer an API contract from a screen label or filename.

### 33.4 Gym App source modules now present in the 14 November release

The Gym App repository's 14 November commit included these services/screens and updates:

```text
lib/core/services/
    gym_api_client.dart
    gym_auth_service.dart

lib/features/audit_logs/
    data/audit_log_service.dart
    presentation/audit_logs_screen.dart

lib/features/branches/
    data/branch_service.dart
    presentation/branch_management_screen.dart

lib/features/devices/
    data/device_service.dart
    presentation/device_management_screen.dart

lib/features/fitness_programs/
    data/fitness_program_service.dart
    presentation/fitness_programs_screen.dart

lib/features/membership_plans/
    data/membership_plan_service.dart
    presentation/membership_plans_screen.dart

lib/features/auth/presentation/
    gym_authenticated_screen.dart
```

The authenticated-screen and Gym Auth service were updated. These files were committed in `909b777`. The commit summary reported 15 changed files, approximately 9,101 insertions and 13 deletions. The Git summary included two timestamped backup copies of the Membership Plans screen; see the repository hygiene note in Section 33.10.

**Implementation status distinction:** source modules and screens are present in the repository. Their presence alone does not prove every action, filter, permission combination, transaction, or error path has passed runtime testing. Record module-level tests separately as they are completed.

### 33.5 Device management and device-to-branch transfer — implementation and user testing

The Gym App now contains device-management service and screen code; the API contains the corresponding controller and route code. The device-transfer migration script is included in the API repository.

The database migration was run successfully before the GitHub release:

- `device_branch_transfer_history` was created.
- The Gym Staff permission catalogue received `devices.view` and `devices.transfer` for the existing system Gym Admin roles.
- The user manually tested device assignment/transfer and reported that it worked successfully.
- The Flutter device-management screen's earlier analyzer issue was corrected. The `separatorBuilder` callback was changed from duplicate underscore identifiers to `(_, _)`, and the user reported `flutter analyze` as `No issues found` at that checkpoint.
- The earlier top-bar `Flexible(Text(...))` layout issue was corrected by the user. The active device's registered/default branch display is distinct from the Gym Staff active working branch selector.

Keep the product rules in Section 32.2 unchanged:

- A device belongs to one organization, not exclusively to one branch.
- `registered_branch_id` is retained as the device's registration/default branch reference.
- Device transfer must not change the device token or the Gym Staff JWT's active branch.
- Device authentication validates token, device status, organization ownership/status and license validity.
- A Gym Admin can manage device assignments within their organization, subject to permission checks.
- Platform/Super Admin performs initial registration/activation provisioning; tenant-level device transfer belongs to the Gym Owner/Gym Admin workflow.
- Branch authorization for staff remains enforced independently through `user_branch_access` and the selected active branch.

Do not run `scripts/migrateGymDeviceTransfers.js` again unless the migration itself is deliberately changed and made safe/idempotent. The reported migration has already been applied to the office database.

### 33.6 Role and permission API foundation — migration applied; Flutter management UI pending

The following API files were created/updated and included in the 14 November API commit:

- `src/controllers/gymRoleController.js`
- `src/routes/gymRoleRoutes.js`
- `src/services/gymAdminPermissionService.js`
- `scripts/migrateGymPermissionScope.js`
- `src/server.js`

The migration script was run successfully. Its reported result was:

```text
Adding permissions.permission_scope...
Gym permission-scope migration completed.
Permission counts:
  gym      26
  platform  6
Existing Gym Admin roles synchronized: 3

org 1 / role 1: 25 permissions; added roles.delete; removed none
org 2 / role 2: 25 permissions; added roles.delete; removed none
org 3 / role 3: 25 permissions; added roles.delete; removed none
```

The migration added the `permission_scope` column to the `permissions` catalogue and classified permissions into `gym` and `platform` scopes. Six permissions are platform-scoped and must not be exposed or assignable in Gym Owner/Gym Staff role management. The Gym scope has 26 catalogue entries. Each of the three existing system Gym Admin roles was synchronized to 25 assigned permissions and received `roles.delete`.

The system Gym Admin synchronization service is the source of truth for default Gym Admin permission grants. It synchronizes permissions marked for Gym Admin defaults. **Custom roles must not be silently changed when new permissions are added.** Newly introduced permissions should be available in the relevant Gym permission catalogue, but a custom role receives one only when an authorized Gym Admin explicitly grants it.

The database audit performed after migration found:

- `permissions.permission_scope` exists.
- 26 `gym` permission rows and 6 `platform` permission rows.
- 13 role records in total.
- 8 role assignments in `user_roles`.
- Three existing system Gym Admin roles, each with 25 assigned permissions.
- No missing required core tables among `permissions`, `roles`, `role_permissions`, `users`, `user_roles`, `user_branch_access`, `branches` and `organizations`.

The API source syntax checks passed for:

```powershell
node --check src/controllers/gymRoleController.js
node --check src/routes/gymRoleRoutes.js
node --check scripts/migrateGymPermissionScope.js
node --check src/services/gymAdminPermissionService.js
node --check src/server.js
```

Earlier source checks also passed for the device and Gym Auth files. The user reported the API health endpoint returned `success = True`, `api = connected`, `database = connected` after this work.

**Not yet confirmed complete:** no Flutter Role & Permission management service/screen has been implemented in the current release; the new Role API has not yet been end-to-end tested with the Flutter UI. Before implementing that UI, inspect `gymRoleRoutes.js` and `gymRoleController.js` and capture their exact API contract. The audit report used for the earlier source inspection predates these newly committed files, so it is not a substitute for reading the current source.

### 33.7 Authentication and permission enforcement rules for continued work

The current Gym Staff authorization design requires the API to reload the user's active state, assigned roles and effective permissions from MySQL on every authenticated request rather than trusting permission claims embedded in a potentially stale JWT.

- `requireGymPermission(permissionKey)` checks `req.gymStaff.permissions` and rejects an unauthorized operation with HTTP 403.
- Branch access remains a separate authorization dimension; a user must be authorized for the active branch through `user_branch_access`.
- Gym permissions and Platform Admin permissions are separate catalogues/scopes and must never be mixed.
- Do not accept client-supplied `organization_id`, creator IDs or arbitrary branch context as trusted identity. Derive organization/user context from the verified session and validate branch access on the server.
- Keep system Gym Admin protected from unsafe rename/edit/delete operations. Custom-role deletion must be blocked or require safe reassignment when users are still assigned.
- Meaningful role/permission mutations must write audit records transactionally with the database change.

The Role API source exists and passed syntax checks, but complete route coverage, all authorization branches, custom-role lifecycle behavior and audit persistence still require endpoint-level tests before calling the RBAC module production-verified.

### 33.8 Database audit snapshot — 14 November 2026

The latest database audit reported:

- Database: `gym_management_db`.
- MySQL server version observed by the audit: `8.0.46`.
- Organization records observed: Innovex Fitness Center, ABC Fitness Center and Power Worlds.
- Core organization/branch/user/role/permission tables listed in Section 33.6 were present.
- Additional feature tables observed included `audit_logs`, `devices`, `device_branch_transfer_history`, `licenses`, `fitness_programs`, `membership_plans` and Platform Admin tables.
- `user_branch_access` showed organization 1 with branch 1, organization 2 with branch 2, and organization 3 with branches 3 and 4.

The role/permission audit confirmed the following current table structure facts:

- `permissions`: `id`, unique `permission_key`, `module_name`, `description`, `gym_admin_default`, and the newly added `permission_scope`.
- `roles`: `id`, `organization_id`, `name`, `description`, `is_system_role`, timestamps and organization-scoped uniqueness/foreign-key relationships.
- `role_permissions`: composite role/permission association with foreign keys.
- `users`: organization-scoped staff identity, full name, email, phone, password hash, active/inactive/locked status and login/timestamp fields.
- `user_roles`: organization-scoped user-to-role association.
- `user_branch_access`: organization-scoped user-to-branch access.
- `branches`: organization, name, branch code, phone, address and active/inactive status.

This is an audit snapshot, not a promise that the live database has not changed since 14 November. Before any destructive or data-changing migration, take a fresh backup, inspect `SHOW CREATE TABLE`, check row counts/foreign keys and confirm the script's idempotency. Do not repeat migrations already reported as successful merely to reproduce their output.

### 33.9 API and Flutter validation evidence

Validation reported during the 14 November work:

- API JavaScript syntax checks passed for the newly created role controller, role routes, permission-scope migration, Gym Admin permission service and API server.
- API health request to `http://localhost:5000/api/health` returned API and database as connected.
- Device and Gym Staff Auth source syntax checks had previously passed.
- The device transfer workflow was manually exercised by the user and reported working.
- Flutter analyzer reported no issues after the earlier device-screen separator callback correction.

The following should not be represented as completed tests without fresh evidence:

- Full repo-wide `flutter analyze` after every newly added module in the 14 November commit.
- Full API automated/integration test suite for all newly committed controllers.
- Role CRUD and permission-assignment API integration tests.
- Staff-management workflow (staff creation, editing, activation/deactivation, role assignment and branch access).
- Flutter Role & Permission screen behavior.
- A complete end-to-end test proving audit rows for each role/device/branch/program/membership mutation.
- End-to-end verification of the branch-switch token replacement and audit record together with the Flutter selector.

### 33.10 Repository hygiene note — backup files included in the release

The Git change summary for the 14 November API commit showed a `Temp/` backup directory containing at least a JSON backup of membership plan data created before an ongoing-membership migration. The Gym App commit included two timestamped backup Dart files:

```text
membership_plans_screen.dart.backup_20261114_101647
membership_plans_screen.dart.backup_20261114_101921
```

These files were part of the commits already synchronized to GitHub. Do not rewrite history or force-push to remove them. Before the next normal release:

1. Inspect the exact contents of the API `Temp/` backup and confirm whether it contains live customer/member data or any sensitive values. Do not paste sensitive records into chat.
2. Decide whether the backup belongs in source control. If it should not be tracked, remove it in a normal follow-up commit after preserving an appropriate private backup.
3. Remove the two Flutter `.backup_*.dart` files from the repository in a normal commit if they are no longer needed as tracked source artifacts.
4. Add narrowly scoped ignore rules for future local backups (for example `Temp/` and `*.backup_*.dart`) only after checking existing ignore rules and confirming the patterns will not hide legitimate migration/source files.
5. Continue to keep `.env`, credential files, private keys, device tokens, activation codes and other secrets out of Git.

The earlier push preflight reported no suspicious secret filenames in staged/unstaged/untracked changes. That filename check does not prove that a JSON backup has no sensitive record content; inspect the file before deciding to keep it public.

### 33.11 Current product and module status summary

| Area | Current 14 November status | Next verification/action |
|---|---|---|
| Platform Super Admin | Existing app and API remain synchronized at `5039251`; no new source edits in this release | Continue only if a new Platform Admin feature is planned; preserve separate platform RBAC |
| Gym Staff Auth | API/session code exists and was updated; health and syntax checks passed | Test login, `/me`, expired/inactive user and branch-context behavior end to end |
| Branch management | Gym API controller/routes and Flutter service/screen are in the committed source | Confirm route permissions, assigned-branch enforcement, mutations and audit rows |
| Device management/transfer | API and Flutter modules committed; transfer migration applied; manual transfer reported working | Verify authorization, transfer history and audit behavior; do not rerun migration |
| Audit logs | API controller/routes and Flutter service/screen committed | Verify filters/pagination and tenant/branch visibility; ensure mutation coverage and authorization |
| Role & Permission API | Controller/routes committed; permission scopes migrated; Gym Admin defaults synchronized | Inspect exact API contract, test routes, then build Flutter management UI |
| Staff management | Not established as complete by the 14 November source inventory | Implement after the role/permission workflow; include branch access, status and audits |
| Fitness Programs | API controller/routes, migration script, Flutter service and screen are present; table observed in DB audit | Verify CRUD/enrollment rules and API/UI end-to-end; avoid claiming all program workflows tested |
| Membership Plans | API controller/routes, migrations, Flutter service and screen are present; table observed in DB audit | Verify plan validation, ongoing-member interactions, permissions and audit writes |
| Trainer Management | Not established as complete in this release | Implement after role/staff foundation and confirm trainer permissions/data model |
| Members and fitness progress | Requirements remain in earlier sections; complete module not verified in this release | Build after the staff/role foundation; maintain organization-wide attendance rule |
| Attendance | No completed attendance module verified | Record actual attendance branch separately from member home branch |
| Services | Separate future module; not part of Membership Plan benefits | Define service catalogue, price/validity and plan entitlement relationship separately |
| Payments/reports | Not established as complete | Build after membership/subscription/payment rules are approved |

### 33.12 Next development sequence

The immediate next steps for the next development session are:

1. **Inspect the current Role API contract.** Read the committed `gymRoleRoutes.js`, `gymRoleController.js`, relevant middleware and `server.js` mounting. Record exact paths, methods, payloads, response shapes, scopes and permission guards before writing Flutter code.
2. **Build Flutter Role & Permission Management.** Load permissions dynamically from the Gym permission scope; group by the server-provided module; support custom role creation/edit/delete and permission assignment; never display Platform-scoped permissions to Gym Staff; protect the system Gym Admin role.
3. **Test role security.** Verify `roles.view/create/update/delete/assign`, the system-role restrictions, custom-role behavior, assigned-user deletion handling, and transactional audit logging using both permitted and denied users.
4. **Build Staff Management.** Include staff account lifecycle, role assignment, branch access and audit logs. Keep staff organization/branch restrictions enforced by the API.
5. **Run complete validation.** Run `node --check`/API tests for changed files, `git diff --check`, full `flutter analyze` in the Gym App, and real HTTP/database integration tests for every changed module. Record which checks passed instead of describing untested code as complete.
6. **Clean tracked backup artifacts in a normal commit.** Inspect API `Temp/` data first, then remove only confirmed unnecessary backup files and add narrow ignore rules as appropriate.
7. Continue refinement/testing of Fitness Programs and Membership Plans, then Trainer Management, Member Management, Attendance, Services, Payments and reports according to the product dependencies.

### 33.13 Continuation instructions for a new ChatGPT conversation

- Treat this Section 33 as the latest checkpoint as of 14 November 2026; Sections 1–32 are retained for the decisions and historical details they contain.
- Use the three correct repository URLs and commit hashes from Section 33.2. The older `Gym-Management-App` repository is not the Flutter Gym App repository being developed now.
- The permission-scope migration and device-transfer migration have already been run on the office database. Do not rerun them blindly.
- Do not guess the Role API route paths or request/response contract. Inspect the actual committed source before building the Flutter Role screen.
- Never assume that a module is fully tested merely because its files exist or its commit was pushed. Preserve the distinction between source present, migration applied, syntax-checked, analyzer-checked and end-to-end tested.
- Do not force-push. The three repositories were confirmed synchronized and clean at the commits shown in Section 33.2. The updated copy of this master file is the next intended documentation commit.

---

---

## 34. Current Office-Laptop Checkpoint — Gym Staff Sessions, Global Branch Selector, Staff Filtering and Trainer Management (17 November 2026)

This is the newest continuation checkpoint, based on the office-laptop work and user-reported tests through 17 November 2026. It supersedes earlier statements in Sections 1, 32 and 33 wherever they describe Gym Staff authentication/branch switching as pending, Staff Management as absent, or Trainer Management as not implemented. Sections 1–33 remain useful historical records; do not delete them. The 14 November GitHub commits in Section 33.2 remain the last verified remote commits. The work described below is in the current office-laptop working copies and **has not been confirmed committed/pushed**.

### 34.1 Active workstation and project paths

Continue on the office Windows laptop. Project root:

```text
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects
```

Repositories:

```text
gym_management_api\
gym_management_app\
gym_management_super_admin\
```

GitHub remotes remain those in Sections 3 and 33.2:

- API: `https://github.com/arafath65/gym-management-api.git`
- Gym App: `https://github.com/arafath65/gym-management-apps.git`
- Super Admin: `https://github.com/arafath65/gym-management-super-admin.git`

The last remote synchronization checkpoint is still the 14 November commit set in Section 33.2. No new commit hashes or successful push results have been supplied for the 15–17 November changes. Therefore, treat the changes in this section as local/unreleased until fresh `git status`, commit, fetch and `origin/main` comparison checks prove otherwise. Each repository must be reviewed and pushed independently. Do not use `git add .`; never stage `.env`, credentials, activation codes, plaintext tokens, local uploads, build output, dependency folders or temporary backups.

### 34.2 Gym Staff authentication and session behavior

The Gym Staff authentication/session implementation is now integrated into the Gym App workflow rather than remaining only an API foundation.

Relevant API source files include:

```text
src/controllers/gymAuthController.js
src/middleware/gymStaffAuthMiddleware.js
src/routes/gymAuthRoutes.js
src/controllers/gymStaffController.js
```

The API mounts Gym Staff authentication under `/api/gym-auth`. The branch-switch endpoint is:

```http
POST /api/gym-auth/switch-branch
```

It is protected by device authentication, Gym Staff JWT authentication and the `branches.switch` permission. The session creation flow validates that the requested branch belongs to the authenticated user's organization, is active and is within the user's authorized branch scope. A successful switch issues a replacement Gym Staff JWT carrying the selected active `branchId`; the session is refreshed in the app. The API also exposes the authenticated user's session/branch information through the Gym Auth `/me` workflow.

Flutter implementation details:

- `GymAuthService.switchBranch` reads the saved Gym Staff session token and device token, calls the switch-branch API, saves the returned session token and restores the session context.
- The authenticated screen refreshes its in-memory staff/session state after the API returns the new session.
- The selected active branch is session context; the device's original `registered_branch_id` remains separate and is not changed by switching.

Authorization rules remain mandatory:

- System Gym Admin can access all active branches belonging to its own organization, subject to the Gym Admin role and its configured permissions.
- A regular Gym Staff user can access only branches assigned through `user_branch_access` and allowed by their permissions.
- Backend checks are authoritative. Do not trust a branch or organization ID supplied by the Flutter client as authenticated identity.
- Device authentication remains organization-bound. A device may be used at another branch within the same organization; it must not be used across organizations.
- Every branch-scoped API must derive the active branch from the verified Gym Staff session (`req.gymStaff.branchId`) and separately enforce user branch access.

### 34.3 Global active-branch selector — implemented and manually tested

The Flutter global branch selector is now rendered in the main authenticated-screen top bar, using `_buildBranchSelector` from `gym_authenticated_screen.dart`. Previously, the selector was only rendered inside Branch Management. The Branch Management screen is no longer passed the duplicate session selector from the parent authenticated screen.

Current behavior:

- The selector uses the accessible branch list returned with the Gym Staff session.
- It is available when the user has more than one accessible branch and is allowed to switch (`branches.switch`; the System Gym Admin UI path is also recognized).
- The top bar has a compact presentation on narrower layouts and a fuller branch label on wider layouts.
- Selecting another branch invokes the session switch API; the app saves the replacement JWT and updates its active staff/session state.
- The top-bar branch is the **active working branch**, not the device's registration/default branch.
- Selecting a branch does not update `devices.registered_branch_id`.

**User test result, 17 November 2026:** after restarting the API and hot-restarting/running the Gym App, the user confirmed that the global branch selector was working. Treat this branch-selection flow as manually tested in the current app environment. Do not infer that all other Gym Staff endpoints or all permission-denial combinations have been tested.

### 34.4 Staff Management — selected-branch filtering and automatic refresh

The Staff API list now scopes staff records to the active working branch derived from the authenticated Gym Staff session.

Backend change in `src/controllers/gymStaffController.js`:

- Reads the active branch from `req.gymStaff.branchId` (verified JWT context), not from a client query parameter.
- Validates that the active branch is present in the actor's accessible branch IDs; otherwise it rejects the request.
- Adds a SQL `EXISTS` condition against `user_branch_access` so only staff assigned to the selected active branch are included.
- Retains organization scoping and the different access rules for System Gym Admin and regular staff.
- The selected branch is not accepted from an arbitrary client-supplied `branch_id` parameter as a substitute for the authenticated session.

Flutter change in `lib/features/staff/presentation/staff_management_screen.dart`:

- `StaffManagementScreen` now receives `activeBranchId` from the authenticated parent screen.
- `didUpdateWidget` detects an active-branch change, resets the page to page 1, clears the expanded staff row/card and reloads the staff list.
- The active branch property is a UI refresh trigger. The actual API branch scope is still derived by the backend from the current Gym Staff JWT.
- This resolves the stale-list behavior where the parent session changed but the existing StatefulWidget retained its previous state and only loaded staff in `initState`.

The main authenticated screen passes the current active branch from its refreshed session into Staff Management.

**User test result, 17 November 2026:** the user confirmed that switching branches while using the app works and that the Staff list updates correctly. This is a manually confirmed integration behavior for the selected-branch staff list. Continue to test separate user roles, cross-branch staff assignments and denied access paths as part of security testing.

### 34.5 Trainer Management — API and Flutter module added

Trainer profiles are implemented as organization-level profiles, separate from Gym Staff login accounts. A trainer may be assigned to more than one branch using the trainer-to-branch mapping. The active branch is automatically assigned when a new trainer is created from a branch context, according to the implemented workflow.

API files added/updated include:

```text
scripts/migrateTrainers.js
src/controllers/trainerController.js
src/routes/trainerRoutes.js
src/services/storage/localStorageProvider.js
```

The trainer routes are mounted under:

```text
/api/trainers
```

The migration was run successfully in the office database. The trainer data model includes the trainer profile and a branch-assignment relationship (`trainer_branch_access`). The precise full DDL should be re-read from the current database before any schema change; this handover does not substitute for `SHOW CREATE TABLE`.

Trainer permission keys introduced for the module:

- `trainers.view`
- `trainers.create`
- `trainers.update`
- `trainers.deactivate`
- `trainers.assign_branches`

The implemented API/UI workflow includes trainer listing and details, create, update, deactivate/reactivate, viewing assigned branches, assigning a trainer to a branch and removing a branch assignment. Backend writes use organization scoping and transaction/audit handling. Trainers are not staff login users and must not be added to `users` or `user_roles` merely to support trainer profiles.

The Gym App has a dedicated Trainer Management feature under:

```text
lib/features/trainers/
```

The authenticated app passes available branch information and active branch context to the trainer screen. Existing profile-management and branch-assignment flows were retained when photo handling was added. The user reported the Trainer module work as functioning; maintain the distinction between user-tested flows and untested edge/error cases.

### 34.6 Trainer profile-photo storage and upload workflow

The API and Flutter Trainer module now support profile-photo retrieval, upload, replacement and removal.

**API dependencies and processing**

- API packages added: `multer` (reported installed version `2.5.0`) and `sharp` (reported installed version `0.35.5`).
- Upload limit: 2 MB.
- Accepted input formats: JPEG, PNG and WebP; Sharp validates/decode-checks the actual image content rather than relying only on the submitted MIME type.
- Image processing rejects files above the configured 20-megapixel input limit, applies orientation correction, center-crops/resizes to 512 × 512 and converts the stored output to WebP at quality 82.
- Multer uses memory storage before validated image processing; uploads are not written using the untrusted original filename.

**Local file storage**

- Storage provider: `src/services/storage/localStorageProvider.js`.
- Files are placed under organization/trainer-specific relative keys, following this pattern:

```text
organizations/{organizationId}/trainers/{trainerId}/profile-{uuid}.webp
```

- The path provider validates that resolved paths remain under the configured storage root and uses generated safe filenames.
- Local API `.env` setting used on the office laptop:

```env
UPLOAD_ROOT=C:/Innovex-Gym-Data/uploads
```

- The corresponding local folder was created at `C:\Innovex-Gym-Data\uploads`.
- `.env` is local configuration and must not be committed. The storage root must exist and be writable by the API process.
- The storage helper was exercised with an image conversion, file save/read and cleanup test; the test completed successfully.

**Photo API behavior**

Mounted under `/api/trainers`:

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| GET | `/:trainerId/photo` | `trainers.view` | Return the trainer's stored photo as WebP |
| POST | `/:trainerId/photo` | `trainers.update` | Validate, process and replace/upload trainer photo |
| DELETE | `/:trainerId/photo` | `trainers.update` | Remove trainer photo |

All three endpoints also require the appropriate device and Gym Staff authentication, organization ownership and trainer access checks defined by the routes/controller. Photo responses use `image/webp` and private/no-store cache behavior.

- Upload DB changes and `TRAINER_PHOTO_UPDATED` audit write are performed in a transaction.
- Removal DB changes and `TRAINER_PHOTO_REMOVED` audit write are performed in a transaction.
- The previous stored file is deleted only after the database commit succeeds; a newly written file is cleaned up on a confirmed rollback.
- Direct JSON writes to `profile_photo_path` were removed from the normal trainer create/update allowlist so clients cannot change the storage reference without the photo endpoint.
- The controller exports for `getTrainerPhoto`, `uploadTrainerPhoto` and `removeTrainerPhoto`, and the trainer route module load were checked successfully after patching.

**Flutter photo behavior**

- Uses the existing `image_picker` and Dio packages.
- `GymApiClient` now supports authenticated byte retrieval and authenticated multipart upload; binary JSON error responses are decoded for useful API error messages.
- Trainer service methods support photo GET, multipart upload and DELETE.
- Trainer UI supports image selection, preview, uploading the selected image after the trainer save flow, display in trainer cards/details, replace and remove.
- The client enforces the same 2 MB upload ceiling before sending the photo.

**Validation recorded:** API storage conversion/read/delete test passed; API JavaScript syntax, controller export and route-load probes passed; Flutter analyzer reported `No issues found` after the Trainer photo UI integration. These checks do not replace deployment testing of file permissions, backup/restore, concurrent upload behavior or production storage durability.

### 34.7 Latest code validation and manual test checkpoint

The 17 November changes were applied with timestamped backups before patching. In particular:

- Trainer photo API patch: controller exports and route loading were checked; JSON photo-path protection was checked.
- Trainer photo Flutter service/UI integration: `flutter analyze` completed with `No issues found` after the relevant changes.
- Global branch selector and Staff refresh patch: the patch script ran the API `node --check`, Dart formatting and full `flutter analyze` steps and reached its final success message without triggering the restore-on-failure path.
- The API and app were restarted/restarted for user testing. The user explicitly confirmed that the global branch selector and Staff list refresh were working.

Do not state that a fresh full integration/automated test suite has passed. The user's confirmation applies to the branch-switch and Staff-refresh flow. Individual trainer features were reported functioning during their implementation, while production hardening and edge-case testing remain follow-ups.

### 34.8 Local changes and release hygiene

The last known change inventory from the office laptop included modifications/additions in the following areas. This is a guide to what must be reviewed, **not a substitute for running fresh `git status`**:

API:

```text
package.json
package-lock.json
src/server.js
src/controllers/gymStaffController.js
src/controllers/trainerController.js
src/routes/trainerRoutes.js
src/services/storage/localStorageProvider.js
scripts/migrateTrainers.js
```

Gym App:

```text
lib/core/services/gym_api_client.dart
lib/features/auth/presentation/gym_authenticated_screen.dart
lib/features/staff/presentation/staff_management_screen.dart
lib/features/trainers/
```

The photo-processing helper and any other associated files must also be captured by a fresh `git status`/diff review rather than relying on this summary. A temporary helper named `scripts/_verify_trainer_photo_api.js` appeared as untracked in one intermediate API status; check whether it still exists and remove it only if it is merely a verification artifact and no longer needed. Do not add temporary verification or backup files to the release.

The npm installation output reported two moderate vulnerabilities. No forced `npm audit fix` was run as part of this work. Review `npm audit` separately and assess each advisory; do not use `npm audit fix --force` or accept breaking dependency upgrades without testing.

Before release:

1. Run fresh `git status --short --branch` separately in all three repositories.
2. Inspect `git diff` and untracked file contents; verify that the trainer migration and all required source files are included.
3. Confirm `.env`, local photo files, private data, backup directories, temporary scripts, `node_modules`, build output and `.dart_tool` are not staged.
4. Run `node --check` on changed API JavaScript files, `git diff --check`, and full `flutter analyze` in the Gym App.
5. Test the photo upload/retrieve/replace/remove flows against the running API and verify audit rows and organization isolation.
6. Commit and push API and Gym App independently. Copy this updated master document into the Super Admin repository and commit/push that documentation update separately. Do not claim a release until `origin/main` has been fetched and compared with local `main` for each repository.

### 34.9 Current module status and outstanding work

| Area | Status as of 17 November 2026 | Remaining work / qualification |
|---|---|---|
| Super Admin organizations, Gym Owner provisioning and password reset | Implemented in the 11 November release | Preserve separate Platform Admin RBAC; permission middleware enforcement still needs review where noted in earlier sections |
| Device activation and startup validation | Implemented; startup validation was exercised for a deleted-device case earlier | Repeat revoked/pending/expired-code and license scenarios after a fresh hot restart; foreground-resume revalidation and public activation rate limiting remain hardening items |
| Gym Staff authentication/session | Implemented and integrated into the Gym App | Continue endpoint-level tests for locked/inactive users, expired JWTs and unauthorized requests |
| Global active-branch selector | Implemented in top bar; user manually confirmed working | Test additional staff roles and permission-denial cases |
| Staff selected-branch list filter/refresh | Implemented in API and Flutter; user manually confirmed working | Test users assigned to multiple branches, regular-staff visibility rules and cross-organization denial |
| Gym Branch Management | API/service/screen exist | Verify create/update/status, permissions and transactional audit coverage per endpoint |
| Device Management / branch transfer | Implemented and manual transfer was reported working | Continue permissions, transfer-history and audit edge-case tests |
| Gym Role & Permission API | API/controller/routes and permission-scope migration exist | Flutter Role & Permission management screen remains pending; test all role CRUD/assignment rules and audits |
| Staff Management | Screen/service/API integration exists; active-branch refresh now tested | Test create/edit/deactivate, role assignment, branch assignments and denied operations comprehensively |
| Membership Plans | API, migration and Flutter screen/service exist | Verify ongoing-member interactions and full plan lifecycle; this is not the same as membership enrolment/payment processing |
| Fitness Programs | API, migration and Flutter screen/service exist | Verify all CRUD/enrollment/progress rules with real API/database tests; do not assume every program workflow is complete |
| Trainer Management | API, migration and Flutter UI added; permissions and branch mapping included | Continue authorization, validation, multi-branch and audit tests; profile photo storage is currently local filesystem based |
| Trainer photo upload | API/Flutter flow implemented; conversion/storage and static checks passed | Test full authenticated upload/retrieve/replace/remove in deployment-like environment; establish durable backups/shared storage before multi-instance production |
| Members and fitness progress | Not confirmed implemented | Build member CRUD, profile images, historical measurements and progress photos |
| Attendance | Not confirmed implemented | Keep members organization-wide; record the branch actually attended, separate from member home branch |
| Membership enrolment, billing and payments | Not confirmed implemented | Define lifecycle, renewals, freezes/cancellations, approvals, receipts, balances, refunds and reconciliation |
| Services and reports | Not confirmed implemented | Continue after membership/payment rules are finalized |
| Operational audit coverage | Audit infrastructure/modules exist; Trainer writes include photo audit events | Verify audit coverage/authorization for every meaningful Gym Staff operation |

### 34.10 Next continuation sequence

1. **Preserve and release this checkpoint safely.** Review all local changes in API and Gym App; inspect any temporary verification file and backup artifacts; run full validation; then commit/push each repository separately only after the user approves the release.
2. **Finish Role & Permission Management UI.** Inspect the actual `gymRoleRoutes.js` and `gymRoleController.js` API contract, build the Flutter UI using only Gym-scoped permissions, protect the System Gym Admin role and test `roles.view/create/update/delete/assign` with allowed and denied users.
3. **Complete Staff Management security tests.** Test staff creation/edit/deactivation, role assignment, multi-branch access, branch switching and selected-branch visibility using Gym Admin and regular staff accounts.
4. **Complete Trainer module integration tests.** Test create/edit/deactivate/reactivate, branch assignment/removal, profile image selection/upload/retrieve/replace/remove, permission denial, cross-organization access denial, audit persistence and behavior when the local upload volume is unavailable.
5. **Harden image storage for production.** Ensure the upload root is persistent, backed up and access-restricted. If the API is deployed to multiple instances or separate hosting nodes, plan shared/object storage rather than relying on one machine's local filesystem. Keep the upload directory outside the public web root and serve photos only through authenticated API checks.
6. Continue Member Management, member fitness progress, Attendance, Membership Enrolment/Payments, Services and reports in the dependency order agreed in earlier sections.

### 34.11 Instructions for future ChatGPT continuation

- Treat Section 34 as the latest authoritative checkpoint as of 17 November 2026. The 14 November GitHub commit hashes in Section 33.2 are historical remote references, not proof that the current local Trainer/branch-selector changes have been pushed.
- Use the office-laptop project paths in Section 34.1. Do not assume the home laptop contains the latest local work.
- The global active-branch selector and selected-branch Staff refresh were manually confirmed by the user. Do not repeat this implementation unless a new defect is reported.
- Always preserve the difference between device registration branch and Gym Staff active working branch. Branch switching updates the Gym Staff session JWT, not the device registration.
- The Staff list API must continue deriving the active branch from the verified Gym Staff JWT. Do not add a client-controlled branch parameter as a security substitute.
- Trainers are organization-level profiles with branch mappings, not Gym Staff login accounts.
- Trainer photo files are stored on the office API host under `UPLOAD_ROOT`; the `.env` file and actual uploaded images are local-only and must not be committed.
- Continue separating implementation, syntax validation, analyzer validation, user-reported manual testing and production readiness. Do not label an entire module production-ready because a single flow passed.

---

**End of current authoritative master handover document (17 November 2026).**

---

## 35. Office-Laptop Checkpoint — GitHub Release and Member Search/Registration API (18 November 2026)

This section is the latest authoritative continuation checkpoint as of 18 November 2026. It supersedes the unreleased/local-only Git status statements in Sections 34.1, 34.8 and 34.11. Older sections remain as historical records unless they conflict with this section. The office laptop remains the active development workstation. The user confirmed that no work or modification was made on the home laptop; no home-laptop synchronization is needed for this checkpoint.

### 35.1 Active office environment and repositories

Continue on the office Windows laptop. The project root is:

```text
C:\Users\Pradeep\Documents\INNOVEX WEB\Flutter Projects
```

Project folders:

```text
gym_management_api\
gym_management_app\
gym_management_super_admin\
```

The three repositories remain independent and must be committed/pushed separately:

| Project | GitHub remote | Latest confirmed office commit on 18 November |
|---|---|---|
| API | `https://github.com/arafath65/gym-management-api.git` | `cb9f3c2` — `Add trainer and member management APIs` |
| Gym App | `https://github.com/arafath65/gym-management-apps.git` | `3234be1` — `Add trainer management and branch-aware staff UI` |
| Super Admin | `https://github.com/arafath65/gym-management-super-admin.git` | No new source commit in this checkpoint; next action is to commit the updated master handover document there |

The user ran the commit and push commands separately for the API and Gym App. Both pushes to `origin/main` completed successfully. The subsequent `git status` output for each repository reported:

```text
On branch main
Your branch is up to date with 'origin/main'.
nothing to commit, working tree clean
```

The API release commit reported 14 files changed, 5,385 insertions and 4 deletions. The Gym App release commit reported 5 files changed, 2,723 insertions and 61 deletions. These are Git change statistics, not counts of completed or integration-tested features.

**API commit contents reported by Git:**

```text
package.json
package-lock.json
scripts/migrateMembers.js
scripts/migrateTrainers.js
src/controllers/gymStaffController.js
src/controllers/memberController.js
src/controllers/memberSearchController.js
src/controllers/trainerController.js
src/routes/memberRoutes.js
src/routes/trainerRoutes.js
src/server.js
src/services/memberIdentityService.js
src/services/storage/localStorageProvider.js
src/services/storage/trainerPhotoProcessor.js
```

**Gym App commit contents reported by Git:**

```text
lib/core/services/gym_api_client.dart
lib/features/auth/presentation/gym_authenticated_screen.dart
lib/features/staff/presentation/staff_management_screen.dart
lib/features/trainers/data/trainer_service.dart
lib/features/trainers/presentation/trainer_management_screen.dart
```

Before a later release, re-run fresh status/fetch checks. Do not assume the working trees remain clean after new development.

### 35.2 Member database migration — completed

The member migration was run successfully on the office database on 17 November 2026 using `scripts/migrateMembers.js`.

Tables created or verified:

- `members`
- `member_fitness_progress`
- `member_progress_photos`

The migration also registered/updated 10 Gym Staff permission keys and synchronized the system Gym Admin roles. The reported output was:

- `permissionsCreatedOrUpdated: 10`
- `gymAdminRolesVerified: 3`
- `organizationsProcessed: 3`
- `customRolesModified: false`

Permission keys:

| Permission | Purpose |
|---|---|
| `members.view` | Search/view member records |
| `members.create` | Register members |
| `members.update` | Update member profile |
| `members.deactivate` | Deactivate member |
| `member_fitness.view` | View fitness progress |
| `member_fitness.create` | Record fitness progress |
| `member_fitness.update` | Update fitness progress |
| `member_fitness.delete` | Delete fitness progress, subject to the agreed audit/business rules |
| `member_fitness.photos.view` | View progress photos |
| `member_fitness.photos.manage` | Manage progress photos |

The migration output reported permission IDs 38–47 in the order above. Do not rely on these numeric IDs in application code; use the stable permission keys.

The `members` table stores NIC material in encrypted/index fields only (`nic_ciphertext`, `nic_iv`, `nic_auth_tag`, `nic_lookup_hash`, `nic_last4`) and has no plaintext NIC column. Its NIC encryption fields are constrained so that they are either all null or all populated. It stores `registration_branch_id` separately from optional `preferred_branch_id`, and stores a member-level admission-fee state. The organization-scoped unique keys cover `member_code` and `nic_lookup_hash`.

`member_fitness_progress` stores dated measurement history; measurements are optional and include height, weight, BMI, arms, waist, thigh, chest, hips and calves. `member_progress_photos` associates at most one photo of each fixed type (`front`, `side`, `back`) with a progress record, with a composite relationship to prevent cross-member progress-photo association. The tables exist, but the progress API, photo upload flow and Flutter screens are not yet confirmed implemented.

Permission backup tables created by the migration:

```text
permissions_backup_members_20261117112727_20960_0704
role_permissions_backup_members_20261117112727_20960_0704
```

These are rollback/audit artifacts in the database. Do not delete them without an explicit database backup/retention decision.

### 35.3 Member NIC identity service — implemented and statically verified

Source file:

```text
src/services/memberIdentityService.js
```

The service currently provides:

- Format recognition for old Sri Lankan NIC format (9 digits plus `V`/`X`) and new NIC format (12 digits).
- Birth-date and gender decoding based on the NIC date-of-year portion.
- Multiple candidate birth dates for ambiguous old-NIC centuries; registration requires an explicit user-confirmed date rather than silently selecting a century.
- Sri Lankan phone number normalization, including conversion of a local `0...` number into the `94...` form used for normalized lookup.
- AES-256-GCM NIC encryption with a random 12-byte IV and 16-byte authentication tag.
- HMAC-SHA256 for exact NIC lookup, using a separate secret from the encryption key.
- NIC last-four storage for masked display.

The two required local environment variables are:

```env
MEMBER_NIC_ENCRYPTION_KEY=<64 hexadecimal characters representing 32 random bytes>
MEMBER_NIC_LOOKUP_SECRET=<64 hexadecimal characters representing 32 random bytes>
```

Both are stored in the office API `.env`, which is Git-ignored. The user verified that `.env` is not tracked by Git. Never commit, paste, print, or regenerate these secrets after NIC data is stored. A replacement key would make existing encrypted NIC values unreadable and existing HMAC lookup values unmatched. A future key-rotation design must re-encrypt/re-HMAC existing records under a controlled migration before replacing active keys.

NIC format validation is not a proof of identity and does not independently verify a person. Do not treat a decoded DOB/gender as authoritative until the member confirms the details. The current implementation checks supported shapes and date-of-year validity; do not claim a separate government identity verification or NIC checksum service.

### 35.4 Member Search API — installed and route-protected

Source files:

```text
src/controllers/memberSearchController.js
src/routes/memberRoutes.js
```

Mounted route:

```http
GET /api/members/search?q=<search-text>
```

Middleware order:

1. `authenticateDevice`
2. `authenticateGymStaff`
3. `requireGymPermission('members.view')`

Search behavior:

- Partial full-name search.
- Partial normalized primary/secondary phone search.
- Exact full-NIC match using the HMAC lookup hash; partial NIC fragment search is intentionally not implemented.
- Organization scope comes from the verified `req.gymStaff.organizationId` session, not a client-supplied organization ID.
- Returns up to five matches, including inactive/blocked records for duplicate prevention and rejoining workflows.
- Returns masked NIC/phone fields rather than ciphertext, HMAC or plaintext NIC.
- Search requests do not write the raw search query or NIC into audit descriptions.

### 35.5 Member Registration API — code installed; live creation still pending

Source file:

```text
src/controllers/memberController.js
```

Route:

```http
POST /api/members
```

The route uses the same device/Gym Staff authentication sequence and requires `members.create`.

Implemented request validation/registration behavior includes:

- Full name is required; NIC is currently optional at the API level.
- Optional contact, email, address/city, emergency contact, preferred branch, registration source and referral fields are validated.
- NIC is validated, decoded and encrypted before being written; no plaintext NIC is stored.
- Existing NIC HMAC values are checked within the authenticated organization before insertion; the database unique key is the final duplicate-race protection.
- The organization ID and creator user ID come from the verified Gym Staff session.
- `registration_branch_id` comes only from the active branch in the authenticated Gym Staff session. It is never accepted from the client body.
- Optional `preferred_branch_id` must be in the staff actor's accessible branch list and is rechecked against an active branch in the same organization.
- Member codes are generated in the format `MBR-000001` using organization-row locking and a transaction.
- Member creation and `MEMBER_REGISTERED` audit insertion share the same database transaction.
- Audit details include safe metadata such as member code, status, branch, admission-fee details, NIC type and last four only; the plaintext NIC and encrypted bytes are not written to the audit description.
- Member status is initially `active`.
- Admission fee status is `pending` when a positive fee is entered, `waived` when explicitly waived, and `not_charged` for a zero fee. The registration endpoint does not mark a fee as paid; actual payment must be recorded by a future payment workflow.
- The registration response masks NIC and contact phone values.

Date-of-birth behavior:

- If the NIC produces one valid candidate date and no manual DOB is entered, that date is used with source `nic_decoded`.
- If an old NIC has multiple possible centuries, the API returns `MEMBER_DOB_CENTURY_CONFIRMATION_REQUIRED` with the candidate dates; the client must send the selected DOB and `date_of_birth_confirmed: true`.
- A manually supplied DOB that differs from the decoded NIC DOB requires explicit confirmation; it is stored with source `manual`.
- This decoding process is not an identity-verification service.

**Validation completed so far:**

- JavaScript syntax checks passed for the identity service, member search controller, member registration controller, member routes and `server.js`.
- Module load checks passed for both controllers and the route module.
- Old/new NIC shape checks, sample DOB decode checks, ambiguous-century handling, phone normalization, AES-256-GCM encrypt/decrypt and HMAC output checks passed.
- Database verification found the `members` table and `members.create` Gym permission.
- `GET /api/health` was run against the office API and returned `success: true`, API connected and database connected.
- An unauthenticated request to `GET /api/members/search?q=test` returned HTTP 401 as expected, confirming the route is protected by authentication middleware.

**Not yet verified:** no authenticated POST registration request has been run against the live API. Duplicate-NIC behavior, member-code generation under concurrent requests, active/preferred branch enforcement, audit insertion, and returned member profile must be tested with an authenticated session before declaring the registration workflow operational. No live member has been registered as part of this checkpoint.

### 35.6 API and Gym App release contents — pushed to GitHub

The user staged only the reviewed source paths in each repository. No `.env` files were staged.

API commit:

```text
cb9f3c2 Add trainer and member management APIs
```

Remote update:

```text
97467a2..cb9f3c2  main -> main
```

Gym App commit:

```text
3234be1 Add trainer management and branch-aware staff UI
```

Remote update:

```text
2b85743..3234be1  main -> main
```

After both pushes, the user ran `git status` in both repositories. Both reported `main`, up to date with `origin/main`, and a clean working tree. No new Gym App Member UI was included in this push; the Member Search/Registration backend code is in the API repository only.

### 35.7 Current next steps — resume development on the office laptop

1. **Keep the office laptop as the source of truth.** Do not request home-laptop pull/sync or ask the user to modify the home laptop; the user explicitly said no home work was performed and they have returned to the office.
2. **Run an authenticated Member Registration integration test** using the existing Flutter Gym Staff session/device token or an existing authorized API test method. Use a clearly synthetic NIC for test data; do not ask the user to paste a real NIC into chat. Confirm the POST response, member row, masked response and transactionally committed audit record.
3. **Test duplicate prevention** by submitting the same synthetic NIC twice in the same organization. Confirm the second request returns HTTP 409 with `MEMBER_NIC_ALREADY_REGISTERED` or the database duplicate conflict code and creates no second member/audit row.
4. **Test organization isolation and branch context.** Try an accessible preferred branch, an inaccessible branch and an inactive branch where test data is available. Confirm registration always uses the active session branch, never a client-provided registration branch.
5. **Review API edge cases before production use.** In particular validate input normalization, old-NIC date candidates, invalid day-of-year values, no-NIC policy, and transaction/audit rollback when audit insertion fails. NIC values must never appear in logs or error output.
6. **Build Flutter Member Search and Registration UI** after the authenticated API tests. The intended reception workflow is search existing member by name/mobile/exact NIC, display at most five masked results including inactive records, open an existing profile when found, and only offer new registration when no existing record is selected.
7. Continue member profile updates/status, profile photo, fitness progress history and progress photos. Enrolment, admission-fee payment, membership/program subscription, invoices, payments, receipts, QR card and WhatsApp sharing remain separate later workflows.

### 35.8 Updated handover and GitHub documentation status

This file is the updated master handover dated 18 November 2026. The API and Gym App repositories have already received their code commits listed in Section 35.6. The updated `.md` itself still needs to be copied into the office `gym_management_super_admin` repository, staged as a documentation-only change, committed and pushed to `origin/main` after inspecting the current Super Admin repository status and existing master-document filename. Do not mix unrelated Super Admin source changes into this documentation commit, and do not use `git add .`.

---

**End of current authoritative master handover document (18 November 2026).**

---

## 36. Office GitHub Checkpoint — Member Fitness API and Member Management Flutter Source Push (18 November 2026)

This is the latest authoritative continuation checkpoint after the user confirmed that the API and Gym App push operations both completed successfully from the office laptop on 18 November 2026. It supersedes the earlier “not yet pushed” wording in Sections 34 and 35 for the member-related files listed below. The office laptop was the source workstation. The user was leaving the office after the pushes; no home-laptop sync or home-laptop changes were part of this checkpoint. Sections 1–35 remain as historical records except where this section explicitly updates their implementation or release status.

### 36.1 Repositories and release status

The two project repositories pushed in this checkpoint are:

| Project | Office folder | GitHub remote | Push result |
|---|---|---|---|
| Gym Management API | `gym_management_api` | `https://github.com/arafath65/gym-management-api.git` | User confirmed push completed successfully |
| Gym Management App | `gym_management_app` | `https://github.com/arafath65/gym-management-apps.git` | User confirmed push completed successfully |

The Super Admin repository was not part of these two source pushes. It is the target repository for the documentation-only commit containing this updated master file.

The exact new commit hashes and post-push `git status` output for the two repositories were not included in the user's confirmation. Do not invent commit hashes or claim a particular clean-tree result. On the next office session, obtain the actual values with `git log -1 --oneline` and `git status -sb` in each repository. The previous confirmed commits remain useful historical references, but they are not necessarily the HEAD commit after this checkpoint:

- API previous checkpoint: `cb9f3c2` — `Add trainer and member management APIs`.
- Gym App previous checkpoint: `3234be1` — `Add trainer management and branch-aware staff UI`.

### 36.2 API files included in the member-related push

The release script staged the following reviewed paths in `gym_management_api`:

```text
src/controllers/memberController.js
src/routes/memberRoutes.js
src/services/memberIdentityService.js
scripts/migrateMemberRegistrationSources.js
src/controllers/memberFitnessController.js
src/controllers/memberListController.js
src/controllers/memberProfileController.js
src/routes/memberFitnessRoutes.js
src/services/storage/memberPhotoProcessor.js
src/services/storage/memberPhotoStorage.js
src/services/storage/memberProgressPhotoProcessor.js
src/services/storage/memberProgressPhotoStorage.js
```

These files cover the member registration/search foundation already described in Section 35, member profile/list endpoints, member fitness history and progress-photo handling, and the associated storage/processing helpers. The migration script was included in the source push; this section does not assert that this particular migration script was executed unless a later database run is recorded.

No `.env` file or NIC encryption/HMAC secret was included in the approved staged path list. Continue to keep `.env`, NIC secrets, plaintext NIC values, device activation codes/tokens, local uploaded images, backups and temporary verification files out of Git.

### 36.3 Gym App files included in the member-related push

The release script staged the following existing app configuration/entry files and the Dart sources under the new members feature:

```text
lib/features/auth/presentation/gym_authenticated_screen.dart
pubspec.yaml
pubspec.lock
lib/features/members/**/*.dart
```

The members feature source directory was checked for Dart files before staging. The main authenticated Gym screen was updated to expose the Member Management section subject to the existing permission check. The member feature source includes the existing member-management/search/registration UI work. The push did not complete the Member Detail screen integration described in Section 36.7 below.

### 36.4 Member Fitness API — implemented; local static verification passed

The API Fitness module now includes authenticated endpoints under:

```http
/api/members/:memberId/fitness
```

The nested route is mounted from the member routes and inherits device and Gym Staff authentication. The route permission keys are:

| Operation | Permission |
|---|---|
| List/get a member's fitness assessments | `member_fitness.view` |
| Create an assessment | `member_fitness.create` |
| Update an assessment | `member_fitness.update` |
| Delete an assessment | `member_fitness.delete` |
| View progress-photo status/retrieve photos | `member_fitness.photos.view` |
| Upload/replace/delete progress photos | `member_fitness.photos.manage` |

Assessment measurements supported by the controller:

- `height_cm`
- `weight_kg`
- `bmi` (calculated from height and weight)
- `arms_cm`
- `waist_cm`
- `thigh_cm`
- `chest_cm`
- `hips_cm`
- `calves_cm`
- Assessment date and notes

Progress photos use the fixed types `front`, `side` and `back`. The current upload path accepts images up to 8 MB and processes them to WebP without intentionally cropping away body/measurement context. Create/update/delete mutations are designed to write operational audit events in the same database transaction as the corresponding mutation.

**Cross-branch Fitness fix included before the push:** `ensureMember()` now scopes member lookup by authenticated organization plus member ID, not `registration_branch_id`. `ensureAssessment()` scopes the assessment by authenticated organization, member ID and assessment ID, not the member's registration branch. The active Gym Staff branch remains the branch recorded for new fitness assessments and associated audit entries. This allows authorized staff at another branch in the same organization to view/manage the member's fitness history without changing the member's original registration branch. Organization isolation remains mandatory.

Static checks recorded as passed for the Fitness API patch include JavaScript syntax checking, controller/router module-load checks and `git diff --check`. No claim is made here that all authenticated live HTTP paths, database transaction edge cases or photo delivery have passed end-to-end testing.

Local patch backups created during this work:

```text
C:\Users\Pradeep\AppData\Local\Temp\gym-member-fitness-api-20261118-152043
C:\Users\Pradeep\AppData\Local\Temp\gym-member-fitness-branch-fix-20261118-161336
```

These are local recovery copies, not source assets to commit.

### 36.5 Member profile and photo API — implemented, cross-branch correction still required

The member profile controller and photo storage/processing files were included in the API push. The user confirmed the Member Profile with image feature as implemented. The existing profile service/UI also has member photo retrieval and upload support.

A source review identified a remaining authorization/scope inconsistency that must be corrected before treating profile operations as organization-wide:

1. `getMemberRow()` in `src/controllers/memberProfileController.js` still filters by `organization_id`, `registration_branch_id` and member ID. Member read/update/deactivate operations that use this helper therefore still restrict the member to their registration branch.
2. The profile-photo update query also filters by `registration_branch_id`. This prevents a staff member at another branch in the same organization from managing the member's profile photo.
3. The member detail `GET /:memberId` route in `src/routes/memberRoutes.js` was observed to require `members.update`. It should require `members.view`; changing a profile must continue to require `members.update`.
4. The profile-not-found response still refers to the “active branch” and should be changed to a generic organization-scoped member-not-found message when the branch restriction is removed.

These corrections were identified but were **not confirmed applied** in this checkpoint. Preserve the following rules when implementing them:

- Member record ownership is organization-wide.
- `registration_branch_id` is informational and must not restrict access by other authorized branches within the same organization.
- The organization ID and actor/user ID must come from the verified Gym Staff session, never from the request body.
- Any branch field recorded for an action/audit event must represent the current active branch from the authenticated Gym Staff session.
- Cross-organization member access must remain impossible.

### 36.6 Existing Flutter Member Management integration points

The following source contracts were inspected before this checkpoint:

- `lib/features/members/data/member_service.dart` already provides member search/list/create/get/update/deactivate/reactivate and profile-photo retrieval/upload methods.
- `lib/core/services/gym_api_client.dart` already provides authenticated `get`, `post`, `patch`, `delete`, `getBytes` and multipart upload methods. These must be reused rather than creating another unauthenticated Dio client.
- `MemberManagementScreen` already accepts `canView`, `canCreate`, `canUpdate`, `canDeactivate`, `organizationId`, `activeBranchId` and `activeBranchName`.
- The current member search selection flow sets `_selectedMember`; the selected-member card still contains a placeholder message saying the detailed profile/rejoining workflow will be added in a later stage. Replace that placeholder with a permission-aware “View Profile” action/navigation without removing the existing registration/edit dialog workflow.
- The authenticated Gym screen already opens Member Management under the `members.view` permission check.

Do not silently change branch filtering of the general Member list without reviewing its intended query contract. The cross-branch profile/fitness rule is mandatory for a member record belonging to the organization; branch-specific lists may still use deliberate filter behavior if the UI clearly explains it.

### 36.7 Member Detail screen — agreed design, integration pending

The user specified a Member Detail screen with four tabs:

1. **Overview** — member profile information and profile image.
2. **Fitness** — fitness assessment history, measurements, BMI, front/side/back progress photos and comparison with the previous assessment.
3. **Membership** — placeholder tab for future subscription/membership integration.
4. **Programs** — placeholder tab for future program enrollment integration.

The profile view and fitness data should be loaded through the existing authenticated service/API layer. Photo retrieval must use the authenticated byte-response method and must not expose filesystem paths or public unauthenticated image URLs. The Fitness tab must respect `member_fitness.view`, and photo controls must additionally respect `member_fitness.photos.view` / `member_fitness.photos.manage`. Create/update/delete controls must separately respect the corresponding Fitness permission. The Membership and Programs tabs should be clearly marked as coming later; do not create fake subscription/enrollment records or imply those workflows exist.

The Member Detail screen, tab navigation, previous-assessment comparison UI, and integration from the selected-member search result were **not yet implemented or verified** in this checkpoint. The user had not run the subsequent read-only PowerShell inspection step that was supplied immediately before leaving the office; the earlier source review is sufficient to retain the known integration points above, so do not ask the user to repeat that inspection before resuming.

### 36.8 Required next steps

Resume from the office laptop with fresh repository status checks before editing. The priorities are:

1. **Fix member profile cross-branch authorization/scope** in `memberProfileController.js`: remove registration-branch filters from the common member lookup and profile-photo update query while retaining organization/member ID checks and active-branch audit context.
2. **Correct the member detail GET permission** in `memberRoutes.js` from `members.update` to `members.view`; keep mutation routes under their update/deactivate permissions.
3. Add/verify authenticated live API tests for profile retrieval, edit, photo retrieval/upload/replace, Fitness list/assessment CRUD, front/side/back photo retrieval/upload/replace/delete, permission denial and cross-organization denial. Use synthetic test members/data; never paste a real NIC or secrets into chat.
4. Complete the Flutter Member Detail screen with the four agreed tabs, connect it to the existing member service/API client, and wire the selected-member “View Profile” action. Preserve existing member registration and editing.
5. Implement Fitness assessment history, measurement/BMI display, front/side/back photo viewer/upload controls, and comparison against the previous assessment. Clearly handle the first assessment, absent measurements and missing photos.
6. Run `node --check` for all changed API files, route/module load checks, `git diff --check`, `flutter analyze` for the Gym App, and authenticated integration tests. Record only checks actually run and their results.
7. Commit/push the next API and Gym App changes separately after reviewing exact staged paths. Do not use `git add .` and do not amend or force-push the completed 18 November release.

### 36.9 Documentation release status

This Section 36 is the latest member-management continuation record. The API and Gym App source changes described above were confirmed by the user as pushed. This master `.md` document itself still needs a separate documentation-only commit in the `gym_management_super_admin` repository. Before committing:

- Check the Super Admin working tree and fetch `origin/main`.
- Identify the existing canonical master-document filename in the repository root rather than overwriting an unknown file.
- Copy this updated document into that canonical location (or use a clearly versioned new filename if no canonical master exists).
- Stage only the selected `.md` file, inspect `git diff --cached --stat` and `git diff --cached --name-only`, then commit and push to `origin/main`.
- Do not include unrelated Super Admin source changes in the documentation commit. Do not use `git add .`.

---

## 37. Current Authoritative Checkpoint — Billing Ledger and Standalone Payments Module (20 November 2026)

This is the newest continuation checkpoint. It supplements and supersedes earlier status statements only where they conflict with the facts below. Sections 1–36 remain as historical design, implementation and debugging records. Do not delete or silently rewrite historical checkpoints. The user asked for the Payments & Collections experience to be completed in the next work stage; the redesign requirements in this section are approved product requirements, not yet implemented features.

### 37.1 Active working paths and runtime evidence

The user’s PowerShell prompt during this continuation explicitly showed the Gym App working directory:

```text
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_app
```

The corresponding API project path used for this project is:

```text
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_api
```

Do not substitute the older office-laptop `C:\Users\Pradeep\Documents\...` paths from Sections 31–36 when giving commands for this continuation. The current prompt is the best evidence of the active path. The Super Admin project path and current Git branch/commit state were not reconfirmed in this 20 November session.

Flutter version previously confirmed for the Gym App: Flutter 3.47.7 stable. The user resolved the earlier Gradle dependency DNS issue. A subsequent `flutter run` built `app-debug.apk`, installed it and synchronized to the Pixel Tablet emulator. This confirms that the app could build/install at that checkpoint; it does not replace a fresh `flutter analyze` or verification after the latest Payments changes.

### 37.2 Membership billing ledger — implementation foundation

The API billing foundation has been implemented for membership invoices, payments, refunds and waivers. The following endpoint shapes were recorded from the implementation work:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/members/:memberId/memberships/:membershipId/invoices` | List invoices for the selected member membership |
| POST | `/api/members/:memberId/memberships/:membershipId/invoices` | Create an invoice using the membership’s saved price snapshot; request fields are `due_date` and `notes` (optional) |
| POST | `/api/members/:memberId/memberships/:membershipId/invoices/:invoiceId/payments` | Receive a payment |
| POST | `/api/members/:memberId/memberships/:membershipId/invoices/:invoiceId/refunds` | Record a refund |
| POST | `/api/members/:memberId/memberships/:membershipId/invoices/:invoiceId/waivers` | Record an eligible invoice waiver |

Recorded request payload contracts:

- Payment: `{ amount, payment_method, payment_reference?, notes?, idempotency_key }`.
- Refund: `{ refund_amount, refund_method, refund_reference?, reason, notes?, idempotency_key }`.
- Waiver: `{ waiver_amount, reason, notes?, idempotency_key }`.
- Invoice creation does not accept a client-calculated total; the invoice amount comes from the membership price snapshot.
- Idempotency keys are UUIDs.
- The authenticated staff/device context supplies organization, actor and active-branch identity. Do not accept client-supplied organization/user/branch identity as authoritative.

Payment methods recorded in the implementation include `cash`, `card`, `bank_transfer`, `cheque`, `mobile_wallet`, `online` and `other`. Refund methods include `original_method`, `cash`, `bank_transfer` and `other`.

Ledger/business rules already established:

- Financial actions are separate invoice/payment/refund/waiver records; do not rewrite historical posted ledger entries to make a balance look correct.
- `posted` records affect balances. A `voided` transaction reverses its financial effect while preserving the history.
- Net paid is posted payments less posted refunds. Posted waivers reduce the remaining amount due.
- Invoice totals come from the membership price snapshot, not the current membership-plan price. A later plan price change must not rewrite historical invoice/member pricing.
- An unpaid invoice does not automatically suspend a membership.
- Invoice-period generation respects the membership’s next billing date and suspensions.
- A waiver is only allowed for an eligible overdue/unpaid residual invoice and requires a reason. It must not change membership start/end dates.
- Do not send arbitrary `organization_id`, `user_id`, `created_by`, or `branch_id` from the Flutter app. The API must derive identity from authenticated middleware and use the active staff branch for transaction/audit context.

The backend foundation should not be described as fully production-verified end-to-end until the outstanding route/permission/transaction scenarios have been tested against the current source and schema. Do not create extra transactions just to test the UI; the existing financial fixture below should be preserved.

### 37.3 Existing financial test fixture — preserve without mutation

The following known database fixture was used when checking billing calculations:

| Record | Known value |
|---|---|
| Organization | `3` |
| Member | `2` |
| Membership | `2` |
| Invoice | `1` — `INV-2026-000001` |
| Invoice total | LKR 3,800 |
| Posted payment | LKR 1,000 |
| Posted refund | LKR 100 |
| Earlier refund | LKR 400 — `voided` |
| Net paid | LKR 900 |
| Outstanding | LKR 2,900 |

**Do not void, delete, edit or otherwise mutate these records unless the user explicitly requests it.** The voided LKR 400 refund remains part of the audit/history and must not be counted as an active refund. This fixture is sufficient for read-only arithmetic verification of the net-paid/outstanding calculation; do not manufacture a second payment or refund as a screen test.

### 37.4 Membership Plan API route contract currently supplied

On 20 November the user supplied the current `src/routes/membershipPlanRoutes.js` contents. The route file:

- Applies `authenticateDevice` and `authenticateGymStaff` with `router.use(...)` before every membership-plan endpoint.
- `GET /` and `GET /:planId` require `membership_plans.view`.
- `POST /` requires `membership_plans.create`.
- `PATCH /:planId` requires `membership_plans.update`.
- `POST /:planId/deactivate` requires `membership_plans.deactivate`.
- `POST /:planId/reactivate` requires `membership_plans.update`.
- Exports the Express router.

This is the existing membership-plan CRUD route contract. The supplied router does **not** expose a plan-based collection report or aggregate financial summary endpoint. The exact membership-plan controller SQL, invoice/payment/refund/waiver table DDL and current membership status enum must be inspected before adding aggregate queries; do not invent column names or infer a response shape from the route file alone.

When a static one-segment route such as `/collections` is added to this router, place it before `/:planId`; otherwise Express can interpret the word `collections` as the `planId` for the existing single-segment route. The new collection route must have a dedicated financial permission check and organization scoping, not merely rely on the Flutter UI hiding controls.

### 37.5 Current Flutter Payments navigation and screen state

The following current Gym App files/modules were observed in the user’s terminal diagnostics and prior source inspection:

```text
lib/features/payments/presentation/payments_screen.dart
lib/features/members/presentation/member_membership_billing_screen.dart
lib/features/members/presentation/member_membership_screen.dart
lib/features/members/data/member_membership_service.dart
lib/features/auth/presentation/gym_authenticated_screen.dart
```

Current implementation facts:

- `gym_authenticated_screen.dart` contains a Dashboard sidebar item and Quick Access item with section ID `payments`, conditionally exposed through `_canAccessPayments`.
- `_buildModulePage()` returns `PaymentsScreen` when `_selectedSection == 'payments'` and passes member, membership and billing permission flags.
- The standalone `PaymentsScreen` exists, is connected to the Dashboard route and was visibly rendered on the Pixel Tablet screenshot after the layout troubleshooting. The screenshot showed the “PAYMENTS & COLLECTIONS” heading, a member search field and an instruction message. The remaining large unused area is a UI problem, not proof that the route is missing.
- `PaymentsScreen` uses the existing `MemberMembershipService.searchMembers(query)` and `listMemberships(memberId, page: 1, pageSize: 100)` methods. The existing search method rejects queries shorter than two characters and is called by the search button or keyboard submit; it does not yet automatically query as each character is typed.
- Selecting a member loads that member’s memberships. Selecting a membership opens `MemberMembershipBillingScreen` for invoice/payment/refund/waiver operations.
- The current standalone screen is a first integration screen, not the approved final Payments & Collections dashboard described in Section 37.6.
- The most recent source diagnostic of the Membership screen showed a `MemberMembershipBillingScreen` import and a “Billing & Payments” button inside membership cards. A patch was provided to remove this embedded billing entry, but no later source excerpt confirmed that the deletion was applied. Reinspect the current file before claiming the Membership screen is billing-free. The intended boundary is: Membership manages membership assignment/update/cancel/renew; all invoice/payment/refund/waiver work lives under the Dashboard Payments item.

### 37.6 Approved Payments & Collections screen requirements — implementation pending

The user supplied a screenshot of the running Payments screen and requested a more useful layout with less empty space. The following requirements were explicitly approved on 20 November:

#### A. Compact financial summary cards

Place four compact cards at the top of the Payments page, above the member search field:

1. Active memberships.
2. Total billed.
3. Total collected.
4. Outstanding balance.

The cards should be small and information-dense, not large dashboard panels. Currency display is LKR for this product. Summary values must be returned by a secure server-side aggregate and calculated from the actual invoice/payment/refund/waiver ledger, not from multiplying plan price by member count or treating every membership fee as paid.

#### B. Automatic member type-ahead search

- Keep a member search field for name, member code or phone.
- Search automatically as the user types, using a short debounce to avoid one API request per keystroke.
- Retain the existing two-character minimum unless the API contract is deliberately changed.
- Show matching member results without requiring the user to press the search icon or submit from the keyboard.
- After a member is selected, load that member’s membership list.
- In this Payments member-selection flow, do not show memberships whose status is `cancelled` or `suspended`. Preserve the exact status rules from the API/database; do not add other exclusions such as `expired` or `scheduled` without confirming their intended behavior from the schema and business rules.

#### C. Membership-plan collection selector and paginated member list

Add one prominent membership-plan combo/dropdown to the main Payments page. Load plans through the existing Membership Plan API. When the user selects a plan, load all members in the authenticated organization who are currently using that selected plan.

Show the plan collection results as a compact paginated list/table, not oversized cards. Each member row must include:

- Member name and member code.
- Membership plan and configured billing interval (monthly, yearly, daily or the actual interval configured for the plan; do not hard-code only monthly/yearly).
- The member’s saved membership fee/price snapshot.
- Total invoiced/billed.
- Net paid (posted payments minus posted refunds).
- Outstanding balance after posted payments, posted refunds and posted waivers.
- Relevant due date: show the due date from the outstanding invoice. If there is no outstanding invoice but the membership has a valid next billing date, show that date; otherwise show `—` rather than inventing a date.

Pagination is required so the app does not download every member/financial record to Flutter. The API must return page metadata and accurate page-independent aggregate values as appropriate.

#### D. Tenant, branch and permission rules

- Collection results are organization-wide for the authenticated organization unless a later explicit branch filter is approved. Do not restrict a member to their `registration_branch_id`; that field is informational and is not an access-control boundary.
- Resolve organization and staff identity from the authenticated device/Gym Staff session, not query/body parameters supplied by Flutter.
- Keep cross-organization isolation strict.
- Use the authenticated staff active branch for branch context on any newly created invoice/payment/refund/waiver and for audit events. Do not derive the financial report's member scope from the active branch.
- The new summary/collection endpoints must enforce appropriate financial dashboard/view permission(s) server-side. Membership-plan reads and member reads must also respect their existing permission requirements. `_canAccessPayments` and client-side `can...` flags are UI visibility only; they are not a substitute for backend authorization.

### 37.7 Financial calculation rules for the new collection report

The backend report must aggregate from ledger entries with the same rules used by the invoice detail screen and existing billing calculations:

- Billed total: sum the relevant invoice totals for the selected member/membership/plan and report period (the report period/filter design must be checked against the existing API/schema before implementation; do not silently add a date filter the user did not request).
- Net paid: posted payment amounts minus posted refund amounts. Voided payments/refunds do not affect the current balance but remain in history.
- Waived amount: only posted waivers count toward reducing the amount outstanding.
- Outstanding: invoiced amount minus net paid minus posted waivers. Handle overpayment/credit consistently with the existing billing service; do not silently discard a credit or create a negative amount without a defined UI label.
- Fee displayed per member: use the saved membership price snapshot, not the latest plan catalogue price.
- Due date: use an actual unpaid invoice due date; fall back to the membership’s next billing date only when the schema/API exposes it and no outstanding invoice due date exists.

Ensure joins do not multiply invoice totals when a member has multiple payments/refunds/waivers. Prefer pre-aggregated subqueries/CTEs or a carefully grouped query. Pagination must occur after the member result set is built, while the summary totals must not accidentally be limited to the current page.

### 37.8 Implementation plan for the next continuation

Resume from the D: project paths shown in Section 37.1, but first confirm both repositories’ current branch, `git status` and uncommitted work. Do not assume all changes are pushed.

1. **Inspect exact current source and schema before coding.** Required API files: `src/routes/membershipPlanRoutes.js` (provided in chat), `src/controllers/membershipPlanController.js`, the actual billing routes/controllers/services, invoice/payment/refund/waiver table DDL and membership table/plan DDL. Required Flutter files: `payments_screen.dart`, `member_membership_billing_screen.dart`, `member_membership_screen.dart`, `member_membership_service.dart`, and `gym_authenticated_screen.dart`. The user has supplied only the membership-plan route source in this continuation; the controller and current payment screen source are not yet in this chat.
2. **Implement server-side summary and plan collections.** Add the correctly permissioned route(s), organization-scoped SQL aggregation, status rules, due-date logic and pagination. Place static collection paths before `/:planId` if they share the same router. Return only the fields required by the UI plus pagination/summary metadata.
3. **Build the Payments & Collections UI.** Add four compact KPI cards, debounced automatic member search, selected-member active membership list (excluding cancelled/suspended), one membership-plan selector and a compact paginated plan-collections list with all financial columns.
4. **Remove billing from Membership.** Ensure membership assignment/update/cancel/renew remains in the Membership module and remove the old embedded `Billing & Payments` button and its unused screen import/launcher after checking current source. The Dashboard Payments route becomes the only billing entry point.
5. **Address the prior runtime issues in the billing screen.** Earlier logs showed an ExpansionTile/ListTile background/ink visibility warning and `TextEditingController was used after being disposed`, followed by Flutter framework assertions (`_dependents.isEmpty` / dirty widget in wrong build scope). A safe replacement for the prompt dialog controller lifecycle and a Material-backed invoice card was prepared, but successful application and runtime verification were not confirmed in this checkpoint. Reinspect current code and fix only if the issue remains.
6. **Validate efficiently without mutating financial history.** Run `node --check` for changed API files, route/module loading, `git diff --check` and `flutter analyze`. Use read-only queries against the existing invoice fixture and open the Payments screen. Do not create additional posted payments/refunds/waivers or edit/void the protected fixture just to test UI rendering.
7. **Review and release separately.** Review exact API and Flutter diffs, stage explicit paths only, and commit/push each repository independently. Do not use `git add .`, force-push, amend the earlier 18 November release, or claim a clean/pushed state without checking it.

### 37.9 Known outstanding work not superseded by this checkpoint

- Member Profile API cross-branch authorization correction and `GET /:memberId` permission correction remain unconfirmed from Section 36.5; verify before marking complete.
- Member Detail Flutter UI and the four-tab Overview/Fitness/Membership/Programs integration remain pending as recorded in Section 36.7.
- Flutter Role & Permission UI and comprehensive API authorization/audit verification remain open from Section 33 unless later source/test evidence is provided.
- The new plan-based collections API and redesigned Payments & Collections UI are not implemented yet; this is the immediate next feature task.
- The embedded Membership “Billing & Payments” entry removal must be verified in current source.
- GitHub push state for the 20 November billing/UI changes has not been confirmed in this continuation. Treat local source and remote release state as separate until checked.

---

**End of current authoritative master handover document (20 November 2026, Section 37).**



## 38. Payments & Collections — Active-Branch Implementation and Release Preparation (21 November 2026)

This section supersedes the Section 37 statements that the plan-based collections API and redesigned Payments screen were still unimplemented. The feature has now been implemented in the current office working copies and passed source-level validation. Authenticated endpoint and payment-write tests remain outstanding; do not describe the feature as fully runtime-tested or production-released until those tests pass.

### 38.1 Confirmed development paths and repositories

The active Windows PowerShell paths remain:

```text
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_api
D:\Personal\INNOVEX WEB\Flutter Projects\gym_management_app
```

The two repositories in scope for this release are separate:

| Project | GitHub repository | Default branch |
|---|---|---|
| Backend API | `https://github.com/arafath65/gym-management-api` | `main` |
| Gym operational Flutter app | `https://github.com/arafath65/gym-management-apps` | `main` |

The Super Admin repository `gym-management-super-admin` is a third independent repository and is not part of this Payments & Collections release. Verify each local repository's actual branch, remote and working tree before staging. Do not assume an API commit also releases the Flutter app.

### 38.2 Final Payments & Collections branch rules

The user clarified that the Payments page is scoped to the currently selected active branch, with a deliberate payment-receiver exception:

1. Active membership count, billed totals and outstanding totals are scoped by the primary member's `members.registration_branch_id` matching the authenticated staff session's active branch.
2. Membership-plan collection count and rows use the same primary-member registration-branch rule.
3. Member search for ordinary billing search users is limited to active members whose `registration_branch_id` matches the selected active branch.
4. Staff with `member_billing.payments.receive` may search active members across all branches so they can collect a payment for a visiting member at the currently selected branch.
5. Collected totals are transaction-branch scoped: include posted payments whose `member_membership_payments.branch_id` is the selected active branch and subtract posted refunds whose `member_membership_refunds.branch_id` is that same branch. A refund linked to a voided payment remains excluded.
6. A cross-branch collection must not change the member's original registration branch. Payment `branch_id` is taken from the authenticated staff session's active branch.
7. Organization isolation remains strict. Organization and active branch are derived from the authenticated device/Gym Staff context, never from client-supplied query/body scope.

This is a deliberate distinction between the membership/reporting scope and the transaction-processing scope. For example, a member registered at Branch A may pay at Branch B when the cashier at Branch B has `member_billing.payments.receive`: that member is not included in Branch B's registration-based plan collection list, while the posted payment is included in Branch B's collected total.

### 38.3 Backend implementation recorded in the current working copy

#### Billing collections aggregate

File:

```text
src/controllers/memberBillingCollectionsController.js
```

Implemented behavior:

- `getCollectionsSummary` requires a valid Gym Staff organization, active branch and user context.
- Active memberships are counted once per membership, using the primary member's registration branch and the active primary participant link.
- Issued invoice totals, net paid and outstanding are aggregated for memberships whose primary member belongs to the active registration branch.
- Payment allocations and refunds are pre-aggregated to avoid invoice-total multiplication. Only posted payments/refunds and posted invoice waivers affect the current financial calculations; voided events do not.
- Collected totals use the actual payment branch and actual refund branch.
- Summary response reports `report_scope: 'active_branch'` and retains metric-visibility checks for the relevant permissions.
- `getMembershipPlanCollections` filters current active memberships by plan and primary-member registration branch. Count and paginated row queries use the same filter. Rows include the saved membership price snapshot, plan period, billed amount, net paid, outstanding, due-date information and included participants.
- The current active-membership query excludes future-start and ended memberships and requires the primary membership participant link to remain active.

The existing protected billing fixture must remain unchanged. The previously documented values and fixture identifiers in Section 37 are preserved; do not use it for payment-write testing.

#### Dedicated billing member search

New file:

```text
src/controllers/memberBillingMemberSearchController.js
```

`GET /api/members/billing/member-search?q=...` now uses a dedicated billing search controller. It preserves the normal Member Management search controller and its endpoint unchanged.

Search behavior:

- Search by member name, member code, normalized phone, or exact Sri Lankan NIC HMAC lookup.
- NIC search remains exact; raw NIC is never returned.
- Search returns up to five active members and masked phone/NIC fields.
- Ordinary billing-search users are restricted by registration branch.
- Staff holding `member_billing.payments.receive` may search across registration branches.
- Response includes `registration_branch_id`, `registration_branch_name`, `registration_branch_code`, and whether cross-branch collection is permitted.
- Branch details are joined from `branches`; the Flutter UI displays the registration branch name, with a branch-ID fallback.

Routes:

```text
src/routes/memberBillingRoutes.js
src/routes/memberRoutes.js
```

`memberRoutes.js` mounts billing routes under `/api/members`, so the complete search path is `/api/members/billing/member-search`. The billing search route accepts either `member_billing.members.search` or `member_billing.payments.receive`. The normal `GET /api/members/search` remains the Member Management search and is not replaced by billing-specific filtering.

#### Read permissions needed by payment receivers

File:

```text
src/routes/memberMembershipRoutes.js
```

The membership-list GET route permits any of:

- `member_memberships.view`
- `member_billing.member_account.view`
- `member_billing.payments.receive`

The membership invoice-list GET route permits any of:

- `member_billing.invoices.view`
- `member_billing.member_account.view`
- `member_billing.payments.receive`

The invoice payment-history GET route permits either:

- `member_billing.payments.view`
- `member_billing.payments.receive`

Other create/update/void/refund/waiver permissions remain separately enforced. Card payment additionally requires `member_billing.payments.receive.card` through the existing card-payment permission middleware.

`src/routes/membershipPlanRoutes.js` defines the static `/collections` route before `/:planId`; the collections route requires membership-plan view, billing dashboard view and billing report view permissions. The summary route requires billing dashboard view.

#### Payment transaction branch storage

File:

```text
src/controllers/memberMembershipPaymentController.js
```

The existing payment receive controller derives `branchId` from `req.gymStaff.branchId` and inserts `context.branchId` into `member_membership_payments.branch_id`. The audit context records the same active branch. The cross-branch payment exception does not update `members.registration_branch_id`. This code was inspected in the working copy; final transaction behavior still requires the controlled disposable-invoice test listed in Section 38.7.

### 38.4 Flutter implementation recorded in the current working copy

Main screen:

```text
lib/features/payments/presentation/payments_screen.dart
```

Service:

```text
lib/features/payments/data/member_billing_collections_service.dart
```

Implemented behavior:

- Four compact summary cards: active memberships, total billed, total collected and outstanding.
- Automatic member type-ahead search with a 350 ms debounce and a two-character minimum.
- The selected-member flow requests `status: 'active'` and also verifies current start/end dates. It excludes non-current and ended participant associations according to the current API status response.
- Selected member's active memberships are displayed for invoice/payment follow-up.
- Membership plan selector loads active plans; selecting a plan loads a server-paginated collection table.
- The seven columns are Member, Plan/Period, Fee, Billed, Net Paid, Outstanding and Next Due.
- The collection table is wrapped in a responsive layout with a minimum width of 1080 logical pixels. On wider tablet layouts it expands to the available width; on narrower layouts horizontal scrolling is retained.
- Member search results show the member's original registration branch name/code returned by the billing API, with a branch-ID fallback.
- Request sequence IDs and loading states prevent stale responses from replacing newer search/collection results.

The authenticated host screen `lib/features/auth/presentation/gym_authenticated_screen.dart` keys `PaymentsScreen` by `ValueKey(_branch['id'])`. When the selected active branch changes, the Payments screen is recreated and its `initState` reloads the branch-scoped summary and plan list. The selected branch is already represented in this key; no extra branch-ID query parameter is supplied by the Flutter client.

The general Member Management search remains separate. `MemberBillingCollectionsService` performs Payments search against the billing route; `MemberService.searchMembers` retains `members/search`. `MemberMembershipService.searchMembers` delegates back to the general member search for other membership flows.

### 38.5 Working-copy patch and backup history

The following backup files were created on the development machine while applying this milestone. They are local recovery artifacts and should not be committed:

- `gym_management_api/src/controllers/memberBillingCollectionsController.js.backup-20261120-232617892`
- `gym_management_api/src/routes/memberBillingRoutes.js.backup-20261120-232929498`
- `gym_management_api/src/routes/memberMembershipRoutes.js.backup-20261120-232929498`
- `gym_management_app/lib/features/members/data/member_service.dart.backup-20261120-233156846`
- `gym_management_app/lib/features/members/data/member_membership_service.dart.backup-20261120-233156846`
- `gym_management_app/lib/features/payments/presentation/payments_screen.dart.backup-20261120-233911610`
- `gym_management_app/lib/features/members/data/member_membership_service.dart.backup-20261120-233911610`

Never stage these backups, `.patch-backups`, review ZIPs, `.env`, credentials, JWTs, device tokens or local database dumps. Do not use `git add .` as a shortcut.

### 38.6 Validation evidence completed

The following checks were reported successful by the user in the current continuation:

| Check | Result |
|---|---|
| API health `GET /api/health` | Pass — API and MySQL both returned `connected` |
| `node --check` on seven modified API files | Pass |
| Flutter billing-search service patch formatting | Pass |
| Flutter analysis after billing-search service integration | Pass — no issues found |
| Flutter Payments screen formatting | Pass |
| Flutter analysis after Payments UI patch | Pass — no issues found |
| Billing search controller branch-name join syntax validation | Pass |
| User confirmation of the registration-branch display update | Confirmed working |

The health response observed was:

```json
{
  "success": true,
  "api": "connected",
  "database": "connected"
}
```

These are source/syntax/analyzer and API-health checks only. They do not prove authenticated branch-specific SQL results or the payment-write business flow.

### 38.7 Authenticated runtime tests still required

Six main test stages remain before declaring Payments & Collections fully verified:

1. **Gym Staff login and active branch:** authenticate with a valid device token and staff account; confirm the selected `branchId` is the active branch in the returned staff session. Keep credentials and tokens out of chat/logged output.
2. **Member search access rules:** a user with ordinary billing-search permission sees only active members registered at the active branch; a user with `member_billing.payments.receive` can search an active member registered at another branch. Confirm the response contains branch ID/name/code and no raw NIC/phone.
3. **Collections summary:** compare active membership count and invoice-based billed/outstanding totals to read-only SQL for the selected registration branch; compare collected total to posted payments and posted refunds processed at the active branch. Check metric visibility for staff with restricted dashboard permissions.
4. **Plan collections:** confirm membership count and paginated rows include only current active memberships for the selected plan whose primary member registration branch matches the active branch. Verify saved fee snapshot, billed, net paid, outstanding and due-date calculations against the ledger.
5. **Branch switch:** switch the authenticated staff session to another authorized branch; confirm the app issues the new staff session and Payments summary/plan collections reload using the new branch. Confirm no old in-flight request overwrites new-branch values.
6. **Cross-branch payment write:** use a disposable test invoice and a payment receiver at Branch B to collect for a member registered at Branch A. Verify the new posted payment's `branch_id` is Branch B and the member's `registration_branch_id` remains Branch A. Confirm the Branch B collected total changes while Branch A membership/billed/outstanding scope remains registration-based. Do not mutate the protected Section 37 fixture.

The authenticated login controller uses `POST /api/gym-auth/login` with a device token in `X-Device-Token` and an identifier (username or email) plus password. Initial branch selection may use the selection-token flow; a completed staff session uses the Gym Staff JWT in `Authorization: Bearer ...`. Exact login response/branch-selection payload should be re-read from the current controller before writing test automation. Do not include secrets in a handover or Git commit.

### 38.8 GitHub release status and exact next release procedure

The two repositories were confirmed to exist and have `main` as the default branch. The GitHub heads inspected during release preparation were:

- API `main`: `4072e3141eb31ed689e5cc229f3e682f2fdd34ad`
- Flutter app `main`: `654d16af364a2e1a7d48d320fc19a274f2e65be5`

Those are the observed remote heads before this release operation; they are not proof that the current local working copies are clean or synchronized. Compare local branch and remote state before committing. This Section 38 must be updated again with actual commit SHAs and push results after a successful release.

Release safety rules:

- Commit and push API and Flutter app independently.
- Inspect `git status --short`, current branch, configured `origin` and `git diff --check` separately in each project.
- Review exact diff before staging; stage only intended tracked and new source/config/migration files.
- Exclude all backup files and secrets. Do not commit `.env` or local database exports.
- Do not use `git add .`, force-push, amend the previous release, or reset unrelated working changes.
- Push only after API syntax checks and Flutter analysis pass; confirm each push by reading the remote branch head/commit URL.
- The standalone master document should be kept as the project continuation reference and included in the API repository documentation (recommended path: `docs/GYM_MANAGEMENT_PROJECT_MASTER.md`) so the API repository has the canonical cross-project handover.

### 38.9 Current exact continuation point

The feature implementation is installed in the current Windows working copies and the user has confirmed the new registration-branch display works. API health, source syntax and Flutter analyzer checks have passed. The next task is to finish the authenticated runtime tests in Section 38.7, then commit/push the two project repositories separately and record their resulting commit SHAs here. The existing protected billing test fixture must remain unchanged throughout.

---

**End of current authoritative master handover document (21 November 2026, Section 38).**
