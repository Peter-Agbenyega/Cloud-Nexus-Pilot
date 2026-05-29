# CloudNexus-Pilot

CloudNexus-Pilot is a single GitHub monorepo for five independent Next.js + TypeScript + Tailwind apps, organized with `apps/`, `packages/`, and Turborepo orchestration.

## Projects

- `cloud-nexus-pilot`: AI interview and meeting copilot
- `devops-automation-agency`: DevOps, AWS, security, and automation consulting site
- `cloud-security-digital-factory`: Digital storefront for templates, SOPs, and cloud security kits
- `ai-automation-agency`: Workflow automation and AI business automation agency site
- `cloud-nexus-market`: Ecommerce-style storefront for cloud-focused digital products

## Monorepo Structure

- `apps/`: independently deployable Next.js apps
- `packages/`: prepared shared packages for UI, config, ESLint, and types
- `docs/`: shared planning and execution docs for the full workspace
- `.github/workflows/`: monorepo CI and deploy placeholders
- `tools/`: local automation and scaffolding helpers

## Getting Started

1. Review `docs/TASKS.md` for manual setup items.
2. Copy `.env.example` to `.env.local` if you want shared root-level notes.
3. Install workspace dependencies from the repo root with `npm install`.
4. Run the priority app locally with `npm run dev:pilot`.
5. Run any individual app directly with `npm run dev --workspace apps/<app-name>`.

## Quality Checks

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run lint --workspace apps/cloud-nexus-pilot`
- `npm run build --workspace apps/devops-automation-agency`

## App Paths

- `apps/cloud-nexus-pilot`
- `apps/devops-automation-agency`
- `apps/cloud-security-digital-factory`
- `apps/ai-automation-agency`
- `apps/cloud-nexus-market`

## GitHub Target

This workspace is intended to live in a single GitHub repository named `CloudNexus-Pilot`.
