# CLAUDE.md — KONA Funnel

## Project Overview

**KONA** is a 3-page sales funnel (Spanish-language) for a LATAM-focused AI automation program. It is a static HTML/CSS/Vanilla JS project with no build tooling, no package manager, and no framework dependencies. Pages are deployed directly to Vercel.

**Funnel Flow:**
```
Meta Ad → optin.html → calculadora.html → thankyou.html → Calendly call
```

**External Integrations:**
- **n8n** (self-hosted at `n8n-n8n.fu6abb.easypanel.host`) — handles all webhook data
- **Meta Pixel** (`1274224524679737`) — ad tracking on all 3 pages
- **Calendly** (`https://calendly.com/axellaban`) — appointment booking
- **Vimeo** — VSL embed in `thankyou.html` (Video Sales Letter)
- **Google Fonts** — Barlow Condensed, Barlow, DM Mono (CDN)

---

## Repository Structure

```
kona/
├── optin.html                  # Page 1: WhatsApp lead capture form
├── calculadora.html            # Page 2: Operational debt calculator (~43 KB)
├── thankyou.html               # Page 3: VSL + application form + Calendly
├── assets/
│   └── axel.jpg               # Profile image
├── n8n-workflows/
│   ├── wf_1_optin.json        # n8n workflow: opt-in webhook
│   ├── wf_2_calculator.json   # n8n workflow: calculator submission
│   ├── wf_3_form.json         # n8n workflow: thank-you form
│   └── wf_4_calendly.json     # n8n workflow: Calendly booking tracking
├── whatsapp-scripts/
│   ├── 01-el-fantasma.txt     # Follow-up: non-starters
│   ├── 02-el-asustado.txt     # Follow-up: scared/hesitant
│   ├── 03-el-indeciso.txt     # Follow-up: indecisive
│   └── 04-el-agendado.txt     # Follow-up: already scheduled
├── vercel.json                # Rewrites "/" → "/optin.html"
├── .env.example               # Required environment variable template
├── README.md                  # Setup and deployment guide
└── INSTRUCCIONES_EXPERTAS.md  # Step-by-step manual setup for Axel
```

---

## Architecture

### Single-File Pattern
Each HTML page is **fully self-contained**: embedded `<style>` in `<head>` and `<script>` at bottom of `<body>`. There are no external `.css` or `.js` files.

### Page-to-Page Data Flow
WhatsApp number is passed as a URL query parameter across pages:
```
optin.html → calculadora.html?wa=521XXXXXXXXXX → thankyou.html?wa=521XXXXXXXXXX
```
JavaScript reads it with: `new URLSearchParams(window.location.search).get('wa')`

### Webhook Pattern
Every form submission `POST`s JSON to an n8n webhook via `fetch`:
```javascript
await fetch('https://n8n-n8n.fu6abb.easypanel.host/webhook/<route>', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre, whatsapp, ... })
});
```

---

## Design System

### Color Palette (CSS Custom Properties)
```css
--black: #000000   /* page background */
--off:   #0a0a0a   /* card/block backgrounds */
--dark:  #111111   /* secondary backgrounds */
--border:#1a1a1a   /* borders */
--red:   #e8320a   /* primary accent, CTAs, highlights */
--green: #22c55e   /* success states */
```

### Typography
- `--dp`: `'Barlow Condensed'` — display/headings
- `--bd`: `'Barlow'` — body text
- `--mn`: `'DM Mono'` — labels, tags, UI chrome

### Layout Breakpoints
- Two-column grid collapses at `820px` (single column on mobile)

### Recurring UI Patterns
- **Scan line overlay**: moving red line animation for cyberpunk aesthetic
- **Grid background**: subtle 60px grid pattern
- **Pulse dot**: blinking red dot for urgency
- **Fade-in-up**: animation class for appearing elements
- **Loading overlay**: scan-ring spinner during async operations

---

## calculadora.html — Calculator Logic

The most complex file (~43 KB). Implements a 7-block cost modeling form.

### Inputs
1. Process name (tag chips or free text)
2. Annual revenue / throughput
3. Manual work hours/month
4. Team size
5. Error rate (2–20%)
6. Solution type (15% vs 50% efficiency gain)
7. Process variability / automation capture (30–100%)

