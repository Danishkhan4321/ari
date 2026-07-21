# Team Tasks Design

## Goal

Add a dedicated Tasks tab to the Team workspace so members can find and manage work assigned within the selected team without leaving Team.

## Product behavior

- The tab lists tasks tied to the selected team and displays title, assignee, priority, due date, status, and description.
- Managers can search and filter by assignee, status, and priority, then sort by due date, newest, assignee, or priority.
- The existing Assign task action remains the creation entry point and the Tasks tab also exposes it.
- View opens a read-only task detail.
- Edit supports title, description, assignee, due date, priority, and status; changing the assignee is the reassign flow.
- Complete and reopen are fast row actions.
- Delete always requires confirmation and permanently removes only that task.
- Loading, empty, error, and success states use the existing CRM/Team visual system.
- The layout is a table on larger screens and readable stacked task cards on narrow screens.

## Architecture

Team tasks receive `team_admin_phone` and `team_name` ownership fields. A schema guard and migration add these nullable fields without disrupting personal or historical tasks. New assignments write both fields. Legacy assignments created by the current user remain visible when their assignee belongs to the selected team.

`GET /api/team/[name]/tasks` returns authorized team tasks and member display names. `PATCH` and `DELETE` on `/api/team/[name]/tasks/[id]` enforce selected-team membership and permit the team admin, task creator, task assigner, or assignee to update status; destructive and reassignment operations are restricted to the team admin or task creator/assigner.

The UI is isolated in `team-tasks-section.tsx`; `team-content.tsx` only registers the tab, lazy-loads the section, opens the shared task form, and refreshes the section after creation.

## Error handling and validation

- API routes reject unauthenticated users, invalid team membership, invalid assignees, malformed dates, unsupported priorities/statuses, and unauthorized mutations.
- Forms show inline errors and keep entered values after a failed request.
- Failed list requests show an error state with Retry.
- Delete uses the shared confirmation dialog and disables duplicate requests.

## Testing

- Parser tests cover valid and invalid task mutation input.
- Workspace source tests verify the Tasks tab, filters, actions, confirmation, responsive presentation, and backend methods.
- Dashboard type checking, unit tests, production build, and a browser interaction pass validate the integrated result.
