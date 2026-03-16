export const siteConfig = {
  "name": "Cloud Security Digital Factory",
  "brandMark": "CDF",
  "tagline": "Digital storefront for templates, SOPs, and cloud playbooks",
  "description": "A storefront-focused Next.js foundation for digital products like Terraform modules, security SOPs, and documentation kits.",
  "footer": "Designed for packaged expertise, downloadable assets, and future gated delivery flows.",
  "cta": {
    "label": "Browse Catalog",
    "href": "/catalog"
  },
  "mainNav": [
    {
      "label": "Catalog",
      "href": "/catalog"
    },
    {
      "label": "Pricing",
      "href": "/pricing"
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
    "eyebrow": "Digital Products",
    "title": "Package cloud security knowledge into products people can buy today.",
    "description": "Cloud Security Digital Factory is built for templates, bundles, and reusable operational assets across security and platform teams.",
    "stats": [
      {
        "title": "Catalog-first UX",
        "description": "Merchandise Terraform assets, SOP bundles, and advisory documentation with confidence.",
        "meta": "01"
      },
      {
        "title": "Bundle-ready pricing",
        "description": "Support single products, curated collections, and future membership packaging.",
        "meta": "02"
      },
      {
        "title": "Download delivery path",
        "description": "Reserve space for gated assets, receipts, and customer file access.",
        "meta": "03"
      }
    ],
    "highlights": [
      {
        "title": "Frictionless merchandising",
        "description": "Product and pricing pages are shaped for digital inventory from day one."
      },
      {
        "title": "Operational credibility",
        "description": "The language and structure fit serious security artifacts rather than generic ebook templates."
      },
      {
        "title": "Future commerce hooks",
        "description": "This repo is ready for Stripe, Lemon Squeezy, or custom delivery workflows later."
      }
    ]
  },
  "pages": {
    "pricing": {
      "eyebrow": "Bundles",
      "title": "Flexible pricing for solo operators, teams, and repeat buyers.",
      "description": "Offer products individually or package them into themed collections.",
      "items": [
        {
          "title": "Single Asset",
          "description": "One focused digital product with documentation and implementation notes.",
          "meta": "$49-$149"
        },
        {
          "title": "Operator Bundle",
          "description": "Bundle two to three related assets for a discounted starter pack.",
          "meta": "$199"
        },
        {
          "title": "Team Vault",
          "description": "Multi-seat access and prioritized updates for internal platform teams.",
          "meta": "$499"
        }
      ]
    }
  },
  "products": [
    {
      "slug": "terraform-landing-zone-kit",
      "name": "Terraform Landing Zone Kit",
      "summary": "A modular AWS baseline with guardrails, networking, and account patterns.",
      "price": "$149",
      "format": "Terraform + Docs"
    },
    {
      "slug": "incident-response-sop-bundle",
      "name": "Incident Response SOP Bundle",
      "summary": "Response playbooks, comms templates, and escalation checklists for cloud incidents.",
      "price": "$89",
      "format": "Docs Bundle"
    },
    {
      "slug": "cloud-security-documentation-pack",
      "name": "Cloud Security Documentation Pack",
      "summary": "Policies, architecture review templates, and evidence collection worksheets.",
      "price": "$129",
      "format": "Documentation Kit"
    }
  ],
  "categories": []
} as const;
