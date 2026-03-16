# CloudNexus-Empire

CloudNexus-Empire is a single monorepo containing five Next.js + TypeScript + Tailwind projects for startup, agency, and digital product experiments.

## Projects

- `cloud-nexus-pilot`: AI interview and meeting copilot
- `devops-automation-agency`: DevOps, AWS, security, and automation consulting site
- `cloud-security-digital-factory`: Digital storefront for templates, SOPs, and cloud security kits
- `ai-automation-agency`: Workflow automation and AI business automation agency site
- `cloud-nexus-market`: Ecommerce-style storefront for cloud-focused digital products

## Monorepo Structure

- `docs/`: shared planning and execution docs for the full workspace
- `.github/workflows/`: shared CI and deployment placeholders
- `tools/`: local automation and scaffolding helpers
- `<project>/`: self-contained Next.js application with its own app, components, docs, and config

## Getting Started

1. Review `docs/TASKS.md` for manual setup items.
2. Copy `.env.example` to `.env.local` if you want shared root-level notes.
3. Install dependencies per project:
   - `npm install --prefix cloud-nexus-pilot`
   - `npm install --prefix devops-automation-agency`
   - `npm install --prefix cloud-security-digital-factory`
   - `npm install --prefix ai-automation-agency`
   - `npm install --prefix cloud-nexus-market`
4. Run an app locally with `npm run dev --prefix <project-folder>`.

## Quality Checks

- `npm run lint --prefix <project-folder>`
- `npm run typecheck --prefix <project-folder>`
- `npm run build --prefix <project-folder>`

## GitHub Target

This workspace is intended to live in a single GitHub repository named `CloudNexus-Empire`.
