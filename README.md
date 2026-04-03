# KONA Funnel

Funnel de 3 páginas para el programa KONA de automatización IA.

## Páginas

- `optin.html` — Landing page principal (tráfico frío desde Meta Ads)
- `calculadora.html` — Calculadora de deuda operativa
- `thankyou.html` — Thank you page con VSL + formulario de aplicación

## Flujo del funnel

```
Meta Ad → optin.html → calculadora.html → thankyou.html → Calendly → Llamada
```

---

## Setup

### 1. Clonar el repo
```bash
git clone https://github.com/axellaban/kona
```

### 2. Reemplazar antes de publicar

> **Nota:** Este proyecto es HTML estático. No hay variables de entorno en runtime.
> Los valores de `.env.example` son solo referencia — deben reemplazarse directamente en los HTML.

| Valor a reemplazar | Archivo(s) | Dónde buscarlo |
|---|---|---|
| Meta Pixel ID (`1274224524679737`) | optin.html, calculadora.html, thankyou.html | `fbq('init', '...')` en el `<script>` del `<head>` |
| Webhook optin | optin.html | `fetch('…/webhook/kona-optin', ...)` en `doSubmit()` |
| Webhook calculadora | calculadora.html | `fetch('…/webhook/kona-calculadora', ...)` en `submitOptin()` |
| Webhook formulario | thankyou.html | `fetch('…/webhook/kona-form', ...)` en `submitApp()` |
| Vimeo video ID | thankyou.html | `src="https://player.vimeo.com/video/TU_VIDEO_ID"` |
| URL de Calendly | thankyou.html | `href="https://calendly.com/..."` en el botón `#calBtn` |

### 3. Conectar a Vercel
1. Ir a vercel.com → New Project
2. Importar este repositorio desde GitHub
3. **Framework: Other** (no configurar ningún build step — es HTML puro)
4. Root directory: `/` (raíz)
5. Deploy

### 4. Configurar dominio
En Vercel → Settings → Domains → agregar dominio propio

---

## Desarrollo local

Sin build step. Servir con cualquier servidor estático:

```bash
python3 -m http.server 8080
# Abrir http://localhost:8080/optin.html
```

---

## n8n Workflows

Importar los archivos JSON de `n8n-workflows/` en la instancia de n8n:

| Archivo | Ruta webhook | Disparado por |
|---|---|---|
| `wf_1_optin.json` | `/webhook/kona-optin` | optin.html |
| `wf_2_calculator.json` | `/webhook/kona-calculadora` | calculadora.html |
| `wf_3_form.json` | `/webhook/kona-form` | thankyou.html |
| `wf_4_calendly.json` | (UUID interno) | Calendly booking event |
