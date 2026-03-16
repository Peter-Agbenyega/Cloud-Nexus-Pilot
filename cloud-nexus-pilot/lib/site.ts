export const siteConfig = {
  "name": "Cloud Nexus Pilot",
  "brandMark": "CNP",
  "tagline": "AI interview and meeting copilot",
  "description": "A polished SaaS starter for interview prep, transcript uploads, prompt libraries, and AI-generated debriefs.",
  "footer": "Built to help operators and candidates turn raw conversations into useful next actions.",
  "cta": {
    "label": "Open Dashboard",
    "href": "/dashboard"
  },
  "mainNav": [
    {
      "label": "Pricing",
      "href": "/pricing"
    },
    {
      "label": "Prompt Library",
      "href": "/prompt-library"
    },
    {
      "label": "Transcripts",
      "href": "/transcripts"
    },
    {
      "label": "Login",
      "href": "/auth/login"
    }
  ],
  "home": {
    "eyebrow": "Interview Intelligence",
    "title": "Turn every interview and meeting into a clear action plan.",
    "description": "Cloud Nexus Pilot helps teams upload transcripts, centralize prompts, and route every conversation into a structured AI workflow.",
    "stats": [
      {
        "title": "Transcript ready",
        "description": "Fast upload flow designed for recruiter screens, coaching sessions, and team meetings.",
        "meta": "01"
      },
      {
        "title": "Prompt governance",
        "description": "Store reusable prompt sets for summaries, interview scorecards, and follow-up generation.",
        "meta": "02"
      },
      {
        "title": "Operator dashboard",
        "description": "Start with a dashboard shell that is ready for analytics, billing, and workspace settings.",
        "meta": "03"
      }
    ],
    "highlights": [
      {
        "title": "Upload once, summarize later",
        "description": "Prepare a transcript pipeline with room for ASR ingestion, storage, and review queues."
      },
      {
        "title": "SaaS-grade information architecture",
        "description": "Marketing, auth, and app surfaces are separated so the product can scale cleanly."
      },
      {
        "title": "Ready for future integrations",
        "description": "Docs capture follow-up work for auth providers, storage backends, and model orchestration."
      }
    ]
  },
  "pages": {
    "pricing": {
      "eyebrow": "Pricing",
      "title": "Simple plans for solo operators and scaling teams.",
      "description": "Start with clear packages and leave room for usage-based AI billing later.",
      "items": [
        {
          "title": "Starter",
          "description": "Landing pages, prompt storage patterns, transcript upload placeholders, and one workspace.",
          "meta": "$29/mo"
        },
        {
          "title": "Pro",
          "description": "Team-level prompt governance, richer dashboards, and admin review workflows.",
          "meta": "$99/mo"
        },
        {
          "title": "Enterprise",
          "description": "Private deployment, advanced audit controls, and tailored onboarding.",
          "meta": "Custom"
        }
      ]
    },
    "promptLibrary": {
      "eyebrow": "Prompt Library",
      "title": "Centralize prompts for every call workflow.",
      "description": "Collect battle-tested prompts for summaries, scorecards, stakeholder updates, and coaching follow-ups.",
      "items": [
        {
          "title": "Interview Debrief",
          "description": "Generate strengths, risks, and recommended follow-up questions in one pass."
        },
        {
          "title": "Meeting Summary",
          "description": "Turn a long transcript into a crisp recap with owners, decisions, and blockers."
        },
        {
          "title": "Candidate Scorecard",
          "description": "Map transcript evidence against role competencies and expected behaviors."
        }
      ]
    }
  },
  "products": [],
  "categories": []
} as const;
