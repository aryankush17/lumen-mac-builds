/**
 * Niche Library
 *
 * Curated, hand-built data per business type. For each niche we define:
 *   - Required pages (with real reasons for inclusion)
 *   - Required homepage sections (in narrative order)
 *   - Primary conversion mechanism (booking? cart? form? donation?)
 *   - Trust signals that matter for this niche
 *   - Schema.org markup required
 *   - Marketing tracking that's relevant (and what to skip)
 *   - Best-in-class reference URLs (real, well-built sites in this niche)
 *   - Visual style direction
 *
 * Used by BlueprintService to translate user form input into an
 * AI-builder prompt grounded in what actually works for that business type.
 *
 * Adding a new niche: add a key to NICHE_PROFILES and ensure
 * niche_keywords[] in classifyNiche() routes to it.
 */

export interface NicheProfile {
  niche: string                     // Internal slug
  label: string                     // User-facing label e.g. "Dental Clinic"
  /** Short paragraph describing what this kind of site needs to do */
  positioning: string
  /** Pages the site needs (homepage assumed) */
  pages: PageSpec[]
  /** Homepage sections in display order */
  homeSections: SectionSpec[]
  /** Primary conversion mechanism */
  primaryConversion: ConversionSpec
  /** Trust signals that move the needle in this niche */
  trustSignals: string[]
  /** Schema.org JSON-LD types required for rich SERP results */
  schemaTypes: string[]
  /** Marketing/tracking that applies — leave empty if not relevant */
  tracking: TrackingSpec
  /** Visual / typography direction guidance */
  visualStyle: VisualStyleSpec
  /** Technical recommendations (stack, performance, accessibility) */
  technical: string[]
  /** Optional integrations worth recommending */
  integrations: string[]
}

interface PageSpec {
  path: string
  label: string
  purpose: string
}

interface SectionSpec {
  name: string
  purpose: string
  /** Concrete contents the section should include */
  must: string[]
}

interface ConversionSpec {
  type: 'booking' | 'form' | 'cart' | 'donation' | 'trial' | 'demo' | 'email' | 'whatsapp' | 'phone'
  label: string
  notes: string
}

interface TrackingSpec {
  googleAnalytics: boolean
  metaPixel: boolean
  linkedinInsight: boolean
  tagManager: boolean
  notes: string
}

interface VisualStyleSpec {
  palette: string
  typography: string
  imagery: string
  mood: string
}

// ─── PROFILES ────────────────────────────────────────────────────────────────