### Key Calculations
```javascript
annualWorkCost  = hours × 12 × hourlyRate
errorCost       = annualWorkCost × errorRate × 1.5   // rework multiplier
OPEX            = $600 base + $20 × teamSize / month
grossSavings    = (workCost + errorCost) × solutionPct × capturePct
netAnnualSaving = grossSavings + opportunityCost - annualOPEX
```

### Zone Classification (5 levels by total annual cost)
- **Elite** — lowest operational debt
- **Amateur**
- **Sedentario**
- **Lesionado**
- **Fuera** — highest (urgency messaging)

### Advanced Options (toggleable)
- ROI simulator with custom investment input
- Stacked bar chart (work cost vs error cost)
- Detailed breakdown table
- Academic citations (Stanford HAI, Deloitte, NBER)

---

## Development Workflow

### Running Locally
No build step required. Open HTML files directly in browser or serve with any static server:
```bash
python3 -m http.server 8080
# then visit http://localhost:8080/optin.html
```

### Deployment
Deployed to Vercel as a static site. Push to `main` → auto-deploy. `vercel.json` rewrites root to `optin.html`.

### Making Changes
1. Edit the relevant HTML file directly
2. Test in browser
3. Commit and push to trigger Vercel deployment

---

## Environment Variables

Defined in `.env.example`. These are **not automatically injected** into static HTML — they are reference values that must be manually placed in the HTML files. The actual values are currently hardcoded in the files.

| Variable | Current Value | File(s) |
|---|---|---|
| `META_PIXEL_ID` | `1274224524679737` | all 3 HTML files |
| `WEBHOOK_URL_OPTIN` | `…/webhook/kona-optin` | optin.html |
| `WEBHOOK_URL_CALCULADORA` | `…/webhook/kona-calculadora` | calculadora.html |
| `WEBHOOK_URL_FORMULARIO` | `…/webhook/kona-form` | thankyou.html |
| `CALENDLY_URL` | `https://calendly.com/axellaban` | thankyou.html |
| `VIMEO_VIDEO_ID` | (placeholder) | thankyou.html |

---

## n8n Workflows

Import JSON files from `n8n-workflows/` into the n8n instance. Each workflow:
- Listens on a webhook route
- Processes lead data
- Triggers WhatsApp follow-up sequences via the appropriate script template

Webhook base URL: `https://n8n-n8n.fu6abb.easypanel.host/webhook/`

---

## WhatsApp Follow-up Scripts

Located in `whatsapp-scripts/`. Four templates targeting different lead behaviors:
- `01-el-fantasma.txt` — Lead opted in but never engaged
- `02-el-asustado.txt` — Lead engaged but showed fear/resistance
- `03-el-indeciso.txt` — Lead is hesitant / hasn't decided
- `04-el-agendado.txt` — Lead booked a call (nurture sequence)

Templates use `[nombre]`, `[monto]`, `[proceso]`, `[link]` as dynamic placeholders replaced by n8n.

---

## Key Conventions to Follow

1. **No build tooling** — never introduce npm, webpack, or transpilation. Keep it plain HTML/CSS/JS.
2. **Single-file pages** — keep CSS in `<style>` and JS in `<script>` within each HTML file. Do not create separate asset files unless explicitly requested.
3. **CSS variables for theming** — always use the defined `--red`, `--green`, `--black`, etc. variables. Never hardcode hex colors inline.
4. **Spanish content** — all user-facing text is in Spanish. Keep it that way.
5. **Vanilla JS** — no jQuery, no React, no framework. Use `fetch`, `async/await`, `URLSearchParams`, and standard DOM APIs.
6. **Webhook error handling** — always wrap `fetch` calls in `try/catch`; show a user-visible error message on failure rather than silently failing.
7. **Meta Pixel on all pages** — `fbq('track', 'Lead')` must fire on all meaningful conversion actions.
8. **Query param continuity** — when linking between pages, always forward the `wa` (WhatsApp) query parameter.
9. **No test suite** — this project has no automated tests. Test changes manually in the browser.
10. **No linting tools** — no ESLint, Prettier, or stylelint. Follow the existing code style by convention.

---

## Git Branch

Active development branch: `claude/add-claude-documentation-NYaxt`
Production branch: `main`
