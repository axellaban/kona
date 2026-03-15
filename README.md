# KONA Funnel

Funnel de 3 páginas para el programa KONA de automatización IA.

## Páginas

- `optin.html` — Landing page principal (tráfico frío desde Meta Ads)
- `calculadora.html` — Calculadora de deuda operativa
- `thankyou.html` — Thank you page con VSL + formulario de aplicación

## Setup

### 1. Clonar el repo
git clone https://github.com/TU_USUARIO/kona-funnel

### 2. Reemplazar antes de publicar
- `TU_PIXEL_ID` en los 3 HTML → ID del Meta Pixel
- `WEBHOOK_URL_OPTIN` → URL del webhook de n8n
- `WEBHOOK_URL_CALCULADORA` → URL del webhook de n8n
- `WEBHOOK_URL_FORMULARIO` → URL del webhook de n8n
- `TU_VIDEO_ID` en thankyou.html → ID del video de Vimeo
- `https://calendly.com/axellaban` en thankyou.html → URL real del Calendly

### 3. Conectar a Vercel
1. Ir a vercel.com → New Project
2. Importar este repositorio desde GitHub
3. Framework: Other (HTML estático)
4. Root directory: / (raíz)
5. Deploy

### 4. Configurar dominio
En Vercel → Settings → Domains → agregar dominio propio

## Flujo del funnel

Meta Ad → optin.html → calculadora.html → thankyou.html → Calendly → Llamada