export const NICHE_PROFILES: Record<string, NicheProfile> = {
  // ── HEALTHCARE / LOCAL ────────────────────────────────────────────────────
  dental_clinic: {
    niche: 'dental_clinic',
    label: 'Dental Clinic',
    positioning:
      'A patient-first clinic where the primary visitor intent is "find a dentist near me, see if they look trustworthy, and book an appointment in under 60 seconds." The site must reduce friction between landing and booking while signalling clinical credibility.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Hero with location + booking CTA; services overview; social proof; map' },
      { path: '/services', label: 'Services', purpose: 'Service grid with prices/ranges where possible. Each service links to its own detail page.' },
      { path: '/services/[slug]', label: 'Service detail', purpose: 'Per-treatment pages (implants, orthodontics, root canal) — drives long-tail SEO' },
      { path: '/about', label: 'About / Team', purpose: 'Doctor bios with credentials, photos, years of experience, specialisations' },
      { path: '/contact', label: 'Contact', purpose: 'Form + phone + WhatsApp + map + hours + parking info' },
      { path: '/blog', label: 'Blog', purpose: 'Patient education content — boosts local SEO over time' }
    ],
    homeSections: [
      {
        name: 'Hero',
        purpose: 'Convey "trusted local dental care" in under 3 seconds',
        must: [
          'Clinic name + city in H1 (e.g. "Family Dentistry in [City]")',
          'Sub-headline emphasising patient experience (e.g. "gentle care since 2009")',
          'Primary CTA: "Book Appointment" linking to booking widget',
          'Secondary CTA: tap-to-call phone number visible on mobile',
          'Background: warm, well-lit clinic photo — never stock dental imagery'
        ]
      },
      {
        name: 'Services Strip',
        purpose: 'Help visitors self-identify which service they need',
        must: ['6-8 service icons with one-line descriptions', 'Each card links to /services/[slug]', 'Lead with most common services first (cleanings, fillings, implants, orthodontics)']
      },
      {
        name: 'Social Proof',
        purpose: 'Validate clinical credibility',
        must: ['Google Reviews widget (real, embedded — not screenshots)', '3-5 patient testimonials with first name + city', 'Star rating aggregate (4.8★ from 200+ reviews)']
      },
      {
        name: 'Why Choose Us',
        purpose: 'Differentiate from generic clinics',
        must: ['Specific differentiators (gentle approach, weekend hours, languages spoken, insurance accepted)', 'Avoid generic claims like "best dentist" — use specifics']
      },
      {
        name: 'Team Preview',
        purpose: 'Faces, not logos — trust comes from seeing the dentist',
        must: ['Head shots of 3-5 doctors with names, credentials, years', 'Link to full /about page']
      },
      {
        name: 'Location & Hours',
        purpose: 'Practical info that closes the booking decision',
        must: ['Embedded Google Map iframe', 'Full street address', 'Operating hours table (Mon-Fri X-Y, Sat half-day, Sun closed)', 'Parking notes if relevant', 'Public transit info if urban']
      },
      {
        name: 'Booking CTA',
        purpose: 'Repeated booking opportunity near the end',
        must: ['Calendly / Cliniko / Zocdoc embedded widget OR clear CTA pointing to it', 'Phone number again', 'WhatsApp link for casual enquiry']
      }
    ],
    primaryConversion: {
      type: 'booking',
      label: 'Online booking widget',
      notes:
        'Embed Calendly, Cliniko, Zocdoc, or a regional equivalent. Self-service booking removes the back-and-forth that loses ~30% of high-intent visitors. WhatsApp is a strong secondary channel in regions where it dominates messaging.'
    },
    trustSignals: [
      'Real Google Reviews widget (4.5+ stars)',
      'Doctor credentials and registration numbers',
      'Patient testimonials with photos + names + treatment received',
      'Before/after photo gallery (with patient consent)',
      'Certifications (dental association memberships)',
      'Insurance providers accepted (list logos)',
      'Years in business / patients served (specific numbers)'
    ],
    schemaTypes: ['Dentist', 'MedicalBusiness', 'LocalBusiness', 'AggregateRating', 'Review'],
    tracking: {
      googleAnalytics: true,
      metaPixel: false,
      linkedinInsight: false,
      tagManager: true,
      notes: 'GA4 for traffic visibility. Skip Meta Pixel unless you actively run paid social ads — most local clinics don\'t. Set up GA4 conversion events for: booking_widget_opened, phone_clicked, whatsapp_clicked, form_submitted.'
    },
    visualStyle: {
      palette: 'Calm whites and off-whites with one accent colour (often soft blue, mint green, or warm coral). Avoid clinical white-on-white.',
      typography: 'Friendly sans-serif for body (Inter, Manrope, DM Sans). A warmer display serif (Fraunces, Lora) for hero headlines works well to humanise.',
      imagery: 'Real photography of the clinic, doctors, and (with consent) happy patients. Stock images of generic dental tools or pristine model smiles undermine trust.',
      mood: 'Warm, calm, professional. Not sterile. Not corporate.'
    },
    technical: [
      'Mobile-first responsive (60-70% of dental searches happen on phone)',
      'Page weight under 500KB on mobile',
      'LCP under 1.5s',
      'WCAG AA accessibility (older patients use the site too)',
      'Click-to-call tel: links on mobile',
      'Schema markup validates in Google Rich Results Test'
    ],
    integrations: [
      'Booking system (Calendly / Cliniko / Practo / Zocdoc)',
      'Google Reviews widget',
      'Google Maps embed',
      'WhatsApp click-to-chat (regions where WhatsApp is dominant)',
      'Email service (Mailchimp / SendinBlue) for patient newsletter'
    ]
  },

  restaurant: {
    niche: 'restaurant',
    label: 'Restaurant',
    positioning:
      'A restaurant site has one job: convert hungry visitors into reservations or orders within 30 seconds. The decision is impulsive and visual — photos and menu drive everything. Hours and location are non-negotiable.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Hero photography + menu glimpse + reservations + hours + location' },
      { path: '/menu', label: 'Menu', purpose: 'Full menu with prices and food photography for top items' },
      { path: '/reservations', label: 'Reservations', purpose: 'OpenTable / Resy / direct booking widget' },
      { path: '/about', label: 'Story', purpose: 'Chef / family / origin story — differentiates from chains' },
      { path: '/contact', label: 'Contact / Location', purpose: 'Address, hours, parking, private dining enquiries' },
      { path: '/order', label: 'Order Online (if applicable)', purpose: 'Direct ordering or links to Zomato / Swiggy / DoorDash / Uber Eats' }
    ],
    homeSections: [
      {
        name: 'Hero (full-bleed photo)',
        purpose: 'Sell the experience visually in under 2 seconds',
        must: [
          'Large hero photo of signature dish OR ambient shot of the dining room (not stock food)',
          'H1 with restaurant name + cuisine + city',
          'Primary CTA: "Reserve a Table" → reservations widget',
          'Secondary CTA: "View Menu"',
          'Hours-of-operation pill showing if open right now'
        ]
      },
      {
        name: 'Menu Highlights',
        purpose: 'Showcase 4-6 signature dishes with photography',
        must: ['Card grid with photo + name + price + one-line description', 'Link to /menu', 'For new dishes, include "Chef\'s Pick" or "Most Ordered" tags']
      },
      {
        name: 'Story / About',
        purpose: 'Human element — why this restaurant exists',
        must: ['Chef or owner photo', 'Founding story (2-3 paragraphs)', 'Sourcing / cuisine philosophy if relevant']
      },
      {
        name: 'Reservations',
        purpose: 'Make booking impossibly easy',
        must: ['Embedded reservation widget (OpenTable / Resy / Yelp Reservations)', 'Alternative: phone number for direct call', 'Private dining / events contact form for group enquiries']
      },
      {
        name: 'Hours & Location',
        purpose: 'Practical info that drives walk-ins',
        must: ['Full hours table (lunch / dinner / brunch split)', 'Google Maps embed', 'Address + nearest landmark', 'Parking / valet notes']
      },
      {
        name: 'Photo Gallery',
        purpose: 'Establish atmosphere',
        must: ['8-12 high-quality photos (food, interior, exterior, staff)', 'Real photography — no stock', 'Optimised WebP/AVIF for fast loading']
      }
    ],
    primaryConversion: {
      type: 'booking',
      label: 'Reservation widget',
      notes: 'OpenTable, Resy, Yelp Reservations, Eat App, TableIn, or a regional equivalent. Direct call-to-reserve still important for older clientele.'
    },
    trustSignals: [
      'Recent press mentions / awards (Michelin, James Beard, Eater Best New, etc.)',
      'Aggregated review scores (Yelp / Google / TripAdvisor)',
      'Years in business',
      'Featured publications logos',
      'Chef credentials and background'
    ],
    schemaTypes: ['Restaurant', 'FoodEstablishment', 'AggregateRating', 'Menu', 'MenuItem'],
    tracking: {
      googleAnalytics: true,
      metaPixel: true,
      linkedinInsight: false,
      tagManager: true,
      notes: 'GA4 + Meta Pixel make sense — restaurants benefit from Instagram retargeting (food photography performs well in social ads).'
    },
    visualStyle: {
      palette: 'Earthy, warm tones. Cream / charcoal / burnished accent. Avoid bright corporate colours.',
      typography: 'Editorial display serif (Playfair, Cormorant, EB Garamond) for headers + clean sans for body. Reads as curated, not corporate.',
      imagery: 'Photography is 80% of the site. Hire a real food photographer — phone snaps undermine premium positioning.',
      mood: 'Inviting, sensual, confident. Not trendy. Not generic.'
    },
    technical: [
      'Mobile-first (most reservations happen on phone, often while walking past)',
      'Photos optimised aggressively — WebP/AVIF, lazy loading',
      'LCP under 2s even with hero photo',
      'Click-to-call phone in header on mobile'
    ],
    integrations: [
      'OpenTable / Resy / Eat App',
      'Google Reviews widget',
      'Instagram feed embed',
      'DoorDash / Uber Eats / Zomato / Swiggy if delivery'
    ]
  },

  salon_spa: {
    niche: 'salon_spa',
    label: 'Salon / Spa',
    positioning:
      'A salon site sells a personal-care experience. The decision is heavily visual (style portfolios + transformations) and convenience-driven (online booking + price transparency). Skip booking and you lose customers to the next salon on Google Maps.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Hero + services pricing + portfolio + book now' },
      { path: '/services', label: 'Services & Pricing', purpose: 'Full service menu with prices' },
      { path: '/team', label: 'Stylists / Therapists', purpose: 'Individual profiles with specialisations and bookable slots' },
      { path: '/gallery', label: 'Portfolio', purpose: 'Before/after gallery — drives 80% of booking decisions' },
      { path: '/contact', label: 'Contact', purpose: 'Hours, location, contact form' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Visual mood + book now', must: ['Editorial portrait or salon interior photo', 'H1: "Hair Salon / Spa in [City]"', '"Book Appointment" CTA prominent', 'Tap-to-call phone for mobile'] },
      { name: 'Services & Pricing', purpose: 'Transparency builds trust', must: ['Service categories with starting prices', 'Avoid "From ₹X" wherever possible — list a range', 'CTA per service to book that specific treatment'] },
      { name: 'Portfolio Gallery', purpose: 'Show the work', must: ['Grid of recent transformations', 'Before/after where applicable', 'Tag with stylist who did it'] },
      { name: 'Team', purpose: 'Connect visitors to specific stylists', must: ['Photos + names + specialisations', 'Years of experience', 'Direct book-with-this-stylist link'] },
      { name: 'Reviews', purpose: 'Social proof', must: ['Google Reviews widget', 'Featured testimonials', 'Star rating aggregate'] },
      { name: 'Location & Booking', purpose: 'Close the loop', must: ['Hours, address, map', 'Booking widget OR clear CTA', 'WhatsApp button if your audience uses it'] }
    ],
    primaryConversion: {
      type: 'booking',
      label: 'Online booking widget',
      notes: 'Setmore, Fresha, Booksy, Vagaro are common. Bonus if visitors can book a specific stylist directly.'
    },
    trustSignals: [
      'Google Reviews (4.5+)',
      'Stylist credentials (training, awards)',
      'Featured in press / magazines',
      'Real client transformations'
    ],
    schemaTypes: ['HairSalon', 'BeautySalon', 'LocalBusiness', 'AggregateRating'],
    tracking: {
      googleAnalytics: true,
      metaPixel: true,
      linkedinInsight: false,
      tagManager: true,
      notes: 'Instagram retargeting works very well for salons — install Meta Pixel.'
    },
    visualStyle: {
      palette: 'Soft, elevated. Sage / dusty pink / charcoal / cream. Avoid neon and high-saturation colours.',
      typography: 'Refined serif headers (Cormorant, Tenor Sans) + clean sans body',
      imagery: 'Real portfolio shots taken in salon. No stock model shots.',
      mood: 'Elevated, calm, confident'
    },
    technical: ['Mobile-first', 'Fast gallery loading (lazy + WebP)', 'Click-to-call in header'],
    integrations: ['Booking system (Fresha / Setmore / Booksy)', 'Instagram feed', 'Google Reviews', 'WhatsApp']
  },

  law_firm: {
    niche: 'law_firm',
    label: 'Law Firm',
    positioning:
      'A law firm site sells trust and expertise. Visitors arrive scared (legal trouble, contract dispute, divorce, accident) and need to feel they\'ve found competent, accessible counsel. Authority signals matter more than design flourishes.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Practice areas + attorney credentials + consultation CTA' },
      { path: '/practice-areas/[slug]', label: 'Practice Areas', purpose: 'Per-practice deep-dive pages (criminal, civil, family, etc.) — drives long-tail SEO' },
      { path: '/attorneys', label: 'Attorneys', purpose: 'Individual attorney bios with credentials, bar admissions, case results' },
      { path: '/case-results', label: 'Results', purpose: 'Verdicts, settlements (with disclaimers)' },
      { path: '/contact', label: 'Free Consultation', purpose: 'Detailed intake form for prospective clients' },
      { path: '/insights', label: 'Insights / Blog', purpose: 'Legal updates and explainers — establishes authority' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Authority + accessibility', must: ['Firm name with practice tagline', 'H1: "[Specialty] Lawyers in [City]"', 'CTA: "Schedule Free Consultation"', 'Phone number prominent — many clients call directly'] },
      { name: 'Practice Areas', purpose: 'Visitors self-identify their case type', must: ['Grid of practice areas with icons', '6-12 areas typical (criminal defence, family, immigration, personal injury, business, etc.)', 'Each card links to detail page'] },
      { name: 'Attorney Spotlights', purpose: 'Faces and credentials build trust', must: ['Lead partner photos + credentials', 'Bar admissions, awards, years practising'] },
      { name: 'Case Results', purpose: 'Concrete proof', must: ['3-5 anonymised case outcomes ($X.X million settlement, charges dismissed, etc.)', 'Disclaimer about results not guaranteeing similar outcomes'] },
      { name: 'Testimonials', purpose: 'Client trust transfer', must: ['Quotes (with first name + case type) — avoid full names for privacy', 'Avvo / Google rating widget if available'] },
      { name: 'Free Consultation CTA', purpose: 'Convert', must: ['Form: name, phone, email, case type, brief description', 'Reassurance: "Confidential consultation"', 'Response time promise ("We respond within 4 business hours")'] }
    ],
    primaryConversion: {
      type: 'form',
      label: 'Free consultation intake form',
      notes: 'Detailed intake form is standard. Some firms also use Calendly for scheduling consultations, but most prefer the form to qualify leads first.'
    },
    trustSignals: [
      'Bar admissions per attorney',
      'Awards (Super Lawyers, Best Lawyers, Martindale-Hubbell ratings)',
      'Years in practice',
      'Case results ($ amounts, charges dismissed)',
      'Press mentions',
      'Pro bono work',
      'Educational credentials (JD, LLM)'
    ],
    schemaTypes: ['LegalService', 'Attorney', 'LocalBusiness', 'Person'],
    tracking: {
      googleAnalytics: true,
      metaPixel: false,
      linkedinInsight: true,
      tagManager: true,
      notes: 'LinkedIn Insight for B2B legal work. Meta Pixel less useful — legal services don\'t target on social. Set up call tracking (CallRail or similar) since most leads come via phone.'
    },
    visualStyle: {
      palette: 'Conservative. Navy / charcoal / muted gold or burgundy accent. Cream or white background.',
      typography: 'Authoritative serif (Cormorant, Libre Caslon, Source Serif) for headers + readable sans for body',
      imagery: 'Real attorneys, real office, no stock courthouse photos. Avoid gavels — clichéd.',
      mood: 'Authoritative, accessible, trustworthy. Not aggressive. Not gimmicky.'
    },
    technical: ['Fast page load (anxious users abandon slow sites)', 'Mobile-first', 'Accessibility for older clients', 'Clear contact info on every page'],
    integrations: ['Calendly for consultation scheduling', 'CallRail for call tracking', 'Form-to-CRM integration', 'Live chat (optional)']
  },

  // ── COMMERCE ─────────────────────────────────────────────────────────────
  ecommerce: {
    niche: 'ecommerce',
    label: 'E-Commerce Store',
    positioning:
      'An e-commerce site\'s only job is converting browsers into buyers. Speed, trust, product photography, and checkout simplicity dominate. Everything else is decoration.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Hero + bestsellers + categories + value props' },
      { path: '/shop', label: 'Shop / Collections', purpose: 'Product grid with filtering' },
      { path: '/product/[slug]', label: 'Product Detail', purpose: 'Photos, description, variants, add to cart, reviews' },
      { path: '/cart', label: 'Cart', purpose: 'Review items, edit quantities, proceed to checkout' },
      { path: '/checkout', label: 'Checkout', purpose: 'Guest checkout, address, payment, confirmation' },
      { path: '/about', label: 'About', purpose: 'Brand story — differentiates from Amazon' },
      { path: '/shipping-returns', label: 'Shipping & Returns', purpose: 'Policies — reduces cart abandonment' },
      { path: '/contact', label: 'Contact', purpose: 'Support form + email + chat' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Lead campaign or signature collection', must: ['Editorial photo of products in use', 'H1: brand value prop', 'CTA: "Shop the Collection" or "Shop New Arrivals"'] },
      { name: 'Value Props Strip', purpose: 'Reduce purchase hesitation', must: ['Free shipping threshold (e.g. "Free shipping on orders over $50")', 'Return policy ("30-day returns")', 'Authenticity / quality guarantee', 'Customer support promise'] },
      { name: 'Bestsellers / Featured', purpose: 'Reduce decision paralysis', must: ['6-8 bestselling products with photos + prices', 'Quick "Add to Cart" from grid', 'Sale tags where applicable'] },
      { name: 'Categories', purpose: 'Help category-browsers find their thing', must: ['Visual category grid (Women / Men / Sale or Bedroom / Living Room / Outdoor)', 'High-quality category imagery'] },
      { name: 'Story / Brand', purpose: 'Differentiate from generic stores', must: ['Brand origin story (2-3 paragraphs)', 'Founder photo if direct-to-consumer', 'What makes the products unique'] },
      { name: 'Reviews / Social Proof', purpose: 'Validate purchase decision', must: ['Aggregated star rating (4.5★ from N,NNN reviews)', 'Customer photos / UGC if available', 'Press mentions if any'] },
      { name: 'Email Signup', purpose: 'Recapture non-converting traffic', must: ['Offer (10% off first order, or early access)', 'Single email field + submit', 'Confirmation that you\'ll send order discounts'] }
    ],
    primaryConversion: {
      type: 'cart',
      label: 'Shopping cart + checkout',
      notes: 'Guest checkout is essential. Auto-saved cart. Multiple payment options (cards + Apple Pay + Google Pay + buy-now-pay-later if relevant). Express checkout options.'
    },
    trustSignals: [
      'Aggregate star ratings on product pages',
      'Customer reviews with verified-purchase badges',
      'Customer photos (UGC)',
      'Payment provider badges',
      '"Free returns" / "Free shipping over $X"',
      'SSL secure-checkout badge near payment',
      'Press logos (if any)',
      'Money-back guarantee'
    ],
    schemaTypes: ['Product', 'Offer', 'AggregateRating', 'Review', 'BreadcrumbList'],
    tracking: {
      googleAnalytics: true,
      metaPixel: true,
      linkedinInsight: false,
      tagManager: true,
      notes: 'Critical: Meta Pixel + GA4 + Google Ads conversion tracking. Set up: ViewContent, AddToCart, InitiateCheckout, Purchase. Dynamic product ads need product catalog feed.'
    },
    visualStyle: {
      palette: 'Brand-driven. Common patterns: minimal monochrome (B&W + accent), warm pastels for beauty/wellness, bold high-contrast for athletic/streetwear',
      typography: 'Clean sans for body. Branded display face for hero / category headers.',
      imagery: 'High-quality product photography is non-negotiable. Lifestyle + flat-lay + detail shots.',
      mood: 'Aspirational but accessible. Speaks to a defined customer.'
    },
    technical: [
      'Sub-1.5s LCP critical for conversion',
      'Mobile cart icon always visible',
      'One-page checkout where possible',
      'Address autocomplete (Google Places API)',
      'Cart persistence across sessions',
      'Image optimisation (WebP/AVIF + lazy + responsive srcset)'
    ],
    integrations: [
      'E-commerce platform (Shopify recommended for most SMBs)',
      'Payment: Stripe + PayPal + Apple/Google Pay + regional gateway (e.g. Razorpay, Mercado Pago, PayU)',
      'Shipping: ShipStation, Shippo, or carrier-specific',
      'Email: Klaviyo (industry standard for e-commerce)',
      'Reviews: Yotpo, Judge.me, Loox',
      'Live chat: Gorgias (e-commerce focused) or Intercom'
    ]
  },

  // ── B2B / DIGITAL ────────────────────────────────────────────────────────
  saas_b2b: {
    niche: 'saas_b2b',
    label: 'SaaS / Software Product',
    positioning:
      'A B2B SaaS site converts visitors into trial signups or demo bookings. The hero must communicate value in under 5 seconds, pricing must be visible (or have a clear "Talk to Sales" path), and security/compliance signals matter for enterprise procurement.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Hero + how-it-works + features + customer logos + CTA' },
      { path: '/features', label: 'Features', purpose: 'Detailed feature breakdown with screenshots/videos' },
      { path: '/pricing', label: 'Pricing', purpose: '2-3 tiered plans + Enterprise CTA' },
      { path: '/integrations', label: 'Integrations', purpose: 'Logo grid of supported integrations' },
      { path: '/customers', label: 'Customer Stories', purpose: 'Case studies with named brands and outcome metrics' },
      { path: '/docs', label: 'Docs', purpose: 'API/product documentation (separate subdomain often)' },
      { path: '/security', label: 'Security & Compliance', purpose: 'SOC 2 / GDPR / HIPAA details for enterprise buyers' },
      { path: '/blog', label: 'Blog', purpose: 'Industry content marketing' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Communicate value in 5 seconds', must: ['H1 = clear value proposition ("Ship better code reviews in half the time")', 'Sub-headline expands on who it\'s for and what it does', 'Primary CTA: "Start Free Trial" OR "Book a Demo"', 'Secondary CTA: "Watch 2-min demo"', 'Hero visual: product UI screenshot or short demo video — never abstract illustrations'] },
      { name: 'Social Proof Strip', purpose: 'Borrowed credibility', must: ['Customer logo bar (5-8 logos of recognisable brands)', 'Heading: "Trusted by teams at..."'] },
      { name: 'Problem → Solution', purpose: 'Visitors must recognise their problem in the copy', must: ['Pain-point section ("Code review queues are a bottleneck")', 'Solution section showing how the product fixes it', 'Use screenshots, not abstract diagrams'] },
      { name: 'Feature Highlights', purpose: '3-5 key features with screenshots', must: ['Each feature gets: short benefit-led headline + 2-3 lines of supporting copy + product screenshot', 'Reinforce primary value prop across features'] },
      { name: 'Customer Stories Preview', purpose: 'Quantitative outcomes', must: ['3 case study cards with outcome metric ("Cut review cycle by 60%")', 'Customer logo + role of testifier', 'Link to full case study'] },
      { name: 'Integration Logos', purpose: 'Show ecosystem fit', must: ['Grid of integration partner logos', 'Categorised (CI/CD, communication, code hosting, etc.)'] },
      { name: 'Security & Compliance', purpose: 'Enterprise procurement', must: ['SOC 2 / ISO 27001 / GDPR / HIPAA badges as applicable', 'Link to security page', 'For enterprise: SSO, SCIM, custom DPA mentions'] },
      { name: 'Pricing Preview', purpose: 'Self-qualification', must: ['Show starting prices ("Starting at $X/seat/month")', 'CTA → /pricing for full plan grid', 'Enterprise: "Contact Sales for custom"'] },
      { name: 'Final CTA', purpose: 'Convert', must: ['Repeat primary CTA at bottom', 'Add secondary "Talk to sales" path for high-touch'] }
    ],
    primaryConversion: {
      type: 'trial',
      label: 'Free trial OR demo booking',
      notes: 'Self-serve products: "Start Free Trial" → 14-day no-credit-card-required trial. Higher-ACV / enterprise: "Book a Demo" → Calendly with sales. Both can coexist if product has free + enterprise tiers.'
    },
    trustSignals: [
      'Customer logos (real, named brands)',
      'Detailed case studies with outcome metrics',
      'SOC 2 Type II / ISO 27001 / GDPR / HIPAA certifications',
      'Years in business + number of customers',
      'Funding announcements / investor logos (for early-stage)',
      'G2 / Capterra rating widgets',
      'Press / award mentions'
    ],
    schemaTypes: ['SoftwareApplication', 'WebApplication', 'Product', 'Organization'],
    tracking: {
      googleAnalytics: true,
      metaPixel: true,
      linkedinInsight: true,
      tagManager: true,
      notes: 'B2B SaaS lives on LinkedIn Insight Tag. Meta Pixel for retargeting (still works for B2B awareness). GA4 essential. Set up conversion events: trial_started, demo_requested, contact_sales, doc_signup.'
    },
    visualStyle: {
      palette: 'Single strong brand colour + neutral background. Common: deep navy / sage / coral / electric blue.',
      typography: 'Sharp geometric sans (Inter, GT America, Söhne) — feels modern and engineering-friendly',
      imagery: 'Product screenshots are 80% of visual content. Either real UI or polished mockups. Skip stock photography entirely.',
      mood: 'Confident, modern, builder-focused. Avoid corporate cliché ("synergy", "leverage", "empower").'
    },
    technical: [
      'Sub-1s LCP for hero',
      'Static site generation for marketing pages (Next.js / Astro)',
      'Separate /app subdomain for authenticated product',
      'Programmatic SEO for integrations pages',
      'Excellent OG image generation for shareable content'
    ],
    integrations: [
      'CRM (HubSpot, Salesforce, Pipedrive)',
      'Email automation (Customer.io, HubSpot, Default)',
      'Analytics (PostHog or Mixpanel for product analytics)',
      'Live chat (Intercom for SaaS, Drift, or Chili Piper)',
      'Demo booking (Chili Piper, Calendly)'
    ]
  },

  agency_services: {
    niche: 'agency_services',
    label: 'Marketing / Design / Dev Agency',
    positioning:
      'An agency site needs to prove capability before claiming it. Visible portfolio work and named client outcomes do more than any "About Us" copy. The conversion is qualified inbound enquiries from prospects who already trust the work.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Hero + selected work + services + outcomes + contact CTA' },
      { path: '/work', label: 'Work / Portfolio', purpose: 'Case study grid with outcome metrics' },
      { path: '/work/[slug]', label: 'Case Study Detail', purpose: 'Per-project deep dive: brief, approach, outcomes' },
      { path: '/services', label: 'Services', purpose: 'What you do and how — should feel specific, not generic' },
      { path: '/about', label: 'About / Team', purpose: 'Team photos, founding story, methodology' },
      { path: '/contact', label: 'Start a Project', purpose: 'Detailed intake form (budget, timeline, scope)' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Position and prove in one screen', must: ['H1: clear positioning statement ("We help SMBs scale through performance marketing")', 'Sub-headline expanding on what kind of work + who for', 'CTA: "Start a Project" or "Book a Discovery Call"', 'Visual: scrolling logo bar of recent clients OR signature project visual'] },
      { name: 'Selected Work', purpose: 'Prove capability before claiming it', must: ['3-6 case study cards with: project visual, client name, outcome metric', 'Make outcomes specific ("3x bookings in 90 days" not "increased bookings")', 'Click-through to full case study'] },
      { name: 'Services', purpose: 'What you do — specifically', must: ['3-5 services maximum (specialisation > generalist)', 'Each service: what it includes + how you approach it differently'] },
      { name: 'Why Us / Differentiators', purpose: 'Why pick this agency over the next', must: ['Specific methodology / framework / philosophy', 'Avoid generic claims ("we love what we do")', 'Concrete capability proofs (in-house team, founder pedigree, vertical specialty)'] },
      { name: 'Client Testimonials', purpose: 'Borrowed credibility', must: ['Quotes with named clients (first name + role + company)', 'Outcome embedded in quote where possible'] },
      { name: 'Contact CTA', purpose: 'Start the engagement', must: ['Form: name, company, project budget range, project description', 'Response time promise', 'Alternative: Calendly link for discovery call'] }
    ],
    primaryConversion: {
      type: 'form',
      label: 'Project enquiry form + discovery call booking',
      notes: 'Most agencies need both: a detailed enquiry form for qualified leads, and a Calendly link for warm prospects. Filter the form by budget range to qualify before scheduling.'
    },
    trustSignals: [
      'Named client logos',
      'Case studies with quantified outcomes',
      'Team bios with backgrounds (where founders worked before)',
      'Awards (industry recognition specific to your discipline)',
      'Press mentions',
      'Years operating',
      'Specialisation (vertical or service depth)'
    ],
    schemaTypes: ['Organization', 'ProfessionalService', 'WebSite'],
    tracking: {
      googleAnalytics: true,
      metaPixel: true,
      linkedinInsight: true,
      tagManager: true,
      notes: 'LinkedIn Insight critical for B2B agency targeting. Meta Pixel for retargeting. Track form_submitted, calendly_opened, case_study_read.'
    },
    visualStyle: {
      palette: 'Distinct, often bold. The site itself is a portfolio piece — make it look like work you\'d be proud of.',
      typography: 'Strong typographic choices. Often a distinct display face + clean body.',
      imagery: 'Case study visuals are the heroes. Process photography, before/after, project shots.',
      mood: 'Confident, specific, opinionated. Generic agency sites read as junior.'
    },
    technical: ['Excellent performance (agency sites are scrutinised)', 'Strong case study UX (image-heavy, no jank)', 'Mobile-first'],
    integrations: ['CRM (HubSpot, Pipedrive)', 'Calendly for discovery calls', 'Slack notifications for new leads', 'Email automation for nurture']
  },

  // ── PROFESSIONAL ─────────────────────────────────────────────────────────
  consultant_freelancer: {
    niche: 'consultant_freelancer',
    label: 'Consultant / Freelancer',
    positioning:
      'A solo consultant\'s site sells you, the individual. The reader must see (1) what you do, (2) who you do it for, (3) proof you\'re good at it, and (4) how to start a conversation. Trust comes from specificity and case work, not from credentials alone.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Position + selected work + about + contact' },
      { path: '/work', label: 'Work / Case Studies', purpose: 'Past projects with outcome metrics' },
      { path: '/about', label: 'About', purpose: 'Who you are, what you believe, how you work' },
      { path: '/writing', label: 'Writing / Notes', purpose: 'Thought leadership — builds authority over time' },
      { path: '/contact', label: 'Start a Project', purpose: 'Project enquiry form' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Clear identity', must: ['H1: "I help [audience] achieve [outcome]" or "[Name] — [Discipline]"', 'Sub-headline with positioning + current availability', 'Primary CTA: "Start a Project" or "Get in Touch"'] },
      { name: 'Selected Work', purpose: 'Show, don\'t tell', must: ['3-6 project cards with client name + outcome', 'Link to case study detail'] },
      { name: 'About', purpose: 'Establish credibility', must: ['Photo of you', 'Bio: where you worked, what you\'ve built, what you\'re known for', 'Personal touch (philosophy / interests outside work)'] },
      { name: 'Contact', purpose: 'Make starting a conversation easy', must: ['Form OR clear mailto: link', 'Calendly for intro calls', 'Response time'] }
    ],
    primaryConversion: {
      type: 'form',
      label: 'Project enquiry form OR intro-call booking',
      notes: 'For consultants: Calendly for intro calls works well. For freelancers/designers: project enquiry form with budget pre-qualification.'
    },
    trustSignals: ['Notable past employers / clients', 'Specific outcomes from past work', 'Published writing / talks / podcasts', 'Recommendations / testimonials'],
    schemaTypes: ['Person', 'ProfessionalService'],
    tracking: {
      googleAnalytics: true,
      metaPixel: false,
      linkedinInsight: true,
      tagManager: false,
      notes: 'LinkedIn Insight is the highest-leverage tracker for B2B consultants. Skip Meta Pixel and GTM unless running campaigns.'
    },
    visualStyle: {
      palette: 'Distinctive, often one-color + neutral. Reflects personal taste.',
      typography: 'Strong opinion — display serif + clean body, or all-mono for technical positioning',
      imagery: 'A great portrait of you. Real project visuals.',
      mood: 'Confident, personal, specific'
    },
    technical: ['Fast page load', 'Excellent mobile experience', 'RSS feed if you write'],
    integrations: ['Calendly', 'Email newsletter (ConvertKit, Buttondown)', 'Form-to-email (Formspree, Plain)']
  },

  // ── NONPROFIT / OTHER ────────────────────────────────────────────────────
  nonprofit: {
    niche: 'nonprofit',
    label: 'Nonprofit / NGO',
    positioning:
      'A nonprofit site converts visitors into donors, volunteers, or advocates. Mission clarity + impact transparency + donation-flow simplicity drive results. Trust signals (financial transparency, registrations) are non-negotiable.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Mission + impact + donate CTA' },
      { path: '/about', label: 'About', purpose: 'Founding story, team, board, mission' },
      { path: '/programs', label: 'Programs / What We Do', purpose: 'Concrete programs with outcomes' },
      { path: '/impact', label: 'Impact / Annual Report', purpose: 'Numbers + stories of who you\'ve helped' },
      { path: '/donate', label: 'Donate', purpose: 'Donation flow (one-off + recurring options)' },
      { path: '/volunteer', label: 'Volunteer / Get Involved', purpose: 'Application form + volunteer roles' },
      { path: '/transparency', label: 'Financials / Transparency', purpose: 'Annual reports, 990s, donor reports' },
      { path: '/news', label: 'News / Updates', purpose: 'Recent activity, stories from the field' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Mission + impact in one screen', must: ['H1 = mission statement', 'Sub-headline with founding year / scale of work', 'CTA: "Donate Now" (the dominant CTA)', 'Secondary: "Volunteer" or "Learn More"'] },
      { name: 'Impact Numbers', purpose: 'Concrete scale of work', must: ['Specific stats: "50,000 meals served", "12 cities reached", "200 volunteers active"', 'Source citations / annual report link'] },
      { name: 'Featured Story', purpose: 'Emotional grounding', must: ['One specific beneficiary story with photo (with consent)', 'How your work changed their situation', 'Quote from beneficiary or local partner'] },
      { name: 'Programs', purpose: 'Show what you do', must: ['2-4 program cards with descriptions', 'Outcome metric per program'] },
      { name: 'How Donations Are Used', purpose: 'Transparency', must: ['Pie chart or breakdown: "70% direct programs, 20% admin, 10% fundraising"', 'Link to financial transparency page'] },
      { name: 'Donate', purpose: 'Repeated donation opportunity', must: ['Inline donation form OR prominent CTA', 'Suggested amounts ($25, $50, $100, custom)', 'Recurring monthly option', 'Tax-deductibility note'] },
      { name: 'Volunteer / Get Involved', purpose: 'Alternative engagement path', must: ['Volunteer signup form', 'Specific roles needed', 'Time commitment expectations'] }
    ],
    primaryConversion: {
      type: 'donation',
      label: 'Donation flow',
      notes: 'Embedded donation widget (DonorBox, GiveLively, Razorpay, Stripe checkout — choose based on region and entity type). Recurring monthly option lifts lifetime value significantly. Suggested amount tiles help donors decide quickly.'
    },
    trustSignals: [
      'Registration / charity number (501(c)(3) for US, Charity Commission number for UK, equivalent local registration elsewhere)',
      'Financial transparency (published annual reports, 990s)',
      'Charity Navigator / GuideStar / Charity Commission rating',
      'Board of directors with bios',
      'Annual impact reports',
      'Press coverage',
      'Donor testimonials (where appropriate)'
    ],
    schemaTypes: ['NGO', 'NonprofitOrganization', 'Organization'],
    tracking: {
      googleAnalytics: true,
      metaPixel: false,
      linkedinInsight: false,
      tagManager: true,
      notes: 'GA4 for impact reporting (most foundations want analytics dashboards). Skip retargeting pixels — nonprofits rarely advertise on Meta and donors find the practice off-putting. Track donation_started, donation_completed, volunteer_form_submitted.'
    },
    visualStyle: {
      palette: 'Warm, hopeful. Often a single strong brand colour (charity:water blue, GiveDirectly yellow, Akshaya Patra orange).',
      typography: 'Editorial serif headers + clean readable body. Optimised for long-form reading.',
      imagery: 'Real photography of programs, beneficiaries (with consent), team in the field. No stock images of "diverse hands together".',
      mood: 'Hopeful, dignified, specific. Avoid pity narratives.'
    },
    technical: ['Mobile-first (most donors arrive from social media)', 'Fast donation flow (under 5 fields)', 'Recurring donation support', 'PCI compliance via payment provider'],
    integrations: ['Donation platform (DonorBox, GiveLively, Razorpay)', 'Email (Mailchimp for nonprofits — free tier)', 'CRM (Salesforce Nonprofit Cloud / Bloomerang / Little Green Light)']
  },

  // ── DEFAULT / UNCATEGORISED ──────────────────────────────────────────────
  generic_local_business: {
    niche: 'generic_local_business',
    label: 'Local Business',
    positioning:
      'A local business site\'s job is to convert nearby visitors into customers. NAP (name/address/phone) clarity, service description, social proof, and frictionless contact are universal requirements.',
    pages: [
      { path: '/', label: 'Home', purpose: 'Services + location + contact + reviews' },
      { path: '/services', label: 'Services', purpose: 'Detailed service descriptions with pricing where possible' },
      { path: '/about', label: 'About', purpose: 'Team, history, credentials' },
      { path: '/contact', label: 'Contact', purpose: 'Form + phone + WhatsApp + map + hours' }
    ],
    homeSections: [
      { name: 'Hero', purpose: 'Position locally', must: ['H1: "[Service] in [City]"', 'Phone number prominent', 'CTA: "Get a Quote" or "Book Now"'] },
      { name: 'Services', purpose: 'What you offer', must: ['Service grid with descriptions', 'Pricing or starting prices where possible'] },
      { name: 'Social Proof', purpose: 'Google reviews + testimonials', must: ['Google Reviews widget', '3-5 testimonials with name + city'] },
      { name: 'About / Why Us', purpose: 'Differentiate', must: ['Years in business', 'Team / family-owned story', 'Specific differentiators'] },
      { name: 'Location & Contact', purpose: 'Close the loop', must: ['Address, hours, phone', 'Map embed', 'WhatsApp button where dominant', 'Contact form'] }
    ],
    primaryConversion: {
      type: 'form',
      label: 'Quote / contact form + phone',
      notes: 'Combination of contact form for general enquiries and click-to-call phone for high-intent visitors. WhatsApp button for markets where it dominates messaging.'
    },
    trustSignals: ['Years in business', 'Real customer reviews', 'Certifications / licenses', 'Family-owned / heritage story', 'Award mentions'],
    schemaTypes: ['LocalBusiness', 'AggregateRating'],
    tracking: {
      googleAnalytics: true,
      metaPixel: false,
      linkedinInsight: false,
      tagManager: false,
      notes: 'GA4 is enough for most local businesses. Skip pixels and GTM unless actively running ads.'
    },
    visualStyle: {
      palette: 'Specific to brand — warm and inviting',
      typography: 'Readable, friendly',
      imagery: 'Real photography of the business, team, work',
      mood: 'Friendly, established, accessible'
    },
    technical: ['Mobile-first', 'Click-to-call', 'Fast load'],
    integrations: ['Google Reviews', 'Maps embed', 'WhatsApp']
  }
}

