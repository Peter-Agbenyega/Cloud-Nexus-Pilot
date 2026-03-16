# CloudNexus-Empire Tasks

## Manual Input Needed

- Decide whether you want a root `package.json` workspace layer later, or if each project should remain independently installed and run.
- Choose hosting targets for each app and the order in which they should be deployed.
- Decide on domains and subdomains for all five projects.
- Add real environment variables in each project once providers are selected.
- Configure the shared deployment workflow for your actual hosting platform.

## Recommended Next Steps

- Run `npm install --prefix <project-folder>` for each project.
- Run lint, typecheck, and build in each project after installation.
- Replace placeholder content with real brand copy, product details, and case studies.
- Decide which projects need auth, payments, booking, storage, or CRM integrations first.

## Project-Specific Follow-Up

- Review each project's local `docs/TASKS.md` for integration details and unresolved product choices.
