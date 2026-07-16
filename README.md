# HandymanCleaners Business Platform

Production website, service-request system, and lightweight operations dashboard for a family-run vacation-rental cleaning and handyman business serving Queen Creek, San Tan Valley, and Gilbert, Arizona.

**Live site:** [handymancleanersaz.com](https://handymancleanersaz.com/)

<a href="https://handymancleanersaz.com/">
  <img src="assets/property/living-room.jpg" alt="Guest-ready vacation rental prepared by HandymanCleaners" width="900">
</a>

## Project Overview

This is a real business application rather than a static portfolio mockup. It combines a conversion-focused public website with a serverless intake workflow and a private admin dashboard used to manage incoming service requests and customer history.

### Customer Experience

- Responsive service and location landing pages
- Conditional intake form for turnover cleaning, recurring service, and handyman work
- Same-day turnover details, property specifications, scheduling preferences, and custom instructions
- Accessible form labels, validation, keyboard navigation, and no-JavaScript fallback
- Legal, privacy, and accessibility pages
- Search-engine metadata, JSON-LD structured data, sitemap, and social sharing metadata

### Business Operations

- Server-side request validation and honeypot spam filtering
- Cloudflare D1 storage for clients and service requests
- Email notifications through Cloudflare Email Routing
- Password-protected admin dashboard with an upcoming schedule and request queue
- Request status management: new, contacted, confirmed, completed, or declined
- Customer search, notes, service history, and call/text/email actions
- Data-first delivery: submissions remain stored if an email notification fails

## Architecture

```text
Customer browser
      |
      |  static pages + POST /api/request
      v
Cloudflare Worker
      |-- validates and normalizes form data
      |-- stores clients and requests in Cloudflare D1
      |-- sends an email notification through Email Routing
      `-- serves the authenticated /admin dashboard
```

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | Semantic HTML, modern CSS, vanilla JavaScript |
| Backend | Cloudflare Workers |
| Database | Cloudflare D1 / SQLite |
| Authentication | HMAC-signed, secure HTTP-only session cookies |
| Email | Cloudflare Email Routing |
| Hosting and CDN | Cloudflare |
| Source control | Git and GitHub |

The project intentionally avoids a heavy frontend framework. Its public pages remain fast, portable, and usable without client-side JavaScript, while the Worker handles the stateful business workflow.

## Security and Privacy

- Deployment credentials and admin secrets are stored as Cloudflare environment secrets, not in source control.
- Admin sessions use HMAC signatures with `HttpOnly`, `Secure`, and `SameSite=Strict` cookies.
- Password comparison is performed in constant time and failed logins are delayed.
- Customer-submitted values are rendered in the dashboard with `textContent` to prevent stored markup injection.
- Form fields have size limits, required-field validation, and a honeypot for basic bot filtering.
- The public form does not request door, garage, alarm, or calendar access credentials.
- The site currently uses no advertising pixels or third-party analytics.

## Repository Structure

```text
.
|-- index.html                         # Homepage
|-- request-service/                   # Conditional service intake
|-- services/                          # Service landing pages
|-- locations/                         # Local SEO landing pages
|-- privacy/ terms/ accessibility/     # Customer policy pages
|-- src/index.js                       # Worker entry point and request API
|-- src/admin.js                       # Authenticated operations dashboard
|-- schema.sql                         # D1 schema
|-- wrangler.jsonc                     # Cloudflare deployment configuration
|-- styles.css and site.js             # Shared presentation and behavior
`-- serve.js                           # Lightweight local static server
```

## Local Development

Preview the static website:

```powershell
node serve.js
```

Then open `http://127.0.0.1:4174`.

Run the complete Worker locally with Wrangler:

```powershell
npx wrangler d1 execute handymancleaners --local --file=schema.sql
npx wrangler dev
```

Create local values for `ADMIN_PASSWORD` and `ADMIN_SESSION_KEY` through Wrangler or an ignored `.dev.vars` file. Never commit those values.

## Deployment

The production application is deployed as a Cloudflare Worker with a static-assets binding, D1 database binding, and Email Routing binding. The custom domain is `handymancleanersaz.com`.

```powershell
npx wrangler deploy
```

Database schema changes are applied separately with Wrangler before code that depends on them is deployed.

## Development Approach

The platform was developed through iterative AI-assisted engineering with human-directed business requirements, content decisions, visual review, security checks, browser testing, and production deployment. The implementation evolved from a static business page into a working intake and operations application based on real usage needs.

## License

Copyright HandymanCleaners. Source is available for portfolio review; no license is granted for reuse.
