export const siteConfig = {
  "name": "Cloud Nexus Market",
  "brandMark": "CNM",
  "tagline": "Ecommerce for cloud tools and digital products",
  "description": "A commerce-first storefront for cloud assets, digital bundles, and future downloadable product fulfillment.",
  "footer": "Built to merchandize categories, product inventory, and digital delivery in a clean market-style layout.",
  "cta": {
    "label": "Browse Products",
    "href": "/products"
  },
  "mainNav": [
    {
      "label": "Categories",
      "href": "/categories"
    },
    {
      "label": "Products",
      "href": "/products"
    },
    {
      "label": "Downloads",
      "href": "/downloads"
    },
    {
      "label": "Contact",
      "href": "/contact"
    }
  ],
  "home": {
    "eyebrow": "Cloud Commerce",
    "title": "Launch a polished storefront for cloud operators and digital buyers.",
    "description": "Cloud Nexus Market provides the structure for categories, listings, product details, and post-purchase digital downloads.",
    "stats": [
      {
        "title": "Merchandising pages",
        "description": "Homepage and category flows designed to surface product collections cleanly.",
        "meta": "01"
      },
      {
        "title": "Product detail templates",
        "description": "Each detail page is ready for richer media, checkout hooks, and reviews.",
        "meta": "02"
      },
      {
        "title": "Digital delivery path",
        "description": "Reserve a downloads area for customer files and future order history.",
        "meta": "03"
      }
    ],
    "highlights": [
      {
        "title": "Commerce without clutter",
        "description": "The layout keeps the storefront crisp while leaving room for future checkout wiring."
      },
      {
        "title": "Flexible category model",
        "description": "You can extend into templates, audits, training kits, or implementation add-ons."
      },
      {
        "title": "Ready for integrations",
        "description": "The repo can grow into Stripe, Shopify headless, or custom cart workflows later."
      }
    ]
  },
  "pages": {},
  "products": [
    {
      "slug": "aws-observability-starter",
      "name": "AWS Observability Starter",
      "summary": "Dashboards, alarms, and documentation to speed up visibility across workloads.",
      "price": "$79",
      "format": "Template Pack"
    },
    {
      "slug": "platform-runbook-vault",
      "name": "Platform Runbook Vault",
      "summary": "A curated set of operator runbooks for incident response, maintenance, and handoffs.",
      "price": "$119",
      "format": "Runbook Bundle"
    },
    {
      "slug": "security-review-toolkit",
      "name": "Security Review Toolkit",
      "summary": "Checklists, architecture review sheets, and reporting templates for cloud security assessments.",
      "price": "$99",
      "format": "Toolkit"
    }
  ],
  "categories": [
    {
      "title": "Terraform Kits",
      "description": "Reusable infrastructure baselines and deployment templates."
    },
    {
      "title": "Security Playbooks",
      "description": "Runbooks, SOPs, and response guidance for cloud teams."
    },
    {
      "title": "Documentation Packs",
      "description": "Starter policies, architecture docs, and onboarding assets."
    }
  ]
} as const;
