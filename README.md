# CloudNexus-Pilot

**The unified ecosystem for the modern cloud/AI professional — from landing a high-tier role to running a profitable DevSecOps and AI consultancy.**

CloudNexus-Pilot is a Turborepo monorepo housing five independent Next.js 15 + TypeScript + Tailwind applications that share UI components, types, and deployment pipelines.

🌐 **Live:** [cloud-nexus-pilot.vercel.app](https://cloud-nexus-pilot-cloud-nexus-pilot.vercel.app)

---

## 🚀 Flagship: Cloud Nexus Pilot (AI Interview Copilot)

The flagship app is a real-time AI interview copilot that listens to live interviews, detects questions, and delivers coaching in a **three-layer answer system**:

| Layer | What it gives you | Speed |
|---|---|---|
| 🟡 **Say This Now** | One punchy sentence to buy time and sound confident | Instant |
| 🟢 **Hit These Points** | 3 key ideas to cover | +400ms |
| 🟣 **Your Full Answer** | Complete answer in your own voice, streamed live | +800ms |

### Core Features
- **Live audio capture** — microphone (phone/in-person) or tab audio (Zoom, Teams, Meet)
- **Real-time transcription** — Deepgram streaming with speaker detection
- **Continuous question detection** — detect → guide → reset → detect, for the entire session
- **Human-tone answers** — first-person, conversational, no corporate buzzwords
- **International candidate support** — treats education and experience from any country equally
- **Graceful degradation** — timeout fallbacks, retry queues, connection-unstable recovery; a failed API call never kills a live session
- **Session limits & auth** — Supabase-protected routes, 10 free sessions, upgrade path
- **AI Summary** — turn any transcript into a structured debrief, scorecard, or follow-up list

### Reliability Guarantees
- 12s server-side timeout with instant fallback guidance
- Tolerant JSON parsing — success, timeout, and parse-failure paths all return valid guidance
- React error boundaries — "Something went wrong — your session is safe."
- Chunk upload auto-retry with 2s backoff
- Middleware fails open if env vars are missing (never white-screens)

---

## 📦 Application Matrix

| App | Product | Audience | Monetization |
|---|---|---|---|
| `apps/cloud-nexus-pilot` | AI interview & meeting copilot | Job seekers, students, tech professionals | SaaS subscription (tiered) |
| `apps/devops-automation-agency` | DevOps/AWS/DevSecOps consulting storefront | Enterprise clients, SMEs | Retainer / project-based |
| `apps/cloud-security-digital-factory` | Audited IAM policies, Terraform kits, SOPs | DevSecOps leads, CISOs, startups | One-time digital purchase |
| `apps/ai-automation-agency` | LLM fine-tuning & workflow automation services | Non-tech businesses, operations | Value-based / retainer |
| `apps/cloud-nexus-market` | Marketplace for vetted cloud architectures & scripts | Engineers, independent consultants | Marketplace fee / single sale |

---

## 🏗 Monorepo Structure

```
CloudNexus-Pilot/
├── apps/                      # Independently deployable Next.js apps
│   ├── cloud-nexus-pilot/     # ⭐ Flagship — AI interview copilot
│   ├── devops-automation-agency/
│   ├── cloud-security-digital-factory/
│   ├── ai-automation-agency/
│   └── cloud-nexus-market/
├── packages/                  # Shared workspace packages
│   ├── db/                    # SQLite (dev) + PostgreSQL (prod) clients & migrations
│   ├── shared/                # Zod schemas, types, helpers
│   ├── ui/                    # Shared UI components
│   ├── types/                 # Shared TypeScript types
│   └── eslint-config/         # Shared lint rules
├── docs/                      # Planning, PRD, and execution docs
├── .github/workflows/         # CI (lint, typecheck, build across all apps)
└── tools/                     # Local automation and scaffolding helpers
```

---

## 🛠 Tech Stack

- **Framework:** Next.js 15 (App Router), React 19, TypeScript (strict)
- **Styling:** Tailwind CSS with a custom dark design system (Electric Indigo `#4F46E5` / Neon Cyan `#06B6D4`)
- **AI:** OpenAI (`gpt-4o-mini` default, configurable via `OPENAI_MODEL`)
- **Transcription:** Deepgram streaming (nova-2, VAD, diarization)
- **Auth:** Supabase (SSR middleware, protected routes)
- **Build:** Turborepo with remote caching
- **Deploy:** Vercel (auto-deploy on push to `main`)

---

## ⚡ Getting Started

```bash
# 1. Clone and install from the repo root
git clone https://github.com/Peter-Agbenyega/Cloud-Nexus-Pilot.git
cd Cloud-Nexus-Pilot
npm install

# 2. Configure environment
cp .env.example .env.local
# Fill in: OPENAI_API_KEY, DEEPGRAM_API_KEY,
# NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY

# 3. Run the flagship app
npm run dev:pilot

# Or run any app individually
npm run dev --workspace apps/<app-name>
```

### Required Environment Variables (Pilot)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Guidance generation & question detection |
| `OPENAI_MODEL` | Optional — defaults to `gpt-4o-mini` |
| `DEEPGRAM_API_KEY` | Live transcription |
| `NEXT_PUBLIC_SUPABASE_URL` | Auth |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Auth |

---

## ✅ Quality Checks

```bash
npm run lint          # Lint all workspaces
npm run typecheck     # Strict TypeScript across the monorepo
npm run build         # Build all apps (Turborepo cached)

# Per-workspace
npm run lint --workspace apps/cloud-nexus-pilot
npm run build --workspace apps/devops-automation-agency
```

**Standards:** zero `any` types in production builds · Lighthouse ≥ 90 per app · CI runs lint + typecheck + build on every push.

---

## 🗺 Roadmap

- **Phase 1 — Foundational** ✅ Shared design system, pilot core engine, agency landing pages
- **Phase 2 — Monetization** 🔄 Stripe integration, Security Digital Factory catalog (10 premium DevSecOps/AWS kits)
- **Phase 3 — Scale** ⏳ CloudNexus Market partner listings, advanced real-time pilot features (whiteboard coaching, coding interview mode)

---

## 📄 License & Ownership

Built and maintained by **Cloud Nexus Hub LLC** (Utica, NY).
All rights reserved. Not licensed for redistribution.

---

*Every interview holds the potential to be life-changing. CloudNexus-Pilot makes sure you're ready for it.*
