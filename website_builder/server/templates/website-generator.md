# Universal Website Generation Skeleton Prompt

This skeleton prompt serves as the master template for generating complete, production-ready website specifications, code structures, and implementation plans.

# Input

This section contains the structured client requirements and specifications used as the source of truth for the generation process.

# Website Planning

Analyze the client requirements and design a comprehensive website planning document:
- Sitemap & Information Architecture: Define a clear hierarchical structure of all pages.
- User Journeys: Map out critical user paths from landing to conversion.
- Target Audience Persona: Define key user demographics, behaviors, and expectations.
- Core Value Proposition: Articulate how the website communicates the business value.

# Feature Planning

Detail the functionality, user stories, and feature specifications:
- Functional Specifications: Describe how each interactive feature works.
- Form Specifications: Define fields, validation rules, error handling, and submission flows.
- Third-party Integrations: List external APIs, libraries, and widgets required.
- Dynamic Features: Outline search, filtering, pagination, and user auth flows.

# Technical Architecture

Formulate the technical design and architectural guidelines:
- Frontend Architecture: Component-driven structure, directory organization, state management, and design tokens.
- Technology Stack: Core frameworks, build tools, database systems, and packages.
- Data Flow & API Design: Detail the communication protocols, database schema, and endpoints.
- Deployment Strategy: CI/CD pipeline, hosting environment, environment variables, and domains.

# SEO Strategy

Formulate an on-page and technical SEO plan:
- Keyword Strategy: Map target search terms to specific pages.
- HTML Semantics: Structure headers (H1-H6), main, section, nav, and article elements correctly.
- Meta Tags & Schema: Define templates for title tags, meta descriptions, Open Graph, and JSON-LD schema markup.
- Site Structure: URL structure, internal linking rules, and breadcrumbs.

# Content Strategy

Define the tone, copy guidelines, and content distribution plans:
- Tone of Voice: Establish the writing style (e.g., professional, friendly, authoritative).
- Core Page Copy outlines: Outline the key messaging blocks for major landing and service pages.
- Media Guidelines: Define recommendations for images, illustrations, video embeds, and icons.

# Conversion Optimization

Define conversion funnels, calls to action (CTAs), trust signals, and lead capture mechanisms:
- CTA Strategy: Map out primary and secondary calls to action for each page type.
- Lead Capture: Design forms, modals, lead magnets, and newsletter signups.
- Trust Elements: Place testimonials, case studies, reviews, security badges, and guarantees.
- Friction Reduction: Optimize page checkout or booking steps to prevent drop-off.

# Performance Strategy

Specify optimization techniques to ensure fast loading times and excellent Core Web Vitals:
- Asset Optimization: Image compression, modern formats (WebP/AVIF), font subsetting, and lazy loading.
- Code Splitting: Dynamic imports, bundle size limits, and tree-shaking.
- Caching Rules: Browser caching, CDN configuration, and stale-while-revalidate patterns.
- CSS/JS Delivery: Inline critical CSS, defer non-critical JS, and eliminate render-blocking assets.

# Accessibility

Detail guidelines to ensure WCAG 2.1 AA/AAA compliance:
- Keyboard Navigation: Ensure focus states are visible and all elements are keyboard-accessible.
- ARIA Roles: Apply correct ARIA roles, states, and properties for interactive components.
- Color Contrast: Guarantee sufficient contrast between text and background elements.
- Screen Readers: Implement proper alt text, hidden headings, and descriptive link text.

# Security

Specify security protocols and guardrails to protect user data and website integrity:
- HTTPS/SSL: Mandatory encryption, HSTS headers, and secure cookie attributes.
- Input Validation: Strict sanitization and validation on both client and server sides.
- Authentication: Secure password hashing, token validation, session management, and CSRF protection.
- Threat Mitigation: Guard against OWASP Top 10 vulnerabilities (SQLi, XSS, SSRF, etc.).

# Crawling & Indexing

Specify requirements for search engines to discover, crawl, and index the site:
- Sitemaps: Generate dynamic XML sitemaps containing all indexable URLs.
- Robots.txt: Define clear allow/disallow directives for bots and search engine crawlers.
- Canonicalization: Use canonical tags to prevent duplicate content issues.
- Crawl Budget: Keep page weight low and resolve redirection chains.

# Analytics & Tracking

Define tag management, custom events, conversion goals, and compliance tracking:
- Web Analytics: Integrate tracking codes (e.g., Google Analytics, Plausible) responsibly.
- Event Tracking: Track click events on CTAs, form submissions, and video plays.
- Privacy Compliance: Implement cookie consent banners and opt-in/opt-out mechanisms (GDPR/CCPA).
- Reporting: Set up standard funnels and dashboard goals to monitor traffic and conversions.

# AI & Search Readiness

Ensure the website is optimized for AI search engines, answer engines, and LLM crawlers:
- LLM Crawlability: Ensure robots.txt allows AI crawlers (e.g., GPTBot, ClaudeBot) to read public content.
- Clean DOM Structure: Maintain clean HTML structure without obfuscation to help LLMs parse content.
- Schema Markups: Implement rich semantic data using schema.org markup to assist AI overview generators.
- Clean API Endpoints: Expose structured JSON feeds/APIs for easy data ingestion where applicable.

# Scalability

Detail horizontal and vertical scaling strategies to handle traffic spikes and growth:
- Architecture: Serverless functions, microservices, or stateless container orchestration.
- Caching: Implement Redis or Memcached layers for database queries and session data.
- Database Optimization: Use indexes, connection pools, and read replicas for high-throughput queries.
- CDN Edge Network: Cache static assets and HTML pages at the network edge close to users.

# Deliverables

Specify the expected output, source code deliverables, and project hand-off items:
- Clean Code Repository: Structured, fully documented, and linted codebase.
- Documentation: Detailed README, API reference docs, and deployment manuals.
- Test Coverage: Unit tests, integration tests, and end-to-end user path tests.
- Hand-off Assets: Figma design tokens, database seeds, and configuration templates.

# Rules

Define strict developer rules and architectural constraints:
- Code Quality: Adhere to strict DRY, SOLID, and clean code principles.
- Linting & Formatting: Use ESLint and Prettier configurations.
- Naming Conventions: Use semantic and consistent names for components, variables, and CSS classes.
- Error Handling: Implement robust error boundaries, logging, and graceful fallbacks.
