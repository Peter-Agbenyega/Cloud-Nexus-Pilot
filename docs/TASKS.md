# CloudNexus-Pilot Tasks

## Manual Input Needed

- Decide whether you want a root `package.json` workspace layer later, or if each project should remain independently installed and run.
- Choose hosting targets for each app and the order in which they should be deployed.
- Decide on domains and subdomains for all five projects.
- Add real environment variables in each project once providers are selected.
- Configure the shared deployment workflow for your actual hosting platform.

## Recommended Next Steps

- Run `npm install` from the repository root to hydrate all workspaces.
- Run root checks with `npm run lint`, `npm run typecheck`, and `npm run build`.
- Run app-specific checks with `npm run <script> --workspace apps/<app-name>` when isolating one project.
- Replace placeholder content with real brand copy, product details, and case studies.
- Decide which projects need auth, payments, booking, storage, or CRM integrations first.

## Project-Specific Follow-Up

- Review each project's local `docs/TASKS.md` for integration details and unresolved product choices.