// ─── CLASSIFICATION ──────────────────────────────────────────────────────────

/**
 * Classify a niche from form input. Inspects industry, business model,
 * services, and target audience to pick the best-fitting profile.
 *
 * Returns the niche slug; falls back to 'generic_local_business' if no
 * specific profile matches.
 */
export function classifyNiche(input: {
  industry?: string
  businessModel?: string
  services?: string
  targetAudience?: string
  productOrService?: string
}): string {
  const text = [
    input.industry,
    input.businessModel,
    input.services,
    input.targetAudience,
    input.productOrService
  ].filter(Boolean).join(' ').toLowerCase()

  // Order matters — most specific first. SaaS is checked before ecommerce
  // because phrases like "SaaS product" would otherwise match "product" in
  // the ecommerce regex.
  if (/\b(dentist|dental|orthodont|implant)\b/.test(text)) return 'dental_clinic'
  if (/\b(restaurant|cafe|bistro|eatery|dining|cuisine|chef)\b/.test(text)) return 'restaurant'
  if (/\b(salon|stylist|spa|beauty|hair|nail|skincare|barber)\b/.test(text)) return 'salon_spa'
  if (/\b(law\s*firm|attorney|lawyer|legal\s*counsel|advocate)\b/.test(text)) return 'law_firm'
  if (/\b(nonprofit|non-profit|ngo|charity|foundation|donation|501c3|fundraising)\b/.test(text)) return 'nonprofit'
  if (/\b(saas|software\s*as\s*a\s*service|software\s*product|web\s*app|web-app|web\s*application|saas\s*platform|api\s*product|developer\s*tool|devtool|b2b\s*software|software\s*for|cloud\s*platform|subscription\s*software|engineering\s*teams|developer\s*platform)\b/.test(text)) return 'saas_b2b'
  if (/\b(agency|marketing\s*agency|design\s*agency|consultancy|consulting\s*firm|creative\s*studio|web\s*agency|ad\s*agency)\b/.test(text)) return 'agency_services'
  if (/\b(freelance|freelancer|consultant|coach|solo\s*practitioner|independent\s*contractor|personal\s*portfolio|self-employed)\b/.test(text)) return 'consultant_freelancer'
  // Ecommerce LAST among commerce types — its keywords are broad and would
  // capture SaaS otherwise. We require cart-specific or product-catalog terms.
  if (/\b(ecommerce|e-commerce|online\s*store|shopify|woocommerce|magento|shopping\s*cart|product\s*catalog|fashion\s*store|apparel|jewelry\s*store|jewellery\s*store|d2c|dtc|direct\s*to\s*consumer|sell\s*online|online\s*shop)\b/.test(text)) return 'ecommerce'

  // Generic local fall-throughs: clinics not dental, gyms, plumbers, etc.
  if (/\b(clinic|gym|fitness|plumber|electrician|hvac|cleaner|tailor|locksmith|mechanic|garage|repair\s*shop)\b/.test(text)) return 'generic_local_business'

  return 'generic_local_business'
}

/**
 * Get a niche profile by slug. Falls back to generic_local_business
 * if the slug isn't recognised.
 */
export function getNicheProfile(slug: string): NicheProfile {
  return NICHE_PROFILES[slug] || NICHE_PROFILES.generic_local_business
}

/**
 * List all available niche slugs (for UI dropdowns).
 */
export function listNiches(): Array<{ slug: string; label: string }> {
  return Object.entries(NICHE_PROFILES).map(([slug, profile]) => ({
    slug,
    label: profile.label
  }))
}
