# CloudNexus-Empire PRD

## Vision

Create a clean startup factory monorepo containing five production-minded web properties that can be launched, iterated, and deployed independently while sharing a single planning and automation layer.

## Goals

- Keep one root Git repository for the full workspace.
- Keep each project self-contained inside its own folder.
- Use consistent Next.js, TypeScript, and Tailwind foundations across all projects.
- Provide SaaS-grade UI patterns that feel polished and reusable.
- Capture manual integration needs clearly so implementation can continue without guesswork.

## Included Products

### Cloud Nexus Pilot

- Landing page
- Auth pages
- Dashboard shell
- Transcript upload page
- AI summary placeholder
- Prompt library page
- Pricing page

### DevOps Automation Agency

- Landing page
- Services page
- Case studies page
- Contact page
- Lead form page
- Booking placeholder

### Cloud Security Digital Factory

- Landing page
- Catalog page
- Product detail template
- Downloads placeholder
- Contact page
- Pricing and bundles page

### AI Automation Agency

- Landing page
- Offers page
- Intake form page
- Case studies page
- Proposal request page
- Contact page

### Cloud Nexus Market

- Homepage
- Categories page
- Product listing page
- Product detail template
- Digital downloads page
- Contact page

## Non-Goals

- Live payment processing
- Live CRM or booking integrations
- Live authentication providers
- Shared runtime package system across apps in this initial pass

## Success Criteria

- Every project has its required MVP pages.
- The monorepo has shared root docs and automation.
- No nested Git repositories remain inside project folders.
- Manual follow-ups are documented in `docs/TASKS.md` and each project's local `docs/TASKS.md`.
